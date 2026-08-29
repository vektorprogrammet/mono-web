import { Effect, Schema } from "effect";
import { Database, type DatabaseShape } from "../database/service.js";
import type {
  OrganizationAuthorityInstant,
  OrganizationPersonAuthority,
} from "../organization/authority.js";
import { lockPersonAuthorization } from "../organization/authority-postgres.js";
import { DepartmentId, PersonId } from "../organization/schema.js";
import { compareRfc3339Instants } from "../time.js";
import {
  CreateReceiptApprovalGrantInputSchema,
  CreateReceiptPaymentAuthorityInputSchema,
  EndReceiptApprovalGrantInputSchema,
  EndReceiptPaymentAuthorityInputSchema,
  projectReceiptAuthority,
  ReceiptApprovalGrantId,
  ReceiptApprovalGrantSchema,
  ReceiptAuthorityInstantSchema,
  ReceiptPaymentAuthorityId,
  ReceiptPaymentAuthoritySchema,
  RemoveReceiptApprovalGrantInputSchema,
  RemoveReceiptPaymentAuthorityInputSchema,
  type ReceiptApprovalGrant,
  type ReceiptAuthority,
  type ReceiptPaymentAuthority,
} from "./authority.js";
import {
  ReceiptAuthorityProjectionMismatch,
  ReceiptAuthorityRecordNotFound,
  ReceiptAuthorityWriteConflict,
  ReceiptDecodeError,
  ReceiptPersistenceError,
  type ReceiptAuthorityResolutionError,
} from "./errors.js";

const NonEmpty = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.length > 0 && value.trim() === value, {
      message: "a trimmed non-empty string",
    }),
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

const ReceiptAuthorityPersonRowSchema = Schema.Struct({ personId: PersonId });
type ReceiptAuthorityPersonRow = typeof ReceiptAuthorityPersonRowSchema.Type;

export type ReceiptAuthorityWriteFailure =
  | ReceiptDecodeError
  | ReceiptPersistenceError
  | ReceiptAuthorityRecordNotFound
  | ReceiptAuthorityWriteConflict;

const lockAuthorityPerson = (
  sql: DatabaseShape,
  personId: PersonId,
): Effect.Effect<void, ReceiptPersistenceError> =>
  lockPersonAuthorization(sql, personId).pipe(
    Effect.mapError((cause) => persistenceError(cause.operation, cause.message)),
  );

export const lockReceiptPaymentAuthorityForWrite = (
  sql: DatabaseShape,
  paymentAuthorityId: ReceiptPaymentAuthority["paymentAuthorityId"],
  expectedRevision: number,
): Effect.Effect<ReceiptPaymentAuthority, ReceiptAuthorityWriteFailure> =>
  Effect.gen(function* () {
    const observedRows = yield* sql<ReceiptAuthorityPersonRow>`
      SELECT person_id AS "personId"
      FROM public.economy_payment_authorities
      WHERE payment_authority_id = ${paymentAuthorityId}
    `;
    const observed = yield* Schema.decodeUnknownEffect(
      Schema.Array(ReceiptAuthorityPersonRowSchema),
    )(observedRows, { onExcessProperty: "error" }).pipe(
      Effect.mapError((cause) => decodeError("decode Receipt payment authority person", cause)),
    );
    const observedPerson = observed[0]?.personId;
    if (observedPerson === undefined) {
      return yield* new ReceiptAuthorityRecordNotFound({
        entity: "PaymentAuthority",
        id: paymentAuthorityId,
      });
    }

    yield* lockAuthorityPerson(sql, observedPerson);
    const lockedRows = yield* sql<ReceiptAuthorityDatabaseRow>`
      SELECT
        'Payment'::text AS "authorityKind",
        payment_authority_id AS "authorityId",
        person_id AS "personId",
        department_id AS "departmentId",
        payment_account_ciphertext AS "paymentAccountCiphertext",
        NULL::text AS "approvalScope",
        to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
        CASE
          WHEN end_at IS NULL THEN NULL
          ELSE to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS "endAt",
        revision
      FROM public.economy_payment_authorities
      WHERE payment_authority_id = ${paymentAuthorityId}
      FOR UPDATE
    `;
    const locked = yield* Schema.decodeUnknownEffect(
      Schema.Array(ReceiptAuthorityDatabaseRowSchema),
    )(lockedRows, { onExcessProperty: "error" }).pipe(
      Effect.mapError((cause) => decodeError("decode locked Receipt payment authority", cause)),
    );
    const row = locked[0];
    if (row === undefined || row.personId !== observedPerson || row.revision !== expectedRevision) {
      return yield* new ReceiptAuthorityWriteConflict({
        entity: "PaymentAuthority",
        id: paymentAuthorityId,
        expectedRevision,
      });
    }
    return yield* paymentRecord(row);
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("lock Receipt payment authority", cause)),
    ),
  );

export const lockReceiptApprovalGrantForWrite = (
  sql: DatabaseShape,
  approvalGrantId: ReceiptApprovalGrant["approvalGrantId"],
  expectedRevision: number,
): Effect.Effect<ReceiptApprovalGrant, ReceiptAuthorityWriteFailure> =>
  Effect.gen(function* () {
    const observedRows = yield* sql<ReceiptAuthorityPersonRow>`
      SELECT person_id AS "personId"
      FROM public.economy_receipt_approval_grants
      WHERE approval_grant_id = ${approvalGrantId}
    `;
    const observed = yield* Schema.decodeUnknownEffect(
      Schema.Array(ReceiptAuthorityPersonRowSchema),
    )(observedRows, { onExcessProperty: "error" }).pipe(
      Effect.mapError((cause) => decodeError("decode Receipt approval grant person", cause)),
    );
    const observedPerson = observed[0]?.personId;
    if (observedPerson === undefined) {
      return yield* new ReceiptAuthorityRecordNotFound({
        entity: "ApprovalGrant",
        id: approvalGrantId,
      });
    }

    yield* lockAuthorityPerson(sql, observedPerson);
    const lockedRows = yield* sql<ReceiptAuthorityDatabaseRow>`
      SELECT
        'Approval'::text AS "authorityKind",
        approval_grant_id AS "authorityId",
        person_id AS "personId",
        department_id AS "departmentId",
        NULL::text AS "paymentAccountCiphertext",
        scope AS "approvalScope",
        to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
        CASE
          WHEN end_at IS NULL THEN NULL
          ELSE to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS "endAt",
        revision
      FROM public.economy_receipt_approval_grants
      WHERE approval_grant_id = ${approvalGrantId}
      FOR UPDATE
    `;
    const locked = yield* Schema.decodeUnknownEffect(
      Schema.Array(ReceiptAuthorityDatabaseRowSchema),
    )(lockedRows, { onExcessProperty: "error" }).pipe(
      Effect.mapError((cause) => decodeError("decode locked Receipt approval grant", cause)),
    );
    const row = locked[0];
    if (row === undefined || row.personId !== observedPerson || row.revision !== expectedRevision) {
      return yield* new ReceiptAuthorityWriteConflict({
        entity: "ApprovalGrant",
        id: approvalGrantId,
        expectedRevision,
      });
    }
    return yield* approvalGrantRecord(row);
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("lock Receipt approval grant", cause)),
    ),
  );

export const createReceiptPaymentAuthority = (
  input: unknown,
): Effect.Effect<ReceiptPaymentAuthority, ReceiptDecodeError | ReceiptPersistenceError, Database> =>
  Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(CreateReceiptPaymentAuthorityInputSchema)(
      input,
      { onExcessProperty: "error" },
    ).pipe(
      Effect.mapError((cause) => decodeError("decode Receipt payment authority creation", cause)),
    );
    const created = yield* Schema.decodeUnknownEffect(ReceiptPaymentAuthoritySchema)(
      { ...command, revision: 0 },
      { onExcessProperty: "error" },
    ).pipe(
      Effect.mapError((cause) => decodeError("decode created Receipt payment authority", cause)),
    );
    const sql = yield* Database;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* lockAuthorityPerson(sql, created.personId);
          yield* sql`
            INSERT INTO public.economy_payment_authorities (
              payment_authority_id,
              person_id,
              department_id,
              payment_account_ciphertext,
              start_at,
              end_at,
              revision
            ) VALUES (
              ${created.paymentAuthorityId},
              ${created.personId},
              ${created.departmentId},
              ${created.paymentAccountCiphertext},
              ${created.startAt},
              ${created.endAt},
              0
            )
          `;
          return created;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("create Receipt payment authority", cause)),
        ),
      );
  });

export const endReceiptPaymentAuthority = (
  input: unknown,
): Effect.Effect<ReceiptPaymentAuthority, ReceiptAuthorityWriteFailure, Database> =>
  Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(EndReceiptPaymentAuthorityInputSchema)(
      input,
      { onExcessProperty: "error" },
    ).pipe(
      Effect.mapError((cause) => decodeError("decode Receipt payment authority ending", cause)),
    );
    const sql = yield* Database;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* lockReceiptPaymentAuthorityForWrite(
            sql,
            command.paymentAuthorityId,
            command.expectedRevision,
          );
          const ended = yield* Schema.decodeUnknownEffect(ReceiptPaymentAuthoritySchema)(
            {
              ...current,
              endAt: command.endAt,
              revision: current.revision + 1,
            },
            { onExcessProperty: "error" },
          ).pipe(
            Effect.mapError((cause) =>
              decodeError("decode ended Receipt payment authority", cause),
            ),
          );
          const updated = yield* sql<{ readonly paymentAuthorityId: string }>`
            UPDATE public.economy_payment_authorities
            SET end_at = ${ended.endAt}, revision = revision + 1
            WHERE payment_authority_id = ${command.paymentAuthorityId}
              AND revision = ${command.expectedRevision}
            RETURNING payment_authority_id AS "paymentAuthorityId"
          `;
          if (updated.length !== 1) {
            return yield* new ReceiptAuthorityWriteConflict({
              entity: "PaymentAuthority",
              id: command.paymentAuthorityId,
              expectedRevision: command.expectedRevision,
            });
          }
          return ended;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("end Receipt payment authority", cause)),
        ),
      );
  });

export const removeReceiptPaymentAuthority = (
  input: unknown,
): Effect.Effect<ReceiptPaymentAuthority, ReceiptAuthorityWriteFailure, Database> =>
  Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(RemoveReceiptPaymentAuthorityInputSchema)(
      input,
      { onExcessProperty: "error" },
    ).pipe(
      Effect.mapError((cause) => decodeError("decode Receipt payment authority removal", cause)),
    );
    const sql = yield* Database;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* lockReceiptPaymentAuthorityForWrite(
            sql,
            command.paymentAuthorityId,
            command.expectedRevision,
          );
          const removed = yield* sql<{ readonly paymentAuthorityId: string }>`
            DELETE FROM public.economy_payment_authorities
            WHERE payment_authority_id = ${command.paymentAuthorityId}
              AND revision = ${command.expectedRevision}
            RETURNING payment_authority_id AS "paymentAuthorityId"
          `;
          if (removed.length !== 1) {
            return yield* new ReceiptAuthorityWriteConflict({
              entity: "PaymentAuthority",
              id: command.paymentAuthorityId,
              expectedRevision: command.expectedRevision,
            });
          }
          return current;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("remove Receipt payment authority", cause)),
        ),
      );
  });

export const createReceiptApprovalGrant = (
  input: unknown,
): Effect.Effect<ReceiptApprovalGrant, ReceiptDecodeError | ReceiptPersistenceError, Database> =>
  Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(CreateReceiptApprovalGrantInputSchema)(
      input,
      { onExcessProperty: "error" },
    ).pipe(
      Effect.mapError((cause) => decodeError("decode Receipt approval grant creation", cause)),
    );
    const created = yield* Schema.decodeUnknownEffect(ReceiptApprovalGrantSchema)(
      { ...command, revision: 0 },
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError((cause) => decodeError("decode created Receipt approval grant", cause)));
    const sql = yield* Database;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* lockAuthorityPerson(sql, created.personId);
          const departmentId =
            created.scope._tag === "Department" ? created.scope.departmentId : null;
          yield* sql`
            INSERT INTO public.economy_receipt_approval_grants (
              approval_grant_id,
              person_id,
              scope,
              department_id,
              start_at,
              end_at,
              revision
            ) VALUES (
              ${created.approvalGrantId},
              ${created.personId},
              ${created.scope._tag},
              ${departmentId},
              ${created.startAt},
              ${created.endAt},
              0
            )
          `;
          return created;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("create Receipt approval grant", cause)),
        ),
      );
  });

export const endReceiptApprovalGrant = (
  input: unknown,
): Effect.Effect<ReceiptApprovalGrant, ReceiptAuthorityWriteFailure, Database> =>
  Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(EndReceiptApprovalGrantInputSchema)(input, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => decodeError("decode Receipt approval grant ending", cause)));
    const sql = yield* Database;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* lockReceiptApprovalGrantForWrite(
            sql,
            command.approvalGrantId,
            command.expectedRevision,
          );
          const ended = yield* Schema.decodeUnknownEffect(ReceiptApprovalGrantSchema)(
            {
              ...current,
              endAt: command.endAt,
              revision: current.revision + 1,
            },
            { onExcessProperty: "error" },
          ).pipe(
            Effect.mapError((cause) => decodeError("decode ended Receipt approval grant", cause)),
          );
          const updated = yield* sql<{ readonly approvalGrantId: string }>`
            UPDATE public.economy_receipt_approval_grants
            SET end_at = ${ended.endAt}, revision = revision + 1
            WHERE approval_grant_id = ${command.approvalGrantId}
              AND revision = ${command.expectedRevision}
            RETURNING approval_grant_id AS "approvalGrantId"
          `;
          if (updated.length !== 1) {
            return yield* new ReceiptAuthorityWriteConflict({
              entity: "ApprovalGrant",
              id: command.approvalGrantId,
              expectedRevision: command.expectedRevision,
            });
          }
          return ended;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("end Receipt approval grant", cause)),
        ),
      );
  });

export const removeReceiptApprovalGrant = (
  input: unknown,
): Effect.Effect<ReceiptApprovalGrant, ReceiptAuthorityWriteFailure, Database> =>
  Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(RemoveReceiptApprovalGrantInputSchema)(
      input,
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError((cause) => decodeError("decode Receipt approval grant removal", cause)));
    const sql = yield* Database;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* lockReceiptApprovalGrantForWrite(
            sql,
            command.approvalGrantId,
            command.expectedRevision,
          );
          const removed = yield* sql<{ readonly approvalGrantId: string }>`
            DELETE FROM public.economy_receipt_approval_grants
            WHERE approval_grant_id = ${command.approvalGrantId}
              AND revision = ${command.expectedRevision}
            RETURNING approval_grant_id AS "approvalGrantId"
          `;
          if (removed.length !== 1) {
            return yield* new ReceiptAuthorityWriteConflict({
              entity: "ApprovalGrant",
              id: command.approvalGrantId,
              expectedRevision: command.expectedRevision,
            });
          }
          return current;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("remove Receipt approval grant", cause)),
        ),
      );
  });

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
