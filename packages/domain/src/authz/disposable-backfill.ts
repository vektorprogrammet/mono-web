/**
 * Disposable-only authoring and persistence for spec 0056 authorization data.
 * The strict `disposable: true` boundary is intentional; this is not a
 * production import API.
 */
import { Data, Effect, Schema } from "effect";
import { Database, type DatabaseShape } from "../database/service.js";
import { DepartmentId, PersonId } from "../organization/schema.js";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "../tutor/evidence.js";
import { normalizeRfc3339Instant, Rfc3339InstantSchema } from "../time.js";
import {
  AUTHZ_LOCK_PROTOCOL,
  createAuthzRule,
  createAuthzTag,
  createAuthzTagAssignment,
  readAuthzRule,
  readAuthzTag,
  readAuthzTagAssignment,
  type AuthzPersistenceFailure,
} from "./postgres.js";
import {
  AuthzRuleId,
  AuthzRuleScopeSchema,
  AuthzTagAssignmentId,
  AuthzTagId,
  AuthzTagNameSchema,
  decodeAuthzRule,
  decodeAuthzTag,
  decodeAuthzTagAssignment,
  type AuthzRule,
  type AuthzRuleSubject,
  type AuthzTag,
  type AuthzTagAssignment,
} from "./schema.js";

export const DisposableAuthzTagAuthoringSchema = Schema.Struct({
  name: AuthzTagNameSchema,
});
export type DisposableAuthzTagAuthoring = typeof DisposableAuthzTagAuthoringSchema.Type;

export const DisposableAuthzTagAssignmentAuthoringSchema = Schema.Struct({
  tagName: AuthzTagNameSchema,
  personId: PersonId,
  startAt: Rfc3339InstantSchema,
  endAt: Schema.NullOr(Rfc3339InstantSchema),
});
export type DisposableAuthzTagAssignmentAuthoring =
  typeof DisposableAuthzTagAssignmentAuthoringSchema.Type;

export const DisposableAuthzRuleSubjectAuthoringSchema = Schema.TaggedUnion({
  Person: { personId: PersonId },
  Tag: { tagName: AuthzTagNameSchema },
});
export type DisposableAuthzRuleSubjectAuthoring =
  typeof DisposableAuthzRuleSubjectAuthoringSchema.Type;

export const DisposableAuthzRuleAuthoringSchema = Schema.Struct({
  capabilityId: Schema.String,
  effectKind: Schema.String,
  scope: AuthzRuleScopeSchema,
  params: Schema.Unknown,
  startAt: Rfc3339InstantSchema,
  endAt: Schema.NullOr(Rfc3339InstantSchema),
});
export type DisposableAuthzRuleAuthoring = typeof DisposableAuthzRuleAuthoringSchema.Type;

const NonEmptyDisposableAuthzRulesSchema = Schema.Array(DisposableAuthzRuleAuthoringSchema).pipe(
  Schema.check(
    Schema.makeFilter((rules) => rules.length > 0, {
      message: "at least one authorization rule per subject",
    }),
  ),
);

export const DisposableAuthzRulesBySubjectAuthoringSchema = Schema.Struct({
  subject: DisposableAuthzRuleSubjectAuthoringSchema,
  rules: NonEmptyDisposableAuthzRulesSchema,
});
export type DisposableAuthzRulesBySubjectAuthoring =
  typeof DisposableAuthzRulesBySubjectAuthoringSchema.Type;

export const DisposableAuthzBackfillInputSchema = Schema.Struct({
  disposable: Schema.Literals([true]),
  tags: Schema.Array(DisposableAuthzTagAuthoringSchema),
  assignments: Schema.Array(DisposableAuthzTagAssignmentAuthoringSchema),
  rulesBySubject: Schema.Array(DisposableAuthzRulesBySubjectAuthoringSchema),
});
export type DisposableAuthzBackfillInput = typeof DisposableAuthzBackfillInputSchema.Type;

export class DisposableAuthzBackfillDecodeError extends Data.TaggedError(
  "DisposableAuthzBackfillDecodeError",
)<{
  readonly message: string;
}> {}

export class DisposableAuthzBackfillDuplicate extends Data.TaggedError(
  "DisposableAuthzBackfillDuplicate",
)<{
  readonly entity: "Tag" | "RuleSubject" | "TagAssignment" | "Rule";
  readonly identity: string;
}> {}

export class DisposableAuthzBackfillMissingReference extends Data.TaggedError(
  "DisposableAuthzBackfillMissingReference",
)<{
  readonly referenceKind: "Person" | "Tag" | "Department";
  readonly referenceId: string;
}> {}

export class DisposableAuthzBackfillConflict extends Data.TaggedError(
  "DisposableAuthzBackfillConflict",
)<{
  readonly entity: "Tag" | "TagAssignment" | "Rule";
  readonly id: string;
}> {}

export class DisposableAuthzBackfillPersistenceError extends Data.TaggedError(
  "DisposableAuthzBackfillPersistenceError",
)<{
  readonly operation: string;
  readonly message: string;
}> {}

export type DisposableAuthzBackfillAuthoringFailure =
  | DisposableAuthzBackfillDecodeError
  | DisposableAuthzBackfillDuplicate
  | DisposableAuthzBackfillMissingReference;

export type DisposableAuthzBackfillFailure =
  | DisposableAuthzBackfillAuthoringFailure
  | DisposableAuthzBackfillConflict
  | DisposableAuthzBackfillPersistenceError
  | AuthzPersistenceFailure;

export interface DisposableAuthzRuleGroup {
  readonly subject: AuthzRuleSubject;
  readonly rules: ReadonlyArray<AuthzRule>;
}

export interface DisposableAuthzBackfillPlan {
  readonly disposable: true;
  readonly tags: ReadonlyArray<AuthzTag>;
  readonly assignments: ReadonlyArray<AuthzTagAssignment>;
  readonly rulesBySubject: ReadonlyArray<DisposableAuthzRuleGroup>;
}

interface ReferenceRow {
  readonly id: string;
}

const compareText = (left: string, right: string): -1 | 0 | 1 =>
  left < right ? -1 : left > right ? 1 : 0;

const decodeError = (cause: unknown) =>
  new DisposableAuthzBackfillDecodeError({ message: String(cause) });

const stableAuthzId = (
  prefix: "authz_tag" | "authz_tag_assignment" | "authz_rule",
  value: unknown,
) => `${prefix}_${sha256Hex(canonicalJsonBytes({ specification: "0056", authorization: value }))}`;

const normalizedEndAt = (endAt: string | null): string | null =>
  endAt === null ? null : normalizeRfc3339Instant(endAt);

const authoredSubjectKey = (subject: DisposableAuthzRuleSubjectAuthoring): string =>
  subject._tag === "Person" ? `Person:${subject.personId}` : `Tag:${subject.tagName}`;

const canonicalSubjectKey = (subject: AuthzRuleSubject): string => {
  switch (subject._tag) {
    case "Person":
      return `Person:${subject.personId}`;
    case "Tag":
      return `Tag:${subject.tagId}`;
    case "ServicePrincipal":
      return `ServicePrincipal:${subject.servicePrincipalId}`;
  }
};

const duplicate = (entity: DisposableAuthzBackfillDuplicate["entity"], identity: string) =>
  new DisposableAuthzBackfillDuplicate({ entity, identity });

const missingReference = (
  referenceKind: DisposableAuthzBackfillMissingReference["referenceKind"],
  referenceId: string,
) => new DisposableAuthzBackfillMissingReference({ referenceKind, referenceId });

/**
 * Strictly decodes disposable authoring data and derives canonical rows. This
 * program is dependency-free and deterministic; it performs no persistence.
 */
export const authorDisposableAuthzBackfill = (
  input: unknown,
): Effect.Effect<DisposableAuthzBackfillPlan, DisposableAuthzBackfillAuthoringFailure> =>
  Effect.gen(function* () {
    const authored = yield* Schema.decodeUnknownEffect(DisposableAuthzBackfillInputSchema)(input, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(decodeError));

    const tagsByName = new Map<string, AuthzTag>();
    for (const tagInput of [...authored.tags].sort((left, right) =>
      compareText(left.name, right.name),
    )) {
      if (tagsByName.has(tagInput.name)) return yield* duplicate("Tag", tagInput.name);
      const tag = yield* decodeAuthzTag({
        tagId: AuthzTagId.make(stableAuthzId("authz_tag", { name: tagInput.name })),
        name: tagInput.name,
        revision: 0,
      }).pipe(Effect.mapError(decodeError));
      tagsByName.set(tag.name, tag);
    }

    const assignmentIds = new Set<string>();
    const assignments: AuthzTagAssignment[] = [];
    for (const assignmentInput of [...authored.assignments].sort((left, right) =>
      compareText(canonicalJson(left), canonicalJson(right)),
    )) {
      const tag = tagsByName.get(assignmentInput.tagName);
      if (tag === undefined) {
        return yield* missingReference("Tag", assignmentInput.tagName);
      }
      const semanticAssignment = {
        tagId: tag.tagId,
        personId: assignmentInput.personId,
        startAt: normalizeRfc3339Instant(assignmentInput.startAt),
        endAt: normalizedEndAt(assignmentInput.endAt),
      } as const;
      const assignmentId = AuthzTagAssignmentId.make(
        stableAuthzId("authz_tag_assignment", semanticAssignment),
      );
      if (assignmentIds.has(assignmentId)) {
        return yield* duplicate("TagAssignment", assignmentId);
      }
      const assignment = yield* decodeAuthzTagAssignment({
        assignmentId,
        ...semanticAssignment,
        revision: 0,
      }).pipe(Effect.mapError(decodeError));
      assignmentIds.add(assignment.assignmentId);
      assignments.push(assignment);
    }

    const authoredSubjectKeys = new Set<string>();
    const ruleIds = new Set<string>();
    const rulesBySubject: DisposableAuthzRuleGroup[] = [];
    for (const authoredGroup of [...authored.rulesBySubject].sort((left, right) =>
      compareText(authoredSubjectKey(left.subject), authoredSubjectKey(right.subject)),
    )) {
      const inputSubjectKey = authoredSubjectKey(authoredGroup.subject);
      if (authoredSubjectKeys.has(inputSubjectKey)) {
        return yield* duplicate("RuleSubject", inputSubjectKey);
      }
      authoredSubjectKeys.add(inputSubjectKey);

      let subject: AuthzRuleSubject;
      if (authoredGroup.subject._tag === "Person") {
        subject = { _tag: "Person", personId: authoredGroup.subject.personId };
      } else {
        const tag = tagsByName.get(authoredGroup.subject.tagName);
        if (tag === undefined) {
          return yield* missingReference("Tag", authoredGroup.subject.tagName);
        }
        subject = { _tag: "Tag", tagId: tag.tagId };
      }

      const rules: AuthzRule[] = [];
      for (const ruleInput of authoredGroup.rules) {
        const provisionalRule = yield* decodeAuthzRule({
          ruleId: AuthzRuleId.make("disposable-authz-rule-authoring"),
          capabilityId: ruleInput.capabilityId,
          effectKind: ruleInput.effectKind,
          subject,
          scope: ruleInput.scope,
          params: ruleInput.params,
          startAt: normalizeRfc3339Instant(ruleInput.startAt),
          endAt: normalizedEndAt(ruleInput.endAt),
          revision: 0,
        }).pipe(Effect.mapError(decodeError));
        const semanticRule = {
          capabilityId: provisionalRule.capabilityId,
          effectKind: provisionalRule.effectKind,
          subject: provisionalRule.subject,
          scope: provisionalRule.scope,
          params: provisionalRule.params,
          startAt: provisionalRule.startAt,
          endAt: provisionalRule.endAt,
        } as const;
        const ruleId = AuthzRuleId.make(stableAuthzId("authz_rule", semanticRule));
        if (ruleIds.has(ruleId)) return yield* duplicate("Rule", ruleId);
        ruleIds.add(ruleId);
        rules.push({ ...provisionalRule, ruleId });
      }
      rules.sort((left, right) => compareText(left.ruleId, right.ruleId));
      rulesBySubject.push({ subject, rules });
    }

    return {
      disposable: true,
      tags: [...tagsByName.values()].sort((left, right) => compareText(left.tagId, right.tagId)),
      assignments: assignments.sort((left, right) =>
        compareText(left.assignmentId, right.assignmentId),
      ),
      rulesBySubject: rulesBySubject.sort((left, right) =>
        compareText(canonicalSubjectKey(left.subject), canonicalSubjectKey(right.subject)),
      ),
    };
  });

const lockPersonReference = (sql: DatabaseShape, personId: PersonId) =>
  sql<ReferenceRow>`
    SELECT person_id AS id
    FROM public.person_profiles
    WHERE person_id = ${personId}
    FOR SHARE
  `.pipe(
    Effect.flatMap((rows) =>
      rows.length === 1 ? Effect.void : Effect.fail(missingReference("Person", personId)),
    ),
  );

const lockDepartmentReference = (sql: DatabaseShape, departmentId: DepartmentId) =>
  sql<ReferenceRow>`
    SELECT department_id AS id
    FROM public.organization_departments
    WHERE department_id = ${departmentId}
    FOR SHARE
  `.pipe(
    Effect.flatMap((rows) =>
      rows.length === 1 ? Effect.void : Effect.fail(missingReference("Department", departmentId)),
    ),
  );

const acquireAuthzWriterLock = (sql: DatabaseShape) =>
  sql`
    SELECT pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(${AUTHZ_LOCK_PROTOCOL.advisoryKey}, 0)
    )
  `.pipe(Effect.asVoid);

const existingTag = (tag: AuthzTag) =>
  readAuthzTag(tag.tagId).pipe(
    Effect.map((value): AuthzTag | undefined => value),
    Effect.catchTag("AuthzRecordNotFound", () => Effect.succeed(undefined)),
  );

const existingAssignment = (assignment: AuthzTagAssignment) =>
  readAuthzTagAssignment(assignment.assignmentId).pipe(
    Effect.map((value): AuthzTagAssignment | undefined => value),
    Effect.catchTag("AuthzRecordNotFound", () => Effect.succeed(undefined)),
  );

const existingRule = (rule: AuthzRule) =>
  readAuthzRule(rule.ruleId).pipe(
    Effect.map((value): AuthzRule | undefined => value),
    Effect.catchTag("AuthzRecordNotFound", () => Effect.succeed(undefined)),
  );

const assertIdenticalReplay = <A>(
  entity: DisposableAuthzBackfillConflict["entity"],
  id: string,
  planned: A,
  existing: A | undefined,
): Effect.Effect<boolean, DisposableAuthzBackfillConflict> =>
  existing === undefined
    ? Effect.succeed(true)
    : canonicalJson(planned) === canonicalJson(existing)
      ? Effect.succeed(false)
      : Effect.fail(new DisposableAuthzBackfillConflict({ entity, id }));

/**
 * Persists one authored disposable plan atomically. All canonical references
 * and identical-replay checks complete before the first create command runs.
 */
export const persistDisposableAuthzBackfill = (
  input: unknown,
): Effect.Effect<DisposableAuthzBackfillPlan, DisposableAuthzBackfillFailure, Database> =>
  Effect.gen(function* () {
    const plan = yield* authorDisposableAuthzBackfill(input);
    const sql = yield* Database;

    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const personIds = new Set<PersonId>();
          const departmentIds = new Set<DepartmentId>();
          for (const assignment of plan.assignments) personIds.add(assignment.personId);
          for (const group of plan.rulesBySubject) {
            if (group.subject._tag === "Person") personIds.add(group.subject.personId);
            for (const rule of group.rules) {
              if (rule.scope._tag === "Department") {
                departmentIds.add(rule.scope.departmentId);
              }
            }
          }

          for (const personId of [...personIds].sort(compareText)) {
            yield* lockPersonReference(sql, personId);
          }
          for (const departmentId of [...departmentIds].sort(compareText)) {
            yield* lockDepartmentReference(sql, departmentId);
          }
          yield* acquireAuthzWriterLock(sql);

          const tagsToCreate: AuthzTag[] = [];
          const assignmentsToCreate: AuthzTagAssignment[] = [];
          const rulesToCreate: AuthzRule[] = [];
          for (const tag of plan.tags) {
            if (yield* assertIdenticalReplay("Tag", tag.tagId, tag, yield* existingTag(tag))) {
              tagsToCreate.push(tag);
            }
          }
          for (const assignment of plan.assignments) {
            if (
              yield* assertIdenticalReplay(
                "TagAssignment",
                assignment.assignmentId,
                assignment,
                yield* existingAssignment(assignment),
              )
            ) {
              assignmentsToCreate.push(assignment);
            }
          }
          for (const group of plan.rulesBySubject) {
            for (const rule of group.rules) {
              if (
                yield* assertIdenticalReplay("Rule", rule.ruleId, rule, yield* existingRule(rule))
              ) {
                rulesToCreate.push(rule);
              }
            }
          }

          for (const tag of tagsToCreate) yield* createAuthzTag(tag);
          for (const assignment of assignmentsToCreate) {
            yield* createAuthzTagAssignment(assignment);
          }
          for (const rule of rulesToCreate) yield* createAuthzRule(rule);
          return plan;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(
            new DisposableAuthzBackfillPersistenceError({
              operation: "persist disposable authorization backfill",
              message: String(cause),
            }),
          ),
        ),
      );
  });
