import { createHash } from "node:crypto";
import { canonicalJson, canonicalJsonBytes } from "@vektorprogrammet/domain/evidence";
import {
  type IdempotencyKey,
  IdempotencyKey as IdempotencyKeySchema,
  makeNativeProblem,
  makeNativeValidationError,
  type NativeProblemCode,
  type NativeValidationError,
  type Sha256Hex,
  type StrongETag,
  type ValidationProblemCode,
  StrongETag as StrongETagSchema,
} from "@vektorprogrammet/http-api/http-semantics";
import { Schema } from "effect";

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const lowerSha256Pattern = /^[a-f0-9]{64}$/u;
const entityTagPattern = /^(W\/)?"([\x21\x23-\x7E]*)"$/u;

export type CredentialSubject =
  | `Person:${string}`
  | `Service:${string}`
  | `Capability:${string}`
  | "Anonymous";

export interface NativeIdempotencyIdentity {
  readonly credentialSubject: CredentialSubject;
  readonly qualifiedOperationId: string;
  readonly normalizedTarget: string;
  readonly idempotencyKey: IdempotencyKey;
}

export type CanonicalEntityTagCondition =
  | "*"
  | ReadonlyArray<readonly [weak: boolean, opaque: string]>;
export type CanonicalIfMatch = CanonicalEntityTagCondition;
export type CanonicalIfNoneMatch = CanonicalEntityTagCondition;

export interface CanonicalSemanticRequest {
  readonly body?: unknown;
  readonly ifMatch?: CanonicalIfMatch | StrongETag | null;
  readonly ifNoneMatch?: CanonicalIfNoneMatch | null;
  readonly query?: Readonly<Record<string, unknown>>;
}

export class HttpSemanticFailure extends Error {
  readonly name = "HttpSemanticFailure";

  constructor(
    readonly code: NativeProblemCode,
    readonly status: number,
  ) {
    super(code);
  }
}

const sha256Bytes = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

const base64urlNoPad = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

export const sha256Hex = (bytes: Uint8Array): Sha256Hex =>
  createHash("sha256").update(bytes).digest("hex") as Sha256Hex;

const isUnicodeScalarString = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const validateJcsValue = (value: unknown, seen: Set<object>): void => {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (!isUnicodeScalarString(value)) throw new HttpSemanticFailure("request.malformed", 400);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new HttpSemanticFailure("request.malformed", 400);
    return;
  }
  if (typeof value !== "object") throw new HttpSemanticFailure("request.malformed", 400);
  if (seen.has(value)) throw new HttpSemanticFailure("request.malformed", 400);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) validateJcsValue(item, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new HttpSemanticFailure("request.malformed", 400);
    }
    for (const [key, item] of Object.entries(value)) {
      if (!isUnicodeScalarString(key)) throw new HttpSemanticFailure("request.malformed", 400);
      validateJcsValue(item, seen);
    }
  }
  seen.delete(value);
};

/** Encodes one I-JSON value with the repository RFC 8785 encoder. */
export const jcsBytes = (value: unknown): Uint8Array => {
  validateJcsValue(value, new Set());
  return canonicalJsonBytes(value);
};

/** Decodes UTF-8 JSON while rejecting duplicate member names before schema decoding. */
export const parseJsonWithoutDuplicateMembers = (bytes: Uint8Array): unknown => {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new HttpSemanticFailure("request.malformed", 400);
  }

  // JSON.parse does not expose duplicate members. This scanner records every
  // object key before JSON.parse constructs the semantic value.
  const stack: Array<{
    readonly kind: "array" | "object";
    readonly keys?: Set<string>;
    expectKey: boolean;
  }> = [];
  let index = 0;
  let expectingKey = false;
  while (index < text.length) {
    const char = text[index]!;
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "{") {
      stack.push({ kind: "object", keys: new Set(), expectKey: true });
      expectingKey = true;
      index += 1;
      continue;
    }
    if (char === "[") {
      stack.push({ kind: "array", expectKey: false });
      expectingKey = false;
      index += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      stack.pop();
      expectingKey = stack.at(-1)?.kind === "object" && stack.at(-1)?.expectKey === true;
      index += 1;
      continue;
    }
    if (char === ",") {
      const top = stack.at(-1);
      if (top?.kind === "object") top.expectKey = true;
      expectingKey = top?.kind === "object";
      index += 1;
      continue;
    }
    if (char === ":") {
      const top = stack.at(-1);
      if (top?.kind === "object") top.expectKey = false;
      expectingKey = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      if (expectingKey) {
        let key: string;
        try {
          key = JSON.parse(text.slice(start, index)) as string;
        } catch {
          throw new HttpSemanticFailure("request.malformed", 400);
        }
        const keys = stack.at(-1)?.keys;
        if (keys?.has(key) === true) throw new HttpSemanticFailure("request.malformed", 400);
        keys?.add(key);
      }
      continue;
    }
    index += 1;
  }

  try {
    const decoded = JSON.parse(text) as unknown;
    validateJcsValue(decoded, new Set());
    return decoded;
  } catch (cause) {
    if (cause instanceof HttpSemanticFailure) throw cause;
    throw new HttpSemanticFailure("request.malformed", 400);
  }
};
export type MergePatchFieldState =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Null" }
  | { readonly _tag: "Value"; readonly value: unknown };

export type MergePatchInterpretation<Field extends string> =
  | {
      readonly _tag: "Accepted";
      readonly fields: ReadonlyArray<readonly [Field, MergePatchFieldState]>;
    }
  | {
      readonly _tag: "Rejected";
      readonly code: ValidationProblemCode;
      readonly errors: ReadonlyArray<NativeValidationError>;
    };

const jsonPointerProperty = (property: string): string =>
  `/${property.replaceAll("~", "~0").replaceAll("/", "~1")}`;

/** Preserves absence, value, and explicit deletion before typed merge-patch decoding. */
export const interpretMergePatchSource = <const Fields extends ReadonlyArray<string>>(
  source: unknown,
  allowedFields: Fields,
): MergePatchInterpretation<Fields[number]> => {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    return {
      _tag: "Rejected",
      code: "validation.failed",
      errors: [makeNativeValidationError("", "invalid")],
    };
  }
  const allowed = new Set<string>(allowedFields);
  const ownKeys = Object.keys(source);
  const unknownKeys = ownKeys.filter((key) => !allowed.has(key)).sort();
  if (unknownKeys.length > 0) {
    return {
      _tag: "Rejected",
      code: "validation.failed",
      errors: unknownKeys.map((key) =>
        makeNativeValidationError(jsonPointerProperty(key), "unknown"),
      ),
    };
  }
  if (ownKeys.length === 0) {
    return {
      _tag: "Rejected",
      code: "validation.no-change",
      errors: [makeNativeValidationError("", "no-change")],
    };
  }

  const record = source as Record<string, unknown>;
  const fields = allowedFields.map(
    (field) =>
      [
        field,
        !Object.hasOwn(record, field)
          ? { _tag: "Absent" as const }
          : record[field] === null
            ? { _tag: "Null" as const }
            : { _tag: "Value" as const, value: record[field] },
      ] as const,
  );
  const deletedFields = fields.filter(([, state]) => state._tag === "Null");
  if (deletedFields.length > 0) {
    return {
      _tag: "Rejected",
      code: "validation.field-not-deletable",
      errors: deletedFields.map(([field]) =>
        makeNativeValidationError(jsonPointerProperty(field), "field-not-deletable"),
      ),
    };
  }
  return { _tag: "Accepted", fields };
};

const profileMergePatchFields = ["firstName", "lastName", "email", "phone"] as const;
const admissionPeriodMergePatchFields = ["startAt", "endAt"] as const;
const articleMergePatchFields = ["title", "bodyHtml", "departmentIds", "sticky"] as const;

export const interpretProfileMergePatchSource = (source: unknown) =>
  interpretMergePatchSource(source, profileMergePatchFields);
export const interpretAdmissionPeriodMergePatchSource = (source: unknown) =>
  interpretMergePatchSource(source, admissionPeriodMergePatchFields);
export const interpretArticleMergePatchSource = (source: unknown) =>
  interpretMergePatchSource(source, articleMergePatchFields);

/** Decodes one non-combinable Idempotency-Key field. */
export const parseIdempotencyKey = (values: ReadonlyArray<string>): IdempotencyKey => {
  if (values.length !== 1 || values[0]?.includes(",") === true) {
    throw new HttpSemanticFailure("idempotency-key.invalid", 400);
  }
  try {
    return Schema.decodeUnknownSync(IdempotencyKeySchema)(values[0]);
  } catch {
    throw new HttpSemanticFailure("idempotency-key.invalid", 400);
  }
};

/** Decodes the required single strong If-Match value for an item mutation. */
export const parseRequiredIfMatch = (values: ReadonlyArray<string>): StrongETag => {
  if (values.length === 0) throw new HttpSemanticFailure("precondition.required", 428);
  if (values.length !== 1) throw new HttpSemanticFailure("precondition.invalid", 400);
  const canonical = values[0]?.trim();
  if (canonical === undefined || canonical.includes(",") || !entityTagPattern.test(canonical)) {
    throw new HttpSemanticFailure("precondition.invalid", 400);
  }
  try {
    return Schema.decodeUnknownSync(StrongETagSchema)(canonical);
  } catch {
    throw new HttpSemanticFailure("precondition.invalid", 400);
  }
};
const splitEntityTagList = (value: string): ReadonlyArray<string> => {
  const items: string[] = [];
  let quoted = false;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === '"') quoted = !quoted;
    if (char === "," && !quoted) {
      items.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted) throw new HttpSemanticFailure("precondition.invalid", 400);
  items.push(value.slice(start));
  return items;
};

const parseOptionalEntityTagCondition = (
  values: ReadonlyArray<string>,
): CanonicalEntityTagCondition | null => {
  if (values.length === 0) return null;
  const combined = values.join(",");
  if (combined.trim() === "*") return "*";
  if (combined.trim().length === 0) {
    throw new HttpSemanticFailure("precondition.invalid", 400);
  }
  const tuples: Array<readonly [boolean, string]> = [];
  const seen = new Set<string>();
  for (const item of splitEntityTagList(combined)) {
    const match = entityTagPattern.exec(item.trim());
    if (match === null) throw new HttpSemanticFailure("precondition.invalid", 400);
    const weak = match[1] !== undefined;
    const opaque = match[2]!;
    const key = `${weak ? "1" : "0"}:${opaque}`;
    if (!seen.has(key)) {
      seen.add(key);
      tuples.push([weak, opaque]);
    }
  }
  tuples.sort(([leftWeak, leftOpaque], [rightWeak, rightOpaque]) => {
    const left = `${leftWeak ? "1" : "0"}:${leftOpaque}`;
    const right = `${rightWeak ? "1" : "0"}:${rightOpaque}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return tuples;
};

/** Canonicalizes an optional read If-Match wildcard or entity-tag list. */
export const parseReadIfMatch = (values: ReadonlyArray<string>): CanonicalIfMatch | null =>
  parseOptionalEntityTagCondition(values);

/** Canonicalizes an optional If-None-Match wildcard or entity-tag list. */
export const parseIfNoneMatch = (values: ReadonlyArray<string>): CanonicalIfNoneMatch | null =>
  parseOptionalEntityTagCondition(values);

/** Encodes one decoded identity as an uppercase RFC 3986 path segment. */
export const encodePathIdentity = (identity: string): string => {
  if (!isUnicodeScalarString(identity)) throw new HttpSemanticFailure("request.malformed", 400);
  return encodeURIComponent(identity).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
};

export const normalizeTarget = (
  routeTemplate: string,
  identities: Readonly<Record<string, string>>,
): string =>
  routeTemplate.replaceAll(/\{([^}]+)\}/gu, (_match, name: string) => {
    const identity = identities[name];
    if (identity === undefined) throw new HttpSemanticFailure("request.malformed", 400);
    return encodePathIdentity(identity);
  });

export interface DerivedHttpIdentity {
  readonly identitySha256: Sha256Hex;
  readonly commandId: `httpv2_${string}`;
}
const validCredentialSubject = /^(?:Anonymous|(?:Person|Service|Capability):[^\s]+)$/u;
const validQualifiedOperationId = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/u;
const validNormalizedTarget = /^\/(?:api(?:\/[^\s?#]*)?|health)$/u;

/** Derives the private storage digest and domain command ID from the identity tuple. */
export const deriveHttpIdentity = (identity: NativeIdempotencyIdentity): DerivedHttpIdentity => {
  if (
    !validCredentialSubject.test(identity.credentialSubject) ||
    !validQualifiedOperationId.test(identity.qualifiedOperationId) ||
    !validNormalizedTarget.test(identity.normalizedTarget)
  ) {
    throw new HttpSemanticFailure("request.malformed", 400);
  }
  try {
    Schema.decodeUnknownSync(IdempotencyKeySchema)(identity.idempotencyKey);
  } catch {
    throw new HttpSemanticFailure("idempotency-key.invalid", 400);
  }
  const tuple = [
    identity.credentialSubject,
    identity.qualifiedOperationId,
    identity.normalizedTarget,
    identity.idempotencyKey,
  ] as const;
  const digestBytes = sha256Bytes(jcsBytes(tuple));
  return {
    identitySha256: Buffer.from(digestBytes).toString("hex") as Sha256Hex,
    commandId: `httpv2_${base64urlNoPad(digestBytes)}`,
  };
};

/** Hashes the decoded semantic request, never transport bytes. */
export const semanticRequestDigest = (request: CanonicalSemanticRequest): Sha256Hex =>
  sha256Hex(jcsBytes(request));

/** Builds the canonical envelope shared by every preconditioned mutation. */
export const semanticMutationRequest = (
  body: unknown,
  ifMatch: StrongETag,
): CanonicalSemanticRequest => ({ body, ifMatch });

export interface SemanticFile {
  readonly byteLength: number;
  readonly contentType: string;
  readonly sha256: Sha256Hex;
}

/** Converts staged multipart bytes to their boundary-independent semantic value. */
export const semanticFile = (bytes: Uint8Array, contentType: string): SemanticFile => ({
  byteLength: bytes.byteLength,
  contentType,
  sha256: sha256Hex(bytes),
});

export type ETagVersionSource =
  | number
  | string
  | ReadonlyArray<ETagVersionSource>
  | { readonly [key: string]: ETagVersionSource };

export interface ETagSourceRecord {
  readonly schemaVersion: "0.2.0";
  readonly representationKind: string;
  readonly resourceIdentity: string;
  readonly version: ETagVersionSource;
}

/** Derives a strong opaque ETag from authoritative version sources only. */
export const deriveStrongETag = (source: Omit<ETagSourceRecord, "schemaVersion">): StrongETag =>
  `"vkr2.${base64urlNoPad(
    sha256Bytes(jcsBytes({ schemaVersion: "0.2.0", ...source } satisfies ETagSourceRecord)),
  )}"` as StrongETag;

export interface ProfileETagSource {
  readonly personId: string;
  readonly nameRevision: number;
  readonly contactRevision: number;
  readonly role: string;
}

/**
 * Derives the self-profile tag from persisted revisions and the projected role
 * semantic. The role is an authority projection source, not response JSON.
 */
export const deriveProfileStrongETag = (source: ProfileETagSource): StrongETag =>
  deriveStrongETag({
    representationKind: "ProfileResource",
    resourceIdentity: source.personId,
    version: {
      nameRevision: source.nameRevision,
      contactRevision: source.contactRevision,
      role: source.role,
    },
  });

export type PreconditionDecision =
  | { readonly _tag: "Proceed" }
  | { readonly _tag: "NotModified" }
  | { readonly _tag: "Failed"; readonly code: "precondition.failed"; readonly status: 412 };

const opaqueETag = (tag: StrongETag): string => tag.slice(1, -1);

/** Evaluates read conditions after credential, authority, absence, and concealment. */
export const evaluateReadPreconditions = (input: {
  readonly currentETag: StrongETag;
  readonly ifMatch?: CanonicalIfMatch | null;
  readonly ifNoneMatch?: CanonicalIfNoneMatch | null;
}): PreconditionDecision => {
  const ifMatch = input.ifMatch;
  if (ifMatch !== undefined && ifMatch !== null && ifMatch !== "*") {
    const currentOpaque = opaqueETag(input.currentETag);
    if (!ifMatch.some(([weak, opaque]) => !weak && opaque === currentOpaque)) {
      return { _tag: "Failed", code: "precondition.failed", status: 412 };
    }
  }
  const condition = input.ifNoneMatch;
  if (condition === undefined || condition === null) return { _tag: "Proceed" };
  if (condition === "*") return { _tag: "NotModified" };
  const currentOpaque = opaqueETag(input.currentETag);
  return condition.some(([, opaque]) => opaque === currentOpaque)
    ? { _tag: "NotModified" }
    : { _tag: "Proceed" };
};

/** Evaluates one required mutation precondition after authorization and concealment. */
export const evaluateMutationPrecondition = (
  currentETag: StrongETag,
  ifMatch: StrongETag,
): PreconditionDecision =>
  currentETag === ifMatch
    ? { _tag: "Proceed" }
    : { _tag: "Failed", code: "precondition.failed", status: 412 };

export const PUBLIC_CACHE_CONTROL = "public, max-age=60, s-maxage=300, must-revalidate";
export const PRIVATE_NO_STORE = "private, no-store";
export const NO_STORE = "no-store";

/** Computes freshness without crossing an admission start or end boundary. */
export const admissionCacheControl = (
  nowEpochMilliseconds: number,
  futureBoundaries: ReadonlyArray<number>,
): string => {
  const next = futureBoundaries
    .filter((boundary) => boundary >= nowEpochMilliseconds)
    .sort((left, right) => left - right)[0];
  const ttl =
    next === undefined
      ? 30
      : Math.max(0, Math.min(30, Math.floor((next - nowEpochMilliseconds) / 1000)));
  return `public, max-age=${ttl}, s-maxage=${ttl}, must-revalidate`;
};

/** Creates an RFC 9457 response without leaking the internal failure. */
export const nativeProblemResponse = (
  code: NativeProblemCode,
  status: number,
  headers: ConstructorParameters<typeof Headers>[0] = {},
): Response => {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", NO_STORE);
  responseHeaders.set("content-type", "application/problem+json");
  if ((status === 409 && code === "idempotency.in-flight") || status === 503) {
    responseHeaders.set("retry-after", status === 409 ? "1" : "5");
  }
  return new Response(JSON.stringify(makeNativeProblem(code, status)), {
    status,
    headers: responseHeaders,
  });
};
/** Emits the bounded dynamic retry delay for a native rate-limit response. */
export const rateLimitProblemResponse = (retryAfterSeconds: number): Response => {
  if (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 1 || retryAfterSeconds > 3600) {
    throw new HttpSemanticFailure("internal.error", 500);
  }
  return nativeProblemResponse("rate-limit.exceeded", 429, {
    "retry-after": String(retryAfterSeconds),
  });
};

/** Emits one bounded validation extension without rejected values. */
export const validationProblemResponse = (
  code: "validation.failed" | "validation.no-change" | "validation.field-not-deletable",
  errors: ReadonlyArray<NativeValidationError>,
): Response => {
  const validation = normalizeValidationErrors(errors);
  return new Response(
    JSON.stringify({
      ...makeNativeProblem(code, 422),
      validation,
    }),
    {
      status: 422,
      headers: {
        "cache-control": NO_STORE,
        "content-type": "application/problem+json",
      },
    },
  );
};

const methodOrder = ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"] as const;

/** Produces the path-specific Allow value in the frozen order. */
export const allowHeader = (methods: ReadonlyArray<string>): string => {
  const allowed = new Set(methods.map((method) => method.toUpperCase()));
  if (allowed.has("GET")) allowed.add("HEAD");
  allowed.add("OPTIONS");
  return methodOrder.filter((method) => allowed.has(method)).join(", ");
};

export const methodNotAllowedResponse = (methods: ReadonlyArray<string>): Response =>
  nativeProblemResponse("method.not-allowed", 405, { allow: allowHeader(methods) });

/** Emits a JSON mutation result with the frozen status and replayable headers. */
export const jsonMutationResponse = (input: {
  readonly status: 200 | 201;
  readonly body: unknown;
  readonly etag: StrongETag;
  readonly location?: string;
}): Response => {
  if (
    input.status === 201 &&
    (input.location === undefined ||
      !/^\/api\/[^\s?#]+$/u.test(input.location) ||
      input.location.startsWith("//"))
  ) {
    throw new HttpSemanticFailure("internal.error", 500);
  }
  if (input.status !== 201 && input.location !== undefined) {
    throw new HttpSemanticFailure("internal.error", 500);
  }
  try {
    Schema.decodeUnknownSync(StrongETagSchema)(input.etag);
  } catch {
    throw new HttpSemanticFailure("internal.error", 500);
  }
  const headers = new Headers({
    "cache-control": NO_STORE,
    "content-type": "application/json",
    etag: input.etag,
  });
  if (input.location !== undefined) headers.set("location", input.location);
  return new Response(JSON.stringify(input.body), { status: input.status, headers });
};

/** Emits a bodyless mutation result with no media type or Location. */
export const noContentMutationResponse = (etag?: StrongETag): Response => {
  if (etag !== undefined) {
    try {
      Schema.decodeUnknownSync(StrongETagSchema)(etag);
    } catch {
      throw new HttpSemanticFailure("internal.error", 500);
    }
  }
  const headers = new Headers({ "cache-control": NO_STORE });
  if (etag !== undefined) headers.set("etag", etag);
  return new Response(null, { status: 204, headers });
};

/** Creates the frozen bodyless 304 projection of a selected 200 response. */
export const notModifiedResponse = (selected: {
  readonly etag: StrongETag;
  readonly cacheControl: string;
  readonly vary: string;
}): Response =>
  new Response(null, {
    status: 304,
    headers: {
      etag: selected.etag,
      "cache-control": selected.cacheControl,
      vary: selected.vary,
    },
  });

export interface HttpResponseCapsule {
  readonly status: number;
  readonly mediaType: string | null;
  readonly bodyBytes: Uint8Array | null;
  readonly headers: Readonly<Record<string, string>>;
}

const storedResponseHeaderNames: Readonly<Record<string, true>> = {
  "content-type": true,
  etag: true,
  location: true,
  "retry-after": true,
};

/** Captures only response bytes and headers allowed by the privacy contract. */
export const responseCapsule = (response: Response): Promise<HttpResponseCapsule> =>
  response
    .clone()
    .arrayBuffer()
    .then((buffer) => {
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (storedResponseHeaderNames[name] === true) headers[name] = value;
      });
      const bodyBytes = buffer.byteLength === 0 ? null : new Uint8Array(buffer);
      const mediaType = bodyBytes === null ? null : response.headers.get("content-type");
      return { status: response.status, mediaType, bodyBytes, headers };
    });

/** Reconstructs a stored mutation result with its non-persisted cache policy. */
export const responseFromCapsule = (capsule: HttpResponseCapsule): Response => {
  const headers = new Headers(capsule.headers);
  headers.set("cache-control", NO_STORE);
  return new Response(capsule.bodyBytes, {
    status: capsule.status,
    headers,
  });
};

/** Sorts and bounds safe validation diagnostics. */
export const normalizeValidationErrors = (
  errors: ReadonlyArray<NativeValidationError>,
): { readonly errors: ReadonlyArray<NativeValidationError>; readonly truncated: boolean } => {
  const sorted = [...errors].sort((left, right) => {
    if (left.pointer !== right.pointer) return left.pointer < right.pointer ? -1 : 1;
    return left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
  });
  return { errors: sorted.slice(0, 32), truncated: sorted.length > 32 };
};

/** Rejects values that are not exact lowercase SHA-256 strings at persistence boundaries. */
export const assertSha256Hex = (value: string): asserts value is Sha256Hex => {
  if (!lowerSha256Pattern.test(value)) throw new HttpSemanticFailure("request.malformed", 400);
};

/** Deterministic JSON body bytes used by first responses and replays. */
export const jsonBodyBytes = (body: unknown): Uint8Array => encoder.encode(canonicalJson(body));
