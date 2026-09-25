import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import {
  ContentArticleNotFound,
  ContentDepartmentNotFound,
  ContentIntegrityError,
  ContentPersistenceError,
  ContentSlugConflict,
} from "@vektorprogrammet/domain/content";
import { DepartmentId } from "@vektorprogrammet/domain/organization";
import { ContentApi, ExternalNativeApi } from "@vektorprogrammet/http-api";
import { Effect, Layer } from "effect";
import { OpenApi } from "effect/unstable/httpapi";
import { describe, expect, it } from "vitest";
import { personPresentation } from "../http-api/problem.js";
import { makeContentManagementTestHttp } from "../test/native-http.js";
import { contentOperationId } from "./http-context.js";
import { readContentRequestBody } from "./http-decode.js";
import { contentHttpErrorResponse } from "./http-problem.js";

const expectProblem = async (response: Response, status: number, code: string): Promise<void> => {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body).toMatchObject({
    type: `urn:vektorprogrammet:problem:v0.2:${code}`,
    status,
    code,
  });
  expect(body).not.toHaveProperty("error");
};

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

  it("maps owned domain failures to closed RFC 9457 problems", async () => {
    const cases = [
      [new ContentArticleNotFound({}), 404, "content.article-not-found"],
      [new ContentSlugConflict({}), 422, "content.slug-conflict"],
      [
        new ContentDepartmentNotFound({ departmentId: DepartmentId.make("department-1") }),
        422,
        "content.department-not-found",
      ],
      [
        new ContentIntegrityError({ operation: "read", message: "missing author" }),
        500,
        "content.integrity-error",
      ],
      [
        new ContentPersistenceError({ operation: "read", message: "database unavailable" }),
        503,
        "content.unavailable",
      ],
    ] as const;

    const presentation = personPresentation(
      new Request("http://backend.test/api/content/articles"),
    );

    for (const [failure, status, code] of cases) {
      await expectProblem(contentHttpErrorResponse(failure, presentation), status, code);
    }

    expect(contentHttpErrorResponse(cases[4][0], presentation).headers.get("retry-after")).toBe(
      "5",
    );
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

  it("enforces media type and bounded request bodies before JSON decoding", async () => {
    const wrongMedia = new Request("http://backend.test/api/content/articles", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });

    const oversized = new Request("http://backend.test/api/content/articles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"title":"too large"}',
    });

    await expect(
      Effect.runPromise(readContentRequestBody(wrongMedia, "application/json", 1024)),
    ).rejects.toMatchObject({
      code: "media-type.unsupported",
      status: 415,
    });
    await expect(
      Effect.runPromise(readContentRequestBody(oversized, "application/json", 4)),
    ).rejects.toMatchObject({
      code: "request.too-large",
      status: 413,
    });
  });

  it("rejects duplicate JSON members before schema decoding", async () => {
    const duplicate = new Request("http://backend.test/api/content/articles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"title":"first","title":"second"}',
    });

    await expect(
      Effect.runPromise(readContentRequestBody(duplicate, "application/json", 1024)),
    ).rejects.toMatchObject({
      code: "request.malformed",
      status: 400,
    });
  });
});
