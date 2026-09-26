import { Effect, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { PersonId } from "@vektorprogrammet/domain/organization";
import {
  AccountAccess,
  AccountAccessFailure,
  transitionAccountAccess,
} from "@vektorprogrammet/domain/identity";
import type { DatabaseOperations } from "./service.js";

/**
 * Whether the native account of `personId` exists and is not disabled. `ForShare` keeps the
 * access state until the transaction ends, so a disable waits for the authorization it gates.
 *
 * @construct sql-lifecycle
 */
export const accountAccessEnabled = (
  sql: DatabaseOperations,
  personId: PersonId,
  lock: "None" | "ForShare",
): Effect.Effect<boolean, SqlError> =>
  sql<{
    readonly enabled: boolean;
  }>`SELECT NOT access_disabled AS enabled FROM auth."user" WHERE id=${personId} ${lock === "ForShare" ? sql`FOR SHARE` : sql``}`.pipe(
    Effect.map((rows) => rows[0]?.enabled === true),
  );

/** Caller holds the administrator-set lock and sorted actor/subject person locks. */
export const changeNativeAccountAccess = Effect.fn("changeNativeAccountAccess")(function* (
  sql: DatabaseOperations,
  input: {
    readonly personId: PersonId;
    readonly expectedRevision: number;
    readonly disabled: boolean;
  },
  actorPersonId: PersonId,
  now: string,
) {
  const rows =
    yield* sql<AccountAccess>`SELECT id AS "personId", access_disabled AS disabled, access_revision AS revision
    FROM auth."user" WHERE id=${input.personId} FOR UPDATE`;

  const current = rows[0];

  if (!current) return yield* new AccountAccessFailure({ code: "NotFound" });
  let anotherUsableAdministrator = true;

  if (input.disabled) {
    const remaining = yield* sql<{ present: boolean }>`SELECT EXISTS(
      SELECT 1 FROM public.organization_global_administrator_grants g JOIN auth."user" u ON u.id=g.person_id
      WHERE NOT u.access_disabled AND u.id<>${input.personId}
        AND g.start_at<=${now}::timestamptz AND (g.end_at IS NULL OR g.end_at>${now}::timestamptz)
    ) AS present`;

    anotherUsableAdministrator = remaining[0]?.present ?? false;
  }

  const next = yield* Effect.fromResult(
    transitionAccountAccess(current, input, { actorPersonId, anotherUsableAdministrator }),
  );

  yield* sql`SELECT id FROM auth."account" WHERE "userId"=${input.personId} ORDER BY id FOR UPDATE`;

  const updated =
    yield* sql<AccountAccess>`UPDATE auth."user" SET access_disabled=${next.disabled}, access_revision=access_revision+1
    WHERE id=${input.personId} AND access_revision=${input.expectedRevision}
    RETURNING id AS "personId", access_disabled AS disabled, access_revision AS revision`;

  // Retain session rows referenced by OAuth audit and token evidence. Epoch mismatch
  // permanently invalidates them, even if a concurrent engine renewal changes expiry.
  yield* sql`UPDATE auth."session" SET "expiresAt"=LEAST("expiresAt",${now}::timestamptz) WHERE "userId"=${input.personId}`;
  yield* sql`DELETE FROM auth.verification WHERE value=${input.personId} AND identifier LIKE 'reset-password:%'`;

  return {
    before: yield* Schema.decodeEffect(AccountAccess)(current),
    after: yield* Schema.decodeUnknownEffect(AccountAccess)(updated[0]),
  };
});
