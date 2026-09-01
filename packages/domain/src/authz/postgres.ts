import { Data, Effect, Schema } from "effect";
import { Database, type DatabaseShape } from "../database/service.js";
import { DepartmentId, PersonId } from "../organization/schema.js";
import { Rfc3339InstantSchema } from "../time.js";
import { DomainId, type CanonicalResourceContext } from "./access.js";
import { applicableAuthzRules } from "./rules.js";
import {
  AuthzCapabilityIdSchema,
  AuthzLockModeSchema,
  AuthzRevisionSchema,
  AuthzRuleEffectKindSchema,
  AuthzRuleId,
  AuthzTagAssignmentId,
  AuthzTagAssignmentSchema,
  AuthzTagId,
  AuthzTagSchema,
  AuthzValidationError,
  EndAuthzRuleInputSchema,
  EndAuthzTagAssignmentInputSchema,
  RemoveAuthzRuleInputSchema,
  RemoveAuthzTagAssignmentInputSchema,
  RemoveAuthzTagInputSchema,
  decodeAuthzRule,
  decodeAuthzTag,
  decodeAuthzTagAssignment,
  type AuthzCapabilityId,
  type AuthzLockMode,
  type AuthzRule,
  type AuthzRuleId as AuthzRuleIdType,
  type AuthzTag,
  type AuthzTagAssignment,
  type AuthzTagAssignmentId as AuthzTagAssignmentIdType,
  type AuthzTagId as AuthzTagIdType,
  type EndAuthzRuleInput,
  type EndAuthzTagAssignmentInput,
  type RemoveAuthzRuleInput,
  type RemoveAuthzTagAssignmentInput,
  type RemoveAuthzTagInput,
} from "./schema.js";

export class AuthzPersistenceError extends Data.TaggedError("AuthzPersistenceError")<{
  readonly operation: string;
  readonly message: string;
}> {}

export class AuthzRecordNotFound extends Data.TaggedError("AuthzRecordNotFound")<{
  readonly entity: "Rule" | "Tag" | "TagAssignment";
  readonly id: string;
}> {}

export class AuthzWriteConflict extends Data.TaggedError("AuthzWriteConflict")<{
  readonly entity: "Rule" | "Tag" | "TagAssignment";
  readonly id: string;
  readonly expectedRevision: number;
}> {}

export type AuthzPersistenceFailure =
  | AuthzValidationError
  | AuthzPersistenceError
  | AuthzRecordNotFound
  | AuthzWriteConflict;

/**
 * Command integrations acquire the shared advisory key before these ordered
 * row projections. Every writer in this module acquires the exclusive key.
 */
export const AUTHZ_LOCK_PROTOCOL = {
  advisoryKey: "vektorprogrammet:authz-rules:v1",
  rowOrder: ["public.authz_tag_assignments", "public.authz_rules"],
} as const;

const persistenceError = (operation: string, cause: unknown) =>
  new AuthzPersistenceError({ operation, message: String(cause) });

const validationError = (entity: AuthzValidationError["entity"], cause: unknown) =>
  new AuthzValidationError({ entity, message: String(cause) });

const acquireAuthorizationLock = (
  sql: DatabaseShape,
  mode: "Shared" | "Exclusive",
): Effect.Effect<void, AuthzPersistenceError> =>
  (mode === "Shared"
    ? sql`
        SELECT pg_catalog.pg_advisory_xact_lock_shared(
          pg_catalog.hashtextextended(${AUTHZ_LOCK_PROTOCOL.advisoryKey}, 0)
        )
      `
    : sql`
        SELECT pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(${AUTHZ_LOCK_PROTOCOL.advisoryKey}, 0)
        )
      `
  ).pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError(`acquire ${mode} authorization lock`, cause)),
    ),
  );

const AuthzRuleDatabaseRowSchema = Schema.Struct({
  ruleId: AuthzRuleId,
  capabilityId: AuthzCapabilityIdSchema,
  effectKind: AuthzRuleEffectKindSchema,
  subjectKind: Schema.Literals(["Person", "Tag"]),
  subjectPersonId: Schema.NullOr(PersonId),
  subjectTagId: Schema.NullOr(AuthzTagId),
  scope: Schema.Literals(["Global", "Domain", "Department"]),
  domainId: Schema.NullOr(DomainId),
  departmentId: Schema.NullOr(DepartmentId),
  params: Schema.Unknown,
  startAt: Rfc3339InstantSchema,
  endAt: Schema.NullOr(Rfc3339InstantSchema),
  revision: AuthzRevisionSchema,
});
type AuthzRuleDatabaseRow = typeof AuthzRuleDatabaseRowSchema.Type;

const decodeRuleDatabaseRow = (
  row: AuthzRuleDatabaseRow,
): Effect.Effect<AuthzRule, AuthzValidationError> => {
  const subject = (() => {
    if (row.subjectKind === "Person" && row.subjectPersonId !== null && row.subjectTagId === null) {
      return { _tag: "Person" as const, personId: row.subjectPersonId };
    }
    if (row.subjectKind === "Tag" && row.subjectPersonId === null && row.subjectTagId !== null) {
      return { _tag: "Tag" as const, tagId: row.subjectTagId };
    }
    return undefined;
  })();
  const scope = (() => {
    if (row.scope === "Global" && row.domainId === null && row.departmentId === null) {
      return { _tag: "Global" as const };
    }
    if (row.scope === "Domain" && row.domainId !== null && row.departmentId === null) {
      return { _tag: "Domain" as const, domainId: row.domainId };
    }
    if (row.scope === "Department" && row.domainId === null && row.departmentId !== null) {
      return { _tag: "Department" as const, departmentId: row.departmentId };
    }
    return undefined;
  })();
  if (subject === undefined || scope === undefined) {
    return Effect.fail(
      validationError("AuthzRule", "persisted subject or scope columns are inconsistent"),
    );
  }
  return decodeAuthzRule({
    ruleId: row.ruleId,
    capabilityId: row.capabilityId,
    effectKind: row.effectKind,
    subject,
    scope,
    params: row.params,
    startAt: row.startAt,
    endAt: row.endAt,
    revision: row.revision,
  });
};

const selectAuthzRule = (
  sql: DatabaseShape,
  ruleId: AuthzRuleIdType,
): Effect.Effect<AuthzRule, AuthzValidationError | AuthzPersistenceError | AuthzRecordNotFound> =>
  Effect.gen(function* () {
    const selected = yield* sql<AuthzRuleDatabaseRow>`
      SELECT
        rule_id AS "ruleId",
        capability_id AS "capabilityId",
        effect_kind AS "effectKind",
        subject_kind AS "subjectKind",
        subject_person_id AS "subjectPersonId",
        subject_tag_id AS "subjectTagId",
        scope,
        domain_id AS "domainId",
        department_id AS "departmentId",
        params,
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
      FROM public.authz_rules
      WHERE rule_id = ${ruleId}
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read authorization rule", cause)),
      ),
    );
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(AuthzRuleDatabaseRowSchema))(
      selected,
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError((cause) => validationError("AuthzRule", cause)));
    const row = rows[0];
    if (row === undefined) return yield* new AuthzRecordNotFound({ entity: "Rule", id: ruleId });
    return yield* decodeRuleDatabaseRow(row);
  });

const selectAuthzTag = (
  sql: DatabaseShape,
  tagId: AuthzTagIdType,
): Effect.Effect<AuthzTag, AuthzValidationError | AuthzPersistenceError | AuthzRecordNotFound> =>
  Effect.gen(function* () {
    const selected = yield* sql<AuthzTag>`
      SELECT tag_id AS "tagId", name, revision
      FROM public.authz_tags
      WHERE tag_id = ${tagId}
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read authorization tag", cause)),
      ),
    );
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(AuthzTagSchema))(selected, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => validationError("AuthzTag", cause)));
    const row = rows[0];
    if (row === undefined) return yield* new AuthzRecordNotFound({ entity: "Tag", id: tagId });
    return row;
  });

const selectAuthzTagAssignment = (
  sql: DatabaseShape,
  assignmentId: AuthzTagAssignmentIdType,
): Effect.Effect<
  AuthzTagAssignment,
  AuthzValidationError | AuthzPersistenceError | AuthzRecordNotFound
> =>
  Effect.gen(function* () {
    const selected = yield* sql<AuthzTagAssignment>`
      SELECT
        assignment_id AS "assignmentId",
        tag_id AS "tagId",
        person_id AS "personId",
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
      FROM public.authz_tag_assignments
      WHERE assignment_id = ${assignmentId}
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read authorization tag assignment", cause)),
      ),
    );
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(AuthzTagAssignmentSchema))(
      selected,
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError((cause) => validationError("AuthzTagAssignment", cause)));
    const row = rows[0];
    if (row === undefined) {
      return yield* new AuthzRecordNotFound({ entity: "TagAssignment", id: assignmentId });
    }
    return row;
  });

export type ApplicableAuthorizationRules = {
  readonly rules: ReadonlyArray<AuthzRule>;
  readonly tagAssignments: ReadonlyArray<AuthzTagAssignment>;
};

/**
 * Caller-transaction projection for protected commands. Passing `ForShare`
 * is command-safe only when `sql` belongs to the caller's state-transition
 * transaction, so its advisory and ordered row locks live through commit or
 * rollback.
 */
export const readApplicableAuthorizationRules = (
  sql: DatabaseShape,
  personIdInput: PersonId,
  capabilityIdInput: AuthzCapabilityId,
  authorizationInstantInput: string,
  context: CanonicalResourceContext,
  lockModeInput: AuthzLockMode,
): Effect.Effect<ApplicableAuthorizationRules, AuthzValidationError | AuthzPersistenceError> =>
  Effect.gen(function* () {
    const personId = yield* Schema.decodeUnknownEffect(PersonId)(personIdInput, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => validationError("PersonId", cause)));
    const capabilityId = yield* Schema.decodeUnknownEffect(AuthzCapabilityIdSchema)(
      capabilityIdInput,
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError((cause) => validationError("AuthzCapabilityId", cause)));
    const authorizationInstant = yield* Schema.decodeUnknownEffect(Rfc3339InstantSchema)(
      authorizationInstantInput,
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError((cause) => validationError("AuthorizationInstant", cause)));
    const lockMode = yield* Schema.decodeUnknownEffect(AuthzLockModeSchema)(lockModeInput, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => validationError("AuthzLockMode", cause)));

    if (lockMode === "ForShare") yield* acquireAuthorizationLock(sql, "Shared");
    const assignmentLock = lockMode === "ForShare" ? sql`FOR SHARE` : sql``;
    const selectedAssignments = yield* sql<AuthzTagAssignment>`
      SELECT
        assignment_id AS "assignmentId",
        tag_id AS "tagId",
        person_id AS "personId",
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
      FROM public.authz_tag_assignments
      WHERE person_id = ${personId}
        AND start_at <= ${authorizationInstant}::timestamptz
        AND (end_at IS NULL OR ${authorizationInstant}::timestamptz < end_at)
      ORDER BY tag_id ASC, assignment_id ASC
      ${assignmentLock}
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read applicable authorization tag assignments", cause)),
      ),
    );
    const tagAssignments = yield* Schema.decodeUnknownEffect(
      Schema.Array(AuthzTagAssignmentSchema),
    )(selectedAssignments, { onExcessProperty: "error" }).pipe(
      Effect.mapError((cause) => validationError("AuthzTagAssignment", cause)),
    );

    const ruleLock = lockMode === "ForShare" ? sql`FOR SHARE OF rule` : sql``;
    const requestedDepartmentId = context.departmentId;
    const selectedRules = yield* sql<AuthzRuleDatabaseRow>`
      SELECT
        rule.rule_id AS "ruleId",
        rule.capability_id AS "capabilityId",
        rule.effect_kind AS "effectKind",
        rule.subject_kind AS "subjectKind",
        rule.subject_person_id AS "subjectPersonId",
        rule.subject_tag_id AS "subjectTagId",
        rule.scope,
        rule.domain_id AS "domainId",
        rule.department_id AS "departmentId",
        rule.params,
        to_char(
          rule.start_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS "startAt",
        CASE
          WHEN rule.end_at IS NULL THEN NULL
          ELSE to_char(
            rule.end_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )
        END AS "endAt",
        rule.revision
      FROM public.authz_rules AS rule
      WHERE rule.capability_id = ${capabilityId}
        AND rule.start_at <= ${authorizationInstant}::timestamptz
        AND (rule.end_at IS NULL OR ${authorizationInstant}::timestamptz < rule.end_at)
        AND (
          rule.scope = 'Global'
          OR (
            rule.scope = 'Domain'
            AND rule.domain_id = ${context.domainId}
          )
          OR (
            rule.scope = 'Department'
            AND rule.department_id = ${requestedDepartmentId}
          )
        )
        AND (
          (rule.subject_kind = 'Person' AND rule.subject_person_id = ${personId})
          OR (
            rule.subject_kind = 'Tag'
            AND EXISTS (
              SELECT 1
              FROM public.authz_tag_assignments AS assignment
              WHERE assignment.tag_id = rule.subject_tag_id
                AND assignment.person_id = ${personId}
                AND assignment.start_at <= ${authorizationInstant}::timestamptz
                AND (
                  assignment.end_at IS NULL
                  OR ${authorizationInstant}::timestamptz < assignment.end_at
                )
            )
          )
        )
      ORDER BY rule.rule_id ASC
      ${ruleLock}
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read applicable authorization rules", cause)),
      ),
    );
    const ruleRows = yield* Schema.decodeUnknownEffect(Schema.Array(AuthzRuleDatabaseRowSchema))(
      selectedRules,
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError((cause) => validationError("AuthzRule", cause)));
    const decodedRules: Array<AuthzRule> = [];
    for (const row of ruleRows) decodedRules.push(yield* decodeRuleDatabaseRow(row));
    const rules = applicableAuthzRules(decodedRules, {
      personId,
      authorizationInstant,
      context,
      tagAssignments,
    });
    const referencedTagIds = new Set(
      rules.flatMap((rule) => (rule.subject._tag === "Tag" ? [rule.subject.tagId] : [])),
    );
    return {
      rules,
      tagAssignments: tagAssignments.filter((assignment) => referencedTagIds.has(assignment.tagId)),
    };
  });

/**
 * Lock-free ambient snapshot for query paths. This loader always uses `None`;
 * command paths must call `readApplicableAuthorizationRules` with their own
 * transaction-bound SQL and the explicit `ForShare` mode.
 */
export const loadApplicableAuthorizationRules = (
  personId: PersonId,
  capabilityId: AuthzCapabilityId,
  authorizationInstant: string,
  context: CanonicalResourceContext,
): Effect.Effect<
  ApplicableAuthorizationRules,
  AuthzValidationError | AuthzPersistenceError,
  Database
> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    return yield* readApplicableAuthorizationRules(
      sql,
      personId,
      capabilityId,
      authorizationInstant,
      context,
      "None",
    );
  });

export const createAuthzRule = (
  input: AuthzRule,
): Effect.Effect<AuthzRule, AuthzPersistenceFailure, Database> =>
  Effect.gen(function* () {
    const rule = yield* decodeAuthzRule(input);
    const sql = yield* Database;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* acquireAuthorizationLock(sql, "Exclusive");
          const subjectPersonId = rule.subject._tag === "Person" ? rule.subject.personId : null;
          const subjectTagId = rule.subject._tag === "Tag" ? rule.subject.tagId : null;
          const domainId = rule.scope._tag === "Domain" ? rule.scope.domainId : null;
          const departmentId = rule.scope._tag === "Department" ? rule.scope.departmentId : null;
          yield* sql`
            INSERT INTO public.authz_rules (
              rule_id,
              capability_id,
              effect_kind,
              subject_kind,
              subject_person_id,
              subject_tag_id,
              scope,
              domain_id,
              department_id,
              params,
              start_at,
              end_at,
              revision
            ) VALUES (
              ${rule.ruleId},
              ${rule.capabilityId},
              ${rule.effectKind},
              ${rule.subject._tag},
              ${subjectPersonId},
              ${subjectTagId},
              ${rule.scope._tag},
              ${domainId},
              ${departmentId},
              ${sql.json(rule.params)},
              ${rule.startAt},
              ${rule.endAt},
              ${rule.revision}
            )
          `;
          return yield* selectAuthzRule(sql, rule.ruleId);
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("create authorization rule", cause)),
        ),
      );
  });

export const readAuthzRule = (
  ruleIdInput: AuthzRuleIdType,
): Effect.Effect<
  AuthzRule,
  AuthzValidationError | AuthzPersistenceError | AuthzRecordNotFound,
  Database
> =>
  Effect.gen(function* () {
    const ruleId = yield* Schema.decodeUnknownEffect(AuthzRuleId)(ruleIdInput, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => validationError("AuthzRuleId", cause)));
    const sql = yield* Database;
    return yield* selectAuthzRule(sql, ruleId);
  });

export const endAuthzRule = (
  input: EndAuthzRuleInput,
): Effect.Effect<AuthzRule, AuthzPersistenceFailure, Database> =>
  Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(EndAuthzRuleInputSchema)(input, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => validationError("EndAuthzRuleInput", cause)));
    const sql = yield* Database;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* acquireAuthorizationLock(sql, "Exclusive");
          const updated = yield* sql<{ readonly ruleId: AuthzRuleIdType }>`
            UPDATE public.authz_rules
            SET end_at = ${command.endAt}, revision = revision + 1
            WHERE rule_id = ${command.ruleId}
              AND revision = ${command.expectedRevision}
              AND ${command.endAt}::timestamptz > start_at
              AND (end_at IS NULL OR ${command.endAt}::timestamptz < end_at)
            RETURNING rule_id AS "ruleId"
          `;
          if (updated.length !== 1) {
            return yield* new AuthzWriteConflict({
              entity: "Rule",
              id: command.ruleId,
              expectedRevision: command.expectedRevision,
            });
          }
          return yield* selectAuthzRule(sql, command.ruleId);
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("end authorization rule", cause)),
        ),
      );
  });

export const removeAuthzRule = (
  input: RemoveAuthzRuleInput,
): Effect.Effect<void, AuthzPersistenceFailure, Database> =>
  Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(RemoveAuthzRuleInputSchema)(input, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => validationError("RemoveAuthzRuleInput", cause)));
    const sql = yield* Database;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* acquireAuthorizationLock(sql, "Exclusive");
          const removed = yield* sql<{ readonly ruleId: AuthzRuleIdType }>`
            DELETE FROM public.authz_rules
            WHERE rule_id = ${command.ruleId}
              AND revision = ${command.expectedRevision}
            RETURNING rule_id AS "ruleId"
          `;
          if (removed.length !== 1) {
            return yield* new AuthzWriteConflict({
              entity: "Rule",
              id: command.ruleId,
              expectedRevision: command.expectedRevision,
            });
          }
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("remove authorization rule", cause)),
        ),
      );
  });

export const createAuthzTag = (
  input: AuthzTag,
): Effect.Effect<AuthzTag, AuthzPersistenceFailure, Database> =>
  Effect.gen(function* () {
    const tag = yield* decodeAuthzTag(input);
    const sql = yield* Database;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* acquireAuthorizationLock(sql, "Exclusive");
          yield* sql`
            INSERT INTO public.authz_tags (tag_id, name, revision)
            VALUES (${tag.tagId}, ${tag.name}, ${tag.revision})
          `;
          return yield* selectAuthzTag(sql, tag.tagId);
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("create authorization tag", cause)),
        ),
      );
  });

export const readAuthzTag = (
  tagIdInput: AuthzTagIdType,
): Effect.Effect<
  AuthzTag,
  AuthzValidationError | AuthzPersistenceError | AuthzRecordNotFound,
  Database
> =>
  Effect.gen(function* () {
    const tagId = yield* Schema.decodeUnknownEffect(AuthzTagId)(tagIdInput, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => validationError("AuthzTagId", cause)));
    const sql = yield* Database;
    return yield* selectAuthzTag(sql, tagId);
  });

export const removeAuthzTag = (
  input: RemoveAuthzTagInput,
): Effect.Effect<void, AuthzPersistenceFailure, Database> =>
  Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(RemoveAuthzTagInputSchema)(input, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => validationError("RemoveAuthzTagInput", cause)));
    const sql = yield* Database;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* acquireAuthorizationLock(sql, "Exclusive");
          const removed = yield* sql<{ readonly tagId: AuthzTagIdType }>`
            DELETE FROM public.authz_tags
            WHERE tag_id = ${command.tagId}
              AND revision = ${command.expectedRevision}
            RETURNING tag_id AS "tagId"
          `;
          if (removed.length !== 1) {
            return yield* new AuthzWriteConflict({
              entity: "Tag",
              id: command.tagId,
              expectedRevision: command.expectedRevision,
            });
          }
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("remove authorization tag", cause)),
        ),
      );
  });

export const createAuthzTagAssignment = (
  input: AuthzTagAssignment,
): Effect.Effect<AuthzTagAssignment, AuthzPersistenceFailure, Database> =>
  Effect.gen(function* () {
    const assignment = yield* decodeAuthzTagAssignment(input);
    const sql = yield* Database;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* acquireAuthorizationLock(sql, "Exclusive");
          yield* sql`
            INSERT INTO public.authz_tag_assignments (
              assignment_id,
              tag_id,
              person_id,
              start_at,
              end_at,
              revision
            ) VALUES (
              ${assignment.assignmentId},
              ${assignment.tagId},
              ${assignment.personId},
              ${assignment.startAt},
              ${assignment.endAt},
              ${assignment.revision}
            )
          `;
          return yield* selectAuthzTagAssignment(sql, assignment.assignmentId);
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("create authorization tag assignment", cause)),
        ),
      );
  });

export const readAuthzTagAssignment = (
  assignmentIdInput: AuthzTagAssignmentIdType,
): Effect.Effect<
  AuthzTagAssignment,
  AuthzValidationError | AuthzPersistenceError | AuthzRecordNotFound,
  Database
> =>
  Effect.gen(function* () {
    const assignmentId = yield* Schema.decodeUnknownEffect(AuthzTagAssignmentId)(
      assignmentIdInput,
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError((cause) => validationError("AuthzTagAssignmentId", cause)));
    const sql = yield* Database;
    return yield* selectAuthzTagAssignment(sql, assignmentId);
  });

export const endAuthzTagAssignment = (
  input: EndAuthzTagAssignmentInput,
): Effect.Effect<AuthzTagAssignment, AuthzPersistenceFailure, Database> =>
  Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(EndAuthzTagAssignmentInputSchema)(input, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => validationError("EndAuthzTagAssignmentInput", cause)));
    const sql = yield* Database;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* acquireAuthorizationLock(sql, "Exclusive");
          const updated = yield* sql<{
            readonly assignmentId: AuthzTagAssignmentIdType;
          }>`
            UPDATE public.authz_tag_assignments
            SET end_at = ${command.endAt}, revision = revision + 1
            WHERE assignment_id = ${command.assignmentId}
              AND revision = ${command.expectedRevision}
              AND ${command.endAt}::timestamptz > start_at
              AND (end_at IS NULL OR ${command.endAt}::timestamptz < end_at)
            RETURNING assignment_id AS "assignmentId"
          `;
          if (updated.length !== 1) {
            return yield* new AuthzWriteConflict({
              entity: "TagAssignment",
              id: command.assignmentId,
              expectedRevision: command.expectedRevision,
            });
          }
          return yield* selectAuthzTagAssignment(sql, command.assignmentId);
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("end authorization tag assignment", cause)),
        ),
      );
  });

export const removeAuthzTagAssignment = (
  input: RemoveAuthzTagAssignmentInput,
): Effect.Effect<void, AuthzPersistenceFailure, Database> =>
  Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(RemoveAuthzTagAssignmentInputSchema)(input, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => validationError("RemoveAuthzTagAssignmentInput", cause)));
    const sql = yield* Database;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* acquireAuthorizationLock(sql, "Exclusive");
          const removed = yield* sql<{
            readonly assignmentId: AuthzTagAssignmentIdType;
          }>`
            DELETE FROM public.authz_tag_assignments
            WHERE assignment_id = ${command.assignmentId}
              AND revision = ${command.expectedRevision}
            RETURNING assignment_id AS "assignmentId"
          `;
          if (removed.length !== 1) {
            return yield* new AuthzWriteConflict({
              entity: "TagAssignment",
              id: command.assignmentId,
              expectedRevision: command.expectedRevision,
            });
          }
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("remove authorization tag assignment", cause)),
        ),
      );
  });
