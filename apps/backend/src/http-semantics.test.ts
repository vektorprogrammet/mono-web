import { StrongETag } from "@vektorprogrammet/http-api";
import { describe, expect, it } from "vitest";
import {
  HttpSemanticFailure,
  admissionCacheControl,
  deriveHttpIdentity,
  deriveProfileStrongETag,
  deriveStrongETag,
  encodePathIdentity,
  evaluateMutationPrecondition,
  evaluateReadPreconditions,
  interpretProfileMergePatchSource,
  jsonMutationResponse,
  noContentMutationResponse,
  nativeProblemResponse,
  normalizeTarget,
  parseIdempotencyKey,
  parseIfNoneMatch,
  parseJsonWithoutDuplicateMembers,
  parseReadIfMatch,
  parseRequiredIfMatch,
  responseCapsule,
  responseFromCapsule,
  semanticFile,
  semanticMutationRequest,
  semanticRequestDigest,
} from "./http-semantics.js";
import { decideNativePreflight, makeNativePreflightMethodResolver } from "./native-preflight.js";
import {
  allowsNativePreflightHeaders,
  makeNativeSessionBoundaryPolicy,
  trustedPreflightResponse,
  withTrustedOriginCors,
} from "./session-security.js";

const key = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";
const tagA = StrongETag.make('"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"');
const tagB = StrongETag.make('"vkr2.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"');

describe("native HTTP semantics", () => {
  it("freezes key grammar, identity derivation, and target normalization", () => {
    const decoded = parseIdempotencyKey([key]);
    const target = normalizeTarget("/api/receipts/{receiptId}", {
      receiptId: "receipt /?*",
    });
    expect(target).toBe(`/api/receipts/${encodePathIdentity("receipt /?*")}`);
    expect(target).toBe("/api/receipts/receipt%20%2F%3F%2A");

    const first = deriveHttpIdentity({
      credentialSubject: "Person:person-1",
      qualifiedOperationId: "receipts.reviseReceipt",
      normalizedTarget: target,
      idempotencyKey: decoded,
    });
    const second = deriveHttpIdentity({
      credentialSubject: "Person:person-1",
      qualifiedOperationId: "receipts.reviseReceipt",
      normalizedTarget: target,
      idempotencyKey: decoded,
    });
    expect(first).toEqual(second);
    expect(first.identitySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.commandId).toMatch(/^httpv2_[A-Za-z0-9_-]{43}$/u);

    expect(() => parseIdempotencyKey([key, key])).toThrow(HttpSemanticFailure);
    expect(() => parseIdempotencyKey(["too-short"])).toThrow(HttpSemanticFailure);
    expect(() => encodePathIdentity("\ud800")).toThrow(HttpSemanticFailure);
    expect(() =>
      deriveHttpIdentity({
        credentialSubject: "Person:" as never,
        qualifiedOperationId: "receipts.reviseReceipt",
        normalizedTarget: target,
        idempotencyKey: decoded,
      }),
    ).toThrow(HttpSemanticFailure);
  });

  it("rejects duplicate JSON names before semantic decoding", () => {
    const bytes = new TextEncoder().encode('{"phone":"one","phone":"two"}');
    expect(() => parseJsonWithoutDuplicateMembers(bytes)).toThrow(HttpSemanticFailure);
    expect(parseJsonWithoutDuplicateMembers(new TextEncoder().encode('{"phone":"one"}'))).toEqual({
      phone: "one",
    });
  });
  it("classifies merge-patch absence, values, deletion, and empty objects", () => {
    expect(interpretProfileMergePatchSource({ firstName: "Ada" })).toEqual({
      _tag: "Accepted",
      fields: [
        ["firstName", { _tag: "Value", value: "Ada" }],
        ["lastName", { _tag: "Absent" }],
        ["email", { _tag: "Absent" }],
        ["phone", { _tag: "Absent" }],
      ],
    });
    expect(interpretProfileMergePatchSource({})).toEqual({
      _tag: "Rejected",
      code: "validation.no-change",
      errors: [
        { pointer: "", code: "no-change", message: "The request does not change the resource." },
      ],
    });
    expect(interpretProfileMergePatchSource({ email: null })).toEqual({
      _tag: "Rejected",
      code: "validation.field-not-deletable",
      errors: [
        {
          pointer: "/email",
          code: "field-not-deletable",
          message: "The field cannot be deleted.",
        },
      ],
    });
    expect(interpretProfileMergePatchSource({ "bad/field": true })).toEqual({
      _tag: "Rejected",
      code: "validation.failed",
      errors: [
        {
          pointer: "/bad~1field",
          code: "unknown",
          message: "The property is not supported.",
        },
      ],
    });
  });

  it("uses read-list semantics while keeping mutation If-Match exact", () => {
    expect(parseRequiredIfMatch([`  ${tagA}  `])).toBe(tagA);
    expect(() => parseRequiredIfMatch([])).toThrow(HttpSemanticFailure);
    expect(parseIfNoneMatch([`W/${tagB}, ${tagA}, ${tagA}`])).toEqual([
      [false, "vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
      [true, "vkr2.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"],
    ]);
    expect(parseIfNoneMatch(['"foreign,opaque"'])).toEqual([[false, "foreign,opaque"]]);
    expect(parseReadIfMatch(["*"])).toBe("*");
    expect(parseReadIfMatch(['"*", "opaque*tag"'])).toEqual([
      [false, "*"],
      [false, "opaque*tag"],
    ]);
    expect(() => parseReadIfMatch(['*, "opaque"'])).toThrow(HttpSemanticFailure);
    expect(
      evaluateReadPreconditions({
        currentETag: tagA,
        ifMatch: parseReadIfMatch([`W/${tagA}, ${tagB}`]),
        ifNoneMatch: "*",
      }),
    ).toEqual({ _tag: "Failed", code: "precondition.failed", status: 412 });
    expect(
      evaluateReadPreconditions({
        currentETag: tagA,
        ifMatch: parseReadIfMatch([`W/${tagB}, ${tagA}`]),
        ifNoneMatch: "*",
      }),
    ).toEqual({ _tag: "NotModified" });
    expect(evaluateMutationPrecondition(tagA, tagA)).toEqual({ _tag: "Proceed" });
  });

  it("digests decoded semantics and file bytes rather than multipart syntax", () => {
    const file = semanticFile(new TextEncoder().encode("same file"), "application/pdf");
    const first = semanticRequestDigest({
      body: { amountOre: 1250, file },
      ifMatch: parseReadIfMatch([tagA]),
      ifNoneMatch: null,
      query: {},
    });
    const second = semanticRequestDigest({
      query: {},
      ifNoneMatch: null,
      ifMatch: parseReadIfMatch([tagA]),
      body: { file, amountOre: 1250 },
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => semanticRequestDigest({ body: { value: "\ud800" } })).toThrow(HttpSemanticFailure);
  });

  it("places a mutation If-Match beside its decoded body", () => {
    const body = { description: "Conference", amountOre: 1250 };
    const canonical = semanticMutationRequest(body, tagA);

    expect(canonical).toEqual({ body, ifMatch: tagA });
    expect(semanticRequestDigest(canonical)).not.toBe(
      semanticRequestDigest({ body: { ...body, ifMatch: tagA } }),
    );
  });

  it("derives opaque ETags only from authoritative source records", () => {
    const first = deriveStrongETag({
      representationKind: "ReceiptResource",
      resourceIdentity: "receipt-1",
      version: 2,
    });
    const next = deriveStrongETag({
      representationKind: "ReceiptResource",
      resourceIdentity: "receipt-1",
      version: 3,
    });
    expect(first).toMatch(/^"vkr2\.[A-Za-z0-9_-]{43}"$/u);
    expect(next).not.toBe(first);
  });

  it("uses all persisted Profile revisions and no projected role text", () => {
    const source = {
      personId: "person-1",
      nameRevision: 7,
      contactRevision: 11,
      representationRevision: 3,
    };
    const original = deriveProfileStrongETag(source);
    const changedRoleProjection = { ...source, role: "ROLE_TEAM_LEADER" };
    const samePersistedSourcesAfterRoleProjection = deriveProfileStrongETag(changedRoleProjection);
    const changedName = deriveProfileStrongETag({ ...source, nameRevision: 8 });
    const changedContact = deriveProfileStrongETag({ ...source, contactRevision: 12 });
    const changedRoleRepresentation = deriveProfileStrongETag({
      ...source,
      representationRevision: 4,
    });

    expect(samePersistedSourcesAfterRoleProjection).toBe(original);
    expect(new Set([original, changedName, changedContact, changedRoleRepresentation]).size).toBe(
      4,
    );
  });

  it("does not keep admission freshness across a boundary", () => {
    expect(admissionCacheControl(1_000, [1_000])).toContain("max-age=0");
    expect(admissionCacheControl(1_000, [31_999])).toContain("max-age=30");
    expect(admissionCacheControl(1_000, [])).toContain("max-age=30");
  });

  it("emits safe problems and replays exact stored response bytes", async () => {
    const problem = nativeProblemResponse("idempotency.in-flight", 409);
    expect(problem.headers.get("content-type")).toBe("application/problem+json");
    expect(problem.headers.get("cache-control")).toBe("no-store");
    expect(problem.headers.get("retry-after")).toBe("1");
    expect(await problem.json()).toEqual({
      type: "urn:vektorprogrammet:problem:v0.2:idempotency.in-flight",
      title: "Idempotent request in progress",
      status: 409,
      code: "idempotency.in-flight",
      detail: "A request with this idempotency identity is still in progress.",
    });

    const first = new Response('{"receiptId":"receipt-1"}', {
      status: 201,
      headers: {
        "content-type": "application/json",
        etag: tagA,
        location: "/api/receipts/receipt-1",
        "x-private": "must-not-persist",
      },
    });
    const created = jsonMutationResponse({
      status: 201,
      body: { receiptId: "receipt-1" },
      etag: tagA,
      location: "/api/receipts/receipt-1",
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("location")).toBe("/api/receipts/receipt-1");
    expect(created.headers.get("etag")).toBe(tagA);
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect(() =>
      jsonMutationResponse({
        status: 201,
        body: {},
        etag: tagA,
        location: "https://example.invalid/api/receipts/receipt-1",
      }),
    ).toThrow(HttpSemanticFailure);
    const noContent = noContentMutationResponse();
    expect(noContent.status).toBe(204);
    expect(noContent.headers.has("content-type")).toBe(false);
    expect(noContent.headers.has("location")).toBe(false);
    expect(noContent.headers.get("cache-control")).toBe("no-store");
    const capsule = await responseCapsule(first);
    expect(capsule.headers).not.toHaveProperty("cache-control");
    const replay = responseFromCapsule(capsule);
    expect(replay.status).toBe(201);
    expect(await replay.text()).toBe('{"receiptId":"receipt-1"}');
    expect(replay.headers.get("location")).toBe("/api/receipts/receipt-1");
    expect(replay.headers.get("cache-control")).toBe("no-store");
    expect(replay.headers.has("x-private")).toBe(false);
  });
  it("derives parameterized preflight methods only from supplied route metadata", () => {
    const resolve = makeNativePreflightMethodResolver([
      { method: "GET", path: "/fixture/items/:itemId" },
      { method: "PATCH", path: "/fixture/items/:itemId" },
      { method: "DELETE", path: "/fixture/items" },
    ]);
    expect(resolve("/fixture/items/item-1")).toEqual(["GET", "PATCH"]);
    expect(resolve("/fixture/items")).toEqual(["DELETE"]);
    expect(resolve("/fixture/items/item-1/extra")).toEqual([]);
    expect(
      decideNativePreflight({
        pathname: "/fixture/items/item-1",
        requestedMethod: "POST",
        headersAllowed: true,
        methodsForPath: resolve,
      }),
    ).toEqual({ _tag: "MethodNotAllowed", methods: ["GET", "PATCH"] });
    expect(
      decideNativePreflight({
        pathname: "/fixture/items/item-1",
        requestedMethod: "PATCH",
        headersAllowed: false,
        methodsForPath: resolve,
      }),
    ).toEqual({ _tag: "HeaderMalformed" });
    expect(
      decideNativePreflight({
        pathname: "/fixture/items/item-1",
        requestedMethod: "PATCH",
        headersAllowed: true,
        methodsForPath: resolve,
      }),
    ).toEqual({ _tag: "Ready", methods: ["GET", "PATCH"] });
  });
  it("enforces frozen origins and credentialed CORS response fields", () => {
    const policy = makeNativeSessionBoundaryPolicy({
      NATIVE_IDENTITY_DEPLOYMENT: "preview",
      NATIVE_IDENTITY_TRUSTED_ORIGINS: '["https://p20.vektor.phibkro.org"]',
    });
    expect(policy.secureCookies).toBe(true);
    expect(() =>
      makeNativeSessionBoundaryPolicy({
        NATIVE_IDENTITY_DEPLOYMENT: "preview",
        NATIVE_IDENTITY_TRUSTED_ORIGINS: '["https://p999.vektor.phibkro.org"]',
      }),
    ).toThrow("frozen dev-main or p20 origin");

    const request = new Request("https://api.example.invalid/api/profile", {
      method: "OPTIONS",
      headers: {
        "access-control-request-headers": "Content-Type, If-Match",
      },
    });
    expect(allowsNativePreflightHeaders(request)).toBe(true);
    const preflight = trustedPreflightResponse(policy.trustedOrigins[0]!, ["PATCH", "GET"]);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, HEAD, PATCH, OPTIONS");
    expect(preflight.headers.get("vary")).toBe(
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    );
    const actual = withTrustedOriginCors(
      new Response(null, { status: 204 }),
      policy.trustedOrigins[0]!,
    );
    expect(actual.headers.get("access-control-allow-origin")).toBe(
      "https://p20.vektor.phibkro.org",
    );
    expect(actual.headers.get("access-control-expose-headers")).toBe(
      "ETag, Location, Retry-After, WWW-Authenticate",
    );
    expect(actual.headers.get("vary")).toBe("Origin");
  });
});
