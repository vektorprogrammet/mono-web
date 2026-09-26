import { IdentitySnapshot } from "@vektorprogrammet/database";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import {
  ARTICLE_SLUG_MAX_LENGTH,
  Content,
  ContentArticleNotFound,
  ContentDepartmentNotFound,
  ContentIntegrityError,
  ContentManagement,
  ContentPersistenceError,
  type ContentManagementFailure,
} from "@vektorprogrammet/domain/content";
import { IdentityActor } from "@vektorprogrammet/domain/identity";
import { DepartmentId, Organization, PersonId } from "@vektorprogrammet/domain/organization";
import { ContentApi, ExternalNativeApi } from "@vektorprogrammet/http-api";
import { NativeProblem } from "@vektorprogrammet/http-api/http-semantics";
import { DateTime, Effect, Layer, Schema } from "effect";
import { OpenApi } from "effect/unstable/httpapi";
import { describe, expect, it } from "vitest";
import { makeContentManagementTestHttp, makePublicNewsTestHttp } from "../test/native-http.js";
import { contentOperationId } from "./http-context.js";

/** Checks a problem response and decodes its body with the contract's problem schema. */
const expectProblem = async (response: Response, status: number, code: string): Promise<void> => {
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const problem = Schema.decodeUnknownSync(NativeProblem)(await response.json());
  expect([response.status, problem.code]).toEqual([status, code]);
};

/** A request with a staff session cookie from the trusted dashboard origin. */
const staffRequest = (
  path: string,
  init: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  } = {},
) =>
  new Request(`http://backend.test${path}`, {
    method: init.method,
    headers: {
      cookie: "better-auth.session_token=content-staff",
      origin: "http://127.0.0.1:5174",
      ...init.headers,
    },
    body: init.body,
  });

const staffPerson = PersonId.make("content-staff");

/**
 * One content administrator. The test services leave the Identity engine
 * unavailable, so person security admits every request to the handler, which
 * resolves the person itself.
 */
const administrator = Layer.mergeAll(
  Layer.mock(IdentitySnapshot, {
    resolveSession: () =>
      Effect.succeed(
        new IdentityActor({
          personId: staffPerson,
          sessionId: "content-staff-session",
          expiresAt: DateTime.makeUnsafe(new Date("2099-01-01T00:00:00.000Z")),
        }),
      ),
  }),
  Layer.mock(Organization, {
    resolvePersonAuthority: (personId, evaluatedAt) =>
      Effect.succeed({ personId, evaluatedAt, globalAdministrator: "Active", memberships: [] }),
    resolvePersonAuthorityForRead: (personId, evaluatedAt) =>
      Effect.succeed({ personId, evaluatedAt, globalAdministrator: "Active", memberships: [] }),
  }),
);

const signedIn = () =>
  Effect.succeed({ personId: staffPerson, authorizationInstant: "2030-01-01T00:00:00.000Z" });

describe("native content HTTP boundary", () => {
  it("identifies every content endpoint by the operation id the published contract assigns it", () => {
    const methods: ReadonlyArray<OpenApi.OpenAPISpecMethodName> = [
      "get",
      "put",
      "post",
      "delete",
      "options",
      "head",
      "patch",
      "trace",
    ];

    const publishedRoutes = new Map(
      Object.entries(OpenApi.fromApi(ExternalNativeApi).paths).flatMap(([path, item]) =>
        methods.flatMap((method) => {
          const operation = item[method];

          return operation === undefined
            ? []
            : [
                [
                  operation.operationId,
                  `${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ":$1")}`,
                ] as const,
              ];
        }),
      ),
    );

    const endpoints = Object.values(ContentApi.endpoints);

    expect(endpoints.map((endpoint) => publishedRoutes.get(contentOperationId(endpoint)))).toEqual(
      endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`),
    );
  });

  it("answers owned domain failures with the problems their operations declare", async () => {
    const cases: ReadonlyArray<readonly [string, ContentManagementFailure, number, string]> = [
      ["/api/content/articles/1", new ContentArticleNotFound({}), 404, "content.article-not-found"],
      [
        "/api/content/articles/1",
        new ContentIntegrityError({ operation: "read", message: "missing author" }),
        500,
        "content.integrity-error",
      ],
      [
        "/api/content/articles/1",
        new ContentPersistenceError({ operation: "read", message: "database unavailable" }),
        503,
        "content.unavailable",
      ],
      [
        "/api/content/articles?department=department-1",
        new ContentDepartmentNotFound({ departmentId: DepartmentId.make("department-1") }),
        422,
        "content.department-not-found",
      ],
    ];

    for (const [path, failure, status, code] of cases) {
      const content = Layer.mock(ContentManagement, {
        readArticleDetail: () => Effect.fail(failure),
        readWorkspace: () => Effect.fail(failure),
      });

      const response = await makeContentManagementTestHttp(
        signedIn,
        Layer.merge(administrator, content),
      ).fetch(staffRequest(path));

      await expectProblem(response, status, code);
      expect(response.headers.get("retry-after")).toBe(status === 503 ? "5" : null);
    }
  });

  it("answers a slug conflict from inside the create transaction", async () => {
    const response = await makeContentManagementTestHttp(signedIn, administrator).fetch(
      staffRequest("/api/content/articles", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "content-create-slug-conflict",
        },
        // The title leaves no letter or digit to build a slug from.
        body: JSON.stringify({ title: "!!!", bodyHtml: "<p>Tekst</p>", departmentIds: [] }),
      }),
    );

    await expectProblem(response, 422, "content.slug-conflict");
  });

  it("routes an article slug of the maximum length to the news read", async () => {
    const slug = "a".repeat(ARTICLE_SLUG_MAX_LENGTH);
    const reads: Array<string> = [];

    const content = Layer.mock(Content, {
      readPublishedArticle: (requested) => {
        reads.push(requested);

        return Effect.fail(new ContentArticleNotFound({}));
      },
    });

    const response = await makePublicNewsTestHttp(content).fetch(
      new Request(`http://backend.test/api/news/${slug}`),
    );

    await expectProblem(response, 404, "content.article-not-found");
    expect(reads).toEqual([slug]);
  });

  it("answers a person rejected after ingress from the credential the request presented", async () => {
    // The test services leave Identity unavailable, so person security admits
    // the request, and the handler's own person resolution rejects it.
    const http = makeContentManagementTestHttp(
      () => Effect.fail(new UnauthenticatedActor({ message: "authentication required" })),
      Layer.empty,
    );

    for (const [headers, code] of [
      [{ cookie: "better-auth.session_token=content-staff" }, "credential.invalid"],
      [{}, "credential.missing"],
    ] as const) {
      const response = await http.fetch(
        new Request("http://backend.test/api/content/articles", { headers }),
      );

      await expectProblem(response, 401, code);
      expect(response.headers.get("www-authenticate")).toBe(
        'VektorSession realm="native-api", Bearer realm="native-api"',
      );
    }
  });

  it("reads one bounded JSON body of its media type before decoding it", async () => {
    const http = makeContentManagementTestHttp(
      () => Effect.die("unexpected person resolution"),
      Layer.empty,
    );

    const create = (headers: Record<string, string>, body: string) =>
      http.fetch(
        staffRequest("/api/content/articles", {
          method: "POST",
          headers: { "idempotency-key": "content-body-test-0000000", ...headers },
          body,
        }),
      );

    await expectProblem(
      await create({ "content-type": "text/plain" }, "{}"),
      415,
      "media-type.unsupported",
    );
    await expectProblem(
      await create({ "content-type": "application/json", "content-length": "1048577" }, "{}"),
      413,
      "request.too-large",
    );
    await expectProblem(
      await create({ "content-type": "application/json", "content-length": "+2" }, "{}"),
      400,
      "request.malformed",
    );
    await expectProblem(
      await create({ "content-type": "application/json" }, '{"title":"first","title":"second"}'),
      400,
      "request.malformed",
    );
  });
});
