import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Database, type DatabaseShape } from "../database/service.js";
import type { OrganizationPersonAuthority } from "../organization/authority.js";
import { DepartmentNotFound } from "../organization/errors.js";
import type { DepartmentId, PersonId } from "../organization/schema.js";
import { Organization } from "../organization/service.js";
import { Profile } from "../profile/service.js";
import { canonicalJsonBytes, sha256Hex } from "../tutor/evidence.js";
import {
  createDraftPostgres,
  publishPostgres,
  readArticleDetailPostgres,
  readWorkspacePostgres,
} from "./postgres.js";

const personId = "workspace-editor" as PersonId;
const ownDepartmentId = "department-own" as DepartmentId;
const outsideDepartmentId = "department-outside" as DepartmentId;
const unknownDepartmentId = "department-unknown" as DepartmentId;
const authorizationInstant =
  "2030-01-01T00:00:00.000Z" as OrganizationPersonAuthority["evaluatedAt"];

const authority: OrganizationPersonAuthority = {
  personId,
  evaluatedAt: authorizationInstant,
  globalAdministrator: "Absent",
  memberships: [
    {
      membershipId: "workspace-membership" as never,
      teamId: "workspace-team" as never,
      departmentId: ownDepartmentId,
      active: true,
      teamLeader: false,
    },
  ],
};

const makeDatabase = (
  execute: (
    statement: string,
    values: ReadonlyArray<unknown>,
  ) => Effect.Effect<ReadonlyArray<unknown>, unknown>,
): DatabaseShape => {
  const sql = ((strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>) =>
    execute(strings.join("?"), values)) as unknown as DatabaseShape;
  return Object.assign(sql, {
    withTransaction: <A, E, R>(program: Effect.Effect<A, E, R>) => program,
    json: (value: unknown) => value as never,
    in: () => ({}) as never,
  });
};

const database = makeDatabase(() => Effect.succeed([]));

const organization = {
  resolvePersonAuthorityForRead: () => Effect.succeed(authority),
  readDepartment: (departmentId: DepartmentId) =>
    departmentId === unknownDepartmentId
      ? Effect.fail(new DepartmentNotFound({ departmentId }))
      : Effect.succeed({ departmentId } as never),
} as never;

describe("content workspace department scope", () => {
  it.effect("returns typed NotInScope for a known department outside the actor authority", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        readWorkspacePostgres({
          personId,
          authorizationInstant,
          query: { departmentId: outsideDepartmentId },
        }).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Organization, organization),
          Effect.provideService(Profile, {} as never),
        ),
      );
      expect(failure._tag).toBe("NotInScope");
    }),
  );

  it.effect("keeps an unknown department distinct as DepartmentNotFound", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        readWorkspacePostgres({
          personId,
          authorizationInstant,
          query: { departmentId: unknownDepartmentId },
        }).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Organization, organization),
          Effect.provideService(Profile, {} as never),
        ),
      );
      expect(failure._tag).toBe("DepartmentNotFound");
      if (failure._tag === "DepartmentNotFound") {
        expect(failure.departmentId).toBe(unknownDepartmentId);
      }
    }),
  );
});
describe("content article detail authority", () => {
  const storedDetail = {
    articleId: 71,
    title: "Eksakt kladd",
    slug: "eksakt-kladd",
    bodyHtml: "<p>Private arbeidskopibytes</p>",
    sticky: false,
    createdByPersonId: personId,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T01:00:00.000Z",
    currentVersionNumber: null,
    revision: 4,
  } as const;

  const detailDatabase = makeDatabase((statement) =>
    Effect.succeed(
      statement.includes("FROM public.content_articles AS article")
        ? [storedDetail]
        : statement.includes("FROM public.content_article_departments")
          ? [{ articleId: storedDetail.articleId, departmentId: ownDepartmentId }]
          : [],
    ),
  );

  it.effect("returns body and revision without the private creator id", () =>
    Effect.gen(function* () {
      const detail = yield* readArticleDetailPostgres({
        articleId: storedDetail.articleId as never,
        personId,
        authorizationInstant,
      }).pipe(
        Effect.provideService(Database, detailDatabase),
        Effect.provideService(Organization, organization),
        Effect.provideService(Profile, {
          readProfiles: () => Effect.succeed([{ firstName: "Erik", lastName: "Redaktør" }]),
        } as never),
      );

      expect(detail).toEqual({
        articleId: 71,
        title: "Eksakt kladd",
        slug: "eksakt-kladd",
        status: "Draft",
        bodyHtml: "<p>Private arbeidskopibytes</p>",
        sticky: false,
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T01:00:00.000Z",
        currentVersionNumber: null,
        revision: 4,
        departmentIds: [ownDepartmentId],
        canRevise: true,
        canPublish: false,
        authorDisplayName: "Erik Redaktør",
      });
      expect("createdByPersonId" in detail).toBe(false);
    }),
  );
  it.effect("blocks the member author from revising their published article", () =>
    Effect.gen(function* () {
      const publishedOwnDatabase = makeDatabase((statement) =>
        Effect.succeed(
          statement.includes("FROM public.content_articles AS article")
            ? [{ ...storedDetail, currentVersionNumber: 1 }]
            : statement.includes("FROM public.content_article_departments")
              ? [{ articleId: storedDetail.articleId, departmentId: ownDepartmentId }]
              : [],
        ),
      );
      const failure = yield* Effect.flip(
        readArticleDetailPostgres({
          articleId: storedDetail.articleId as never,
          personId,
          authorizationInstant,
        }).pipe(
          Effect.provideService(Database, publishedOwnDatabase),
          Effect.provideService(Organization, organization),
          Effect.provideService(Profile, {} as never),
        ),
      );
      expect(failure._tag).toBe("DraftNotOwned");
    }),
  );

  it.effect("maps absence and foreign drafts to typed failures", () =>
    Effect.gen(function* () {
      const missing = yield* Effect.flip(
        readArticleDetailPostgres({
          articleId: 999 as never,
          personId,
          authorizationInstant,
        }).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Organization, organization),
          Effect.provideService(Profile, {} as never),
        ),
      );
      expect(missing._tag).toBe("ArticleNotFound");

      const foreignDatabase = makeDatabase((statement) =>
        Effect.succeed(
          statement.includes("FROM public.content_articles AS article")
            ? [{ ...storedDetail, createdByPersonId: "another-editor" }]
            : statement.includes("FROM public.content_article_departments")
              ? [{ articleId: storedDetail.articleId, departmentId: ownDepartmentId }]
              : [],
        ),
      );
      const denied = yield* Effect.flip(
        readArticleDetailPostgres({
          articleId: storedDetail.articleId as never,
          personId,
          authorizationInstant,
        }).pipe(
          Effect.provideService(Database, foreignDatabase),
          Effect.provideService(Organization, organization),
          Effect.provideService(Profile, {} as never),
        ),
      );
      expect(denied._tag).toBe("DraftNotOwned");
    }),
  );
});

describe("content command receipts and sequencing", () => {
  const createCommand = {
    commandId: "content-create-replay",
    title: "Replay article",
    bodyHtml: "<p>Stored body</p>",
    departmentIds: [ownDepartmentId],
    sticky: false,
  } as const;
  const storedDraft = {
    articleId: 41,
    title: "Replay article",
    slug: "replay-article",
    bodyHtml: "<p>Stored body</p>",
    sticky: false,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    currentVersionNumber: null,
    revision: 0,
  } as const;
  const createDigest = sha256Hex(canonicalJsonBytes(createCommand));

  it.effect("returns the strict stored draft for an identical create replay", () =>
    Effect.gen(function* () {
      let authorityReads = 0;
      const replayDatabase = makeDatabase((statement) =>
        Effect.succeed(
          statement.includes("FROM public.content_publication_command_receipts")
            ? [
                {
                  commandId: createCommand.commandId,
                  kind: "CreateDraft",
                  payloadSha256: createDigest,
                  resultJson: storedDraft,
                },
              ]
            : [],
        ),
      );
      const replayed = yield* createDraftPostgres({
        command: createCommand as never,
        personId,
        authorizationInstant,
      }).pipe(
        Effect.provideService(Database, replayDatabase),
        Effect.provideService(Organization, {
          resolvePersonAuthorityForRead: () => {
            authorityReads += 1;
            return Effect.succeed(authority);
          },
        } as never),
      );

      expect(replayed).toEqual(storedDraft);
      expect(authorityReads).toBe(0);
    }),
  );

  it.effect("rejects command id reuse across a different command kind", () =>
    Effect.gen(function* () {
      const reusedKindDatabase = makeDatabase((statement) =>
        Effect.succeed(
          statement.includes("FROM public.content_publication_command_receipts")
            ? [
                {
                  commandId: createCommand.commandId,
                  kind: "Publish",
                  payloadSha256: createDigest,
                  resultJson: storedDraft,
                },
              ]
            : [],
        ),
      );
      const failure = yield* Effect.flip(
        createDraftPostgres({
          command: createCommand as never,
          personId,
          authorizationInstant,
        }).pipe(
          Effect.provideService(Database, reusedKindDatabase),
          Effect.provideService(Organization, {} as never),
        ),
      );

      expect(failure._tag).toBe("CommandConflict");
    }),
  );

  it.effect("rejects command id reuse with different canonical command bytes", () =>
    Effect.gen(function* () {
      const reusedBytesDatabase = makeDatabase((statement) =>
        Effect.succeed(
          statement.includes("FROM public.content_publication_command_receipts")
            ? [
                {
                  commandId: createCommand.commandId,
                  kind: "CreateDraft",
                  payloadSha256: createDigest,
                  resultJson: storedDraft,
                },
              ]
            : [],
        ),
      );
      const failure = yield* Effect.flip(
        createDraftPostgres({
          command: { ...createCommand, title: "Different canonical bytes" } as never,
          personId,
          authorizationInstant,
        }).pipe(
          Effect.provideService(Database, reusedBytesDatabase),
          Effect.provideService(Organization, {} as never),
        ),
      );

      expect(failure._tag).toBe("CommandConflict");
    }),
  );

  it.effect("rejects excess properties in a stored create observation", () =>
    Effect.gen(function* () {
      const invalidObservationDatabase = makeDatabase((statement) =>
        Effect.succeed(
          statement.includes("FROM public.content_publication_command_receipts")
            ? [
                {
                  commandId: createCommand.commandId,
                  kind: "CreateDraft",
                  payloadSha256: createDigest,
                  resultJson: { ...storedDraft, privateLeak: "must fail closed" },
                },
              ]
            : [],
        ),
      );
      const failure = yield* Effect.flip(
        createDraftPostgres({
          command: createCommand as never,
          personId,
          authorizationInstant,
        }).pipe(
          Effect.provideService(Database, invalidObservationDatabase),
          Effect.provideService(Organization, {} as never),
        ),
      );

      expect(failure._tag).toBe("ContentPersistenceError");
    }),
  );

  it.effect("maps a lost unique-slug insertion race to SlugConflict", () =>
    Effect.gen(function* () {
      const uniqueRaceDatabase = makeDatabase((statement) => {
        if (statement.includes("INSERT INTO public.content_articles")) {
          return Effect.fail({
            _tag: "SqlError",
            cause: { code: "23505", constraint: "content_articles_slug_unique" },
          });
        }
        return Effect.succeed([]);
      });
      const administratorAuthority: OrganizationPersonAuthority = {
        personId,
        evaluatedAt: authorizationInstant,
        globalAdministrator: "Active",
        memberships: [],
      };
      const failure = yield* Effect.flip(
        createDraftPostgres({
          command: {
            ...createCommand,
            commandId: "content-create-slug-race",
            departmentIds: [],
          } as never,
          personId,
          authorizationInstant,
        }).pipe(
          Effect.provideService(Database, uniqueRaceDatabase),
          Effect.provideService(Organization, {
            resolvePersonAuthorityForRead: () => Effect.succeed(administratorAuthority),
          } as never),
        ),
      );

      expect(failure._tag).toBe("SlugConflict");
    }),
  );

  it.effect("issues a republish version from immutable MAX rather than the cleared pointer", () =>
    Effect.gen(function* () {
      let selectedImmutableMaximum = false;
      const republishDatabase = makeDatabase((statement) => {
        if (statement.includes("FROM public.content_publication_command_receipts")) {
          return Effect.succeed([]);
        }
        if (
          statement.includes("FROM public.content_articles AS article") &&
          statement.includes("FOR UPDATE")
        ) {
          return Effect.succeed([
            {
              articleId: 41,
              createdByPersonId: personId,
              title: "Republish article",
              slug: "republish-article",
              bodyHtml: "<p>body</p>",
              sticky: false,
              createdAt: "2030-01-01T00:00:00.000Z",
              updatedAt: "2030-01-01T00:00:00.000Z",
              currentVersionNumber: null,
              revision: 5,
            },
          ]);
        }
        if (statement.includes("MAX(version_number)")) {
          selectedImmutableMaximum = true;
          return Effect.succeed([{ nextVersionNumber: 4 }]);
        }
        if (statement.includes("INSERT INTO public.content_article_versions")) {
          return Effect.succeed([{ publishedAt: "2030-01-02T00:00:00.000Z" }]);
        }
        return Effect.succeed([]);
      });
      const administratorAuthority: OrganizationPersonAuthority = {
        personId,
        evaluatedAt: authorizationInstant,
        globalAdministrator: "Active",
        memberships: [],
      };
      const observation = yield* publishPostgres({
        command: { commandId: "content-republish-four", articleId: 41 } as never,
        personId,
        authorizationInstant,
      }).pipe(
        Effect.provideService(Database, republishDatabase),
        Effect.provideService(Organization, {
          resolvePersonAuthorityForRead: () => Effect.succeed(administratorAuthority),
        } as never),
      );

      expect(selectedImmutableMaximum).toBe(true);
      expect(observation.versionNumber).toBe(4);
    }),
  );
  it.effect("sanitizes a preexisting working copy before publication", () =>
    Effect.gen(function* () {
      let publishedBody: string | undefined;
      const publishDatabase = makeDatabase((statement, values) => {
        if (statement.includes("FROM public.content_publication_command_receipts")) {
          return Effect.succeed([]);
        }
        if (
          statement.includes("FROM public.content_articles AS article") &&
          statement.includes("FOR UPDATE")
        ) {
          return Effect.succeed([
            {
              articleId: 41,
              createdByPersonId: personId,
              title: "Preexisting article",
              slug: "preexisting-article",
              bodyHtml: "<p>before</p><script>alert(1)</script><p>after</p>",
              sticky: false,
              createdAt: "2030-01-01T00:00:00.000Z",
              updatedAt: "2030-01-01T00:00:00.000Z",
              currentVersionNumber: null,
              revision: 5,
            },
          ]);
        }
        if (statement.includes("MAX(version_number)")) {
          return Effect.succeed([{ nextVersionNumber: 1 }]);
        }
        if (statement.includes("INSERT INTO public.content_article_versions")) {
          publishedBody = values[4] as string;
          return Effect.succeed([{ publishedAt: "2030-01-02T00:00:00.000Z" }]);
        }
        return Effect.succeed([]);
      });
      const administratorAuthority: OrganizationPersonAuthority = {
        personId,
        evaluatedAt: authorizationInstant,
        globalAdministrator: "Active",
        memberships: [],
      };

      yield* publishPostgres({
        command: { commandId: "content-publish-sanitizes-body", articleId: 41 } as never,
        personId,
        authorizationInstant,
      }).pipe(
        Effect.provideService(Database, publishDatabase),
        Effect.provideService(Organization, {
          resolvePersonAuthorityForRead: () => Effect.succeed(administratorAuthority),
        } as never),
      );

      expect(publishedBody).toBe("<p>before</p><p>after</p>");
    }),
  );
  it.effect("rejects an unsafe preexisting working copy before immutable insertion", () =>
    Effect.gen(function* () {
      let immutableInsertAttempted = false;
      const publishDatabase = makeDatabase((statement) => {
        if (statement.includes("FROM public.content_publication_command_receipts")) {
          return Effect.succeed([]);
        }
        if (
          statement.includes("FROM public.content_articles AS article") &&
          statement.includes("FOR UPDATE")
        ) {
          return Effect.succeed([
            {
              articleId: 41,
              createdByPersonId: personId,
              title: "Unsafe article",
              slug: "unsafe-article",
              bodyHtml: '<p><a href="java&#x73;cript:alert(1)">unsafe</a></p>',
              sticky: false,
              createdAt: "2030-01-01T00:00:00.000Z",
              updatedAt: "2030-01-01T00:00:00.000Z",
              currentVersionNumber: null,
              revision: 5,
            },
          ]);
        }
        if (statement.includes("MAX(version_number)")) {
          return Effect.succeed([{ nextVersionNumber: 1 }]);
        }
        if (statement.includes("INSERT INTO public.content_article_versions")) {
          immutableInsertAttempted = true;
        }
        return Effect.succeed([]);
      });
      const administratorAuthority: OrganizationPersonAuthority = {
        personId,
        evaluatedAt: authorizationInstant,
        globalAdministrator: "Active",
        memberships: [],
      };

      const failure = yield* Effect.flip(
        publishPostgres({
          command: { commandId: "content-publish-rejects-unsafe-body", articleId: 41 } as never,
          personId,
          authorizationInstant,
        }).pipe(
          Effect.provideService(Database, publishDatabase),
          Effect.provideService(Organization, {
            resolvePersonAuthorityForRead: () => Effect.succeed(administratorAuthority),
          } as never),
        ),
      );

      expect(failure._tag).toBe("ContentDecodeError");
      expect(immutableInsertAttempted).toBe(false);
    }),
  );
});

describe("content create department authority", () => {
  it.effect("prevents a publisher from selecting an active non-leader membership", () =>
    Effect.gen(function* () {
      const publisherAuthority: OrganizationPersonAuthority = {
        personId,
        evaluatedAt: authorizationInstant,
        globalAdministrator: "Absent",
        memberships: [
          {
            membershipId: "leader-own" as never,
            teamId: "leader-team" as never,
            departmentId: ownDepartmentId,
            active: true,
            teamLeader: true,
          },
          {
            membershipId: "member-outside" as never,
            teamId: "member-team" as never,
            departmentId: outsideDepartmentId,
            active: true,
            teamLeader: false,
          },
        ],
      };
      const scopedDatabase = makeDatabase(() => Effect.succeed([]));
      const failure = yield* Effect.flip(
        createDraftPostgres({
          command: {
            commandId: "content-create-widening",
            title: "No widening",
            bodyHtml: "<p>body</p>",
            departmentIds: [outsideDepartmentId],
          } as never,
          personId,
          authorizationInstant,
        }).pipe(
          Effect.provideService(Database, scopedDatabase),
          Effect.provideService(Organization, {
            resolvePersonAuthorityForRead: () => Effect.succeed(publisherAuthority),
          } as never),
        ),
      );

      expect(failure._tag).toBe("NotInScope");
    }),
  );

  it.effect("requires non-administrators to select at least one department", () =>
    Effect.gen(function* () {
      const scopedDatabase = makeDatabase(() => Effect.succeed([]));
      const failure = yield* Effect.flip(
        createDraftPostgres({
          command: {
            commandId: "content-create-empty-scope",
            title: "No empty scope",
            bodyHtml: "<p>body</p>",
            departmentIds: [],
          } as never,
          personId,
          authorizationInstant,
        }).pipe(
          Effect.provideService(Database, scopedDatabase),
          Effect.provideService(Organization, {
            resolvePersonAuthorityForRead: () => Effect.succeed(authority),
          } as never),
        ),
      );

      expect(failure._tag).toBe("NotInScope");
    }),
  );
});
