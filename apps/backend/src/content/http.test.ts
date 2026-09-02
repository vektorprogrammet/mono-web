import {
  ContentArticleNotFound,
  ContentDepartmentNotFound,
  ContentIntegrityError,
  ContentPersistenceError,
  ContentSlugConflict,
} from "@vektorprogrammet/domain/content";
import { DepartmentId } from "@vektorprogrammet/domain/organization";
import { describe, expect, it } from "vitest";
import { HttpSemanticFailure } from "../http-semantics.js";
import {
  CONTENT_NATIVE_OPERATION_IDS,
  contentHttpErrorResponse,
  readContentRequestBody,
} from "./http.js";

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
  it("registers the complete frozen owned-operation inventory exactly once", () => {
    expect(CONTENT_NATIVE_OPERATION_IDS).toEqual([
      "content.readContentWorkspace",
      "content.createArticle",
      "content.readArticle",
      "content.reviseArticle",
      "content.publishArticle",
      "content.unpublishArticle",
      "content.listNews",
      "content.readNewsArticle",
    ]);
    expect(
      CONTENT_NATIVE_OPERATION_IDS.every(
        (operationId, index) => CONTENT_NATIVE_OPERATION_IDS.indexOf(operationId) === index,
      ),
    ).toBe(true);
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

    for (const [failure, status, code] of cases) {
      await expectProblem(contentHttpErrorResponse(failure), status, code);
    }
    expect(contentHttpErrorResponse(cases[4][0]).headers.get("retry-after")).toBe("5");
  });

  it("adds both challenges to person credential failures", async () => {
    const response = contentHttpErrorResponse(new HttpSemanticFailure("credential.invalid", 401));

    await expectProblem(response, 401, "credential.invalid");
    expect(response.headers.get("www-authenticate")).toBe(
      'VektorSession realm="native-api", Bearer realm="native-api"',
    );
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
      readContentRequestBody(wrongMedia, "application/json", 1024),
    ).rejects.toMatchObject({
      code: "media-type.unsupported",
      status: 415,
    });
    await expect(readContentRequestBody(oversized, "application/json", 4)).rejects.toMatchObject({
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

    await expect(readContentRequestBody(duplicate, "application/json", 1024)).rejects.toMatchObject(
      {
        code: "request.malformed",
        status: 400,
      },
    );
  });
});
