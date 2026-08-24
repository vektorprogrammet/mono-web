/**
 * Transport layer — wraps fetch with auth resolution and error mapping.
 *
 * All request helpers return Effect<A, InternalSdkError> where A is decoded via Schema.
 * The caller provides the Schema; the transport handles HTTP, auth, and error mapping.
 */

import { Effect, Schema, pipe } from "effect";
import {
  Unauthorized,
  NotFound,
  Validation,
  Conflict,
  Network,
  RateLimited,
  Configuration,
  UnauthenticatedActor,
  InactiveActor,
  ReceiptOwnerDenied,
  ReceiptScopeDenied,
  ReceiptDecodeError,
  ReceiptAlreadyExists,
  DuplicateReceiptCommandConflict,
  ReceiptNotFound,
  StaleReceiptRevision,
  InvalidReceiptTransition,
  ReceiptFileNotStaged,
  ReceiptPersistenceError,
  AdmissionRoleDenied,
  AdmissionScopeDenied,
  DepartmentRequired,
  DepartmentNotFound,
  SemesterNotFound,
  AdmissionPeriodNotFound,
  AdmissionPeriodDecodeError,
  InvalidAdmissionPeriodWindow,
  AdmissionWindowOutsideSemester,
  AdmissionPeriodAlreadyExists,
  PublicApplicationDecodeError,
  NoEligibleAdmissionPeriod,
  PublicApplicationDepartmentNotFound,
  FieldOfStudyNotFound,
  FieldOfStudyInactive,
  FieldOfStudyDepartmentMismatch,
  DuplicatePublicApplication,
  DuplicatePublicApplicationCommandConflict,
  RequestBodyTooLarge,
  PublicApplicationRateLimitExceeded,
  PublicApplicationNotFound,
  PublicApplicationPersistenceError,
  RecruitmentUnauthenticatedActor,
  RecruitmentDecodeError,
  RecruitmentInactiveActor,
  RecruitmentRoleDenied,
  RecruitmentScopeDenied,
  RecruitmentAdmissionPeriodNotFound,
  RecruitmentAmbiguousAdmissionPeriod,
  RecruitmentApplicationNotFound,
  RecruitmentApplicationAlreadyAssigned,
  RecruitmentInterviewSchemaNotFound,
  RecruitmentInterviewSchemaInactive,
  RecruitmentInterviewerNotEligible,
  RecruitmentAssignmentCommandConflict,
  RecruitmentInterviewNotFound,
  RecruitmentInvitationNotFound,
  RecruitmentInvitationAlreadyResponded,
  RecruitmentInterviewAlreadyScheduled,
  RecruitmentInterviewStaleRevision,
  RecruitmentScheduleCommandConflict,
  RecruitmentScheduleInPast,
  RecruitmentProfileContactNotFound,
  RecruitmentPersistenceError,
  OrganizationUnauthenticatedActor,
  OrganizationRoleDenied,
  OrganizationInvalidReference,
  OrganizationCommandConflict,
  OrganizationDecodeError,
  OrganizationRequestBodyTooLarge,
  OrganizationPersistenceError,
  type InternalSdkError,
} from "./errors.js";
import { parseViolations } from "./adapter/errors.js";

const MAX_JSON_RESPONSE_BYTES = 1_048_576;

export type AuthOption = string | (() => string | Promise<string>);
export type QueryParams = Record<string, string | number | undefined>;

/**
 * Resolves the auth token — supports static string or async function.
 */
const resolveAuth = (auth: AuthOption): Effect.Effect<string, Network> =>
  typeof auth === "string"
    ? Effect.succeed(auth)
    : Effect.tryPromise({
        try: () => Promise.resolve(auth()),
        catch: (cause) =>
          new Network({
            message: cause instanceof Error ? cause.message : "Failed to resolve auth",
            cause,
          }),
      });

const receiptFailureFromBody = (body: unknown): InternalSdkError | undefined => {
  if (typeof body !== "object" || body === null) return undefined;
  const root = body as Record<string, unknown>;
  const error =
    typeof root.error === "object" && root.error !== null
      ? (root.error as Record<string, unknown>)
      : root;
  const tag = error.tag ?? error._tag;
  if (typeof tag !== "string") return undefined;

  switch (tag) {
    case "UnauthenticatedActor":
      return new UnauthenticatedActor();
    case "InactiveActor":
      return new InactiveActor();
    case "ReceiptOwnerDenied":
      return new ReceiptOwnerDenied();
    case "ReceiptScopeDenied":
      return new ReceiptScopeDenied();
    case "ReceiptDecodeError":
      return new ReceiptDecodeError();
    case "ReceiptAlreadyExists":
      return new ReceiptAlreadyExists();
    case "DuplicateReceiptCommandConflict":
      return new DuplicateReceiptCommandConflict();
    case "ReceiptNotFound":
      return new ReceiptNotFound();
    case "StaleReceiptRevision":
      return new StaleReceiptRevision();
    case "InvalidReceiptTransition":
      return new InvalidReceiptTransition();
    case "ReceiptFileNotStaged":
      return new ReceiptFileNotStaged();
    case "ReceiptPersistenceError":
      return new ReceiptPersistenceError();
    case "AdmissionRoleDenied":
      return new AdmissionRoleDenied();
    case "AdmissionScopeDenied":
      return new AdmissionScopeDenied();
    case "DepartmentRequired":
      return new DepartmentRequired();
    case "DepartmentNotFound":
      return new DepartmentNotFound();
    case "SemesterNotFound":
      return new SemesterNotFound();
    case "AdmissionPeriodNotFound":
      return new AdmissionPeriodNotFound();
    case "AdmissionPeriodDecodeError":
      return new AdmissionPeriodDecodeError();
    case "InvalidAdmissionPeriodWindow":
      return new InvalidAdmissionPeriodWindow();
    case "AdmissionWindowOutsideSemester":
      return new AdmissionWindowOutsideSemester();
    case "AdmissionPeriodAlreadyExists":
      return new AdmissionPeriodAlreadyExists();
    case "PublicApplicationDecodeError":
      return new PublicApplicationDecodeError();
    case "NoEligibleAdmissionPeriod":
      return new NoEligibleAdmissionPeriod();
    case "FieldOfStudyNotFound":
      return new FieldOfStudyNotFound();
    case "FieldOfStudyInactive":
      return new FieldOfStudyInactive();
    case "FieldOfStudyDepartmentMismatch":
      return new FieldOfStudyDepartmentMismatch();
    case "DuplicatePublicApplication":
      return new DuplicatePublicApplication();
    case "DuplicatePublicApplicationCommandConflict":
      return new DuplicatePublicApplicationCommandConflict();
    case "RequestBodyTooLarge":
      return new RequestBodyTooLarge();
    case "PublicApplicationRateLimitExceeded":
      return new PublicApplicationRateLimitExceeded();
    case "PublicApplicationNotFound":
      return new PublicApplicationNotFound();
    case "PublicApplicationPersistenceError":
      return new PublicApplicationPersistenceError();
  }
};
const publicApplicationFailureFromBody = (body: unknown): InternalSdkError | undefined => {
  if (typeof body !== "object" || body === null) return undefined;
  const root = body as Record<string, unknown>;
  const error =
    typeof root.error === "object" && root.error !== null
      ? (root.error as Record<string, unknown>)
      : root;
  const tag = error.tag ?? error._tag;
  if (typeof tag !== "string") return undefined;

  switch (tag) {
    case "DepartmentNotFound":
      return new PublicApplicationDepartmentNotFound();
    case "PublicApplicationDecodeError":
      return new PublicApplicationDecodeError();
    case "NoEligibleAdmissionPeriod":
      return new NoEligibleAdmissionPeriod();
    case "FieldOfStudyNotFound":
      return new FieldOfStudyNotFound();
    case "FieldOfStudyInactive":
      return new FieldOfStudyInactive();
    case "FieldOfStudyDepartmentMismatch":
      return new FieldOfStudyDepartmentMismatch();
    case "DuplicatePublicApplication":
      return new DuplicatePublicApplication();
    case "DuplicatePublicApplicationCommandConflict":
      return new DuplicatePublicApplicationCommandConflict();
    case "RequestBodyTooLarge":
      return new RequestBodyTooLarge();
    case "PublicApplicationRateLimitExceeded":
      return new PublicApplicationRateLimitExceeded();
    case "PublicApplicationNotFound":
      return new PublicApplicationNotFound();
    case "PublicApplicationPersistenceError":
      return new PublicApplicationPersistenceError();
    default:
      return receiptFailureFromBody(body);
  }
};

const StrictNativeFailureBodySchema = Schema.Struct({
  error: Schema.Struct({ tag: Schema.String }),
});

const recruitmentFailureFromBody = (
  body: unknown,
  strict: boolean,
): InternalSdkError | undefined => {
  let tag: unknown;
  if (strict) {
    try {
      tag = Schema.decodeUnknownSync(StrictNativeFailureBodySchema)(
        body,
        { onExcessProperty: "error" },
      ).error.tag;
    } catch {
      return new RecruitmentDecodeError();
    }
  } else {
    if (typeof body !== "object" || body === null) return undefined;
    const root = body as Record<string, unknown>;
    const error =
      typeof root.error === "object" && root.error !== null
        ? (root.error as Record<string, unknown>)
        : root;
    tag = error.tag ?? error._tag;
  }
  if (typeof tag !== "string") {
    return strict ? new RecruitmentDecodeError() : undefined;
  }
  switch (tag) {
    case "UnauthenticatedActor":
      return new RecruitmentUnauthenticatedActor();
    case "RecruitmentInactiveActor":
      return new RecruitmentInactiveActor();
    case "RecruitmentRoleDenied":
      return new RecruitmentRoleDenied();
    case "RecruitmentScopeDenied":
      return new RecruitmentScopeDenied();
    case "RecruitmentAdmissionPeriodNotFound":
      return new RecruitmentAdmissionPeriodNotFound();
    case "RecruitmentAmbiguousAdmissionPeriod":
      return new RecruitmentAmbiguousAdmissionPeriod();
    case "RecruitmentApplicationNotFound":
      return new RecruitmentApplicationNotFound();
    case "RecruitmentApplicationAlreadyAssigned":
      return new RecruitmentApplicationAlreadyAssigned();
    case "RecruitmentInterviewSchemaNotFound":
      return new RecruitmentInterviewSchemaNotFound();
    case "RecruitmentInterviewSchemaInactive":
      return new RecruitmentInterviewSchemaInactive();
    case "RecruitmentInterviewerNotEligible":
      return new RecruitmentInterviewerNotEligible();
    case "RecruitmentAssignmentCommandConflict":
      return new RecruitmentAssignmentCommandConflict();
    case "RecruitmentInterviewNotFound":
      return new RecruitmentInterviewNotFound();
    case "RecruitmentInvitationNotFound":
      return new RecruitmentInvitationNotFound();
    case "RecruitmentInvitationAlreadyResponded":
      return new RecruitmentInvitationAlreadyResponded();
    case "RecruitmentInterviewAlreadyScheduled":
      return new RecruitmentInterviewAlreadyScheduled();
    case "RecruitmentInterviewStaleRevision":
      return new RecruitmentInterviewStaleRevision();
    case "RecruitmentScheduleCommandConflict":
      return new RecruitmentScheduleCommandConflict();
    case "RecruitmentScheduleInPast":
      return new RecruitmentScheduleInPast();
    case "ProfileContactNotFound":
      return new RecruitmentProfileContactNotFound();
    case "RecruitmentDecodeError":
      return new RecruitmentDecodeError();
    case "RecruitmentPersistenceError":
      return new RecruitmentPersistenceError();
    case "RequestBodyTooLarge":
      return new RequestBodyTooLarge();
    default:
      return strict ? new RecruitmentDecodeError() : undefined;
  }
};

const organizationFailureFromBody = (
  body: unknown,
  strict: boolean,
): InternalSdkError | undefined => {
  let tag: unknown;
  if (strict) {
    try {
      tag = Schema.decodeUnknownSync(StrictNativeFailureBodySchema)(body, {
        onExcessProperty: "error",
      }).error.tag;
    } catch {
      return new OrganizationDecodeError();
    }
  } else {
    if (typeof body !== "object" || body === null) return undefined;
    const root = body as Record<string, unknown>;
    const error =
      typeof root.error === "object" && root.error !== null
        ? (root.error as Record<string, unknown>)
        : root;
    tag = error.tag ?? error._tag;
  }
  if (typeof tag !== "string") {
    return strict ? new OrganizationDecodeError() : undefined;
  }
  switch (tag) {
    case "UnauthenticatedActor":
      return new OrganizationUnauthenticatedActor();
    case "OrganizationRoleDenied":
      return new OrganizationRoleDenied();
    case "OrganizationInvalidReference":
      return new OrganizationInvalidReference();
    case "OrganizationCommandConflict":
      return new OrganizationCommandConflict();
    case "OrganizationDecodeError":
      return new OrganizationDecodeError();
    case "RequestBodyTooLarge":
      return new OrganizationRequestBodyTooLarge();
    case "OrganizationPersistenceError":
      return new OrganizationPersistenceError();
    default:
      return strict ? new OrganizationDecodeError() : undefined;
  }
};

/**
 * Maps HTTP status codes to InternalSdkError.
 *
 * Native errors carry only a typed tag in the response body. The transport
 * preserves that tag and intentionally ignores any untrusted text.
 */
const mapStatusToError = (
  status: number,
  body: unknown,
  options?: DecodeOptions,
): InternalSdkError => {
  const typedError =
    options?.errorFamily === "organization"
      ? organizationFailureFromBody(body, options.strict === true)
      : options?.errorFamily === "public_application"
        ? publicApplicationFailureFromBody(body)
        : options?.errorFamily === "recruitment"
          ? recruitmentFailureFromBody(body, options.strict === true)
          : receiptFailureFromBody(body);
  if (typedError !== undefined) return typedError;
  if (status === 401 || status === 403) return new Unauthorized({ message: `HTTP ${status}` });
  if (status === 404) return new NotFound({ message: "Not found" });
  if (status === 409) return new Conflict({ message: "Conflict" });
  if (status === 413) return new RequestBodyTooLarge();
  if (status === 422)
    return new Validation({ message: "Validation failed", fields: parseViolations(body) });
  if (status === 429) return new RateLimited({ message: "Rate limited" });
  return new Network({ message: `HTTP ${status}` });
};

export type DecodeOptions = {
  readonly strict?: boolean;
  readonly decodeError?: () => InternalSdkError;
  readonly errorFamily?: "public_application" | "recruitment" | "organization";
  readonly headers?: Readonly<Record<string, string>>;
  readonly includeAuth?: boolean;
  readonly expectedStatus?: number | ReadonlyArray<number>;
};

export interface Transport {
  get<A>(
    url: string,
    schema: Schema.ConstraintDecoder<A, never>,
    params?: QueryParams,
    options?: DecodeOptions,
  ): Effect.Effect<A, InternalSdkError>;
  getCollection<A>(
    url: string,
    itemSchema: Schema.ConstraintDecoder<A, never>,
    params?: QueryParams,
    options?: DecodeOptions,
  ): Effect.Effect<
    { items: A[]; totalItems: number; page: number; pageSize: number },
    InternalSdkError
  >;
  post<A>(
    url: string,
    body: unknown,
    schema: Schema.ConstraintDecoder<A, never>,
    options?: DecodeOptions,
  ): Effect.Effect<A, InternalSdkError>;
  postVoid(
    url: string,
    body: unknown,
    options?: DecodeOptions,
  ): Effect.Effect<void, InternalSdkError>;
  put(url: string, body: unknown): Effect.Effect<void, InternalSdkError>;
  del(url: string): Effect.Effect<void, InternalSdkError>;
  postFormData<A>(
    url: string,
    formData: FormData,
    schema: Schema.ConstraintDecoder<A, never>,
    options?: DecodeOptions,
  ): Effect.Effect<A, InternalSdkError>;
  postFormDataVoid(url: string, formData: FormData): Effect.Effect<void, InternalSdkError>;
}

/**
 * Creates a Transport backed by fetch.
 *
 * Auth is injected into every request as a Bearer token header.
 * Responses are decoded through the provided Schema.
 * HTTP errors are mapped to InternalSdkError.
 *
 * The base URL is intentionally validated inside each returned Effect. This
 * keeps factories and verb construction lazy while making configuration failure
 * observable through the typed error channel before fetch is called.
 */
export function createTransport(baseUrl: string | undefined, auth?: AuthOption): Transport {
  const buildHeaders = (
    extra?: Readonly<Record<string, string>>,
    includeAuth = true,
  ): Effect.Effect<Record<string, string>, Network> => {
    const headers: Record<string, string> = { ...extra };
    if (!auth || !includeAuth) return Effect.succeed(headers);
    return pipe(
      resolveAuth(auth),
      Effect.map((token) => {
        headers["Authorization"] = `Bearer ${token}`;
        return headers;
      }),
    );
  };

  const buildUrl = (path: string, params?: QueryParams): Effect.Effect<string, Configuration> =>
    Effect.try({
      try: () => {
        if (baseUrl === undefined || baseUrl.trim() === "") {
          throw new Error("API URL is not configured");
        }
        const parsedBase = new URL(baseUrl);
        if (parsedBase.protocol !== "http:" && parsedBase.protocol !== "https:") {
          throw new Error("API URL must use http or https");
        }
        const url = new URL(path, parsedBase);
        if (params) {
          for (const [key, value] of Object.entries(params)) {
            if (value !== undefined) url.searchParams.set(key, String(value));
          }
        }
        return url.toString();
      },
      catch: (cause) =>
        new Configuration({
          message: cause instanceof Error ? cause.message : "Invalid API URL",
        }),
    });

  const executeFetch = (url: string, init: RequestInit): Effect.Effect<Response, Network> =>
    Effect.tryPromise({
      try: (signal) => fetch(url, { ...init, signal }),
      catch: (cause) =>
        new Network({
          message: cause instanceof Error ? cause.message : "Network error",
          cause,
        }),
    });

  const readBoundedJson = (response: Response): Effect.Effect<unknown, Network> =>
    Effect.tryPromise({
      try: async () => {
        const contentLength = response.headers?.get("content-length");
        if (contentLength !== null && contentLength !== undefined) {
          if (!/^\d+$/.test(contentLength)) throw new Error("Invalid response content length");
          const declaredLength = Number(contentLength);
          if (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_JSON_RESPONSE_BYTES) {
            throw new Error("Response body exceeds the SDK limit");
          }
        }

        if (response.body === null || response.body === undefined) return response.json();

        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > MAX_JSON_RESPONSE_BYTES) {
              await reader.cancel();
              throw new Error("Response body exceeds the SDK limit");
            }
            chunks.push(next.value);
          }
        } finally {
          reader.releaseLock();
        }

        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      },
      catch: (cause) =>
        new Network({
          message: cause instanceof Error ? cause.message : "Failed to parse response JSON",
          cause,
        }),
    });

  const readErrorBody = (response: Response): Effect.Effect<unknown, never> =>
    readBoundedJson(response).pipe(Effect.orElseSucceed(() => null as unknown));

  const executeJson = (
    url: string,
    method: string,
    body?: unknown,
    extraHeaders?: Readonly<Record<string, string>>,
    options?: DecodeOptions,
  ): Effect.Effect<unknown, InternalSdkError> =>
    pipe(
      buildHeaders(
        {
          Accept: "application/ld+json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...extraHeaders,
        },
        options?.includeAuth !== false,
      ),
      Effect.flatMap((headers) =>
        executeFetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        }),
      ),
      Effect.flatMap((response) => {
        if (!response.ok) {
          return readErrorBody(response).pipe(
            Effect.flatMap((responseBody) =>
              Effect.fail(mapStatusToError(response.status, responseBody, options)),
            ),
          );
        }
        if (
          options?.expectedStatus !== undefined &&
          (typeof options.expectedStatus === "number"
            ? response.status !== options.expectedStatus
            : !options.expectedStatus.includes(response.status))
        ) {
          return Effect.fail(
            options.decodeError?.() ??
              new Network({
                message: `Unexpected HTTP ${response.status}`,
              }),
          );
        }
        return readBoundedJson(response);
      }),
    );

  const executeVoid = (
    url: string,
    method: string,
    body?: unknown,
    extraHeaders?: Readonly<Record<string, string>>,
    options?: DecodeOptions,
  ): Effect.Effect<void, InternalSdkError> =>
    pipe(
      buildHeaders(
        {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...extraHeaders,
        },
        options?.includeAuth !== false,
      ),
      Effect.flatMap((headers) =>
        executeFetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        }),
      ),
      Effect.flatMap((response) => {
        if (!response.ok) {
          return readErrorBody(response).pipe(
            Effect.flatMap((responseBody) =>
              Effect.fail(
                mapStatusToError(response.status, responseBody, options),
              ),
            ),
          );
        }
        if (
          options?.expectedStatus !== undefined &&
          (typeof options.expectedStatus === "number"
            ? response.status !== options.expectedStatus
            : !options.expectedStatus.includes(response.status))
        ) {
          return Effect.fail(
            options.decodeError?.() ??
              new Network({
                message: `Unexpected HTTP ${response.status}`,
              }),
          );
        }
        return Effect.void;
      }),
    );

  const decodeWith =
    <A>(schema: Schema.ConstraintDecoder<A, never>, options?: DecodeOptions) =>
    (json: unknown): Effect.Effect<A, InternalSdkError> => {
      const decoded = options?.strict
        ? Schema.decodeUnknownEffect(schema)(json, { onExcessProperty: "error" })
        : Schema.decodeUnknownEffect(schema)(json);
      return decoded.pipe(
        Effect.mapError((error) =>
          options?.strict
            ? (options.decodeError?.() ?? new ReceiptDecodeError())
            : new Validation({ message: `Decode error: ${error.message}`, fields: {} }),
        ),
      );
    };

  return {
    get<A>(
      url: string,
      schema: Schema.ConstraintDecoder<A, never>,
      params?: QueryParams,
      options?: DecodeOptions,
    ) {
      return pipe(
        buildUrl(url, params),
        Effect.flatMap((resolvedUrl) =>
          executeJson(
            resolvedUrl,
            "GET",
            undefined,
            options?.headers,
            options,
          ),
        ),
        Effect.flatMap(decodeWith(schema, options)),
      );
    },

    getCollection<A>(
      url: string,
      itemSchema: Schema.ConstraintDecoder<A, never>,
      params?: QueryParams,
      options?: DecodeOptions,
    ) {
      const page = Number(params?.page ?? 1);
      const pageSize = Number(params?.itemsPerPage ?? params?.pageSize ?? 30);
      const collectionSchema = Schema.Struct({
        "hydra:member": Schema.Array(itemSchema),
        "hydra:totalItems": Schema.optional(Schema.Number),
      });
      return pipe(
        buildUrl(url, params),
        Effect.flatMap((resolvedUrl) =>
          executeJson(
            resolvedUrl,
            "GET",
            undefined,
            options?.headers,
            options,
          ),
        ),
        Effect.flatMap(decodeWith(collectionSchema, options)),
        Effect.map(({ "hydra:member": items, "hydra:totalItems": totalItems }) => ({
          items: Array.from(items),
          totalItems: totalItems ?? 0,
          page,
          pageSize,
        })),
      );
    },

    post<A>(
      url: string,
      body: unknown,
      schema: Schema.ConstraintDecoder<A, never>,
      options?: DecodeOptions,
    ) {
      return pipe(
        buildUrl(url),
        Effect.flatMap((resolvedUrl) =>
          executeJson(
            resolvedUrl,
            "POST",
            body,
            options?.headers,
            options,
          ),
        ),
        Effect.flatMap(decodeWith(schema, options)),
      );
    },

    postVoid(url: string, body: unknown, options?: DecodeOptions) {
      return pipe(
        buildUrl(url),
        Effect.flatMap((resolvedUrl) =>
          executeVoid(
            resolvedUrl,
            "POST",
            body,
            options?.headers,
            options,
          ),
        ),
      );
    },

    put(url: string, body: unknown) {
      return pipe(
        buildUrl(url),
        Effect.flatMap((resolvedUrl) => executeVoid(resolvedUrl, "PUT", body)),
      );
    },

    del(url: string) {
      return pipe(
        buildUrl(url),
        Effect.flatMap((resolvedUrl) => executeVoid(resolvedUrl, "DELETE")),
      );
    },

    postFormData<A>(
      url: string,
      formData: FormData,
      schema: Schema.ConstraintDecoder<A, never>,
      options?: DecodeOptions,
    ) {
      return pipe(
        buildUrl(url),
        Effect.flatMap((resolvedUrl) =>
          pipe(
            buildHeaders({ Accept: "application/ld+json" }),
            Effect.flatMap((headers) =>
              executeFetch(resolvedUrl, {
                method: "POST",
                headers,
                body: formData,
              }),
            ),
          ),
        ),
        Effect.flatMap((response) => {
          if (!response.ok) {
            return readErrorBody(response).pipe(
              Effect.flatMap((responseBody) =>
                Effect.fail(mapStatusToError(response.status, responseBody)),
              ),
            );
          }
          return Effect.tryPromise({
            try: () => response.json(),
            catch: () => new Network({ message: "Failed to parse response JSON" }),
          });
        }),
        Effect.flatMap(decodeWith(schema, options)),
      );
    },

    postFormDataVoid(url: string, formData: FormData) {
      return pipe(
        buildUrl(url),
        Effect.flatMap((resolvedUrl) =>
          pipe(
            buildHeaders(),
            Effect.flatMap((headers) =>
              executeFetch(resolvedUrl, {
                method: "POST",
                headers,
                body: formData,
              }),
            ),
          ),
        ),
        Effect.flatMap((response) => {
          if (!response.ok) {
            return readErrorBody(response).pipe(
              Effect.flatMap((responseBody) =>
                Effect.fail(mapStatusToError(response.status, responseBody)),
              ),
            );
          }
          return Effect.void;
        }),
      );
    },
  };
}
