import { Effect, Schema } from "effect";
import { Database, type DatabaseShape } from "../database/service.js";
import type {
  OrganizationAuthorityInstant,
  OrganizationPersonAuthority,
} from "../organization/authority.js";
import { Organization } from "../organization/service.js";
import { Profile } from "../profile/service.js";
import { DepartmentId, PersonId } from "../organization/schema.js";
import { normalizeRfc3339Instant, Rfc3339InstantSchema } from "../time.js";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "../tutor/evidence.js";
import { canPublishContent, canReviseDraft, resolveContentActor } from "./actor.js";
import {
  ContentArticleNotFound,
  ContentAuthorityInactive,
  ContentCommandConflict,
  ContentDecodeError,
  ContentDepartmentNotFound,
  ContentDraftNotOwned,
  ContentIntegrityError,
  ContentNotInScope,
  ContentNotPublisher,
  ContentPersistenceError,
  ContentSlugConflict,
  type ContentManagementFailure,
} from "./errors.js";
import {
  ArticleDraft,
  ArticleId,
  ArticleVersionNumber,
  ContentArticleDetailSchema,
  ContentWorkspaceQuerySchema,
  ContentWorkspaceSchema,
  CreateArticleDraftInputSchema,
  PublishArticleInputSchema,
  PublishObservationSchema,
  ReviseArticleDraftInputSchema,
  UnpublishArticleInputSchema,
  UnpublishObservationSchema,
  type ArticleDraftJson,
  type ContentArticleDetail,
  type ContentWorkspace,
  type ContentWorkspaceQuery,
  type CreateArticleDraftInput,
  type PublishArticleInput,
  type PublishObservation,
  type ReviseArticleDraftInput,
  type UnpublishArticleInput,
  type UnpublishObservation,
} from "./schema.js";
import { dedupeSlug, slugifyTitle } from "./projection.js";
import { sanitizeArticleBodyHtml } from "./sanitize.js";

const decodeError = (operation: string, cause: unknown): ContentDecodeError =>
  new ContentDecodeError({ operation, message: String(cause) });

const persistenceError = (operation: string, cause: unknown): ContentPersistenceError =>
  new ContentPersistenceError({ operation, message: String(cause) });

type DraftRow = typeof DraftRowSchema.Type;

const DraftRowSchema = Schema.Struct({
  articleId: ArticleId,
  createdByPersonId: PersonId,
  title: Schema.String,
  slug: Schema.String,
  bodyHtml: Schema.String,
  sticky: Schema.Boolean,
  createdAt: Rfc3339InstantSchema,
  updatedAt: Rfc3339InstantSchema,
  currentVersionNumber: Schema.NullOr(ArticleVersionNumber),
  revision: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});

const departmentIdsForArticles = (
  sql: DatabaseShape,
  articleIds: ReadonlyArray<number>,
): Effect.Effect<ReadonlyMap<number, ReadonlyArray<DepartmentId>>, ContentPersistenceError> =>
  articleIds.length === 0
    ? Effect.succeed(new Map())
    : sql<{ readonly articleId: string; readonly departmentId: string }>`
        SELECT article_id::text AS "articleId", department_id AS "departmentId"
        FROM public.content_article_departments
        WHERE ${sql.in("article_id", articleIds)}
        ORDER BY article_id, department_id
      `.pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("read content departments", cause)),
        ),
        Effect.map((rows) => {
          const map = new Map<number, Array<DepartmentId>>();
          for (const row of rows) {
            const key = Number(row.articleId);
            const list = map.get(key) ?? [];
            list.push(row.departmentId as DepartmentId);
            map.set(key, list);
          }
          for (const [key, list] of map) {
            map.set(
              key,
              [...list].sort((left, right) => left.localeCompare(right)),
            );
          }
          return map;
        }),
      );

const decodeDraftRows = (selected: unknown): ReadonlyArray<DraftRow> =>
  Schema.decodeUnknownSync(Schema.Array(DraftRowSchema))(selected, {
    onExcessProperty: "error",
  });

/**
 * Reads the caller-visible workspace in one repeatable-read, write-free
 * snapshot. The Organization projection resolves inside that snapshot; the
 * actor matrix and projections are pure functions over its result.
 */
export const readWorkspacePostgres = (input: {
  readonly personId: PersonId;
  readonly authorizationInstant: OrganizationAuthorityInstant;
  readonly query: ContentWorkspaceQuery;
}): Effect.Effect<ContentWorkspace, ContentManagementFailure, Database | Organization | Profile> =>
  Effect.gen(function* () {
    const decodedQuery = yield* Schema.decodeUnknownEffect(ContentWorkspaceQuerySchema)(
      input.query,
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError((cause) => decodeError("decode content workspace query", cause)));
    const database = yield* Database;
    const organization = yield* Organization;
    const profile = yield* Profile;

    return yield* database
      .withTransaction(
        Effect.gen(function* () {
          yield* database`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`.pipe(
            Effect.asVoid,
          );
          const authority: OrganizationPersonAuthority = yield* organization
            .resolvePersonAuthorityForRead(input.personId, input.authorizationInstant)
            .pipe(Effect.mapError((cause) => persistenceError("resolve content authority", cause)));
          if (authority.evaluatedAt !== input.authorizationInstant) {
            return yield* decodeError(
              "resolve content authority",
              "Organization authority used a different authorization instant",
            );
          }
          const decision = resolveContentActor(authority);
          if (decision._tag === "Deny") {
            return yield* decision.reason === "AuthorityInactive"
              ? new ContentAuthorityInactive({})
              : new ContentNotInScope({});
          }
          const filterDepartmentId = decodedQuery.departmentId;
          if (filterDepartmentId !== undefined) {
            yield* organization.readDepartment(filterDepartmentId).pipe(
              Effect.asVoid,
              Effect.mapError((cause) =>
                cause._tag === "DepartmentNotFound"
                  ? new ContentDepartmentNotFound({ departmentId: filterDepartmentId })
                  : persistenceError("read content department filter", cause),
              ),
            );
            if (
              decision.value._tag !== "ContentAdministrator" &&
              !decision.value.departmentIds.includes(filterDepartmentId)
            ) {
              return yield* new ContentNotInScope({});
            }
          }
          const rows = yield* database<DraftRow>`
            SELECT
              CAST(article.article_id AS integer) AS "articleId",
              article.title,
              article.slug,
              article.body_html AS "bodyHtml",
              article.sticky,
              article.created_by_person_id AS "createdByPersonId",
              to_char(article.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
              to_char(article.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
              article.current_version_number AS "currentVersionNumber",
              article.revision
            FROM public.content_articles AS article
            ORDER BY article.updated_at DESC, article.article_id DESC
          `.pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(persistenceError("read content drafts", cause)),
            ),
          );
          const drafts = yield* Effect.try({
            try: () => decodeDraftRows(rows),
            catch: (cause) => decodeError("decode content draft rows", cause),
          });
          const departmentIdsByArticle = yield* departmentIdsForArticles(
            database,
            drafts.map((draft) => draft.articleId),
          );
          // Visibility law: editors see own drafts plus all published
          // articles; leaders and administrators see everything in scope.
          const visibleDrafts = drafts.filter((draft) => {
            if (decision.value._tag === "ContentAdministrator") return true;
            if (draft.currentVersionNumber !== null) return true;
            return canReviseDraft(decision.value, {
              createdByPersonId: draft.createdByPersonId,
              currentVersionNumber: draft.currentVersionNumber,
              departmentIds: departmentIdsByArticle.get(draft.articleId) ?? [],
            });
          });
          const scoped =
            filterDepartmentId === undefined
              ? visibleDrafts
              : visibleDrafts.filter((draft) =>
                  (departmentIdsByArticle.get(draft.articleId) ?? []).includes(filterDepartmentId),
                );
          // Author display names resolve from one Profile read inside the
          // same snapshot; a missing profile row is a typed integrity
          // failure, never an opaque identifier.
          const authorPersonIds = [
            ...new Set(scoped.map((draft) => draft.createdByPersonId)),
          ].sort();
          const profiles = yield* profile.readProfiles(authorPersonIds as never).pipe(
            Effect.mapError((cause) =>
              cause._tag === "ProfileContactNotFound" || cause._tag === "ProfileNotFound"
                ? new ContentIntegrityError({
                    operation: "read content workspace authors",
                    message: `missing profile for a workspace author: ${String(cause)}`,
                  })
                : persistenceError("read content workspace authors", cause),
            ),
          );
          const namesByPerson = new Map<string, string>(
            profiles.map((entry) => [entry.personId, `${entry.firstName} ${entry.lastName}`]),
          );
          for (const draft of scoped) {
            if (!namesByPerson.has(draft.createdByPersonId)) {
              return yield* new ContentIntegrityError({
                operation: "read content workspace authors",
                message: `no profile resolved for author ${draft.createdByPersonId}`,
              });
            }
          }
          const entries = scoped.map((draft) => {
            const departmentIds = departmentIdsByArticle.get(draft.articleId) ?? [];
            return {
              articleId: draft.articleId,
              title: draft.title,
              slug: draft.slug,
              status:
                draft.currentVersionNumber === null ? ("Draft" as const) : ("Published" as const),
              sticky: draft.sticky,
              updatedAt: draft.updatedAt,
              departmentIds,
              canRevise: canReviseDraft(decision.value, {
                createdByPersonId: draft.createdByPersonId,
                currentVersionNumber: draft.currentVersionNumber,
                departmentIds,
              }),
              canPublish: canPublishContent(decision.value, departmentIds),
              authorDisplayName: namesByPerson.get(draft.createdByPersonId)!,
            };
          });
          const workspace = { entries };
          return yield* Schema.decodeUnknownEffect(ContentWorkspaceSchema)(workspace, {
            onExcessProperty: "error",
          }).pipe(Effect.mapError((cause) => decodeError("decode content workspace", cause)));
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("content workspace snapshot", cause)),
        ),
      );
  });
/**
 * Reads one editable working copy without widening the exact workspace summary.
 * The detail contains body/revision but never the private creator identifier.
 */
export const readArticleDetailPostgres = (input: {
  readonly articleId: ArticleId;
  readonly personId: PersonId;
  readonly authorizationInstant: OrganizationAuthorityInstant;
}): Effect.Effect<
  ContentArticleDetail,
  ContentManagementFailure,
  Database | Organization | Profile
> =>
  Effect.gen(function* () {
    const articleId = yield* Schema.decodeUnknownEffect(ArticleId)(input.articleId, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => decodeError("decode content article id", cause)));
    const database = yield* Database;
    const organization = yield* Organization;
    const profile = yield* Profile;

    return yield* database
      .withTransaction(
        Effect.gen(function* () {
          yield* database`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`.pipe(
            Effect.asVoid,
          );
          const authority = yield* organization
            .resolvePersonAuthorityForRead(input.personId, input.authorizationInstant)
            .pipe(
              Effect.mapError((cause) =>
                persistenceError("resolve content detail authority", cause),
              ),
            );
          if (authority.evaluatedAt !== input.authorizationInstant) {
            return yield* decodeError(
              "resolve content detail authority",
              "Organization authority used a different authorization instant",
            );
          }
          const decision = resolveContentActor(authority);
          if (decision._tag === "Deny") {
            return yield* decision.reason === "AuthorityInactive"
              ? new ContentAuthorityInactive({})
              : new ContentNotInScope({});
          }
          const rows = yield* database<DraftRow>`
            SELECT
              CAST(article.article_id AS integer) AS "articleId",
              article.title,
              article.slug,
              article.body_html AS "bodyHtml",
              article.sticky,
              article.created_by_person_id AS "createdByPersonId",
              to_char(article.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
              to_char(article.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
              article.current_version_number AS "currentVersionNumber",
              article.revision
            FROM public.content_articles AS article
            WHERE article.article_id = ${articleId}
          `.pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(persistenceError("read content article detail", cause)),
            ),
          );
          const draft = yield* Effect.try({
            try: () => decodeDraftRows(rows)[0],
            catch: (cause) => decodeError("decode content article detail row", cause),
          });
          if (draft === undefined) return yield* new ContentArticleNotFound({});
          const departmentIds =
            (yield* departmentIdsForArticles(database, [draft.articleId])).get(draft.articleId) ??
            [];
          const canRevise = canReviseDraft(decision.value, {
            createdByPersonId: draft.createdByPersonId,
            currentVersionNumber: draft.currentVersionNumber,
            departmentIds,
          });
          if (!canRevise) {
            return yield* decision.value._tag === "ContentEditor"
              ? new ContentDraftNotOwned({ articleId: draft.articleId })
              : new ContentNotInScope({});
          }
          const profiles = yield* profile.readProfiles([draft.createdByPersonId]).pipe(
            Effect.mapError((cause) =>
              cause._tag === "ProfileContactNotFound" || cause._tag === "ProfileNotFound"
                ? new ContentIntegrityError({
                    operation: "read content article detail author",
                    message: `missing profile for article author: ${String(cause)}`,
                  })
                : persistenceError("read content article detail author", cause),
            ),
          );
          const author = profiles[0];
          if (author === undefined) {
            return yield* new ContentIntegrityError({
              operation: "read content article detail author",
              message: "no profile resolved for article author",
            });
          }
          return yield* Schema.decodeUnknownEffect(ContentArticleDetailSchema)(
            {
              articleId: draft.articleId,
              title: draft.title,
              slug: draft.slug,
              status: draft.currentVersionNumber === null ? "Draft" : "Published",
              bodyHtml: draft.bodyHtml,
              sticky: draft.sticky,
              createdAt: draft.createdAt,
              updatedAt: draft.updatedAt,
              currentVersionNumber: draft.currentVersionNumber,
              revision: draft.revision,
              departmentIds,
              canRevise,
              canPublish: canPublishContent(decision.value, departmentIds),
              authorDisplayName: `${author.firstName} ${author.lastName}`,
            },
            { onExcessProperty: "error" },
          ).pipe(Effect.mapError((cause) => decodeError("decode content article detail", cause)));
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("content article detail snapshot", cause)),
        ),
      );
  });

type ContentCommandKind = "CreateDraft" | "ReviseDraft" | "Publish" | "Unpublish";

interface CommandReceiptRow {
  readonly commandId: string;
  readonly kind: ContentCommandKind;
  readonly payloadSha256: string;
  readonly resultJson: unknown;
}

const findCommandReceipt = (
  sql: DatabaseShape,
  commandId: string,
): Effect.Effect<CommandReceiptRow | undefined, ContentPersistenceError> =>
  sql<CommandReceiptRow>`
    SELECT
      command_id AS "commandId",
      kind,
      payload_sha256 AS "payloadSha256",
      result_json AS "resultJson"
    FROM public.content_publication_command_receipts
    WHERE command_id = ${commandId}
  `.pipe(
    Effect.map((rows) => rows[0]),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read content command receipt", cause)),
    ),
  );

const lockCommandReceipt = (
  sql: DatabaseShape,
  commandId: string,
): Effect.Effect<void, ContentPersistenceError> =>
  sql`SELECT pg_advisory_xact_lock(hashtextextended(${`content-command-${commandId}`}, 0))`.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("lock content command receipt", cause)),
    ),
  );

const commandReceiptConflicts = (
  stored: CommandReceiptRow,
  kind: ContentCommandKind,
  payloadSha256: string,
): boolean => stored.kind !== kind || stored.payloadSha256 !== payloadSha256;

const decodeStoredDraft = (
  stored: unknown,
): Effect.Effect<ArticleDraftJson, ContentPersistenceError> =>
  Schema.decodeUnknownEffect(ArticleDraft.json)(stored, { onExcessProperty: "error" }).pipe(
    Effect.mapError((cause) => persistenceError("decode stored article draft", cause)),
  );

const decodeStoredPublish = (
  stored: unknown,
): Effect.Effect<PublishObservation, ContentPersistenceError> =>
  Schema.decodeUnknownEffect(PublishObservationSchema)(stored, { onExcessProperty: "error" }).pipe(
    Effect.mapError((cause) => persistenceError("decode stored publish observation", cause)),
  );

const decodeStoredUnpublish = (
  stored: unknown,
): Effect.Effect<UnpublishObservation, ContentPersistenceError> =>
  Schema.decodeUnknownEffect(UnpublishObservationSchema)(stored, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError((cause) => persistenceError("decode stored unpublish observation", cause)),
  );

const insertReceiptAndAudit = (input: {
  readonly sql: DatabaseShape;
  readonly commandId: string;
  readonly articleId: number;
  readonly kind: ContentCommandKind;
  readonly payloadBytes: Uint8Array;
  readonly result: unknown;
  readonly actorPersonId: string;
  readonly action: string;
  readonly versionNumber: number | null;
}): Effect.Effect<void, ContentPersistenceError> => {
  const { sql } = input;
  return Effect.gen(function* () {
    yield* sql`
      INSERT INTO public.content_publication_command_receipts (
        command_id, article_id, kind, payload_sha256, result_json, committed_at
      ) VALUES (
        ${input.commandId},
        ${input.articleId},
        ${input.kind},
        ${sha256Hex(input.payloadBytes)},
        ${sql.json(JSON.parse(canonicalJson(input.result)))},
        now()
      )
    `.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("insert content command receipt", cause)),
      ),
    );
    yield* sql`
      INSERT INTO public.content_publication_audit (
        command_id, article_id, actor_person_id, action, version_number, occurred_at
      ) VALUES (
        ${input.commandId}, ${input.articleId}, ${input.actorPersonId}, ${input.action},
        ${input.versionNumber}, now()
      )
    `.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("insert content audit", cause)),
      ),
    );
  });
};

/** Resolves the Organization projection inside the command's own transaction. */
const resolveAuthorityInTransaction = (input: {
  readonly organization: {
    resolvePersonAuthorityForRead: (
      personId: PersonId,
      instant: OrganizationAuthorityInstant,
    ) => Effect.Effect<OrganizationPersonAuthority, unknown>;
  };
  readonly personId: PersonId;
  readonly authorizationInstant: OrganizationAuthorityInstant;
}) =>
  input.organization
    .resolvePersonAuthorityForRead(input.personId, input.authorizationInstant)
    .pipe(Effect.mapError((cause) => persistenceError("resolve content authority", cause)));

const authorityDecisionOrDenial = (
  authority: OrganizationPersonAuthority,
  authorizationInstant: OrganizationAuthorityInstant,
): Effect.Effect<
  Extract<ReturnType<typeof resolveContentActor>, { readonly _tag: "Allow" }>["value"],
  ContentDecodeError | ContentAuthorityInactive | ContentNotInScope
> => {
  if (authority.evaluatedAt !== authorizationInstant) {
    return Effect.fail(
      decodeError(
        "resolve content authority",
        "Organization authority used a different authorization instant",
      ),
    );
  }
  const decision = resolveContentActor(authority);
  if (decision._tag === "Deny") {
    return decision.reason === "AuthorityInactive"
      ? Effect.fail(new ContentAuthorityInactive({}))
      : Effect.fail(new ContentNotInScope({}));
  }
  return Effect.succeed(decision.value);
};

const readDraftForUpdate = (
  sql: DatabaseShape,
  articleId: ArticleId,
): Effect.Effect<DraftRow | undefined, ContentPersistenceError> =>
  sql<DraftRow>`
    SELECT
      CAST(article.article_id AS integer) AS "articleId",
      article.title,
      article.slug,
      article.body_html AS "bodyHtml",
      article.sticky,
      article.created_by_person_id AS "createdByPersonId",
      to_char(article.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
      to_char(article.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
      article.current_version_number AS "currentVersionNumber",
      article.revision
    FROM public.content_articles AS article
    WHERE article.article_id = ${articleId}
    FOR UPDATE
  `.pipe(
    Effect.map((rows) => rows[0]),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("lock content article", cause)),
    ),
  );

const replaceArticleDepartments = (
  sql: DatabaseShape,
  articleId: number,
  departmentIds: ReadonlyArray<DepartmentId>,
): Effect.Effect<void, ContentPersistenceError | ContentDepartmentNotFound> => {
  const markRevisionManaged = sql`
    SELECT set_config('vektor.content_revision_managed', 'on', true)
  `.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("mark content revision managed", cause)),
    ),
  );
  const clear =
    sql`DELETE FROM public.content_article_departments WHERE article_id = ${articleId}`.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("clear content departments", cause)),
      ),
    );
  const insertOne = (departmentId: DepartmentId) =>
    sql`
      INSERT INTO public.content_article_departments (article_id, department_id)
      VALUES (${articleId}, ${departmentId})
    `.pipe(
      Effect.asVoid,
      Effect.catchIf(
        (cause: unknown): cause is ContentDepartmentNotFound =>
          String(cause).includes("foreign key"),
        () => new ContentDepartmentNotFound({ departmentId }),
      ),
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("insert content department link", cause)),
      ),
    );
  return Effect.flatMap(markRevisionManaged, () =>
    Effect.flatMap(clear, () =>
      departmentIds.length === 0
        ? Effect.void
        : Effect.forEach(departmentIds, insertOne, { discard: true }),
    ),
  ) as Effect.Effect<void, ContentPersistenceError | ContentDepartmentNotFound>;
};

/**
 * Creates one draft. The slug is generated from the title with the legacy
 * transliteration and deduplicated inside the creation transaction; unique
 * across drafts and all published versions.
 */
export const createDraftPostgres = (input: {
  readonly command: CreateArticleDraftInput;
  readonly personId: PersonId;
  readonly authorizationInstant: OrganizationAuthorityInstant;
}): Effect.Effect<ArticleDraftJson, ContentManagementFailure, Database | Organization> =>
  Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(CreateArticleDraftInputSchema)(
      input.command,
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError((cause) => decodeError("decode create-draft command", cause)));
    const payloadDigest = sha256Hex(canonicalJsonBytes(command));
    const database = yield* Database;
    const organization = yield* Organization;

    return yield* database
      .withTransaction(
        Effect.gen(function* () {
          yield* lockCommandReceipt(database, command.commandId);
          const stored = yield* findCommandReceipt(database, command.commandId);
          if (stored !== undefined) {
            if (commandReceiptConflicts(stored, "CreateDraft", payloadDigest)) {
              return yield* new ContentCommandConflict({ commandId: command.commandId });
            }
            return yield* decodeStoredDraft(stored.resultJson);
          }
          const sanitizedBody = yield* sanitizeArticleBodyHtml(
            "sanitize create-draft body",
            command.bodyHtml,
          );

          const authority = yield* resolveAuthorityInTransaction({
            organization,
            personId: input.personId,
            authorizationInstant: input.authorizationInstant,
          });
          const actor = yield* authorityDecisionOrDenial(authority, input.authorizationInstant);
          if (
            actor._tag !== "ContentAdministrator" &&
            (command.departmentIds.length === 0 ||
              !command.departmentIds.every((departmentId) =>
                actor.departmentIds.includes(departmentId),
              ))
          ) {
            return yield* new ContentNotInScope({});
          }
          const sticky = command.sticky ?? false;
          if (sticky && actor._tag === "ContentEditor") {
            return yield* new ContentNotInScope({});
          }
          const baseSlug = slugifyTitle(command.title);
          if (!/^[a-z0-9-]+$/.test(baseSlug) || baseSlug.length === 0) {
            return yield* new ContentSlugConflict({});
          }
          const taken = new Set<string>(
            (yield* database<{ readonly slug: string }>`
                SELECT slug FROM public.content_articles WHERE slug LIKE ${`${baseSlug}%`}
                UNION ALL
                SELECT slug FROM public.content_article_versions WHERE slug LIKE ${`${baseSlug}%`}
              `.pipe(
              Effect.catchTag("SqlError", (cause) =>
                Effect.fail(persistenceError("read existing slugs", cause)),
              ),
            )).map((row) => row.slug),
          );
          const slug = dedupeSlug(baseSlug, taken);
          const inserted = yield* database<ArticleDraftJson>`
            INSERT INTO public.content_articles (
              title, slug, body_html, sticky, created_by_person_id,
              created_at, updated_at, current_version_number, revision
            ) VALUES (
              ${command.title}, ${slug}, ${sanitizedBody}, ${sticky}, ${input.personId},
              now(), now(), NULL, 0
            )
            RETURNING
              CAST(article_id AS integer) AS "articleId",
              title,
              slug,
              body_html AS "bodyHtml",
              sticky,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
              current_version_number AS "currentVersionNumber",
              revision
          `.pipe(
            Effect.mapError((cause): ContentPersistenceError | ContentSlugConflict => {
              const driverCause =
                typeof cause === "object" && cause !== null && "cause" in cause
                  ? cause.cause
                  : cause;
              const sqlReason =
                typeof cause === "object" && cause !== null && "reason" in cause
                  ? cause.reason
                  : undefined;
              const code =
                typeof driverCause === "object" && driverCause !== null && "code" in driverCause
                  ? driverCause.code
                  : undefined;
              const constraint =
                typeof sqlReason === "object" &&
                sqlReason !== null &&
                "constraint" in sqlReason &&
                typeof sqlReason.constraint === "string"
                  ? sqlReason.constraint
                  : undefined;
              const description = `${String(cause)} ${String(driverCause)}`;
              return code === "23505" ||
                constraint === "content_articles_slug_unique" ||
                description.includes("content_articles_slug_unique") ||
                description.includes("content_articles_slug_key")
                ? new ContentSlugConflict({})
                : persistenceError("insert content draft", cause);
            }),
          );
          const observation = yield* Schema.decodeUnknownEffect(ArticleDraft.json)(inserted[0], {
            onExcessProperty: "error",
          }).pipe(Effect.mapError((cause) => decodeError("decode created article draft", cause)));
          yield* replaceArticleDepartments(database, observation.articleId, command.departmentIds);
          yield* insertReceiptAndAudit({
            sql: database,
            commandId: command.commandId,
            articleId: observation.articleId,
            kind: "CreateDraft",
            payloadBytes: canonicalJsonBytes(command),
            result: observation,
            actorPersonId: input.personId,
            action: "CreateDraft",
            versionNumber: null,
          });
          return observation;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("create draft transaction", cause)),
        ),
      );
  });

export const publishPostgres = (input: {
  readonly command: PublishArticleInput;
  readonly personId: PersonId;
  readonly authorizationInstant: OrganizationAuthorityInstant;
}): Effect.Effect<PublishObservation, ContentManagementFailure, Database | Organization> =>
  Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(PublishArticleInputSchema)(input.command, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => decodeError("decode publish command", cause)));
    const payloadDigest = sha256Hex(canonicalJsonBytes(command));
    const database = yield* Database;
    const organization = yield* Organization;

    return yield* database
      .withTransaction(
        Effect.gen(function* () {
          // Law 2: the article lock serializes concurrent publish/unpublish.
          yield* database`SELECT pg_advisory_xact_lock(hashtextextended(${`content-article-${command.articleId}`}, 0))`.pipe(
            Effect.asVoid,
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(persistenceError("lock content article transition", cause)),
            ),
          );
          yield* lockCommandReceipt(database, command.commandId);
          // Law 9: identical replay returns the stored observation.
          const stored = yield* findCommandReceipt(database, command.commandId);
          if (stored !== undefined) {
            if (commandReceiptConflicts(stored, "Publish", payloadDigest)) {
              return yield* new ContentCommandConflict({ commandId: command.commandId });
            }
            return yield* decodeStoredPublish(stored.resultJson);
          }
          const authority = yield* resolveAuthorityInTransaction({
            organization,
            personId: input.personId,
            authorizationInstant: input.authorizationInstant,
          });
          const actor = yield* authorityDecisionOrDenial(authority, input.authorizationInstant);
          const draft = yield* readDraftForUpdate(database, command.articleId);
          if (draft === undefined) {
            return yield* new ContentArticleNotFound({});
          }
          const departmentIds = yield* departmentIdsForArticles(database, [draft.articleId]);
          const draftDepartments = departmentIds.get(draft.articleId) ?? [];
          if (!canPublishContent(actor, draftDepartments)) {
            return yield* actor._tag === "ContentEditor"
              ? new ContentNotPublisher({ articleId: draft.articleId })
              : new ContentNotInScope({});
          }
          const nextVersionRows = yield* database<{ readonly nextVersionNumber: number }>`
            SELECT CAST(COALESCE(MAX(version_number), 0) + 1 AS integer) AS "nextVersionNumber"
            FROM public.content_article_versions
            WHERE article_id = ${draft.articleId}
          `.pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(persistenceError("issue next article version number", cause)),
            ),
          );
          const nextVersionNumber = ArticleVersionNumber.make(
            Number(nextVersionRows[0]?.nextVersionNumber),
          );
          const sanitizedBody = yield* sanitizeArticleBodyHtml(
            "sanitize publish body",
            draft.bodyHtml,
          );

          // The publish instant is the database transaction's own clock
          // (spec law 2): now() is inserted and returned as the observation.
          const insertedVersion = yield* database<{ readonly publishedAt: string }>`
            INSERT INTO public.content_article_versions (
              article_id, version_number, title, slug, body_html, sticky,
              published_at, published_by_person_id
            ) VALUES (
              ${draft.articleId}, ${nextVersionNumber}, ${draft.title}, ${draft.slug},
              ${sanitizedBody}, ${draft.sticky}, now(), ${input.personId}
            )
            RETURNING to_char(
              published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ) AS "publishedAt"
          `.pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(persistenceError("insert published version", cause)),
            ),
          );
          const publishedAt = Rfc3339InstantSchema.make(
            normalizeRfc3339Instant(insertedVersion[0]!.publishedAt),
          );
          yield* database`
            UPDATE public.content_articles
            SET current_version_number = ${nextVersionNumber}, revision = revision + 1
            WHERE article_id = ${draft.articleId}
          `.pipe(
            Effect.asVoid,
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(persistenceError("advance current version pointer", cause)),
            ),
          );
          const observation: PublishObservation = {
            _tag: "Published",
            commandId: command.commandId,
            articleId: draft.articleId,
            versionNumber: nextVersionNumber,
            publishedAt,
          };
          yield* insertReceiptAndAudit({
            sql: database,
            commandId: command.commandId,
            articleId: draft.articleId,
            kind: "Publish",
            payloadBytes: canonicalJsonBytes(command),
            result: observation,
            actorPersonId: input.personId,
            action: "Publish",
            versionNumber: nextVersionNumber,
          });
          return observation;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("publish transaction", cause)),
        ),
      );
  });

export const unpublishPostgres = (input: {
  readonly command: UnpublishArticleInput;
  readonly personId: PersonId;
  readonly authorizationInstant: OrganizationAuthorityInstant;
}): Effect.Effect<UnpublishObservation, ContentManagementFailure, Database | Organization> =>
  Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(UnpublishArticleInputSchema)(input.command, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => decodeError("decode unpublish command", cause)));
    const payloadDigest = sha256Hex(canonicalJsonBytes(command));
    const database = yield* Database;
    const organization = yield* Organization;

    return yield* database
      .withTransaction(
        Effect.gen(function* () {
          yield* database`SELECT pg_advisory_xact_lock(hashtextextended(${`content-article-${command.articleId}`}, 0))`.pipe(
            Effect.asVoid,
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(persistenceError("lock content article transition", cause)),
            ),
          );
          yield* lockCommandReceipt(database, command.commandId);
          const stored = yield* findCommandReceipt(database, command.commandId);
          if (stored !== undefined) {
            if (commandReceiptConflicts(stored, "Unpublish", payloadDigest)) {
              return yield* new ContentCommandConflict({ commandId: command.commandId });
            }
            return yield* decodeStoredUnpublish(stored.resultJson);
          }
          const authority = yield* resolveAuthorityInTransaction({
            organization,
            personId: input.personId,
            authorizationInstant: input.authorizationInstant,
          });
          const actor = yield* authorityDecisionOrDenial(authority, input.authorizationInstant);
          const draft = yield* readDraftForUpdate(database, command.articleId);
          if (draft === undefined) {
            return yield* new ContentArticleNotFound({});
          }
          const departmentIds = yield* departmentIdsForArticles(database, [draft.articleId]);
          if (!canPublishContent(actor, departmentIds.get(draft.articleId) ?? [])) {
            return yield* actor._tag === "ContentEditor"
              ? new ContentNotPublisher({ articleId: draft.articleId })
              : new ContentNotInScope({});
          }
          if (draft.currentVersionNumber === null) {
            return yield* new ContentCommandConflict({ commandId: command.commandId });
          }
          yield* database`
            UPDATE public.content_articles
            SET current_version_number = NULL, revision = revision + 1
            WHERE article_id = ${draft.articleId}
          `.pipe(
            Effect.asVoid,
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(persistenceError("clear current version pointer", cause)),
            ),
          );
          const observation: UnpublishObservation = {
            _tag: "Unpublished",
            commandId: command.commandId,
            articleId: draft.articleId,
          };
          yield* insertReceiptAndAudit({
            sql: database,
            commandId: command.commandId,
            articleId: draft.articleId,
            kind: "Unpublish",
            payloadBytes: canonicalJsonBytes(command),
            result: observation,
            actorPersonId: input.personId,
            action: "Unpublish",
            versionNumber: null,
          });
          return observation;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("unpublish transaction", cause)),
        ),
      );
  });

export const reviseDraftPostgres = (input: {
  readonly command: ReviseArticleDraftInput;
  readonly personId: PersonId;
  readonly authorizationInstant: OrganizationAuthorityInstant;
}): Effect.Effect<ArticleDraftJson, ContentManagementFailure, Database | Organization> =>
  Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(ReviseArticleDraftInputSchema)(
      input.command,
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError((cause) => decodeError("decode revise command", cause)));
    const payloadDigest = sha256Hex(canonicalJsonBytes(command));
    const database = yield* Database;
    const organization = yield* Organization;

    return yield* database
      .withTransaction(
        Effect.gen(function* () {
          yield* database`SELECT pg_advisory_xact_lock(hashtextextended(${`content-article-${command.articleId}`}, 0))`.pipe(
            Effect.asVoid,
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(persistenceError("lock content article transition", cause)),
            ),
          );
          yield* lockCommandReceipt(database, command.commandId);
          const stored = yield* findCommandReceipt(database, command.commandId);
          if (stored !== undefined) {
            if (commandReceiptConflicts(stored, "ReviseDraft", payloadDigest)) {
              return yield* new ContentCommandConflict({ commandId: command.commandId });
            }
            return yield* decodeStoredDraft(stored.resultJson);
          }
          const sanitizedBody = yield* sanitizeArticleBodyHtml(
            "sanitize revise body",
            command.bodyHtml,
          );
          const authority = yield* resolveAuthorityInTransaction({
            organization,
            personId: input.personId,
            authorizationInstant: input.authorizationInstant,
          });
          const actor = yield* authorityDecisionOrDenial(authority, input.authorizationInstant);
          const draft = yield* readDraftForUpdate(database, command.articleId);
          if (draft === undefined) {
            return yield* new ContentArticleNotFound({});
          }
          const departmentIds = yield* departmentIdsForArticles(database, [draft.articleId]);
          const current = departmentIds.get(draft.articleId) ?? [];
          if (
            !canReviseDraft(actor, {
              createdByPersonId: draft.createdByPersonId,
              currentVersionNumber: draft.currentVersionNumber,
              departmentIds: current,
            })
          ) {
            return yield* actor._tag === "ContentEditor"
              ? new ContentDraftNotOwned({ articleId: draft.articleId })
              : new ContentNotPublisher({ articleId: draft.articleId });
          }
          if (
            actor._tag !== "ContentAdministrator" &&
            (command.departmentIds.length === 0 ||
              !command.departmentIds.every((departmentId) =>
                actor.departmentIds.includes(departmentId),
              ))
          ) {
            return yield* new ContentNotInScope({});
          }
          if (draft.revision !== command.expectedRevision) {
            return yield* new ContentCommandConflict({ commandId: command.commandId });
          }
          const sticky = command.sticky ?? draft.sticky;
          if (sticky !== draft.sticky && !canPublishContent(actor, current)) {
            return yield* new ContentNotPublisher({ articleId: draft.articleId });
          }
          const revised = yield* database<ArticleDraftJson>`
            UPDATE public.content_articles
            SET title = ${command.title}, body_html = ${sanitizedBody}, sticky = ${sticky},
                updated_at = now(), revision = revision + 1
            WHERE article_id = ${draft.articleId}
            RETURNING
              CAST(article_id AS integer) AS "articleId",
              title,
              slug,
              body_html AS "bodyHtml",
              sticky,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
              current_version_number AS "currentVersionNumber",
              revision
          `.pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(persistenceError("revise content draft", cause)),
            ),
          );
          const observation = yield* Schema.decodeUnknownEffect(ArticleDraft.json)(revised[0], {
            onExcessProperty: "error",
          }).pipe(Effect.mapError((cause) => decodeError("decode revised article draft", cause)));
          yield* replaceArticleDepartments(database, draft.articleId, command.departmentIds);
          yield* insertReceiptAndAudit({
            sql: database,
            commandId: command.commandId,
            articleId: draft.articleId,
            kind: "ReviseDraft",
            payloadBytes: canonicalJsonBytes(command),
            result: observation,
            actorPersonId: input.personId,
            action: "ReviseDraft",
            versionNumber: null,
          });
          return observation;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("revise draft transaction", cause)),
        ),
      );
  });

const ContentArticleHttpSourceSchema = Schema.Struct({
  articleId: ArticleId,
  createdByPersonId: PersonId,
  articleRevision: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  authorProfileRevision: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});

export type ContentArticleHttpSource = typeof ContentArticleHttpSourceSchema.Type;

/** Version and ownership facts used by the v0.2 staff article HTTP adapter. */
export const readContentArticleHttpSourcePostgres = (
  articleId: ArticleId,
): Effect.Effect<
  ContentArticleHttpSource,
  ContentArticleNotFound | ContentDecodeError | ContentPersistenceError,
  Database
> =>
  Database.use((database) =>
    Effect.gen(function* () {
      const rows = yield* database`
        SELECT
          article.article_id::integer AS "articleId",
          article.created_by_person_id AS "createdByPersonId",
          article.revision AS "articleRevision",
          author.revision AS "authorProfileRevision"
        FROM public.content_articles AS article
        INNER JOIN public.person_profiles AS author
          ON author.person_id = article.created_by_person_id
        WHERE article.article_id = ${articleId}
      `.pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("read content HTTP article source", cause)),
        ),
      );
      const row = rows[0];
      if (row === undefined) return yield* new ContentArticleNotFound({});
      return yield* Schema.decodeUnknownEffect(ContentArticleHttpSourceSchema)(row, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError((cause) => decodeError("decode content HTTP article source", cause)));
    }),
  );

const ContentAuthorityHttpSourceSchema = Schema.Struct({
  kind: Schema.Literals(["GlobalAdministrator", "Membership"]),
  identity: Schema.String,
  revisions: Schema.Array(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
});

export type ContentAuthorityHttpSource = typeof ContentAuthorityHttpSourceSchema.Type;

/**
 * Ordered revisions of every Organization row consulted by content authority.
 * These records are representation sources, never public response fields.
 */
export const readContentAuthorityHttpSourcesPostgres = (
  personId: PersonId,
): Effect.Effect<
  ReadonlyArray<ContentAuthorityHttpSource>,
  ContentDecodeError | ContentPersistenceError,
  Database
> =>
  Database.use((database) =>
    Effect.gen(function* () {
      const grants = yield* database`
        SELECT
          'GlobalAdministrator' AS kind,
          grant_id AS identity,
          ARRAY[revision]::integer[] AS revisions
        FROM public.organization_global_administrator_grants
        WHERE person_id = ${personId}
        ORDER BY grant_id
      `;
      const memberships = yield* database`
        SELECT
          'Membership' AS kind,
          membership.membership_id AS identity,
          ARRAY[membership.revision, team.revision, department.revision]::integer[] AS revisions
        FROM public.organization_memberships AS membership
        INNER JOIN public.organization_teams AS team
          ON team.team_id = membership.team_id
        INNER JOIN public.organization_departments AS department
          ON department.department_id = team.department_id
        WHERE membership.person_id = ${personId}
        ORDER BY membership.membership_id
      `;
      return yield* Schema.decodeUnknownEffect(Schema.Array(ContentAuthorityHttpSourceSchema))([
        ...grants,
        ...memberships,
      ]).pipe(
        Effect.mapError((cause) => decodeError("decode content HTTP authority sources", cause)),
      );
    }).pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read content HTTP authority sources", cause)),
      ),
    ),
  );

const PublishedNewsCollectionHttpSourceSchema = Schema.Struct({
  articleId: ArticleId,
  currentVersionNumber: ArticleVersionNumber,
  publishedAt: Rfc3339InstantSchema,
  authorProfileRevision: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});

export type PublishedNewsCollectionHttpSource = typeof PublishedNewsCollectionHttpSourceSchema.Type;

/** Ordered authoritative sources for one public news listing validator. */
export const readPublishedNewsCollectionHttpSourcesPostgres = (
  departmentId?: DepartmentId,
): Effect.Effect<
  ReadonlyArray<PublishedNewsCollectionHttpSource>,
  ContentDecodeError | ContentPersistenceError,
  Database
> =>
  Database.use((database) => {
    const selectedDepartment = departmentId ?? null;
    return database`
      SELECT
        article.article_id::integer AS "articleId",
        article.current_version_number AS "currentVersionNumber",
        to_char(
          version.published_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS "publishedAt",
        author.revision AS "authorProfileRevision"
      FROM public.content_articles AS article
      INNER JOIN public.content_article_versions AS version
        ON version.article_id = article.article_id
       AND version.version_number = article.current_version_number
      INNER JOIN public.person_profiles AS author
        ON author.person_id = article.created_by_person_id
      WHERE article.current_version_number IS NOT NULL
        AND (
          ${selectedDepartment}::text IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM public.content_article_departments AS any_department
            WHERE any_department.article_id = article.article_id
          )
          OR EXISTS (
            SELECT 1
            FROM public.content_article_departments AS selected_department
            WHERE selected_department.article_id = article.article_id
              AND selected_department.department_id = ${selectedDepartment}
          )
        )
      ORDER BY article.article_id
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read public news HTTP collection sources", cause)),
      ),
      Effect.flatMap((rows) =>
        Schema.decodeUnknownEffect(Schema.Array(PublishedNewsCollectionHttpSourceSchema))(rows, {
          onExcessProperty: "error",
        }).pipe(
          Effect.mapError((cause) =>
            decodeError("decode public news HTTP collection sources", cause),
          ),
        ),
      ),
    );
  });

const PublishedNewsArticleHttpSourceSchema = Schema.Struct({
  articleId: ArticleId,
  currentVersionNumber: ArticleVersionNumber,
  selectedVersionNumber: ArticleVersionNumber,
  publishedAt: Rfc3339InstantSchema,
  authorProfileRevision: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});

export type PublishedNewsArticleHttpSource = typeof PublishedNewsArticleHttpSourceSchema.Type;

/** Authoritative current-pointer and immutable-version source for news detail. */
export const readPublishedNewsArticleHttpSourcePostgres = (
  slug: string,
  versionNumber?: number,
): Effect.Effect<
  PublishedNewsArticleHttpSource,
  ContentArticleNotFound | ContentDecodeError | ContentPersistenceError,
  Database
> =>
  Database.use((database) =>
    Effect.gen(function* () {
      const rows = yield* database`
        SELECT
          article.article_id::integer AS "articleId",
          article.current_version_number AS "currentVersionNumber",
          version.version_number AS "selectedVersionNumber",
          to_char(
            version.published_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ) AS "publishedAt",
          author.revision AS "authorProfileRevision"
        FROM public.content_articles AS article
        INNER JOIN public.content_article_versions AS version
          ON version.article_id = article.article_id
        INNER JOIN public.person_profiles AS author
          ON author.person_id = article.created_by_person_id
        WHERE version.slug = ${slug}
          AND article.current_version_number IS NOT NULL
          AND (
            ${versionNumber ?? null}::integer IS NULL
            OR version.version_number = ${versionNumber ?? null}
          )
        ORDER BY version.version_number DESC
        LIMIT 1
      `.pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("read public news HTTP article source", cause)),
        ),
      );
      const row = rows[0];
      if (row === undefined) return yield* new ContentArticleNotFound({});
      return yield* Schema.decodeUnknownEffect(PublishedNewsArticleHttpSourceSchema)(row, {
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError((cause) => decodeError("decode public news HTTP article source", cause)),
      );
    }),
  );
