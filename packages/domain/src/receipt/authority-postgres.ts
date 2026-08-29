import { Effect, Schema } from "effect";
import { Database, type DatabaseShape } from "../database/service.js";
import type {
  OrganizationAuthorityInstant,
  OrganizationPersonAuthority,
} from "../organization/authority.js";
import { DepartmentId, PersonId } from "../organization/schema.js";
import { compareRfc3339Instants } from "../time.js";
import {
  projectReceiptAuthority,
  ReceiptApprovalGrantId,
  ReceiptAuthorityInstantSchema,
  ReceiptPaymentAuthorityId,
  type ReceiptApprovalGrant,
  type ReceiptAuthority,
  type ReceiptPaymentAuthority,
} from "./authority.js";
import {
  ReceiptAuthorityProjectionMismatch,
  ReceiptDecodeError,
  ReceiptPersistenceError,
  type ReceiptAuthorityResolutionError,
} from "./errors.js";

const NonEmpty = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0, { message: "a non-empty string" }),
  ),
);
const Revision = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const ApprovalScope = Schema.Literals(["Department", "Global"]);

const ReceiptAuthorityDatabaseRowSchema = Schema.Struct({
  authorityKind: Schema.Literals(["Payment", "Approval"]),
  authorityId: NonEmpty,
  personId: PersonId,
  departmentId: Schema.NullOr(DepartmentId),
  paymentAccountCiphertext: Schema.NullOr(NonEmpty),
  approvalScope: Schema.NullOr(ApprovalScope),
  startAt: ReceiptAuthorityInstantSchema,
  endAt: Schema.NullOr(ReceiptAuthorityInstantSchema),
  revision: Revision,
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (row) =>
        (row.endAt === null || compareRfc3339Instants(row.endAt, row.startAt) > 0) &&
        (row.authorityKind === "Payment"
          ? row.departmentId !== null &&
            row.paymentAccountCiphertext !== null &&
            row.approvalScope === null
          : row.paymentAccountCiphertext === null &&
            ((row.approvalScope === "Department" && row.departmentId !== null) ||
              (row.approvalScope === "Global" && row.departmentId === null))),
      { message: "a valid persisted Receipt authority row" },
    ),
  ),
);
type ReceiptAuthorityDatabaseRow = typeof ReceiptAuthorityDatabaseRowSchema.Type;

const decodeError = (operation: string, cause: unknown) =>
  new ReceiptDecodeError({ message: `${operation}: ${String(cause)}` });

const persistenceError = (operation: string, cause: unknown) =>
  new ReceiptPersistenceError({ operation, message: String(cause) });

const paymentRecord = (
  row: ReceiptAuthorityDatabaseRow,
): Effect.Effect<ReceiptPaymentAuthority, ReceiptDecodeError> => {
  if (
    row.authorityKind !== "Payment" ||
    row.departmentId === null ||
    row.paymentAccountCiphertext === null ||
    row.approvalScope !== null
  ) {
    return Effect.fail(decodeError("decode Receipt payment authority", "invalid row shape"));
  }
  return Effect.succeed({
    paymentAuthorityId: ReceiptPaymentAuthorityId.make(row.authorityId),
    personId: row.personId,
    departmentId: row.departmentId,
    paymentAccountCiphertext: row.paymentAccountCiphertext,
    startAt: row.startAt,
    endAt: row.endAt,
    revision: row.revision,
  });
};

const approvalGrantRecord = (
  row: ReceiptAuthorityDatabaseRow,
): Effect.Effect<ReceiptApprovalGrant, ReceiptDecodeError> => {
  if (
    row.authorityKind !== "Approval" ||
    row.paymentAccountCiphertext !== null ||
    row.approvalScope === null
  ) {
    return Effect.fail(decodeError("decode Receipt approval grant", "invalid row shape"));
  }
  let scope: ReceiptApprovalGrant["scope"];
  if (row.approvalScope === "Global") {
    if (row.departmentId !== null) {
      return Effect.fail(decodeError("decode Receipt approval grant", "invalid global scope"));
    }
    scope = { _tag: "Global" };
  } else {
    if (row.departmentId === null) {
      return Effect.fail(decodeError("decode Receipt approval grant", "missing department scope"));
    }
    scope = { _tag: "Department", departmentId: row.departmentId };
  }
  return Effect.succeed({
    approvalGrantId: ReceiptApprovalGrantId.make(row.authorityId),
    personId: row.personId,
    scope,
    startAt: row.startAt,
    endAt: row.endAt,
    revision: row.revision,
  });
};

export type ReceiptAuthorityRowLockMode = "None" | "ForShare";

/**
 * Caller-transaction Economy projection. Receipt commands pass their
 * state-transition SQL client and keep every selected authority row locked
 * until that transaction commits or rolls back.
 */
export const resolveReceiptAuthorityWithSql = (
  sql: DatabaseShape,
  personId: PersonId,
  authorizationInstant: OrganizationAuthorityInstant,
  organizationProjection: OrganizationPersonAuthority,
  lockMode: ReceiptAuthorityRowLockMode,
): Effect.Effect<ReceiptAuthority, ReceiptAuthorityResolutionError> =>
  Effect.gen(function* () {
    const evaluatedAt = yield* Schema.decodeUnknownEffect(ReceiptAuthorityInstantSchema)(
      authorizationInstant,
    ).pipe(Effect.mapError((cause) => decodeError("decode Receipt authority instant", cause)));
    if (
      organizationProjection.personId !== personId ||
      organizationProjection.evaluatedAt !== evaluatedAt
    ) {
      return yield* new ReceiptAuthorityProjectionMismatch({
        personId,
        authorizationInstant: evaluatedAt,
        organizationPersonId: organizationProjection.personId,
        organizationEvaluatedAt: organizationProjection.evaluatedAt,
      });
    }

    const authorityLock = lockMode === "ForShare" ? sql`FOR SHARE` : sql``;
    const selected = yield* sql<ReceiptAuthorityDatabaseRow>`
      WITH locked_payment_authorities AS MATERIALIZED (
        SELECT
          payment_authority_id,
          person_id,
          department_id,
          payment_account_ciphertext,
          start_at,
          end_at,
          revision
        FROM public.economy_payment_authorities
        WHERE person_id = ${personId}
        ORDER BY department_id ASC, start_at ASC, payment_authority_id ASC
        ${authorityLock}
      ),
      locked_approval_grants AS MATERIALIZED (
        SELECT
          approval_grant_id,
          person_id,
          scope,
          department_id,
          start_at,
          end_at,
          revision
        FROM public.economy_receipt_approval_grants
        WHERE person_id = ${personId}
        ORDER BY scope ASC, department_id ASC NULLS FIRST, start_at ASC, approval_grant_id ASC
        ${authorityLock}
      ),
      authority_rows AS (
        SELECT
          'Payment'::text AS authority_kind,
          payment_authority_id AS authority_id,
          person_id,
          department_id,
          payment_account_ciphertext,
          NULL::text AS approval_scope,
          start_at,
          end_at,
          revision
        FROM locked_payment_authorities
        UNION ALL
        SELECT
          'Approval'::text AS authority_kind,
          approval_grant_id AS authority_id,
          person_id,
          department_id,
          NULL::text AS payment_account_ciphertext,
          scope AS approval_scope,
          start_at,
          end_at,
          revision
        FROM locked_approval_grants
      )
      SELECT
        authority_kind AS "authorityKind",
        authority_id AS "authorityId",
        person_id AS "personId",
        department_id AS "departmentId",
        payment_account_ciphertext AS "paymentAccountCiphertext",
        approval_scope AS "approvalScope",
        to_char(
          start_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS "startAt",
        CASE
          WHEN end_at IS NULL THEN NULL
          ELSE to_char(
            end_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )
        END AS "endAt",
        revision
      FROM authority_rows
      ORDER BY
        authority_kind ASC,
        approval_scope ASC NULLS FIRST,
        department_id ASC NULLS LAST,
        start_at ASC,
        authority_id ASC
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("resolve Receipt authority", cause)),
      ),
    );
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(ReceiptAuthorityDatabaseRowSchema))(
      selected,
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError((cause) => decodeError("decode Receipt authority rows", cause)));

    const paymentAuthorities: Array<ReceiptPaymentAuthority> = [];
    const approvalGrants: Array<ReceiptApprovalGrant> = [];
    for (const row of rows) {
      if (row.personId !== personId) {
        return yield* decodeError(
          "decode Receipt authority rows",
          "query returned an authority for another person",
        );
      }
      if (row.authorityKind === "Payment") {
        paymentAuthorities.push(yield* paymentRecord(row));
      } else {
        approvalGrants.push(yield* approvalGrantRecord(row));
      }
    }
    return projectReceiptAuthority(organizationProjection, paymentAuthorities, approvalGrants);
  });

/** Read projection for a caller-owned repeatable-read, read-only snapshot. */
export const resolveReceiptAuthorityForRead = (
  personId: PersonId,
  authorizationInstant: OrganizationAuthorityInstant,
  organizationProjection: OrganizationPersonAuthority,
): Effect.Effect<ReceiptAuthority, ReceiptAuthorityResolutionError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    return yield* resolveReceiptAuthorityWithSql(
      sql,
      personId,
      authorizationInstant,
      organizationProjection,
      "None",
    );
  });
