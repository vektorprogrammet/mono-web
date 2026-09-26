import { createHash } from "node:crypto";
import { canonicalJson, canonicalJsonBytes } from "@vektorprogrammet/domain/shared-kernel";
import { parseJsonWithUniqueMembers } from "@vektorprogrammet/domain/http-semantics";
import {
  type IdempotencyKey,
  IdempotencyKey as IdempotencyKeySchema,
  isProblem,
  makeNativeValidationError,
  type NativeValidationError,
  Problem,
  Sha256Hex,
  type StrongETag,
  type ValidationProblemCode,
  StrongETag as StrongETagSchema,
} from "@vektorprogrammet/http-api/http-semantics";
import { Array as Arr, Data, Predicate, Schema } from "effect";

const encoder = new TextEncoder();

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

export type CanonicalSemanticRequest = {
  readonly body?: Schema.Json;
  readonly ifMatch?: CanonicalIfMatch | StrongETag | null;
  readonly ifNoneMatch?: CanonicalIfNoneMatch | null;
  readonly query?: Schema.JsonObject;
};

const sha256Bytes = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

const base64urlNoPad = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

export const sha256Hex = (bytes: Uint8Array): Sha256Hex =>
  Sha256Hex.make(createHash("sha256").update(bytes).digest("hex"));

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

const validateJcsValue = (value: Schema.Json, seen: Set<object>): void => {
  if (value === null || Predicate.isBoolean(value)) return;

  if (Predicate.isString(value)) {
    if (!isUnicodeScalarString(value)) throw Problem.make("request.malformed");

    return;
  }

  if (Predicate.isNumber(value)) {
    if (!Number.isFinite(value)) throw Problem.make("request.malformed");

    return;
  }

  if (!(value === null || Predicate.isObjectOrArray(value)))
    throw Problem.make("request.malformed");

  if (seen.has(value)) throw Problem.make("request.malformed");
  seen.add(value);

  if (Arr.isArray<Schema.Json>(value)) {
    for (const item of value) validateJcsValue(item, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
      throw Problem.make("request.malformed");
    }

    for (const [key, item] of Object.entries<Schema.Json>(value)) {
      if (!isUnicodeScalarString(key)) throw Problem.make("request.malformed");
      validateJcsValue(item, seen);
    }
  }

  seen.delete(value);
};

/**
 * Encodes one I-JSON value with the repository RFC 8785 encoder.
 *
 * @construct http-transport
 */
export const jcsBytes = (value: Schema.Json): Uint8Array => {
  validateJcsValue(value, new Set());

  return canonicalJsonBytes(value);
};

/**
 * Decodes UTF-8 JSON while rejecting duplicate member names before schema decoding.
 *
 * @construct http-transport
 */
export const parseJsonWithoutDuplicateMembers = (bytes: Uint8Array): Schema.Json => {
  try {
    const decoded = parseJsonWithUniqueMembers(bytes);
    validateJcsValue(decoded, new Set());

    return decoded;
  } catch (cause) {
    if (isProblem(cause)) throw cause;
    throw Problem.make("request.malformed");
  }
};

export type MergePatchFieldState =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Null" }
  | { readonly _tag: "Value"; readonly value: Schema.Json };

export const MergePatchFieldState = Data.taggedEnum<MergePatchFieldState>();

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

interface MergePatchInterpretationDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: MergePatchInterpretation<this["A"] & string>;
}

export const MergePatchInterpretation = Data.taggedEnum<MergePatchInterpretationDefinition>();

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  value !== null && Predicate.isObjectOrArray(value) && !Arr.isArray<Schema.Json>(value);

const jsonPointerProperty = (property: string): string =>
  `/${property.replaceAll("~", "~0").replaceAll("/", "~1")}`;

/**
 * Preserves absence, value, and explicit deletion before typed merge-patch decoding.
 *
 * @construct http-transport
 */
export const interpretMergePatchSource = <const Fields extends ReadonlyArray<string>>(
  source: Schema.Json,
  allowedFields: Fields,
): MergePatchInterpretation<Fields[number]> => {
  if (!isJsonObject(source)) {
    return MergePatchInterpretation.Rejected<Fields[number]>({
      code: "validation.failed",
      errors: [makeNativeValidationError("", "invalid")],
    });
  }

  const allowed = new Set<string>(allowedFields);
  const ownKeys = Object.keys(source);
  const unknownKeys = ownKeys.filter((key) => !allowed.has(key)).sort();

  if (unknownKeys.length > 0) {
    return MergePatchInterpretation.Rejected<Fields[number]>({
      code: "validation.failed",
      errors: unknownKeys.map((key) =>
        makeNativeValidationError(jsonPointerProperty(key), "unknown"),
      ),
    });
  }

  if (ownKeys.length === 0) {
    return MergePatchInterpretation.Rejected<Fields[number]>({
      code: "validation.no-change",
      errors: [makeNativeValidationError("", "no-change")],
    });
  }

  const record = source;

  const fields = allowedFields.map((field) => {
    if (!Object.hasOwn(record, field)) return [field, MergePatchFieldState.Absent()] as const;
    const value = record[field];

    if (value === undefined) throw Problem.make("request.malformed");

    return [
      field,
      value === null ? MergePatchFieldState.Null() : MergePatchFieldState.Value({ value }),
    ] as const;
  });

  const deletedFields = fields.filter(([, state]) => Predicate.isTagged(state, "Null"));

  if (deletedFields.length > 0) {
    return MergePatchInterpretation.Rejected<Fields[number]>({
      code: "validation.field-not-deletable",
      errors: deletedFields.map(([field]) =>
        makeNativeValidationError(jsonPointerProperty(field), "field-not-deletable"),
      ),
    });
  }

  return MergePatchInterpretation.Accepted<Fields[number]>({ fields });
};

const profileMergePatchFields = ["firstName", "lastName", "email", "phone"] as const;

const admissionPeriodMergePatchFields = ["startAt", "endAt"] as const;

const articleMergePatchFields = ["title", "bodyHtml", "departmentIds", "sticky"] as const;

export const interpretProfileMergePatchSource = (source: Schema.Json) =>
  interpretMergePatchSource(source, profileMergePatchFields);

export const interpretAdmissionPeriodMergePatchSource = (source: Schema.Json) =>
  interpretMergePatchSource(source, admissionPeriodMergePatchFields);

export const interpretArticleMergePatchSource = (source: Schema.Json) =>
  interpretMergePatchSource(source, articleMergePatchFields);

/**
 * Decodes one non-combinable Idempotency-Key field.
 *
 * @construct http-transport
 */
export const parseIdempotencyKey = (values: ReadonlyArray<string>): IdempotencyKey => {
  if (values.length !== 1 || values[0]?.includes(",") === true) {
    throw Problem.make("idempotency-key.invalid");
  }

  try {
    return Schema.decodeUnknownSync(IdempotencyKeySchema)(values[0]);
  } catch {
    throw Problem.make("idempotency-key.invalid");
  }
};

/**
 * Decodes the required single strong If-Match value for an item mutation.
 *
 * @construct http-transport
 */
export const parseRequiredIfMatch = (values: ReadonlyArray<string>): StrongETag => {
  if (values.length === 0) throw Problem.make("precondition.required");

  if (values.length !== 1) throw Problem.make("precondition.invalid");
  const canonical = values[0]?.trim();

  if (canonical === undefined || canonical.includes(",") || !entityTagPattern.test(canonical)) {
    throw Problem.make("precondition.invalid");
  }

  try {
    return Schema.decodeUnknownSync(StrongETagSchema)(canonical);
  } catch {
    throw Problem.make("precondition.invalid");
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

  if (quoted) throw Problem.make("precondition.invalid");
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
    throw Problem.make("precondition.invalid");
  }

  const tuples: Array<readonly [boolean, string]> = [];
  const seen = new Set<string>();

  for (const item of splitEntityTagList(combined)) {
    const match = entityTagPattern.exec(item.trim());

    if (match === null) throw Problem.make("precondition.invalid");
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

/**
 * Canonicalizes an optional read If-Match wildcard or entity-tag list.
 *
 * @construct http-transport
 */
export const parseReadIfMatch = (values: ReadonlyArray<string>): CanonicalIfMatch | null =>
  parseOptionalEntityTagCondition(values);

/**
 * Canonicalizes an optional If-None-Match wildcard or entity-tag list.
 *
 * @construct http-transport
 */
export const parseIfNoneMatch = (values: ReadonlyArray<string>): CanonicalIfNoneMatch | null =>
  parseOptionalEntityTagCondition(values);

/**
 * Encodes one decoded identity as an uppercase RFC 3986 path segment.
 *
 * @construct http-transport
 */
export const encodePathIdentity = (identity: string): string => {
  if (!isUnicodeScalarString(identity)) throw Problem.make("request.malformed");

  return encodeURIComponent(identity).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
};

/**
 * Fills a route template with its encoded identities; a missing identity is a malformed request.
 *
 * @construct http-transport
 */
export const normalizeTarget = (
  routeTemplate: string,
  identities: Readonly<Record<string, string>>,
): string =>
  routeTemplate.replaceAll(/\{([^}]+)\}/gu, (_match, name: string) => {
    const identity = identities[name];

    if (identity === undefined) throw Problem.make("request.malformed");

    return encodePathIdentity(identity);
  });

export interface DerivedHttpIdentity {
  readonly identitySha256: Sha256Hex;
  readonly commandId: `httpv2_${string}`;
}

const validCredentialSubject = /^(?:Anonymous|(?:Person|Service|Capability):[^\s]+)$/u;

const validQualifiedOperationId =
  /^[a-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*(?:\.[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)+$/u;

const validNormalizedTarget = /^\/(?:api(?:\/[^\s?#]*)?|health)$/u;

/**
 * Derives the private storage digest and domain command ID from the identity tuple.
 *
 * @construct http-transport
 */
export const deriveHttpIdentity = (identity: NativeIdempotencyIdentity): DerivedHttpIdentity => {
  if (
    !validCredentialSubject.test(identity.credentialSubject) ||
    !validQualifiedOperationId.test(identity.qualifiedOperationId) ||
    !validNormalizedTarget.test(identity.normalizedTarget)
  ) {
    throw Problem.make("request.malformed");
  }

  try {
    Schema.decodeUnknownSync(IdempotencyKeySchema)(identity.idempotencyKey);
  } catch {
    throw Problem.make("idempotency-key.invalid");
  }

  const tuple = [
    identity.credentialSubject,
    identity.qualifiedOperationId,
    identity.normalizedTarget,
    identity.idempotencyKey,
  ] as const;

  const digestBytes = sha256Bytes(jcsBytes(tuple));

  return {
    identitySha256: Sha256Hex.make(Buffer.from(digestBytes).toString("hex")),
    commandId: `httpv2_${base64urlNoPad(digestBytes)}`,
  };
};

/** Hashes the decoded semantic request, never transport bytes. */
export const semanticRequestDigest = (request: CanonicalSemanticRequest): Sha256Hex =>
  sha256Hex(jcsBytes(request));

/** Builds the canonical envelope shared by every preconditioned mutation. */
export const semanticMutationRequest = (
  body: Schema.Json,
  ifMatch: StrongETag,
): CanonicalSemanticRequest => ({ body, ifMatch });

export type SemanticFile = {
  readonly byteLength: number;
  readonly contentType: string;
  readonly sha256: Sha256Hex;
};

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
  StrongETagSchema.make(
    `"vkr2.${base64urlNoPad(
      sha256Bytes(jcsBytes({ schemaVersion: "0.2.0", ...source } satisfies ETagSourceRecord)),
    )}"`,
  );

export interface ProfileETagSource {
  readonly personId: string;
  readonly nameRevision: number;
  readonly contactRevision: number;
  readonly representationRevision: number;
}

/** Derives the self-profile tag from its three persisted representation revisions. */
export const deriveProfileStrongETag = (source: ProfileETagSource): StrongETag =>
  deriveStrongETag({
    representationKind: "ProfileResource",
    resourceIdentity: source.personId,
    version: {
      nameRevision: source.nameRevision,
      contactRevision: source.contactRevision,
      representationRevision: source.representationRevision,
    },
  });

export type PreconditionDecision =
  | { readonly _tag: "Proceed" }
  | { readonly _tag: "NotModified" }
  | { readonly _tag: "Failed"; readonly code: "precondition.failed"; readonly status: 412 };

export const PreconditionDecision = Data.taggedEnum<PreconditionDecision>();

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
      return PreconditionDecision.Failed({ code: "precondition.failed", status: 412 });
    }
  }

  const condition = input.ifNoneMatch;

  if (condition === undefined || condition === null) return PreconditionDecision.Proceed();

  if (condition === "*") return PreconditionDecision.NotModified();
  const currentOpaque = opaqueETag(input.currentETag);

  return condition.some(([, opaque]) => opaque === currentOpaque)
    ? PreconditionDecision.NotModified()
    : PreconditionDecision.Proceed();
};

/** Evaluates one required mutation precondition after authorization and concealment. */
export const evaluateMutationPrecondition = (
  currentETag: StrongETag,
  ifMatch: StrongETag,
): PreconditionDecision =>
  currentETag === ifMatch
    ? PreconditionDecision.Proceed()
    : PreconditionDecision.Failed({ code: "precondition.failed", status: 412 });

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

const methodOrder = ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"] as const;

/** Produces the path-specific Allow value in the frozen order. */
export const allowHeader = (methods: ReadonlyArray<string>): string => {
  const allowed = new Set(methods.map((method) => method.toUpperCase()));

  if (allowed.has("GET")) allowed.add("HEAD");
  allowed.add("OPTIONS");

  return methodOrder.filter((method) => allowed.has(method)).join(", ");
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
  readonly bodyBytes: Uint8Array<ArrayBuffer> | null;
  readonly headers: Readonly<Record<string, string>>;
}

const storedResponseHeaderNames = {
  "content-type": true,
  etag: true,
  location: true,
  "retry-after": true,
} as const;

/** Captures only response bytes and headers allowed by the privacy contract. */
export const responseCapsule = (response: Response): Promise<HttpResponseCapsule> =>
  response
    .clone()
    .arrayBuffer()
    .then((buffer) => {
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (Object.hasOwn(storedResponseHeaderNames, name)) headers[name] = value;
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

/** Deterministic JSON body bytes used by first responses and replays. */
export const jsonBodyBytes = (body: Schema.Json): Uint8Array<ArrayBuffer> =>
  encoder.encode(canonicalJson(body));
