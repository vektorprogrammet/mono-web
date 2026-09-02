/**
 * Frozen v0.2 HTTP primitives shared by every native endpoint.
 *
 * @since 0.2.0
 */
import { Schema } from "effect";
import { HttpApiSchema } from "effect/unstable/httpapi";

const idempotencyKeyPattern = /^[A-Za-z0-9_-]{22,128}$/u;
const strongETagPattern = /^"vkr2\.[A-Za-z0-9_-]{43}"$/u;
const sha256HexPattern = /^[a-f0-9]{64}$/u;

/** A case-sensitive, unpadded base64url idempotency key. */
export const IdempotencyKey = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => idempotencyKeyPattern.test(value), {
      message: "22 through 128 unpadded base64url characters",
    }),
  ),
  Schema.brand("IdempotencyKey"),
);
export type IdempotencyKey = typeof IdempotencyKey.Type;

/** A strong opaque v0.2 entity tag in canonical quoted wire form. */
export const StrongETag = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => strongETagPattern.test(value), {
      message: "a quoted vkr2 strong entity tag",
    }),
  ),
  Schema.brand("StrongETag"),
);
export type StrongETag = typeof StrongETag.Type;

/** A lowercase SHA-256 digest. */
export const Sha256Hex = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => sha256HexPattern.test(value), {
      message: "64 lowercase hexadecimal characters",
    }),
  ),
  Schema.brand("Sha256Hex"),
);
export type Sha256Hex = typeof Sha256Hex.Type;

/** Headers accepted by every external native mutation. */
export const IdempotencyHeaders = Schema.Struct({
  "idempotency-key": IdempotencyKey,
}).annotate({ identifier: "IdempotencyHeaders" });
export type IdempotencyHeaders = typeof IdempotencyHeaders.Type;

/** Headers accepted by an existing-resource native mutation. */
export const IdempotencyIfMatchHeaders = Schema.Struct({
  "idempotency-key": IdempotencyKey,
  "if-match": StrongETag,
}).annotate({ identifier: "IdempotencyIfMatchHeaders" });
export type IdempotencyIfMatchHeaders = typeof IdempotencyIfMatchHeaders.Type;

const EntityTagConditionHeader = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0 && value.length <= 4096, {
      message: "an entity-tag condition",
    }),
  ),
);

/** Optional validators accepted by each frozen conditional read. */
export const ConditionalReadHeaders = Schema.Struct({
  "if-match": Schema.optional(EntityTagConditionHeader),
  "if-none-match": Schema.optional(EntityTagConditionHeader),
}).annotate({ identifier: "ConditionalReadHeaders" });
export type ConditionalReadHeaders = typeof ConditionalReadHeaders.Type;

const OriginVary = Schema.Literal("Origin");
const NoStore = Schema.Literal("no-store");
const PrivateNoStore = Schema.Literal("private, no-store");
const PublicCache = Schema.Literal("public, max-age=60, s-maxage=300, must-revalidate");
const DynamicAdmissionCache = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => {
        const match =
          /^public, max-age=([0-9]|[12][0-9]|30), s-maxage=([0-9]|[12][0-9]|30), must-revalidate$/u.exec(
            value,
          );
        return match !== null && match[1] === match[2];
      },
      { message: "the frozen dynamic admission cache policy" },
    ),
  ),
);
const OriginRelativeLocation = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => /^\/api\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u.test(value), {
      message: "an origin-relative API resource location",
    }),
  ),
);
const RetryAfterSeconds = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => {
        const seconds = Number(value);
        return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 3_600;
      },
      { message: "a retry delay from 1 through 3600 seconds" },
    ),
  ),
);

const externalHeaders = <CacheControl extends Schema.Top>(cacheControl: CacheControl) => ({
  "Cache-Control": cacheControl,
  Vary: OriginVary,
});

const conditionalReadResponses = <S extends Schema.Top, CacheControl extends Schema.Top>(
  success: S,
  cacheControl: CacheControl,
) => {
  const headers = {
    ...externalHeaders(cacheControl),
    ETag: StrongETag,
  };
  return [
    HttpApiSchema.WithHeaders(success, headers),
    HttpApiSchema.WithHeaders(HttpApiSchema.NoContent.pipe(HttpApiSchema.status(304)), headers),
  ] as const;
};

/** Public conditional response with the fixed five-minute shared cache policy. */
export const publicConditionalResponses = <S extends Schema.Top>(success: S) =>
  conditionalReadResponses(success, PublicCache);

/** Public conditional response whose TTL is bounded by the next admission boundary. */
export const dynamicAdmissionConditionalResponses = <S extends Schema.Top>(success: S) =>
  conditionalReadResponses(success, DynamicAdmissionCache);

/** Credential-selected conditional response that is never stored. */
export const privateConditionalResponses = <S extends Schema.Top>(success: S) =>
  conditionalReadResponses(success, PrivateNoStore);

/** Credential-selected non-conditional read response. */
export const privateReadResponse = <S extends Schema.Top>(success: S) =>
  HttpApiSchema.WithHeaders(success, externalHeaders(PrivateNoStore));

/** Anonymous or health response that is not cacheable. */
export const noStoreReadResponse = <S extends Schema.Top>(success: S) =>
  HttpApiSchema.WithHeaders(success, externalHeaders(NoStore));

/** Internal response with no browser CORS contract. */
export const internalNoStoreResponse = <S extends Schema.Top>(success: S) =>
  HttpApiSchema.WithHeaders(success, { "Cache-Control": NoStore });

/** Successful resource creation response. */
export const createdMutationResponse = <S extends Schema.Top>(success: S) =>
  HttpApiSchema.WithHeaders(success, {
    ...externalHeaders(NoStore),
    ETag: StrongETag,
    Location: OriginRelativeLocation,
  });

/** Successful mutation response carrying a current mutable representation. */
export const entityMutationResponse = <S extends Schema.Top>(success: S) =>
  HttpApiSchema.WithHeaders(success, {
    ...externalHeaders(NoStore),
    ETag: StrongETag,
  });

/** Successful no-content mutation response, optionally with a new entity tag. */
export const noContentMutationResponse = (options?: { readonly etag?: boolean }) => {
  const response = HttpApiSchema.WithHeaders(HttpApiSchema.NoContent, {
    ...externalHeaders(NoStore),
    ...(options?.etag === true ? { ETag: StrongETag } : {}),
  });
  return response as unknown as Schema.Codec<typeof response.Type, typeof response.Encoded>;
};

const ValidationPointer = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) =>
        value.length <= 512 && /^(?:|\/(?:[^~/]|~[01])*(?:\/(?:[^~/]|~[01])*)*)$/u.test(value),
      { message: "an RFC 6901 pointer of at most 512 characters" },
    ),
  ),
);

export const NativeValidationMessage = {
  invalid: "The value is invalid.",
  missing: "A required value is missing.",
  unknown: "The property is not supported.",
  duplicate: "The value occurs more than once.",
  "out-of-range": "The value is outside the permitted range.",
  "field-not-deletable": "The field cannot be deleted.",
  "no-change": "The request does not change the resource.",
} as const;
export type NativeValidationCode = keyof typeof NativeValidationMessage;

const validationError = <Code extends NativeValidationCode>(code: Code) =>
  Schema.Struct({
    pointer: ValidationPointer,
    code: Schema.Literal(code),
    message: Schema.Literal(NativeValidationMessage[code]),
  });

/** One safe validation failure in the public semantic request. */
export const NativeValidationError = Schema.Union([
  validationError("invalid"),
  validationError("missing"),
  validationError("unknown"),
  validationError("duplicate"),
  validationError("out-of-range"),
  validationError("field-not-deletable"),
  validationError("no-change"),
]);
export type NativeValidationError = typeof NativeValidationError.Type;

export const makeNativeValidationError = <Code extends NativeValidationCode>(
  pointer: string,
  code: Code,
): {
  readonly pointer: string;
  readonly code: Code;
  readonly message: (typeof NativeValidationMessage)[Code];
} => ({
  pointer,
  code,
  message: NativeValidationMessage[code],
});

const InstanceUrn = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) =>
        /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          value,
        ),
      { message: "a UUID URN" },
    ),
  ),
);

interface FrozenProblemDefinition {
  readonly type: `urn:vektorprogrammet:problem:v0.2:${string}`;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
}

/** Exhaustive public registry. No title or detail is derived from a code. */
export const NativeProblemRegistry = {
  "admission-period.already-exists": {
    type: "urn:vektorprogrammet:problem:v0.2:admission-period.already-exists",
    title: "Admission period already exists",
    status: 409,
    detail: "An admission period already exists for this department and semester.",
  },
  "admission-period.invalid-window": {
    type: "urn:vektorprogrammet:problem:v0.2:admission-period.invalid-window",
    title: "Invalid admission period window",
    status: 422,
    detail: "The admission period window is invalid.",
  },
  "admission-period.not-found": {
    type: "urn:vektorprogrammet:problem:v0.2:admission-period.not-found",
    title: "Admission period not found",
    status: 404,
    detail: "The admission period was not found.",
  },
  "admissions.unavailable": {
    type: "urn:vektorprogrammet:problem:v0.2:admissions.unavailable",
    title: "Admissions unavailable",
    status: 503,
    detail: "The admissions service is temporarily unavailable.",
  },
  "application.ambiguous-period": {
    type: "urn:vektorprogrammet:problem:v0.2:application.ambiguous-period",
    title: "Ambiguous admission period",
    status: 409,
    detail: "More than one admission period matches this application.",
  },
  "application.duplicate": {
    type: "urn:vektorprogrammet:problem:v0.2:application.duplicate",
    title: "Duplicate application",
    status: 409,
    detail: "An application already exists for this applicant and admission period.",
  },
  "application.invalid-field-of-study": {
    type: "urn:vektorprogrammet:problem:v0.2:application.invalid-field-of-study",
    title: "Invalid field of study",
    status: 422,
    detail: "The selected field of study is not valid for this application.",
  },
  "application.no-eligible-period": {
    type: "urn:vektorprogrammet:problem:v0.2:application.no-eligible-period",
    title: "No eligible admission period",
    status: 409,
    detail: "No eligible admission period is open for this application.",
  },
  "application.not-found": {
    type: "urn:vektorprogrammet:problem:v0.2:application.not-found",
    title: "Application not found",
    status: 404,
    detail: "The application was not found.",
  },
  "authority.denied": {
    type: "urn:vektorprogrammet:problem:v0.2:authority.denied",
    title: "Authority denied",
    status: 403,
    detail: "The authenticated principal is not permitted to perform this operation.",
  },
  "content.article-not-found": {
    type: "urn:vektorprogrammet:problem:v0.2:content.article-not-found",
    title: "Article not found",
    status: 404,
    detail: "The article was not found.",
  },
  "content.department-not-found": {
    type: "urn:vektorprogrammet:problem:v0.2:content.department-not-found",
    title: "Content department not found",
    status: 422,
    detail: "A selected content department was not found.",
  },
  "content.integrity-error": {
    type: "urn:vektorprogrammet:problem:v0.2:content.integrity-error",
    title: "Content integrity error",
    status: 500,
    detail: "The content representation failed an integrity check.",
  },
  "content.lifecycle-conflict": {
    type: "urn:vektorprogrammet:problem:v0.2:content.lifecycle-conflict",
    title: "Content lifecycle conflict",
    status: 409,
    detail: "The article cannot make the requested lifecycle transition.",
  },
  "content.slug-conflict": {
    type: "urn:vektorprogrammet:problem:v0.2:content.slug-conflict",
    title: "Article slug conflict",
    status: 422,
    detail: "The article slug conflicts with an existing article.",
  },
  "content.unavailable": {
    type: "urn:vektorprogrammet:problem:v0.2:content.unavailable",
    title: "Content unavailable",
    status: 503,
    detail: "The content service is temporarily unavailable.",
  },
  "credential.invalid": {
    type: "urn:vektorprogrammet:problem:v0.2:credential.invalid",
    title: "Invalid credential",
    status: 401,
    detail: "The supplied credential is invalid.",
  },
  "credential.missing": {
    type: "urn:vektorprogrammet:problem:v0.2:credential.missing",
    title: "Credential required",
    status: 401,
    detail: "A credential is required for this operation.",
  },
  "dependency.unavailable": {
    type: "urn:vektorprogrammet:problem:v0.2:dependency.unavailable",
    title: "Dependency unavailable",
    status: 503,
    detail: "A required dependency is temporarily unavailable.",
  },
  "directory.cursor-malformed": {
    type: "urn:vektorprogrammet:problem:v0.2:directory.cursor-malformed",
    title: "Malformed directory cursor",
    status: 422,
    detail: "The directory cursor is malformed.",
  },
  "directory.unavailable": {
    type: "urn:vektorprogrammet:problem:v0.2:directory.unavailable",
    title: "Directory unavailable",
    status: 503,
    detail: "The directory service is temporarily unavailable.",
  },
  "header.malformed": {
    type: "urn:vektorprogrammet:problem:v0.2:header.malformed",
    title: "Malformed header",
    status: 400,
    detail: "A request header is malformed.",
  },
  "health.unavailable": {
    type: "urn:vektorprogrammet:problem:v0.2:health.unavailable",
    title: "Health check unavailable",
    status: 503,
    detail: "The service health check is temporarily unavailable.",
  },
  "idempotency-key.invalid": {
    type: "urn:vektorprogrammet:problem:v0.2:idempotency-key.invalid",
    title: "Invalid idempotency key",
    status: 400,
    detail: "The Idempotency-Key header is invalid.",
  },
  "idempotency.digest-conflict": {
    type: "urn:vektorprogrammet:problem:v0.2:idempotency.digest-conflict",
    title: "Idempotency conflict",
    status: 409,
    detail: "This idempotency key identifies a different semantic request.",
  },
  "idempotency.in-flight": {
    type: "urn:vektorprogrammet:problem:v0.2:idempotency.in-flight",
    title: "Idempotent request in progress",
    status: 409,
    detail: "A request with this idempotency identity is still in progress.",
  },
  "idempotency.response-expired": {
    type: "urn:vektorprogrammet:problem:v0.2:idempotency.response-expired",
    title: "Idempotent response expired",
    status: 409,
    detail: "The stored response for this idempotency identity has expired.",
  },
  "idempotency.unavailable": {
    type: "urn:vektorprogrammet:problem:v0.2:idempotency.unavailable",
    title: "Idempotency unavailable",
    status: 503,
    detail: "The idempotency receipt store is temporarily unavailable.",
  },
  "identity.unavailable": {
    type: "urn:vektorprogrammet:problem:v0.2:identity.unavailable",
    title: "Identity unavailable",
    status: 503,
    detail: "The identity service is temporarily unavailable.",
  },
  "internal.error": {
    type: "urn:vektorprogrammet:problem:v0.2:internal.error",
    title: "Internal error",
    status: 500,
    detail: "The server encountered an unexpected error.",
  },
  "invitation.already-responded": {
    type: "urn:vektorprogrammet:problem:v0.2:invitation.already-responded",
    title: "Invitation already answered",
    status: 409,
    detail: "The invitation already has a response.",
  },
  "media-type.unsupported": {
    type: "urn:vektorprogrammet:problem:v0.2:media-type.unsupported",
    title: "Unsupported media type",
    status: 415,
    detail: "The request media type is not supported for this operation.",
  },
  "method.not-allowed": {
    type: "urn:vektorprogrammet:problem:v0.2:method.not-allowed",
    title: "Method not allowed",
    status: 405,
    detail: "The requested method is not allowed for this resource.",
  },
  "organization.invalid-reference": {
    type: "urn:vektorprogrammet:problem:v0.2:organization.invalid-reference",
    title: "Invalid organization reference",
    status: 422,
    detail: "An organization reference is invalid.",
  },
  "organization.unavailable": {
    type: "urn:vektorprogrammet:problem:v0.2:organization.unavailable",
    title: "Organization unavailable",
    status: 503,
    detail: "The organization service is temporarily unavailable.",
  },
  "origin.denied": {
    type: "urn:vektorprogrammet:problem:v0.2:origin.denied",
    title: "Origin denied",
    status: 403,
    detail: "The browser origin is not trusted for this operation.",
  },
  "precondition.failed": {
    type: "urn:vektorprogrammet:problem:v0.2:precondition.failed",
    title: "Precondition failed",
    status: 412,
    detail: "The selected representation changed.",
  },
  "precondition.invalid": {
    type: "urn:vektorprogrammet:problem:v0.2:precondition.invalid",
    title: "Invalid precondition",
    status: 400,
    detail: "A conditional request header is malformed.",
  },
  "precondition.required": {
    type: "urn:vektorprogrammet:problem:v0.2:precondition.required",
    title: "Precondition required",
    status: 428,
    detail: "This operation requires an If-Match header.",
  },
  "profile.not-found": {
    type: "urn:vektorprogrammet:problem:v0.2:profile.not-found",
    title: "Profile not found",
    status: 404,
    detail: "The profile was not found.",
  },
  "profile.unavailable": {
    type: "urn:vektorprogrammet:problem:v0.2:profile.unavailable",
    title: "Profile unavailable",
    status: 503,
    detail: "The profile service is temporarily unavailable.",
  },
  "rate-limit.exceeded": {
    type: "urn:vektorprogrammet:problem:v0.2:rate-limit.exceeded",
    title: "Rate limit exceeded",
    status: 429,
    detail: "The request rate limit was exceeded.",
  },
  "receipt.already-exists": {
    type: "urn:vektorprogrammet:problem:v0.2:receipt.already-exists",
    title: "Receipt already exists",
    status: 409,
    detail: "A receipt already exists for this submission.",
  },
  "receipt.file-not-staged": {
    type: "urn:vektorprogrammet:problem:v0.2:receipt.file-not-staged",
    title: "Receipt file not staged",
    status: 422,
    detail: "The receipt file was not staged for this request.",
  },
  "receipt.invalid-transition": {
    type: "urn:vektorprogrammet:problem:v0.2:receipt.invalid-transition",
    title: "Invalid receipt transition",
    status: 409,
    detail: "The receipt cannot make the requested lifecycle transition.",
  },
  "receipt.not-found": {
    type: "urn:vektorprogrammet:problem:v0.2:receipt.not-found",
    title: "Receipt not found",
    status: 404,
    detail: "The receipt was not found.",
  },
  "receipts.unavailable": {
    type: "urn:vektorprogrammet:problem:v0.2:receipts.unavailable",
    title: "Receipts unavailable",
    status: 503,
    detail: "The receipt service is temporarily unavailable.",
  },
  "recruitment.admission-period-not-found": {
    type: "urn:vektorprogrammet:problem:v0.2:recruitment.admission-period-not-found",
    title: "Recruitment admission period not found",
    status: 404,
    detail: "The recruitment admission period was not found.",
  },
  "recruitment.already-cancelled": {
    type: "urn:vektorprogrammet:problem:v0.2:recruitment.already-cancelled",
    title: "Interview already cancelled",
    status: 409,
    detail: "The interview is already cancelled.",
  },
  "recruitment.already-finalized": {
    type: "urn:vektorprogrammet:problem:v0.2:recruitment.already-finalized",
    title: "Interview already finalized",
    status: 409,
    detail: "The interview is already finalized.",
  },
  "recruitment.already-scheduled": {
    type: "urn:vektorprogrammet:problem:v0.2:recruitment.already-scheduled",
    title: "Interview already scheduled",
    status: 409,
    detail: "The interview is already scheduled.",
  },
  "recruitment.application-already-assigned": {
    type: "urn:vektorprogrammet:problem:v0.2:recruitment.application-already-assigned",
    title: "Application already assigned",
    status: 409,
    detail: "The application is already assigned to an interview.",
  },
  "recruitment.application-not-found": {
    type: "urn:vektorprogrammet:problem:v0.2:recruitment.application-not-found",
    title: "Recruitment application not found",
    status: 404,
    detail: "The recruitment application was not found.",
  },
  "recruitment.conduct-invalid": {
    type: "urn:vektorprogrammet:problem:v0.2:recruitment.conduct-invalid",
    title: "Invalid interview conduct",
    status: 422,
    detail: "The interview conduct data is invalid.",
  },
  "recruitment.interview-not-found": {
    type: "urn:vektorprogrammet:problem:v0.2:recruitment.interview-not-found",
    title: "Interview not found",
    status: 404,
    detail: "The interview was not found.",
  },
  "recruitment.interview-not-scheduled": {
    type: "urn:vektorprogrammet:problem:v0.2:recruitment.interview-not-scheduled",
    title: "Interview not scheduled",
    status: 409,
    detail: "The interview is not scheduled.",
  },
  "recruitment.interview-schema-inactive": {
    type: "urn:vektorprogrammet:problem:v0.2:recruitment.interview-schema-inactive",
    title: "Interview schema inactive",
    status: 422,
    detail: "The selected interview schema is inactive.",
  },
  "recruitment.interview-schema-not-found": {
    type: "urn:vektorprogrammet:problem:v0.2:recruitment.interview-schema-not-found",
    title: "Interview schema not found",
    status: 404,
    detail: "The selected interview schema was not found.",
  },
  "recruitment.invitation-not-accepted": {
    type: "urn:vektorprogrammet:problem:v0.2:recruitment.invitation-not-accepted",
    title: "Invitation not accepted",
    status: 409,
    detail: "The recruitment invitation has not been accepted.",
  },
  "recruitment.schedule-in-past": {
    type: "urn:vektorprogrammet:problem:v0.2:recruitment.schedule-in-past",
    title: "Interview schedule is in the past",
    status: 422,
    detail: "The interview cannot be scheduled in the past.",
  },
  "recruitment.unavailable": {
    type: "urn:vektorprogrammet:problem:v0.2:recruitment.unavailable",
    title: "Recruitment unavailable",
    status: 503,
    detail: "The recruitment service is temporarily unavailable.",
  },
  "request.malformed": {
    type: "urn:vektorprogrammet:problem:v0.2:request.malformed",
    title: "Malformed request",
    status: 400,
    detail: "The request is malformed.",
  },
  "request.too-large": {
    type: "urn:vektorprogrammet:problem:v0.2:request.too-large",
    title: "Request too large",
    status: 413,
    detail: "The request body exceeds the permitted size.",
  },
  "resource.not-found": {
    type: "urn:vektorprogrammet:problem:v0.2:resource.not-found",
    title: "Resource not found",
    status: 404,
    detail: "The requested resource was not found.",
  },
  "schools.invalid-department": {
    type: "urn:vektorprogrammet:problem:v0.2:schools.invalid-department",
    title: "Invalid school department",
    status: 422,
    detail: "The selected department is not valid for the school directory.",
  },
  "schools.unavailable": {
    type: "urn:vektorprogrammet:problem:v0.2:schools.unavailable",
    title: "Schools unavailable",
    status: 503,
    detail: "The school directory is temporarily unavailable.",
  },
  "validation.failed": {
    type: "urn:vektorprogrammet:problem:v0.2:validation.failed",
    title: "Validation failed",
    status: 422,
    detail: "The request contains invalid semantic values.",
  },
  "validation.field-not-deletable": {
    type: "urn:vektorprogrammet:problem:v0.2:validation.field-not-deletable",
    title: "Field cannot be deleted",
    status: 422,
    detail: "The merge patch tries to delete a field that cannot be deleted.",
  },
  "validation.no-change": {
    type: "urn:vektorprogrammet:problem:v0.2:validation.no-change",
    title: "No changes requested",
    status: 422,
    detail: "The merge patch does not change the resource.",
  },
} as const satisfies Record<string, FrozenProblemDefinition>;

export type NativeProblemCode = keyof typeof NativeProblemRegistry;
export type ValidationProblemCode =
  | "validation.failed"
  | "validation.no-change"
  | "validation.field-not-deletable";

const nativeProblemCoreSchema = <Code extends NativeProblemCode>(code: Code) => {
  const definition = NativeProblemRegistry[code];
  return Schema.Struct({
    type: Schema.Literal(definition.type),
    title: Schema.Literal(definition.title),
    status: Schema.Literal(definition.status),
    code: Schema.Literal(code),
    detail: Schema.Literal(definition.detail),
    instance: Schema.optional(InstanceUrn),
  }).pipe(HttpApiSchema.status(definition.status));
};

const problemCodes = Object.keys(NativeProblemRegistry) as ReadonlyArray<NativeProblemCode>;

/** The closed RFC 9457 core representation used by native API failures. */
export const NativeProblem = Schema.Union(
  problemCodes.map((code) => nativeProblemCoreSchema(code)) as never,
).annotate({ identifier: "NativeProblem" });
export type NativeProblem = typeof NativeProblem.Type;

const validationBody = Schema.Struct({
  errors: Schema.Array(NativeValidationError).pipe(
    Schema.check(
      Schema.makeFilter((errors) => errors.length <= 32, {
        message: "at most 32 safe validation errors",
      }),
    ),
  ),
  truncated: Schema.Boolean,
});

/** Creates one correlated validation problem variant. */
export const validationProblemSchema = <Code extends ValidationProblemCode>(code: Code) => {
  const definition = NativeProblemRegistry[code];
  return Schema.Struct({
    type: Schema.Literal(definition.type),
    title: Schema.Literal(definition.title),
    status: Schema.Literal(definition.status),
    code: Schema.Literal(code),
    detail: Schema.Literal(definition.detail),
    instance: Schema.optional(InstanceUrn),
    validation: validationBody,
  }).pipe(HttpApiSchema.status(definition.status));
};

/** The only public extension for semantic validation failures. */
export const ValidationProblem = Schema.Union([
  validationProblemSchema("validation.failed"),
  validationProblemSchema("validation.no-change"),
  validationProblemSchema("validation.field-not-deletable"),
]).annotate({ identifier: "ValidationProblem" });
export type ValidationProblem = typeof ValidationProblem.Type;

export type ProblemDescriptor = readonly [code: NativeProblemCode, status: number];

/** Creates one fixed RFC 9457 core variant from the frozen registry. */
export const nativeProblemSchema = <Code extends NativeProblemCode>(
  code: Code,
  expectedStatus?: number,
) => {
  const definition = NativeProblemRegistry[code];
  if (expectedStatus !== undefined && definition.status !== expectedStatus) {
    throw new Error(`${code} is frozen at HTTP ${definition.status}, not ${expectedStatus}`);
  }
  return nativeProblemCoreSchema(code);
};

const isValidationProblemCode = (code: NativeProblemCode): code is ValidationProblemCode =>
  code === "validation.failed" ||
  code === "validation.no-change" ||
  code === "validation.field-not-deletable";

/** Creates a closed endpoint-specific Problem Details union. */
export const problemUnion = (identifier: string, descriptors: ReadonlyArray<ProblemDescriptor>) => {
  const unique = [
    ...new Map(descriptors.map((descriptor) => [descriptor[0], descriptor])).values(),
  ];
  if (unique.length === 0) throw new Error(`${identifier} must contain at least one problem`);
  const schemas = unique.map(([code, status]) => {
    const definition = NativeProblemRegistry[code];
    if (definition.status !== status) {
      throw new Error(
        `${identifier} declares ${code} at ${status}; registry requires ${definition.status}`,
      );
    }
    return isValidationProblemCode(code)
      ? validationProblemSchema(code)
      : nativeProblemCoreSchema(code);
  });
  const union = Schema.Union(schemas as never).annotate({
    identifier,
    title: identifier,
    description: `Closed RFC 9457 error union for ${identifier}.`,
  });
  // The variants above are rebuilt only from this module's service-free codecs.
  return union as unknown as Schema.Codec<unknown, unknown>;
};

/**
 * Splits an endpoint-specific Problem union into status-bearing response
 * schemas. Effect resolves an HTTP status only from the outer schema, so a
 * plain union of annotated variants would collapse to the default 500.
 */
export const endpointProblemResponses = <S extends Schema.Top>(
  problem: S,
  options?: { readonly cors?: boolean },
): ReadonlyArray<Schema.Codec<unknown, unknown>> => {
  const ast = problem.ast;
  const members = ast._tag === "Union" ? ast.types : [ast];
  const grouped = new Map<number, Array<(typeof members)[number]>>();
  for (const member of members) {
    const annotations = member.annotations;
    const annotatedStatus =
      annotations !== undefined && "httpApiStatus" in annotations
        ? annotations.httpApiStatus
        : undefined;
    const status = typeof annotatedStatus === "number" ? annotatedStatus : 500;
    const bucket = grouped.get(status);
    if (bucket === undefined) grouped.set(status, [member]);
    else bucket.push(member);
  }
  const hasProblemCode = (variant: (typeof members)[number], code: NativeProblemCode): boolean =>
    variant._tag === "Objects" &&
    variant.propertySignatures.some(
      (property) =>
        property.name === "code" &&
        property.type._tag === "Literal" &&
        property.type.literal === code,
    );
  const responses = [...grouped.entries()].map(([status, variants]) => {
    const headers = {
      "Cache-Control": NoStore,
      ...(options?.cors === false ? {} : { Vary: OriginVary }),
      ...(status === 401 ? { "WWW-Authenticate": Schema.String } : {}),
      ...(variants.some((variant) => hasProblemCode(variant, "idempotency.in-flight"))
        ? { "Retry-After": Schema.optional(Schema.Literal("1")) }
        : {}),
      ...(status === 429 ? { "Retry-After": RetryAfterSeconds } : {}),
      ...(status === 503 ? { "Retry-After": Schema.Literal("5") } : {}),
    };
    const firstVariant = variants[0];
    if (firstVariant === undefined) throw new Error(`${status} problem group is empty`);
    const body = Schema.Union([
      Schema.make(firstVariant),
      ...variants.slice(1).map((variant) => Schema.make(variant)),
    ]).pipe(
      HttpApiSchema.status(status),
      HttpApiSchema.asJson({ contentType: "application/problem+json" }),
    );
    return HttpApiSchema.WithHeaders(body, headers);
  });
  // Every member is rebuilt from this module's closed, service-free Problem codecs.
  // Schema.make cannot recover that requirement type from a reflected AST.
  return responses as unknown as ReadonlyArray<Schema.Codec<unknown, unknown>>;
};

/** Builds one safe fixed public problem value. */
export const makeNativeProblem = <Code extends NativeProblemCode>(
  code: Code,
  expectedStatus?: number,
  instance?: string,
) => {
  const definition = NativeProblemRegistry[code];
  if (expectedStatus !== undefined && definition.status !== expectedStatus) {
    throw new Error(`${code} is frozen at HTTP ${definition.status}, not ${expectedStatus}`);
  }
  return {
    ...definition,
    code,
    ...(instance === undefined ? {} : { instance }),
  };
};

/** Path-level error for a method outside a resource's frozen method set. */
export const NativeMethodNotAllowedProblem = nativeProblemSchema("method.not-allowed").annotate({
  identifier: "NativeMethodNotAllowedProblem",
});

/** Standard credentials accepted by a native user endpoint. */
export const nativeUserChallenges = (invalidBearer = false): string =>
  `VektorSession realm="native-api", Bearer realm="native-api"${invalidBearer ? ', error="invalid_token"' : ""}`;

/** Standard credential accepted by a cookie-only native endpoint. */
export const nativeCookieChallenge = 'VektorSession realm="native-api"';
