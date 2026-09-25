import { beforeEach, describe, expect, it } from "vitest";
import { Cause, Deferred, Exit, Result, Predicate, Data, Effect } from "effect";
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
          database: string;
          username: string;
        }>`SELECT current_setting('unix_socket_directories') AS host, current_database() AS database, current_user AS username`;

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

beforeEach(async () => {
  await database.run(
    Database.use((sql) =>
      Effect.gen(function* () {
        yield* sql`CREATE TABLE IF NOT EXISTS native_test_domain_state (revision integer NOT NULL)`;
        yield* sql`CREATE TABLE IF NOT EXISTS native_test_commands (command_id text, CONSTRAINT native_test_commands_id_key UNIQUE (command_id))`;
        yield* sql`DROP TRIGGER IF EXISTS reject_native_receipt_commit ON public.native_http_idempotency_receipts`;
        yield* sql`TRUNCATE public.native_http_idempotency_receipts, native_test_domain_state, native_test_commands`;
        yield* sql`INSERT INTO native_test_domain_state VALUES (0)`;
      }),
    ),
  );
});

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
  it("commits the domain write and receipt once, then replays identical bytes", async () => {
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

    await expect(database.run(preparedCommand(identity, execute, prepare))).resolves.toEqual(
      NativeHttpCommandOutcome.Committed({ response }),
    );
    expect(await database.run(persistedState)).toEqual({ revision: 1, receipts: 1 });
    const replay = await database.run(preparedCommand(identity, execute, prepare));
    expect(replay._tag).toBe("Replay");

    if (!Predicate.isTagged(replay, "Replay")) throw new Error("Expected a stored replay");
    expect({ ...replay.response, bodyBytes: Array.from(replay.response.bodyBytes ?? []) }).toEqual({
      ...response,
      bodyBytes: Array.from(response.bodyBytes ?? []),
    });
    expect(await database.run(persistedState)).toEqual({ revision: 1, receipts: 1 });
    await expect(
      database.run(
        preparedCommand({ ...identity, requestSha256: "c".repeat(64) }, execute, prepare),
      ),
    ).resolves.toEqual(NativeHttpCommandOutcome.DigestConflict());
    expect(executions).toBe(1);
    expect(preparations).toBe(3);
  });

  it.each([database.run, runWithExternalSchema])(
    "rolls back both writes when PostgreSQL rejects the deferred commit",
    async (run) => {
      await database.run(
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

      const result = run(preparedCommand(identity, execute));
      await expect(result).rejects.toHaveProperty("_tag", "NativeHttpReceiptPersistenceError");
      await expect(result).rejects.toMatchObject({ operation: "execute" });
      expect(executed).toBe(true);
      expect(await database.run(persistedState)).toEqual({ revision: 0, receipts: 0 });
    },
  );

  it("returns in-flight while a distinct PostgreSQL session holds the key lock", async () => {
    const held = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();

    const holder = database.compete(
      Database.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* lockAdvisory(sql, AdvisoryLockKey.httpCommandReceipt(identity.identitySha256));
            yield* Deferred.succeed(held, undefined);
            yield* Deferred.await(release);
          }),
        ),
      ),
    );

    let executed = false;

    try {
      await Promise.race([database.run(Deferred.await(held)), holder]);

      const execute = Effect.sync(() => {
        executed = true;

        return response;
      });

      await expect(database.run(preparedCommand(identity, execute))).resolves.toEqual(
        NativeHttpCommandOutcome.InFlight({ retryAfterSeconds: 1 }),
      );
      expect(executed).toBe(false);
      expect(await database.run(persistedState)).toEqual({ revision: 0, receipts: 0 });
    } finally {
      await database.run(Deferred.succeed(release, undefined));
      await holder;
    }
  });

  it("restarts once after a real concurrent unique-key winner invalidates its snapshot", async () => {
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
                yield* Effect.promise(() =>
                  database.compete(
                    Database.use(
                      (other) => other`INSERT INTO native_test_commands VALUES ('same-command')`,
                    ),
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

    await expect(database.run(command)).resolves.toEqual(
      NativeHttpCommandOutcome.Committed({ response }),
    );
    expect(preparations).toBe(2);
    expect(executions).toBe(2);
    expect(await database.run(persistedState)).toEqual({ revision: 0, receipts: 1 });
  });

  it("checks current credentials before returning a stored replay", async () => {
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

    await expect(database.run(command)).resolves.toEqual(
      NativeHttpCommandOutcome.Committed({ response }),
    );
    credentialCurrent = false;
    await expect(database.run(command)).rejects.toBeInstanceOf(CredentialRevoked);
    expect(executions).toBe(1);
    expect(await database.run(persistedState)).toEqual({ revision: 0, receipts: 1 });
  });

  it.each([database.run, runWithExternalSchema])(
    "preserves non-SQL defects without retrying or committing",
    async (run) => {
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

      const exit = await run(Effect.exit(command));

      if (!Exit.isFailure(exit)) throw new Error("Expected a defect exit");
      expect(Cause.hasFails(exit.cause)).toBe(false);
      const observed = Cause.findDefect(exit.cause);

      if (!Result.isSuccess(observed)) throw new Error("Expected the original defect");
      expect(observed.success).toBe(defect);
      expect(attempts).toBe(1);
      expect(await database.run(persistedState)).toEqual({ revision: 0, receipts: 0 });
    },
  );
});
