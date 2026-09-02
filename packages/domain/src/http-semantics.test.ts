import { describe, expect, it } from "vitest";
import { Data, Effect } from "effect";
import { Database, type DatabaseShape } from "./database/service.js";
import {
  executeNativeHttpCommandPostgres,
  type NativeHttpReceiptIdentity,
  type NativeHttpResponseCapsule,
} from "./http-semantics.js";

const identity: NativeHttpReceiptIdentity = {
  identitySha256: "a".repeat(64),
  requestSha256: "b".repeat(64),
  operationId: "receipts.reviseReceipt",
};

const response: NativeHttpResponseCapsule = {
  status: 200,
  mediaType: "application/json",
  bodyBytes: new TextEncoder().encode('{"receiptId":"receipt-1"}'),
  headers: { "content-type": "application/json" },
};

interface StoredRow {
  identitySha256: string;
  requestSha256: string;
  operationId: string;
  state: "Complete" | "Tombstone";
  status: number | null;
  mediaType: string | null;
  bodyBytes: Uint8Array | null;
  headers: Readonly<Record<string, string>> | null;
}

interface FakeDatabaseState {
  readonly receipts: Map<string, StoredRow>;
  domainRevision: number;
}

class FakeSqlError extends Data.TaggedError("SqlError")<{
  readonly cause: string;
}> {}

const makeSql = () => {
  let committed: FakeDatabaseState = {
    receipts: new Map(),
    domainRevision: 0,
  };
  let active = committed;
  let lockAcquired = true;
  let failCommit = false;
  let domainWriteAttempts = 0;
  let receiptWriteAttempts = 0;

  const cloneState = (state: FakeDatabaseState): FakeDatabaseState => ({
    receipts: new Map(
      [...state.receipts].map(([key, row]) => [
        key,
        {
          ...row,
          bodyBytes: row.bodyBytes === null ? null : row.bodyBytes.slice(),
          headers: row.headers === null ? null : { ...row.headers },
        },
      ]),
    ),
    domainRevision: state.domainRevision,
  });

  const query = (strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>) =>
    Effect.sync(() => {
      const statement = strings.join("?").replaceAll(/\s+/gu, " ").trim();
      if (statement.includes("pg_try_advisory_xact_lock")) {
        return [{ acquired: lockAcquired }];
      }
      if (statement.startsWith("UPDATE native_test_domain_state")) {
        domainWriteAttempts += 1;
        active.domainRevision += 1;
        return [];
      }
      if (statement.startsWith("UPDATE native_http_idempotency_receipts")) {
        const key = values[0] as string;
        const row = active.receipts.get(key);
        if (row?.state === "Complete" && row.status === -1) {
          active.receipts.set(key, {
            ...row,
            state: "Tombstone",
            status: null,
            mediaType: null,
            bodyBytes: null,
            headers: null,
          });
        }
        return [];
      }
      if (
        statement.startsWith("SELECT") &&
        statement.includes("FROM native_http_idempotency_receipts")
      ) {
        const row = active.receipts.get(values[0] as string);
        return row === undefined ? [] : [row];
      }
      if (statement.startsWith("INSERT INTO native_http_idempotency_receipts")) {
        receiptWriteAttempts += 1;
        active.receipts.set(values[0] as string, {
          identitySha256: values[0] as string,
          requestSha256: values[1] as string,
          operationId: values[2] as string,
          state: "Complete",
          status: values[3] as number,
          mediaType: values[4] as string | null,
          bodyBytes: values[5] as Uint8Array | null,
          headers: values[6] as Readonly<Record<string, string>> | null,
        });
        return [];
      }
      throw new Error(`unexpected SQL: ${statement}`);
    });

  Object.defineProperty(query, "withTransaction", {
    value: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        const transaction = cloneState(committed);
        active = transaction;
        return effect.pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.gen(function* () {
                active = committed;
                return yield* Effect.fail(error);
              }),
            onSuccess: (value) =>
              Effect.gen(function* () {
                if (failCommit) {
                  active = committed;
                  return yield* Effect.fail(new FakeSqlError({ cause: "commit failed" }));
                }
                committed = transaction;
                active = committed;
                return value;
              }),
          }),
        );
      }),
  });
  Object.defineProperty(query, "json", {
    value: (value: unknown) => value,
  });
  const sql = query as unknown as DatabaseShape;
  return {
    sql,
    committedDomainRevision: () => committed.domainRevision,
    committedReceiptCount: () => committed.receipts.size,
    domainWriteAttempts: () => domainWriteAttempts,
    receiptWriteAttempts: () => receiptWriteAttempts,
    setLockAcquired(value: boolean) {
      lockAcquired = value;
    },
    setFailCommit(value: boolean) {
      failCommit = value;
    },
  };
};

const run = <A, E>(sql: DatabaseShape, effect: Effect.Effect<A, E, Database>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provideService(Database, sql)));

describe("native HTTP command receipt transaction", () => {
  it("commits the injected domain write and HTTP receipt once, then replays", async () => {
    const state = makeSql();
    let executions = 0;
    const execute = Database.use((sql) =>
      Effect.sync(() => {
        executions += 1;
      }).pipe(
        Effect.andThen(sql`
          UPDATE native_test_domain_state
          SET revision = revision + 1
        `),
        Effect.as(response),
      ),
    );

    const committed = await run(state.sql, executeNativeHttpCommandPostgres(identity, execute));
    expect(committed).toEqual({ _tag: "Committed", response });
    expect(state.committedDomainRevision()).toBe(1);
    expect(state.committedReceiptCount()).toBe(1);

    const replay = await run(state.sql, executeNativeHttpCommandPostgres(identity, execute));
    expect(replay).toEqual({ _tag: "Replay", response });
    expect(executions).toBe(1);
    expect(state.committedDomainRevision()).toBe(1);
    expect(state.committedReceiptCount()).toBe(1);

    const conflict = await run(
      state.sql,
      executeNativeHttpCommandPostgres({ ...identity, requestSha256: "c".repeat(64) }, execute),
    );
    expect(conflict).toEqual({ _tag: "DigestConflict" });
    expect(executions).toBe(1);
  });

  it("rolls back the injected domain write and HTTP receipt when commit fails", async () => {
    const state = makeSql();
    state.setFailCommit(true);
    const execute = Database.use((sql) =>
      sql`
        UPDATE native_test_domain_state
        SET revision = revision + 1
      `.pipe(Effect.as(response)),
    );

    await expect(
      run(state.sql, executeNativeHttpCommandPostgres(identity, execute)),
    ).rejects.toMatchObject({
      _tag: "NativeHttpReceiptPersistenceError",
      operation: "execute",
    });
    expect(state.domainWriteAttempts()).toBe(1);
    expect(state.receiptWriteAttempts()).toBe(1);
    expect(state.committedDomainRevision()).toBe(0);
    expect(state.committedReceiptCount()).toBe(0);
  });

  it("returns an in-flight result without executing the command", async () => {
    const state = makeSql();
    state.setLockAcquired(false);
    let executed = false;
    const execute = Effect.sync(() => {
      executed = true;
      return response;
    });
    const result = await run(state.sql, executeNativeHttpCommandPostgres(identity, execute));
    expect(result).toEqual({ _tag: "InFlight", retryAfterSeconds: 1 });
    expect(executed).toBe(false);
  });
});
