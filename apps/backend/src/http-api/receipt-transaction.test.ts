import { beforeEach, describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Exit, Fiber, Result, Predicate, Data, Effect } from "effect";
import { Database } from "@vektorprogrammet/database";
import { AdvisoryLockKey, lockAdvisory } from "@vektorprogrammet/database/advisory-lock";
import { DatabaseRuntimeLive } from "@vektorprogrammet/database/runtime";
import { backendPostgres } from "../../test/postgres.js";
import {
  executeNativeHttpCommandPostgres,
  NativeHttpCommandOutcome,
  type NativeHttpReceiptIdentity,
  type NativeHttpResponseCapsule,
} from "./receipt-transaction.js";

const database = backendPostgres();

const runWithExternalSchema = <A, E>(effect: Effect.Effect<A, E, Database>) =>
  database.run(
    Database.use((sql) =>
      Effect.gen(function* () {
        const [config] = yield* sql<{
          host: string;
          port: number;
          database: string;
          username: string;
        }>`SELECT current_setting('unix_socket_directories') AS host, current_setting('port')::integer AS port, current_database() AS database, current_user AS username`;

        if (config === undefined)
          return yield* Effect.die("Missing PostgreSQL connection configuration");

        return yield* Effect.provide(effect, DatabaseRuntimeLive({ ...config, maxConnections: 1 }));
      }),
    ),
  );

const identity: NativeHttpReceiptIdentity = {
  identitySha256: "a".repeat(64),
  requestSha256: "b".repeat(64),
  operationId: "social-events.create",
};

const response: NativeHttpResponseCapsule = {
  status: 200,
  mediaType: "application/json",
  bodyBytes: new TextEncoder().encode('{"receiptId":"receipt-1"}'),
  headers: { "content-type": "application/json" },
};

class CredentialRevoked extends Data.TaggedError("CredentialRevoked") {}

beforeEach(() =>
  Effect.runPromise(
    database.run(
      Database.use((sql) =>
        Effect.gen(function* () {
          yield* sql`CREATE TABLE IF NOT EXISTS native_test_domain_state (revision integer NOT NULL)`;
          yield* sql`CREATE TABLE IF NOT EXISTS native_test_commands (command_id text, CONSTRAINT native_test_commands_id_key UNIQUE (command_id))`;
          yield* sql`DROP TRIGGER IF EXISTS reject_native_receipt_commit ON public.native_http_idempotency_receipts`;
          yield* sql`TRUNCATE public.native_http_idempotency_receipts, native_test_domain_state, native_test_commands`;
          yield* sql`INSERT INTO native_test_domain_state VALUES (0)`;
        }),
      ),
    ),
  ),
);

const persistedState = Database.use((sql) =>
  Effect.gen(function* () {
    const revisions = yield* sql<{
      revision: number;
    }>`SELECT revision FROM native_test_domain_state`;

    const receipts = yield* sql<{
      count: number;
    }>`SELECT count(*)::integer AS count FROM public.native_http_idempotency_receipts`;

    return { revision: revisions[0]?.revision, receipts: receipts[0]?.count };
  }),
);

const preparedCommand = <E>(
  preparedIdentity: NativeHttpReceiptIdentity,
  execute: Effect.Effect<NativeHttpResponseCapsule, E, Database>,
  onPrepare?: () => void,
) =>
  executeNativeHttpCommandPostgres(
    Effect.sync(() => {
      onPrepare?.();

      return { identity: preparedIdentity, execute };
    }),
  );

describe("native HTTP command receipt transaction", () => {
  it.live("commits the domain write and receipt once, then replays identical bytes", () =>
    Effect.gen(function* () {
      let executions = 0;
      let preparations = 0;

      const execute = Database.use((sql) =>
        Effect.gen(function* () {
          executions += 1;
          yield* sql`UPDATE native_test_domain_state SET revision = revision + 1`;

          return response;
        }),
      );

      const prepare = () => {
        preparations += 1;
      };

      expect(yield* database.run(preparedCommand(identity, execute, prepare))).toEqual(
        NativeHttpCommandOutcome.Committed({ response }),
      );
      expect(yield* database.run(persistedState)).toEqual({ revision: 1, receipts: 1 });
      const replay = yield* database.run(preparedCommand(identity, execute, prepare));
      expect(replay._tag).toBe("Replay");

      if (!Predicate.isTagged(replay, "Replay")) throw new Error("Expected a stored replay");
      expect({
        ...replay.response,
        bodyBytes: Array.from(replay.response.bodyBytes ?? []),
      }).toEqual({
        ...response,
        bodyBytes: Array.from(response.bodyBytes ?? []),
      });
      expect(yield* database.run(persistedState)).toEqual({ revision: 1, receipts: 1 });
      expect(
        yield* database.run(
          preparedCommand({ ...identity, requestSha256: "c".repeat(64) }, execute, prepare),
        ),
      ).toEqual(NativeHttpCommandOutcome.DigestConflict());
      expect(executions).toBe(1);
      expect(preparations).toBe(3);
    }),
  );

  it.live.each([database.run, runWithExternalSchema])(
    "rolls back both writes when PostgreSQL rejects the deferred commit",
    (run) =>
      Effect.gen(function* () {
        yield* database.run(
          Database.use((sql) =>
            Effect.gen(function* () {
              yield* sql`CREATE OR REPLACE FUNCTION reject_native_receipt_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt commit rejected'; END $$`;
              yield* sql`CREATE CONSTRAINT TRIGGER reject_native_receipt_commit AFTER INSERT ON public.native_http_idempotency_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_native_receipt_commit()`;
            }),
          ),
        );
        let executed = false;

        const execute = Database.use((sql) =>
          Effect.gen(function* () {
            yield* sql`UPDATE native_test_domain_state SET revision = revision + 1`;
            executed = true;

            return response;
          }),
        );

        const failure = yield* Effect.flip(run(preparedCommand(identity, execute)));
        expect(failure).toHaveProperty("_tag", "NativeHttpReceiptPersistenceError");
        expect(failure).toMatchObject({ operation: "execute" });
        expect(executed).toBe(true);
        expect(yield* database.run(persistedState)).toEqual({ revision: 0, receipts: 0 });
      }),
  );

  it.live("returns in-flight while a distinct PostgreSQL session holds the key lock", () =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const holder = yield* database
        .compete(
          Database.use((sql) =>
            sql.withTransaction(
              Effect.gen(function* () {
                yield* lockAdvisory(
                  sql,
                  AdvisoryLockKey.httpCommandReceipt(identity.identitySha256),
                );
                yield* Deferred.succeed(held, undefined);
                yield* Deferred.await(release);
              }),
            ),
          ),
        )
        .pipe(Effect.forkChild);

      let executed = false;

      yield* Effect.gen(function* () {
        yield* Effect.raceFirst(Deferred.await(held), Fiber.join(holder));

        const execute = Effect.sync(() => {
          executed = true;

          return response;
        });

        expect(yield* database.run(preparedCommand(identity, execute))).toEqual(
          NativeHttpCommandOutcome.InFlight({ retryAfterSeconds: 1 }),
        );
        expect(executed).toBe(false);
        expect(yield* database.run(persistedState)).toEqual({ revision: 0, receipts: 0 });
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));

      yield* Fiber.join(holder);
    }),
  );

  it.live("restarts once after a real concurrent unique-key winner invalidates its snapshot", () =>
    Effect.gen(function* () {
      let preparations = 0;
      let executions = 0;

      const command = executeNativeHttpCommandPostgres(
        Effect.sync(() => {
          preparations += 1;

          return {
            identity,
            execute: Database.use((sql) =>
              Effect.gen(function* () {
                executions += 1;

                const rows = yield* sql<{
                  commandId: string;
                }>`SELECT command_id AS "commandId" FROM native_test_commands WHERE command_id = 'same-command'`;

                if (rows.length === 0) {
                  yield* database.compete(
                    Database.use(
                      (other) => other`INSERT INTO native_test_commands VALUES ('same-command')`,
                    ),
                  );
                  yield* sql`INSERT INTO native_test_commands VALUES ('same-command')`;
                }

                return response;
              }),
            ),
          };
        }),
        {
          retry: "serialization-or-unique-once",
          retryUniqueConstraints: ["native_test_commands_id_key"],
        },
      );

      expect(yield* database.run(command)).toEqual(
        NativeHttpCommandOutcome.Committed({ response }),
      );
      expect(preparations).toBe(2);
      expect(executions).toBe(2);
      expect(yield* database.run(persistedState)).toEqual({ revision: 0, receipts: 1 });
    }),
  );

  it.live("checks current credentials before returning a stored replay", () =>
    Effect.gen(function* () {
      let credentialCurrent = true;
      let executions = 0;

      const execute = Effect.sync(() => {
        executions += 1;

        return response;
      });

      const command = executeNativeHttpCommandPostgres(
        Effect.suspend(() =>
          credentialCurrent
            ? Effect.succeed({ identity, execute })
            : Effect.fail(new CredentialRevoked()),
        ),
      );

      expect(yield* database.run(command)).toEqual(
        NativeHttpCommandOutcome.Committed({ response }),
      );
      credentialCurrent = false;
      expect(yield* Effect.flip(database.run(command))).toBeInstanceOf(CredentialRevoked);
      expect(executions).toBe(1);
      expect(yield* database.run(persistedState)).toEqual({ revision: 0, receipts: 1 });
    }),
  );

  it.live.each([database.run, runWithExternalSchema])(
    "preserves non-SQL defects without retrying or committing",
    (run) =>
      Effect.gen(function* () {
        const defect = new Error("Unexpected command defect");
        let attempts = 0;

        const command = executeNativeHttpCommandPostgres(
          Effect.sync(() => {
            attempts += 1;

            return { identity, execute: Effect.die(defect) };
          }),
          {
            retry: "serialization-or-unique-once",
            retryUniqueConstraints: ["native_test_commands_id_key"],
          },
        );

        const exit = yield* run(Effect.exit(command));

        if (!Exit.isFailure(exit)) throw new Error("Expected a defect exit");
        expect(Cause.hasFails(exit.cause)).toBe(false);
        const observed = Cause.findDefect(exit.cause);

        if (!Result.isSuccess(observed)) throw new Error("Expected the original defect");
        expect(observed.success).toBe(defect);
        expect(attempts).toBe(1);
        expect(yield* database.run(persistedState)).toEqual({ revision: 0, receipts: 0 });
      }),
  );
});
