import {
  ContentArticleDetailSchema,
  CreateArticleRequest,
  IdempotencyKey,
  StrongETag,
} from "@vektorprogrammet/http-api";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createPromiseClient } from "../src/promise.js";

const idempotencyKey = IdempotencyKey.make("content-idempotency-key-0001");
const etag = StrongETag.make('"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"');
const articleId = ContentArticleDetailSchema.fields.articleId.make(7);
const createPayload = Schema.decodeUnknownSync(CreateArticleRequest)({
  title: "Tittel",
  bodyHtml: "<p>Brødtekst</p>",
  departmentIds: ["department-1"],
});

const credentialProblem = {
  type: "urn:vektorprogrammet:problem:v0.2:credential.missing",
  title: "Credential required",
  status: 401,
  detail: "A credential is required for this operation.",
  code: "credential.missing",
} as const;

describe("generated content SDK", () => {
  it("uses canonical routes, RFC 9457 errors, and reflected mutation headers", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify(credentialProblem), {
        status: 401,
        headers: { "content-type": "application/problem+json" },
      });
    });
    const client = createPromiseClient("http://api.test", {
      cookie: "better-auth.session_token=content-session",
      fetch,
    });

    await Promise.allSettled([
      client.content.readContentWorkspace({ query: {} }),
      client.content.readArticle({ params: { articleId }, headers: {} }),
      client.content.createArticle({
        headers: { "idempotency-key": idempotencyKey },
        payload: createPayload,
      }),
      client.content.reviseArticle({
        params: { articleId },
        headers: { "idempotency-key": idempotencyKey, "if-match": etag },
        payload: { sticky: false },
      }),
      client.content.publishArticle({
        params: { articleId },
        headers: { "idempotency-key": idempotencyKey, "if-match": etag },
        payload: {},
      }),
      client.content.unpublishArticle({
        params: { articleId },
        headers: { "idempotency-key": idempotencyKey, "if-match": etag },
        payload: {},
      }),
    ]);

    expect(requests.map(({ method, url }) => [method, url])).toEqual([
      ["GET", "http://api.test/api/content/articles"],
      ["GET", "http://api.test/api/content/articles/7"],
      ["POST", "http://api.test/api/content/articles"],
      ["PATCH", "http://api.test/api/content/articles/7"],
      ["POST", "http://api.test/api/content/articles/7:publish"],
      ["POST", "http://api.test/api/content/articles/7:unpublish"],
    ]);
    for (const request of requests.slice(2)) {
      expect(request.headers.get("Idempotency-Key")).toBe(idempotencyKey);
    }
    for (const request of requests.slice(3)) {
      expect(request.headers.get("If-Match")).toBe(etag);
    }
    const mutationBodies = await Promise.all(requests.slice(2).map((request) => request.json()));
    expect(JSON.stringify(mutationBodies)).not.toMatch(/commandId|expectedRevision/u);
  });
});
