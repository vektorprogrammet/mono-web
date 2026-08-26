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
  ArticleVersionNumber,
  ContentCommandId,
  ContentWorkspaceQuerySchema,
  ContentWorkspaceSchema,
  CreateArticleDraftInputSchema,
  PublishArticleInputSchema,
  PublishObservationSchema,
  ReviseArticleDraftInputSchema,
  UnpublishArticleInputSchema,
  UnpublishObservationSchema,
  ArticleId,
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
        SELECT article_id::text AS "articleId", department_id
        FROM content_article_departments
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
            FROM content_articles AS article
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
            Effect.tapError((cause) =>
              Effect.sync(() => {
                process.stderr?.write?.(`[content-debug] profile error: ${JSON.stringify(String(cause))}\n`);
              }),
            ),
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
        Effect.tapError((cause) =>
          Effect.sync(() => {
            process.stderr?.write?.(
              `[content-ws-debug] failure: ${JSON.stringify(String(cause))}\n`,
            );
          }),
        ),
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("content workspace snapshot", cause)),
        ),
      );
  });

interface CommandReceiptRow {
  readonly commandId: string;
  readonly payloadSha256: string;
  readonly resultJson: unknown;
}

const findCommandReceipt = (
  sql: DatabaseShape,
  commandId: string,
): Effect.Effect<CommandReceiptRow | undefined, ContentPersistenceError> =>
  sql<CommandReceiptRow>`
    SELECT command_id AS "commandId", payload_sha256 AS "payloadSha256", result_json AS "resultJson"
    FROM content_publication_command_receipts
    WHERE command_id = ${commandId}
  `.pipe(
    Effect.map((rows) => rows[0]),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read content command receipt", cause)),
    ),
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
  readonly kind: "CreateDraft" | "ReviseDraft" | "Publish" | "Unpublish";
  readonly payloadBytes: Uint8Array;
  readonly result: unknown;
  readonly actorPersonId: string;
  readonly action: string;
  readonly versionNumber: number | null;
}): Effect.Effect<void, ContentPersistenceError> => {
  const { sql } = input;
  return Effect.gen(function* () {
    yield* sql`
      INSERT INTO content_publication_command_receipts (
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
      INSERT INTO content_publication_audit (
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
      article.created_at AS "createdAt",
      article.updated_at AS "updatedAt",
      article.current_version_number AS "currentVersionNumber",
      article.revision
    FROM content_articles AS article
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
  const clear = sql`DELETE FROM content_article_departments WHERE article_id = ${articleId}`.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("clear content departments", cause)),
    ),
  );
  const insertOne = (departmentId: DepartmentId) =>
    sql`
      INSERT INTO content_article_departments (article_id, department_id)
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
  return Effect.flatMap(clear, () =>
    departmentIds.length === 0
      ? Effect.void
      : Effect.forEach(departmentIds, insertOne, { discard: true }),
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
}): Effect.Effect<
  { readonly _tag: "DraftCreated"; readonly articleId: ArticleId; readonly slug: string },
  ContentManagementFailure,
  Database | Organization
> =>
  Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(CreateArticleDraftInputSchema)(
      input.command,
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError((cause) => decodeError("decode create-draft command", cause)));
    const sanitizedBody = yield* sanitizeArticleBodyHtml(
      "sanitize create-draft body",
      command.bodyHtml,
    );
    const database = yield* Database;
    const organization = yield* Organization;

    const created = yield* database
      .withTransaction(
        Effect.gen(function* () {
          const authority = yield* resolveAuthorityInTransaction({
            organization,
            personId: input.personId,
            authorizationInstant: input.authorizationInstant,
          });
          const actor = yield* authorityDecisionOrDenial(authority, input.authorizationInstant);
          if (actor._tag === "ContentPublisher" || actor._tag === "ContentAdministrator") {
            // Publishers may not create org-wide drafts unless administrators.
          }
          if (
            actor._tag === "ContentEditor" &&
            (command.departmentIds.length === 0 ||
              !command.departmentIds.every((departmentId) =>
                (authority.memberships ?? [])
                  .filter((membership) => membership.active)
                  .some((membership) => membership.departmentId === departmentId),
              ))
          ) {
            return yield* new ContentNotInScope({});
          }
          const sticky = command.sticky ?? false;
          if (sticky && actor._tag === "ContentEditor") {
            const deniedArticleId = ArticleId.make(-1);
            return yield* new ContentNotPublisher({ articleId: deniedArticleId });
          }
          const baseSlug = slugifyTitle(command.title);
          if (!/^[a-z0-9-]+$/.test(baseSlug) || baseSlug.length === 0) {
            return yield* new ContentSlugConflict({});
          }
          const taken = new Set<string>(
            (yield* database<{ readonly slug: string }>`
                SELECT slug FROM content_articles WHERE slug LIKE ${`${baseSlug}%`}
                UNION ALL
                SELECT slug FROM content_article_versions WHERE slug LIKE ${`${baseSlug}%`}
              `.pipe(
              Effect.catchTag("SqlError", (cause) =>
                Effect.fail(persistenceError("read existing slugs", cause)),
              ),
            )).map((row) => row.slug),
          );
          const slug = dedupeSlug(baseSlug, taken);
          const inserted = yield* database<{ readonly articleId: string }>`
            INSERT INTO content_articles (
              title, slug, body_html, sticky, created_by_person_id,
              created_at, updated_at, current_version_number, revision
            ) VALUES (
              ${command.title}, ${slug}, ${sanitizedBody}, ${sticky}, ${input.personId},
              now(), now(), NULL, 0
            )
            RETURNING article_id::text AS "articleId"
          `.pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(persistenceError("insert content draft", cause)),
            ),
          );
          const articleId = ArticleId.make(Number(inserted[0]?.articleId));
          yield* replaceArticleDepartments(database, articleId, command.departmentIds);
          const observation = {
            _tag: "DraftCreated" as const,
            commandId: command.commandId,
            articleId,
            slug,
          };
          yield* insertReceiptAndAudit({
            sql: database,
            commandId: command.commandId,
            articleId,
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
    return created;
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
          // Law 9: identical replay returns the stored observation.
          const stored = yield* findCommandReceipt(database, command.commandId);
          if (stored !== undefined) {
            if (stored.payloadSha256 !== payloadDigest) {
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
          const nextVersionNumber = ArticleVersionNumber.make(
            (draft.currentVersionNumber ?? 0) + 1,
          );
          // The publish instant is the database transaction's own clock
          // (spec law 2): now() is inserted and returned as the observation.
          const insertedVersion = yield* database<{ readonly publishedAt: string }>`
            INSERT INTO content_article_versions (
              article_id, version_number, title, slug, body_html, sticky,
              published_at, published_by_person_id
            ) VALUES (
              ${draft.articleId}, ${nextVersionNumber}, ${draft.title}, ${draft.slug},
              ${draft.bodyHtml}, ${draft.sticky}, now(), ${input.personId}
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
            UPDATE content_articles
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
          const stored = yield* findCommandReceipt(database, command.commandId);
          if (stored !== undefined) {
            if (stored.payloadSha256 !== payloadDigest) {
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
            UPDATE content_articles
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

const ReviseReplaySchema = Schema.Struct({
  _tag: Schema.Literals(["DraftRevised"]),
  commandId: ContentCommandId,
  articleId: ArticleId,
  revision: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});

export const reviseDraftPostgres = (input: {
  readonly command: ReviseArticleDraftInput;
  readonly personId: PersonId;
  readonly authorizationInstant: OrganizationAuthorityInstant;
}): Effect.Effect<
  {
    readonly _tag: "DraftRevised";
    readonly commandId: typeof ReviseArticleDraftInputSchema.fields.commandId.Type;
    readonly articleId: ArticleId;
    readonly revision: number;
  },
  ContentManagementFailure,
  Database | Organization
> =>
  Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(ReviseArticleDraftInputSchema)(
      input.command,
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError((cause) => decodeError("decode revise command", cause)));
    const sanitizedBody = yield* sanitizeArticleBodyHtml("sanitize revise body", command.bodyHtml);
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
          const stored = yield* findCommandReceipt(database, command.commandId);
          if (stored !== undefined) {
            if (stored.payloadSha256 !== payloadDigest) {
              return yield* new ContentCommandConflict({ commandId: command.commandId });
            }
            const replayed = Schema.decodeUnknownSync(ReviseReplaySchema)(stored.resultJson);
            return replayed;
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
          const current = departmentIds.get(draft.articleId) ?? [];
          const mergedScope = [...new Set([...current, ...command.departmentIds])];
          if (
            !canReviseDraft(actor, {
              createdByPersonId: draft.createdByPersonId,
              currentVersionNumber: draft.currentVersionNumber,
              departmentIds: mergedScope,
            })
          ) {
            return yield* actor._tag === "ContentEditor"
              ? new ContentDraftNotOwned({ articleId: draft.articleId })
              : new ContentNotPublisher({ articleId: draft.articleId });
          }
          if (draft.revision !== command.expectedRevision) {
            return yield* new ContentCommandConflict({ commandId: command.commandId });
          }
          const sticky = command.sticky ?? draft.sticky;
          if (sticky !== draft.sticky && !canPublishContent(actor, current)) {
            return yield* new ContentNotPublisher({ articleId: draft.articleId });
          }
          yield* database`
            UPDATE content_articles
            SET title = ${command.title}, body_html = ${sanitizedBody}, sticky = ${sticky},
                updated_at = now(), revision = revision + 1
            WHERE article_id = ${draft.articleId}
          `.pipe(
            Effect.asVoid,
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(persistenceError("revise content draft", cause)),
            ),
          );
          yield* replaceArticleDepartments(database, draft.articleId, command.departmentIds);
          const observation = {
            _tag: "DraftRevised" as const,
            commandId: command.commandId,
            articleId: draft.articleId,
            revision: draft.revision + 1,
          };
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
