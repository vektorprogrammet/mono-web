import {
  ContentCommandId,
  CreateArticleDraftInputSchema,
  PublishArticleInputSchema,
  UnpublishArticleInputSchema,
} from "@vektorprogrammet/domain/content";
import { observePostgresStatements } from "../src/test-support/observe-postgres.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createDraftPostgres,
  publishPostgres,
  readNewsListingPostgres,
  unpublishPostgres,
} from "@vektorprogrammet/database/content";
import {
  OrganizationAuthorityInstantSchema,
  type OrganizationAuthorityInstant,
  PersonId,
} from "@vektorprogrammet/domain/organization";
import { Database, type DatabaseOperations } from "../src/service.js";
import { OrganizationLive } from "@vektorprogrammet/database/organization";
import { ProfileLive } from "@vektorprogrammet/database/profile";
import { Predicate, Config, Deferred, Effect, Fiber, Layer, Redacted } from "effect";
import { DatabaseLive } from "../src/layers.js";

const makeProofLayer = (url: Redacted.Redacted<string>, applicationName: string) => {
  const databaseLayer = DatabaseLive({
    url: Redacted.make(Redacted.value(url)),
    applicationName,
    maxConnections: 1,
  });

  const organizationLayer = OrganizationLive.pipe(Layer.provide(databaseLayer));

  const profileLayer = ProfileLive.pipe(
    Layer.provide(Layer.merge(databaseLayer, organizationLayer)),
  );

  return Layer.mergeAll(databaseLayer, organizationLayer, profileLayer);
};

const assertDisposablePostgres = (url: Redacted.Redacted<string>): void => {
  const parsed = new URL(Redacted.value(url));
  assert.ok(["postgres:", "postgresql:"].includes(parsed.protocol));
  assert.ok(["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname));
  assert.match(decodeURIComponent(parsed.pathname.slice(1)), /proof|test/u);
};

const pauseAfterSlugScan = (
  sql: DatabaseOperations,
  ready: Deferred.Deferred<void>,
  start: Deferred.Deferred<void>,
): DatabaseOperations =>
  observePostgresStatements(sql, (statement, text) => {
    if (!text.includes("SELECT slug FROM public.content_articles")) return statement;

    return statement.pipe(
      Effect.tap(() =>
        Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(start))),
      ),
    );
  });

const pauseAfterVersionInsert = (
  sql: DatabaseOperations,
  ready: Deferred.Deferred<void>,
  resume: Deferred.Deferred<void>,
): DatabaseOperations =>
  observePostgresStatements(sql, (statement, text) => {
    if (!text.includes("INSERT INTO public.content_article_versions")) return statement;

    return statement.pipe(
      Effect.tap(() =>
        Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(resume))),
      ),
    );
  });

const signalBeforeArticleLock = (
  sql: DatabaseOperations,
  started: Deferred.Deferred<void>,
): DatabaseOperations =>
  observePostgresStatements(sql, (statement, text, values) => {
    if (
      !text.includes("pg_advisory_xact_lock") ||
      !String(values[0]).startsWith("content-article-")
    ) {
      return statement;
    }

    return Deferred.succeed(started, undefined).pipe(Effect.andThen(statement));
  });

const pauseAfterListingRows = (
  sql: DatabaseOperations,
  articleId: number,
  ready: Deferred.Deferred<void>,
  resume: Deferred.Deferred<void>,
  snapshotVersion: Deferred.Deferred<number | null>,
): DatabaseOperations =>
  observePostgresStatements(sql, (statement, text) => {
    if (
      !text.includes("FROM public.content_article_versions AS version") ||
      !text.includes('AS "publishedByPersonId"')
    ) {
      return statement;
    }

    return statement.pipe(
      Effect.flatMap((rows) =>
        Deferred.succeed(ready, undefined).pipe(
          Effect.andThen(Deferred.await(resume)),
          Effect.andThen(sql<{ readonly versionNumber: number | null }>`
              SELECT CAST(current_version_number AS integer) AS "versionNumber"
              FROM public.content_articles
              WHERE article_id = ${articleId}
            `),
          Effect.tap((versions) =>
            Deferred.succeed(snapshotVersion, versions[0]?.versionNumber ?? null),
          ),
          Effect.as(rows),
        ),
      ),
    );
  });

const createContender = (input: {
  readonly databaseUrl: Redacted.Redacted<string>;
  readonly applicationName: string;
  readonly commandId: string;
  readonly title: string;
  readonly personId: string;
  readonly authorizationInstant: OrganizationAuthorityInstant;
  readonly ready: Deferred.Deferred<void>;
  readonly start: Deferred.Deferred<void>;
}) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const synchronizedSql = pauseAfterSlugScan(sql, input.ready, input.start);

    return yield* Effect.result(
      createDraftPostgres({
        command: CreateArticleDraftInputSchema.make({
          commandId: ContentCommandId.make(input.commandId),
          title: input.title,
          bodyHtml: "<p>Concurrent slug proof</p>",
          departmentIds: [],
        }),
        personId: PersonId.make(input.personId),
        authorizationInstant: input.authorizationInstant,
      }).pipe(Effect.provideService(Database, synchronizedSql)),
    );
  }).pipe(Effect.provide(makeProofLayer(input.databaseUrl, input.applicationName)));

const program = Effect.scoped(
  Effect.gen(function* () {
    const databaseUrl = yield* Config.Redacted("DATABASE_URL");
    assertDisposablePostgres(databaseUrl);
    const runId = `${Date.now().toString(36)}-${randomUUID()}`;
    const personId = `content-proof-admin-${runId}`;

    const authorizationInstant = OrganizationAuthorityInstantSchema.make(
      "2035-01-01T00:00:00.000Z",
    );

    yield* Effect.gen(function* () {
      const sql = yield* Database;
      yield* sql.migrate;
      yield* sql`
        INSERT INTO person_profiles (person_id, first_name, last_name)
        VALUES (${personId}, 'Content', 'Proof Administrator')
      `;
      yield* sql`
        INSERT INTO public.organization_global_administrator_grants (
          grant_id, person_id, start_at, end_at, revision
        ) VALUES (${`content-proof-grant-${runId}`}, ${personId}, '2030-01-01T00:00:00Z', NULL, 0)
      `;
    }).pipe(Effect.provide(makeProofLayer(databaseUrl, "content-postgres-proof-setup")));

    const replayCommand = {
      commandId: ContentCommandId.make(`content-proof-create-replay-${runId}`),
      title: `Content replay ${runId}`,
      bodyHtml: "<p>Replay bytes</p>",
      departmentIds: [],
    } as const;

    const replay = yield* Effect.gen(function* () {
      const first = yield* createDraftPostgres({
        command: CreateArticleDraftInputSchema.make(replayCommand),
        personId: PersonId.make(personId),
        authorizationInstant,
      });

      const second = yield* createDraftPostgres({
        command: CreateArticleDraftInputSchema.make(replayCommand),
        personId: PersonId.make(personId),
        authorizationInstant,
      });

      const sql = yield* Database;

      const [counts] = yield* sql<{ readonly receipts: string; readonly audits: string }>`
        SELECT
          (SELECT count(*)::text FROM public.content_publication_command_receipts
            WHERE command_id = ${replayCommand.commandId}) AS receipts,
          (SELECT count(*)::text FROM public.content_publication_audit
            WHERE command_id = ${replayCommand.commandId}) AS audits
      `;

      return { first, second, counts };
    }).pipe(Effect.provide(makeProofLayer(databaseUrl, "content-postgres-proof-replay")));

    assert.deepEqual(replay.second, replay.first);
    assert.equal(Number(replay.counts?.receipts), 1);
    assert.equal(Number(replay.counts?.audits), 1);

    const kindReuse = yield* Effect.result(
      publishPostgres({
        command: PublishArticleInputSchema.make({
          commandId: ContentCommandId.make(replayCommand.commandId),
          articleId: replay.first.articleId,
        }),
        personId: PersonId.make(personId),
        authorizationInstant,
      }),
    ).pipe(Effect.provide(makeProofLayer(databaseUrl, "content-postgres-proof-kind-reuse")));

    assert.equal(kindReuse._tag, "Failure");

    if (Predicate.isTagged(kindReuse, "Failure"))
      assert.equal(kindReuse.failure._tag, "CommandConflict");

    const readyA = yield* Deferred.make<void>();
    const readyB = yield* Deferred.make<void>();
    const start = yield* Deferred.make<void>();
    const raceTitle = `Content slug race ${runId}`;

    const contenderA = yield* Effect.forkScoped(
      createContender({
        databaseUrl,
        applicationName: "content-postgres-proof-slug-a",
        commandId: `content-proof-slug-a-${runId}`,
        title: raceTitle,
        personId,
        authorizationInstant,
        ready: readyA,
        start,
      }),
    );

    const contenderB = yield* Effect.forkScoped(
      createContender({
        databaseUrl,
        applicationName: "content-postgres-proof-slug-b",
        commandId: `content-proof-slug-b-${runId}`,
        title: raceTitle,
        personId,
        authorizationInstant,
        ready: readyB,
        start,
      }),
    );

    yield* Deferred.await(readyA);
    yield* Deferred.await(readyB);
    yield* Deferred.succeed(start, undefined);

    const slugRace = yield* Effect.all([Fiber.join(contenderA), Fiber.join(contenderB)], {
      concurrency: "unbounded",
    });

    const slugWinners = slugRace.filter((result) => Predicate.isTagged(result, "Success"));

    const slugConflicts = slugRace.filter(
      (result) =>
        Predicate.isTagged(result, "Failure") && Predicate.isTagged(result.failure, "SlugConflict"),
    );

    assert.equal(slugWinners.length, 1);
    assert.equal(slugConflicts.length, 1);
    const raceArticle = slugWinners[0];
    assert.ok(raceArticle !== undefined && Predicate.isTagged(raceArticle, "Success"));

    const republish = yield* Effect.gen(function* () {
      const first = yield* publishPostgres({
        command: PublishArticleInputSchema.make({
          commandId: ContentCommandId.make(`content-proof-publish-1-${runId}`),
          articleId: raceArticle.success.articleId,
        }),
        personId: PersonId.make(personId),
        authorizationInstant,
      });

      yield* unpublishPostgres({
        command: UnpublishArticleInputSchema.make({
          commandId: ContentCommandId.make(`content-proof-unpublish-${runId}`),
          articleId: raceArticle.success.articleId,
        }),
        personId: PersonId.make(personId),
        authorizationInstant,
      });

      const second = yield* publishPostgres({
        command: PublishArticleInputSchema.make({
          commandId: ContentCommandId.make(`content-proof-publish-2-${runId}`),
          articleId: raceArticle.success.articleId,
        }),
        personId: PersonId.make(personId),
        authorizationInstant,
      });

      const sql = yield* Database;

      const versions = yield* sql<{ readonly versionNumber: number }>`
        SELECT version_number AS "versionNumber"
        FROM public.content_article_versions
        WHERE article_id = ${raceArticle.success.articleId}
        ORDER BY version_number
      `;

      return { first, second, versions };
    }).pipe(Effect.provide(makeProofLayer(databaseUrl, "content-postgres-proof-republish")));

    assert.equal(republish.first.versionNumber, 1);
    assert.equal(republish.second.versionNumber, 2);
    assert.deepEqual(
      republish.versions.map((version) => Number(version.versionNumber)),
      [1, 2],
    );
    const atomicPublishCommandId = `content-proof-atomic-publish-${runId}`;
    const atomicUnpublishCommandId = `content-proof-atomic-unpublish-${runId}`;
    const publishInsertReady = yield* Deferred.make<void>();
    const resumePublish = yield* Deferred.make<void>();
    const unpublishLockStarted = yield* Deferred.make<void>();

    const atomicPublish = yield* Effect.forkScoped(
      Effect.gen(function* () {
        const sql = yield* Database;

        return yield* publishPostgres({
          command: PublishArticleInputSchema.make({
            commandId: ContentCommandId.make(atomicPublishCommandId),
            articleId: replay.first.articleId,
          }),
          personId: PersonId.make(personId),
          authorizationInstant,
        }).pipe(
          Effect.provideService(
            Database,
            pauseAfterVersionInsert(sql, publishInsertReady, resumePublish),
          ),
        );
      }).pipe(Effect.provide(makeProofLayer(databaseUrl, "content-postgres-proof-atomic-publish"))),
    );

    yield* Deferred.await(publishInsertReady);

    const atomicUnpublish = yield* Effect.forkScoped(
      Effect.gen(function* () {
        const sql = yield* Database;

        return yield* unpublishPostgres({
          command: UnpublishArticleInputSchema.make({
            commandId: ContentCommandId.make(atomicUnpublishCommandId),
            articleId: replay.first.articleId,
          }),
          personId: PersonId.make(personId),
          authorizationInstant,
        }).pipe(
          Effect.provideService(Database, signalBeforeArticleLock(sql, unpublishLockStarted)),
        );
      }).pipe(
        Effect.provide(makeProofLayer(databaseUrl, "content-postgres-proof-atomic-unpublish")),
      ),
    );

    yield* Deferred.await(unpublishLockStarted);
    yield* Deferred.succeed(resumePublish, undefined);

    const [atomicPublishObservation, atomicUnpublishObservation] = yield* Effect.all(
      [Fiber.join(atomicPublish), Fiber.join(atomicUnpublish)],
      { concurrency: "unbounded" },
    );

    assert.equal(atomicPublishObservation._tag, "Published");
    assert.equal(atomicUnpublishObservation._tag, "Unpublished");

    const atomicFacts = yield* Effect.gen(function* () {
      const sql = yield* Database;

      return yield* sql<{
        readonly currentVersionNumber: number | null;
        readonly versions: string;
        readonly receipts: string;
        readonly audits: string;
      }>`
        SELECT
          CAST(article.current_version_number AS integer) AS "currentVersionNumber",
          (SELECT count(*)::text FROM public.content_article_versions AS version
            WHERE version.article_id = article.article_id) AS versions,
          (SELECT count(*)::text FROM public.content_publication_command_receipts AS receipt
            WHERE receipt.command_id IN (${atomicPublishCommandId}, ${atomicUnpublishCommandId}))
            AS receipts,
          (SELECT count(*)::text FROM public.content_publication_audit AS audit
            WHERE audit.command_id IN (${atomicPublishCommandId}, ${atomicUnpublishCommandId}))
            AS audits
        FROM public.content_articles AS article
        WHERE article.article_id = ${replay.first.articleId}
      `;
    }).pipe(Effect.provide(makeProofLayer(databaseUrl, "content-postgres-proof-atomic-facts")));

    assert.equal(atomicFacts[0]?.currentVersionNumber, null);
    assert.equal(Number(atomicFacts[0]?.versions), 1);
    assert.equal(Number(atomicFacts[0]?.receipts), 2);
    assert.equal(Number(atomicFacts[0]?.audits), 2);

    const listingReady = yield* Deferred.make<void>();
    const resumeListing = yield* Deferred.make<void>();
    const snapshotVersion = yield* Deferred.make<number | null>();

    const listingFiber = yield* Effect.forkScoped(
      Effect.gen(function* () {
        const sql = yield* Database;

        return yield* readNewsListingPostgres().pipe(
          Effect.provideService(
            Database,
            pauseAfterListingRows(
              sql,
              raceArticle.success.articleId,
              listingReady,
              resumeListing,
              snapshotVersion,
            ),
          ),
        );
      }).pipe(Effect.provide(makeProofLayer(databaseUrl, "content-postgres-proof-snapshot-read"))),
    );

    yield* Deferred.await(listingReady);
    const snapshotTitle = `${raceTitle} updated`;

    const concurrentPublish = yield* Effect.gen(function* () {
      const sql = yield* Database;
      yield* sql`
        UPDATE public.content_articles
        SET title = ${snapshotTitle}, updated_at = date_trunc('milliseconds', now(), 'UTC'), revision = revision + 1
        WHERE article_id = ${raceArticle.success.articleId}
      `;

      return yield* publishPostgres({
        command: PublishArticleInputSchema.make({
          commandId: ContentCommandId.make(`content-proof-snapshot-publish-${runId}`),
          articleId: raceArticle.success.articleId,
        }),
        personId: PersonId.make(personId),
        authorizationInstant,
      });
    }).pipe(Effect.provide(makeProofLayer(databaseUrl, "content-postgres-proof-snapshot-publish")));

    assert.equal(concurrentPublish.versionNumber, 3);
    yield* Deferred.succeed(resumeListing, undefined);
    const snapshotListing = yield* Fiber.join(listingFiber);
    const versionInsideSnapshot = yield* Deferred.await(snapshotVersion);
    assert.equal(versionInsideSnapshot, 2);
    assert.equal(
      snapshotListing.articles.find((article) => article.slug === raceArticle.success.slug)?.title,
      raceTitle,
    );

    const currentAfterSnapshot = yield* Effect.gen(function* () {
      const sql = yield* Database;

      const rows = yield* sql<{ readonly versionNumber: number | null }>`
        SELECT CAST(current_version_number AS integer) AS "versionNumber"
        FROM public.content_articles
        WHERE article_id = ${raceArticle.success.articleId}
      `;

      return rows[0]?.versionNumber ?? null;
    }).pipe(Effect.provide(makeProofLayer(databaseUrl, "content-postgres-proof-snapshot-facts")));

    assert.equal(currentAfterSnapshot, 3);

    yield* Effect.sync(() =>
      process.stdout.write(
        `${JSON.stringify({
          specId: "0062",
          database: "PostgreSQL",
          passed: true,
          createReplay: true,
          kindReuseConflict: true,
          concurrentSlugConflict: true,
          republishVersions: [1, 2],
          publishUnpublishSerialized: true,
          atomicReceiptsAndAudit: true,
          repeatableReadSnapshot: { observedVersion: 2, concurrentVersion: 3 },
        })}\n`,
      ),
    );
  }),
);

void Effect.runPromise(program).catch((cause: unknown) => {
  process.stderr.write(`${String(cause)}\n`);
  process.exitCode = 1;
});
