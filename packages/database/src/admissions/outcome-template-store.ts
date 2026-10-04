/**
 * The versioned store of the admission outcome mail templates (spec 0027, migration 0082).
 *
 * Every function runs in the caller's transaction on the captured `Database` and grants no
 * authority: the transport resolves the person's authority in that transaction with
 * `outcomeTemplateAuthority`. A scope is the global default (`departmentId` null) or one
 * department. A department's effective set shows its own latest revision of a variant and the
 * global default's latest revision of the rest, never a global default in place of an invalid
 * override. Revisions are append-only, so a save adds one and changes no earlier revision.
 */
import { Effect, Option, Predicate, Schema } from "effect";
import { SqlSchema } from "effect/unstable/sql";
import { isSqlError } from "effect/unstable/sql/SqlError";
import {
  decodeOutcomeTemplateDraft,
  OutcomeTemplateFailure,
  OutcomeTemplateKind,
  outcomeTemplateKinds,
  OutcomeTemplatePersistenceError,
  type OutcomeTemplateDraft,
  type OutcomeTemplateEntry,
  type OutcomeTemplateSet,
} from "@vektorprogrammet/domain/admissions/template";
import { DepartmentId, type PersonId } from "@vektorprogrammet/domain/organization";
import { canonicalJsonValue, sha256Hex } from "@vektorprogrammet/domain/shared-kernel";
import { Rfc3339InstantSchema } from "@vektorprogrammet/domain/time";
import { Database, type DatabaseOperations } from "../service.js";

const serializationConflict = (cause: unknown, depth = 0): boolean =>
  depth < 8 &&
  ((isSqlError(cause) &&
    (Predicate.isTagged(cause.reason, "SerializationError") ||
      Predicate.isTagged(cause.reason, "DeadlockError"))) ||
    (Predicate.hasProperty(cause, "cause") && serializationConflict(cause.cause, depth + 1)));

/** Keeps the cause private and marks serialization and deadlock aborts as retryable conflicts. */
const persistenceFailure = (cause: unknown): OutcomeTemplatePersistenceError => {
  const conflict = serializationConflict(cause);

  return new OutcomeTemplatePersistenceError({
    code: conflict ? "transaction.conflict" : "internal.error",
    status: conflict ? 409 : 500,
    cause,
  });
};

const Row = Schema.Struct({
  revisionId: Schema.String,
  departmentId: Schema.NullOr(Schema.String),
  kind: OutcomeTemplateKind,
  revision: Schema.Int,
  subject: Schema.Unknown,
  body: Schema.Unknown,
  authoredAt: Rfc3339InstantSchema,
});

const selectColumns = (sql: DatabaseOperations) => sql`
  revision.revision_id AS "revisionId", revision.department_id AS "departmentId", revision.kind,
  revision.revision, revision.subject_json AS subject, revision.body_json AS body,
  to_char(revision.authored_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "authoredAt"`;

/** The latest revision of each variant in the scope; a department's own rows rank first. */
const findEffective = SqlSchema.findAll({
  Request: Schema.NullOr(DepartmentId),
  Result: Row,
  execute: (departmentId) =>
    Database.use((sql) =>
      departmentId === null
        ? sql`
          SELECT DISTINCT ON (revision.kind) ${selectColumns(sql)}
          FROM public.admission_outcome_template_revisions AS revision
          WHERE revision.department_id IS NULL
          ORDER BY revision.kind, revision.revision DESC`
        : sql`
          SELECT DISTINCT ON (revision.kind) ${selectColumns(sql)}
          FROM public.admission_outcome_template_revisions AS revision
          WHERE revision.department_id IS NULL OR revision.department_id = ${departmentId}
          ORDER BY revision.kind, (revision.department_id IS NULL), revision.revision DESC`,
    ),
});

const findDepartment = SqlSchema.findOneOption({
  Request: DepartmentId,
  Result: Schema.Struct({ departmentId: Schema.String }),
  execute: (departmentId) =>
    Database.use(
      (sql) => sql`
    SELECT department_id AS "departmentId" FROM public.organization_departments
    WHERE department_id = ${departmentId}`,
    ),
});

const requireDepartment = (departmentId: DepartmentId) =>
  findDepartment(departmentId).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new OutcomeTemplateFailure({ code: "resource.not-found", status: 404 })),
        onSome: () => Effect.void,
      }),
    ),
  );

/**
 * The effective entry of every variant for one scope, in the order of `outcomeTemplateKinds`.
 * Stored documents are untrusted on read: each is decoded strictly again, and one that fails is
 * corrupted data, not an author's error.
 */
export const readEffectiveOutcomeTemplates = (
  departmentId: DepartmentId | null,
): Effect.Effect<ReadonlyArray<OutcomeTemplateEntry>, OutcomeTemplatePersistenceError, Database> =>
  findEffective(departmentId).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((rows) =>
      Effect.forEach(outcomeTemplateKinds, (kind) => {
        const row = rows.find((candidate) => candidate.kind === kind);

        return row === undefined
          ? Effect.fail(persistenceFailure("missing outcome template"))
          : decodeOutcomeTemplateDraft(kind)({ subject: row.subject, body: row.body }).pipe(
              Effect.mapError(persistenceFailure),
              Effect.map(
                (draft): OutcomeTemplateEntry => ({
                  kind,
                  provenance: row.departmentId === null ? "Global" : "Department",
                  revisionId: row.revisionId,
                  revision: row.revision,
                  subject: draft.subject,
                  body: draft.body,
                  authoredAt: row.authoredAt,
                }),
              ),
            );
      }),
    ),
  );

/**
 * Reads the effective templates of the global default or of one department.
 *
 * @remarks
 * Fails with `OutcomeTemplateFailure` `resource.not-found` for an unknown department.
 */
export const readOutcomeTemplates = (scope: {
  readonly departmentId?: DepartmentId;
}): Effect.Effect<
  OutcomeTemplateSet,
  OutcomeTemplateFailure | OutcomeTemplatePersistenceError,
  Database
> =>
  Effect.gen(function* () {
    const departmentId = scope.departmentId ?? null;

    if (departmentId !== null) yield* requireDepartment(departmentId);

    return { departmentId, templates: yield* readEffectiveOutcomeTemplates(departmentId) };
  });

const revisionIdOf = (scopeKey: string, kind: string, revision: number): string =>
  `outcome-template-${sha256Hex(new TextEncoder().encode(`${scopeKey}\n${kind}\n${revision}`))}`;

/**
 * Appends one revision of one variant to its scope and answers the scope's new effective set.
 *
 * @remarks
 * Takes the scope's row lock, reads the current set, runs `checkPrecondition` on it, and inserts
 * revision `max + 1` of the scope's own history of the variant. The draft is decoded strictly
 * again, so a loosely decoded caller cannot store an unsafe document. The callback's failures
 * and requirements propagate unchanged; success precedes the caller's commit.
 */
export const saveOutcomeTemplate = <E, R>(
  input: {
    readonly kind: OutcomeTemplateKind;
    readonly departmentId?: DepartmentId;
    readonly draft: OutcomeTemplateDraft;
    readonly actor: PersonId;
    readonly now: string;
  },
  checkPrecondition: (current: OutcomeTemplateSet) => Effect.Effect<void, E, R>,
): Effect.Effect<
  OutcomeTemplateSet,
  OutcomeTemplateFailure | OutcomeTemplatePersistenceError | E,
  Database | R
> =>
  Effect.gen(function* () {
    const draft = yield* decodeOutcomeTemplateDraft(input.kind)(input.draft);
    const departmentId = input.departmentId ?? null;
    const scopeKey = departmentId ?? "global";

    if (departmentId !== null) yield* requireDepartment(departmentId);

    yield* Database.use(
      (sql) =>
        sql`INSERT INTO public.admission_outcome_template_scopes(scope_key) VALUES (${scopeKey}) ON CONFLICT DO NOTHING`,
    ).pipe(Effect.mapError(persistenceFailure));

    yield* Database.use(
      (sql) =>
        sql`SELECT scope_key FROM public.admission_outcome_template_scopes WHERE scope_key = ${scopeKey} FOR UPDATE`,
    ).pipe(Effect.mapError(persistenceFailure));

    const current = {
      departmentId,
      templates: yield* readEffectiveOutcomeTemplates(departmentId),
    } satisfies OutcomeTemplateSet;

    yield* checkPrecondition(current);

    const [latest] = yield* Database.use(
      (sql) => sql<{ readonly revision: number }>`
        SELECT COALESCE(max(revision), 0)::integer AS revision
        FROM public.admission_outcome_template_revisions
        WHERE kind = ${input.kind}
          AND ${departmentId === null ? sql`department_id IS NULL` : sql`department_id = ${departmentId}`}`,
    ).pipe(Effect.mapError(persistenceFailure));

    const revision = (latest?.revision ?? 0) + 1;

    yield* Database.use(
      (sql) => sql`
        INSERT INTO public.admission_outcome_template_revisions (
          revision_id, department_id, kind, revision, schema_version, subject_json, body_json,
          provenance, authored_by_person_id, authored_at
        ) VALUES (
          ${revisionIdOf(scopeKey, input.kind, revision)}, ${departmentId}, ${input.kind},
          ${revision}, 1, ${sql.json(canonicalJsonValue(draft.subject))},
          ${sql.json(canonicalJsonValue(draft.body))}, 'Editor', ${input.actor}, ${input.now}
        )`,
    ).pipe(Effect.mapError(persistenceFailure));

    return { departmentId, templates: yield* readEffectiveOutcomeTemplates(departmentId) };
  });
