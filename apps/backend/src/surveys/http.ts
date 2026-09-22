import { randomUUID } from "node:crypto";
import {
  DepartmentId,
  SchoolSurveyCommandId,
  SchoolSurveys,
  SurveyId,
  SurveyResponseId,
  SemesterId,
  encodeSchoolSurveyResultsCsv,
  type PreparedSchoolSurveyResponse,
} from "@vektorprogrammet/domain";
import {
  OrganizationAuthorityInstantSchema,
  type OrganizationPersonAuthority,
} from "@vektorprogrammet/domain/organization";
import { Database } from "@vektorprogrammet/database";
import {
  resolveOrganizationPersonAuthorityWithSql,
  type OrganizationAuthorityRowLockMode,
} from "@vektorprogrammet/database/organization";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  CloseAdminSurveyEndpoint,
  CloseSchoolSurveyRequest,
  CreateAdminSurveyEndpoint,
  CreateSchoolSurveyRequest,
  ExportAdminResultsEndpoint,
  ExternalNativeApi,
  ListAdminSurveysEndpoint,
  ReadAdminCatalogEndpoint,
  ReadAdminResultsEndpoint,
  ReadSchoolSurveyEndpoint,
  SchoolSurveyAdminCatalogResource,
  SchoolSurveyAdminListResource,
  SchoolSurveyAdminResource,
  SchoolSurveyFormResource,
  SchoolSurveyResponseResource,
  SchoolSurveyResultsResource,
  SubmitSchoolSurveyResponseEndpoint,
  SubmitSchoolSurveyResponseRequest,
  makeNativeValidationError,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { resolveRequestCredentialInTransaction } from "../authority.js";
import { readBoundedJson } from "../http-api/read-json.js";
import { toHttpApiResponse } from "../http-api/transport.js";
import {
  HttpSemanticFailure,
  deriveHttpIdentity,
  deriveStrongETag,
  encodePathIdentity,
  jsonBodyBytes,
  nativeProblemResponse,
  parseIdempotencyKey,
  semanticRequestDigest,
  validationProblemResponse,
} from "../http-semantics.js";
import {
  authorizeAnonymousNativeOperation,
  genericContext,
  nativeCommandOutcomeResponse,
} from "../native-operation.js";

const maxSubmitBodyBytes = 65_536;
const maxAdminBodyBytes = 65_536;
const PERSON_CHALLENGE = 'VektorSession realm="native-api", Bearer realm="native-api"';

const adminListQueryKeys: Record<string, true> = {
  departmentId: true,
  semesterId: true,
};
const AdminListScope = Schema.Struct({
  departmentId: DepartmentId,
  semesterId: SemesterId,
});


type AnonymousEndpoint = typeof ReadSchoolSurveyEndpoint | typeof SubmitSchoolSurveyResponseEndpoint;

const semantic = <A>(operation: () => A) =>
  Effect.try({
    try: operation,
    catch: (cause) =>
      cause instanceof HttpSemanticFailure ? cause : new HttpSemanticFailure("internal.error", 500),
  });
const noQuery = (request: Request) =>
  semantic(() => {
    if (new URL(request.url).search !== "") {
      throw new HttpSemanticFailure("request.malformed", 400);
    }
  });

const strictDecode = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
  code: "request.malformed" | "validation.failed" | "internal.error",
) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      () =>
        new HttpSemanticFailure(
          code,
          code === "request.malformed" ? 400 : code === "validation.failed" ? 422 : 500,
        ),
    ),
  );

const strictAdminListScope = (request: Request) =>
  semantic(() => {
    const values = [...new URL(request.url).searchParams];
    if (
      values.length !== 2 ||
      values.some(([name]) => adminListQueryKeys[name] !== true) ||
      values.filter(([name]) => name === "departmentId").length !== 1 ||
      values.filter(([name]) => name === "semesterId").length !== 1
    ) {
      throw new HttpSemanticFailure("request.malformed", 400);
    }
    return Object.fromEntries(values);
  }).pipe(Effect.flatMap((scope) => strictDecode(AdminListScope, scope, "request.malformed")));

const transactionInstant = () =>
  Database.use((sql) =>
    sql<{ readonly now: string }>`
      SELECT to_char(
        transaction_timestamp() AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) AS now
    `.pipe(
      Effect.flatMap((rows) => {
        const now = rows[0]?.now;
        return now === undefined
          ? Effect.fail(new HttpSemanticFailure("internal.error", 500))
          : Effect.succeed(now);
      }),
    ),
  ).pipe(
    Effect.catchTag("SqlError", () =>
      Effect.fail(new HttpSemanticFailure("dependency.unavailable", 503)),
    ),
  );

const resolveSurveyAuthority = (
  request: Request,
  observedAt: string,
  lockMode: OrganizationAuthorityRowLockMode,
) =>
  Effect.gen(function* () {
    const authenticated = yield* resolveRequestCredentialInTransaction(request, "OAuthUserBearer", {
      now: () => observedAt,
    });
    if (authenticated.credential.principal._tag !== "Person") {
      return yield* Effect.fail(new HttpSemanticFailure("credential.invalid", 401));
    }
    const authority = yield* Database.use((sql) =>
      resolveOrganizationPersonAuthorityWithSql(
        sql,
        authenticated.credential.principal.personId,
        OrganizationAuthorityInstantSchema.make(observedAt),
        lockMode,
      ),
    );
    return { ...authenticated, authority };
  });

const managesDepartment = (
  authority: OrganizationPersonAuthority,
  departmentId: string,
): boolean =>
  authority.globalAdministrator === "Active" ||
  authority.memberships.some(
    (membership) =>
      membership.active && membership.teamLeader && String(membership.departmentId) === departmentId,
  );

const requireDepartmentManager = (
  authority: OrganizationPersonAuthority,
  departmentId: string,
  conceal: boolean,
) =>
  managesDepartment(authority, departmentId)
    ? Effect.void
    : Effect.fail(
        new HttpSemanticFailure(conceal ? "resource.not-found" : "authority.denied", conceal ? 404 : 403),
      );

const requireResultsAccess = (
  authority: OrganizationPersonAuthority,
  survey: typeof SchoolSurveyAdminResource.Type,
) =>
  authority.globalAdministrator === "Active" ||
  (survey.resultsVisibility === "DepartmentManagers" &&
    managesDepartment(authority, String(survey.departmentId)))
    ? Effect.void
    : Effect.fail(new HttpSemanticFailure("resource.not-found", 404));

const privateJsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
      vary: "Origin",
    },
  });

const ensureJsonContentType = (request: Request) =>
  semantic(() => {
    if (
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json"
    ) {
      throw new HttpSemanticFailure("media-type.unsupported", 415);
    }
  });

const authorizeAnonymous = (endpoint: AnonymousEndpoint, surveyId: SurveyId, now: string) =>
  authorizeAnonymousNativeOperation(
    Option.getOrThrow(reflectAccessSpec(endpoint)),
    {
      selection: "ExactlyOne",
      contexts: [
        genericContext({
          domainId: "surveys",
          resourceKind: "school-survey",
          resourceId: String(surveyId),
          authorityVersion: now,
        }),
      ],
    },
    now,
  );

/** Uses the service's position-normalized representation for idempotency semantics. */
const canonicalRequest = (prepared: PreparedSchoolSurveyResponse) => ({
  schoolId: prepared.schoolId,
  answers: prepared.answers.map((answer) =>
    answer.kind === "Check"
      ? { kind: answer.kind, questionId: answer.questionId, values: answer.values }
      : { kind: answer.kind, questionId: answer.questionId, value: answer.value },
  ),
});

const readAdminSurvey = (surveyId: SurveyId) =>
  SchoolSurveys.use(({ readAdminSurvey: read }) => read(surveyId)).pipe(
    Effect.flatMap((survey) => strictDecode(SchoolSurveyAdminResource, survey, "internal.error")),
  );

const read = (request: Request, surveyId: SurveyId) =>
  Effect.gen(function* () {
    yield* noQuery(request);
    return yield* Database.use((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* Database.use(
            (transaction) =>
              transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`,
          );
          const now = yield* transactionInstant();
          yield* authorizeAnonymous(ReadSchoolSurveyEndpoint, surveyId, now);
          const body = yield* SchoolSurveys.use(({ readForm }) => readForm(surveyId));
          const response = yield* strictDecode(SchoolSurveyFormResource, body, "internal.error");
          return new Response(JSON.stringify(response), {
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
              vary: "Origin",
            },
          });
        }),
      ),
    );
  });

const submit = (request: Request, surveyId: SurveyId) =>
  Effect.gen(function* () {
    yield* noQuery(request);
    yield* ensureJsonContentType(request);
    const body = yield* strictDecode(
      SubmitSchoolSurveyResponseRequest,
      yield* readBoundedJson(request, maxSubmitBodyBytes),
      "validation.failed",
    );
    const idempotencyKeyHeader = request.headers.get("idempotency-key");
    const idempotencyKey = yield* semantic(() =>
      parseIdempotencyKey(idempotencyKeyHeader === null ? [] : [idempotencyKeyHeader]),
    );
    const operationId = "surveys.submitSchoolSurveyResponse";
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const now = yield* transactionInstant();
        yield* authorizeAnonymous(SubmitSchoolSurveyResponseEndpoint, surveyId, now);
        const prepared = yield* SchoolSurveys.use(({ prepareResponse }) =>
          prepareResponse({ surveyId, request: body }),
        );
        const identity = yield* semantic(() =>
          deriveHttpIdentity({
            credentialSubject: "Anonymous",
            qualifiedOperationId: operationId,
            normalizedTarget: `/api/surveys/${encodePathIdentity(surveyId)}/responses`,
            idempotencyKey,
          }),
        );
        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ body: canonicalRequest(prepared) }),
            operationId,
          },
          execute: SchoolSurveys.use(({ persistResponse }) =>
            Effect.gen(function* () {
              const response = yield* persistResponse({
                responseId: yield* semantic(() =>
                  SurveyResponseId.make(`survey_response_${randomUUID()}`),
                ),
                prepared,
              });
              const decoded = yield* Schema.decodeUnknownEffect(SchoolSurveyResponseResource)(
                response,
                {
                  onExcessProperty: "error",
                },
              ).pipe(Effect.mapError(() => new HttpSemanticFailure("internal.error", 500)));
              return {
                status: 201,
                mediaType: "application/json",
                headers: {
                  "content-type": "application/json",
                  etag: deriveStrongETag({
                    representationKind: "school-survey-response",
                    resourceIdentity: decoded.responseId,
                    version: decoded.submittedAt,
                  }),
                  location: `/api/surveys/${encodePathIdentity(surveyId)}/responses/${encodePathIdentity(decoded.responseId)}`,
                },
                bodyBytes: jsonBodyBytes(decoded),
              };
            }),
          ),
        };
      }),
      {
        retry: "serialization-or-unique-once",
        retryUniqueConstraints: ["native_http_idempotency_receipts_pkey"],
      },
    );
    return nativeCommandOutcomeResponse(outcome);
  });

const readAdminCatalog = (request: Request) =>
  Effect.gen(function* () {
    yield* noQuery(request);
    return yield* Database.use((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
          const now = yield* transactionInstant();
          const authorization = yield* resolveSurveyAuthority(request, now, "None");
          if (
            authorization.authority.globalAdministrator !== "Active" &&
            !authorization.authority.memberships.some(
              (membership) => membership.active && membership.teamLeader,
            )
          ) {
            return yield* Effect.fail(new HttpSemanticFailure("authority.denied", 403));
          }
          const catalog = yield* SchoolSurveys.use(({ readAdminCatalog: read }) =>
            read(authorization.authority),
          );
          const decoded = yield* strictDecode(
            SchoolSurveyAdminCatalogResource,
            catalog,
            "internal.error",
          );
          return privateJsonResponse(decoded);
        }),
      ),
    );
  });

const listAdminSurveys = (request: Request) =>
  Effect.gen(function* () {
    const scope = yield* strictAdminListScope(request);
    return yield* Database.use((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
          const now = yield* transactionInstant();
          const authorization = yield* resolveSurveyAuthority(request, now, "None");
          yield* requireDepartmentManager(authorization.authority, String(scope.departmentId), false);
          const surveys = yield* SchoolSurveys.use(({ listAdminSurveys: list }) => list(scope));
          const decoded = yield* strictDecode(
            SchoolSurveyAdminListResource,
            surveys,
            "internal.error",
          );
          return privateJsonResponse(decoded);
        }),
      ),
    );
  });

const createAdminSurvey = (request: Request) =>
  Effect.gen(function* () {
    yield* noQuery(request);
    yield* ensureJsonContentType(request);
    const body = yield* strictDecode(
      CreateSchoolSurveyRequest,
      yield* readBoundedJson(request, maxAdminBodyBytes),
      "validation.failed",
    );
    const idempotencyKeyHeader = request.headers.get("idempotency-key");
    const idempotencyKey = yield* semantic(() =>
      parseIdempotencyKey(idempotencyKeyHeader === null ? [] : [idempotencyKeyHeader]),
    );
    const operationId = "surveys.createAdminSurvey";
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const now = yield* transactionInstant();
        const authorization = yield* resolveSurveyAuthority(request, now, "ForShare");
        yield* requireDepartmentManager(authorization.authority, String(body.departmentId), false);
        const identity = yield* semantic(() =>
          deriveHttpIdentity({
            credentialSubject: `Person:${authorization.authority.personId}`,
            qualifiedOperationId: operationId,
            normalizedTarget: "/api/surveys/admin",
            idempotencyKey,
          }),
        );
        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ body }),
            operationId,
          },
          execute: SchoolSurveys.use(({ createAdminSurvey: create }) =>
            Effect.gen(function* () {
              const survey = yield* create({
                commandId: SchoolSurveyCommandId.make(identity.commandId),
                surveyId: SurveyId.make(`survey_${randomUUID()}`),
                actorPersonId: authorization.authority.personId,
                occurredAt: OrganizationAuthorityInstantSchema.make(now),
                request: body,
              });
              const decoded = yield* strictDecode(SchoolSurveyAdminResource, survey, "internal.error");
              return {
                status: 201,
                mediaType: "application/json",
                headers: {
                  "content-type": "application/json",
                  etag: deriveStrongETag({
                    representationKind: "school-survey-admin",
                    resourceIdentity: String(decoded.surveyId),
                    version: decoded.revision,
                  }),
                  location: `/api/surveys/${encodePathIdentity(decoded.surveyId)}`,
                },
                bodyBytes: jsonBodyBytes(decoded),
              };
            }),
          ),
        };
      }),
      {
        retry: "serialization-or-unique-once",
        retryUniqueConstraints: ["native_http_idempotency_receipts_pkey"],
      },
    );
    return nativeCommandOutcomeResponse(outcome);
  });

const closeAdminSurvey = (request: Request, surveyId: SurveyId) =>
  Effect.gen(function* () {
    yield* noQuery(request);
    yield* ensureJsonContentType(request);
    const body = yield* strictDecode(
      CloseSchoolSurveyRequest,
      yield* readBoundedJson(request, maxAdminBodyBytes),
      "validation.failed",
    );
    const idempotencyKeyHeader = request.headers.get("idempotency-key");
    const idempotencyKey = yield* semantic(() =>
      parseIdempotencyKey(idempotencyKeyHeader === null ? [] : [idempotencyKeyHeader]),
    );
    const operationId = "surveys.closeAdminSurvey";
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const now = yield* transactionInstant();
        const authorization = yield* resolveSurveyAuthority(request, now, "ForShare");
        const survey = yield* readAdminSurvey(surveyId);
        yield* requireDepartmentManager(
          authorization.authority,
          String(survey.departmentId),
          true,
        );
        const identity = yield* semantic(() =>
          deriveHttpIdentity({
            credentialSubject: `Person:${authorization.authority.personId}`,
            qualifiedOperationId: operationId,
            normalizedTarget: `/api/surveys/admin/${encodePathIdentity(surveyId)}/close`,
            idempotencyKey,
          }),
        );
        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ body }),
            operationId,
          },
          execute: SchoolSurveys.use(({ closeAdminSurvey: close }) =>
            Effect.gen(function* () {
              const closed = yield* close({
                commandId: SchoolSurveyCommandId.make(identity.commandId),
                surveyId,
                actorPersonId: authorization.authority.personId,
                occurredAt: OrganizationAuthorityInstantSchema.make(now),
                request: body,
              });
              const decoded = yield* strictDecode(
                SchoolSurveyAdminResource,
                closed,
                "internal.error",
              );
              return {
                status: 200,
                mediaType: "application/json",
                headers: {
                  "content-type": "application/json",
                  etag: deriveStrongETag({
                    representationKind: "school-survey-admin",
                    resourceIdentity: String(decoded.surveyId),
                    version: decoded.revision,
                  }),
                },
                bodyBytes: jsonBodyBytes(decoded),
              };
            }),
          ),
        };
      }),
      {
        retry: "serialization-or-unique-once",
        retryUniqueConstraints: ["native_http_idempotency_receipts_pkey"],
      },
    );
    return nativeCommandOutcomeResponse(outcome);
  });

const readAdminResults = (request: Request, surveyId: SurveyId) =>
  Effect.gen(function* () {
    yield* noQuery(request);
    return yield* Database.use((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
          const now = yield* transactionInstant();
          const authorization = yield* resolveSurveyAuthority(request, now, "None");
          const survey = yield* readAdminSurvey(surveyId);
          yield* requireResultsAccess(authorization.authority, survey);
          const results = yield* SchoolSurveys.use(({ readAdminResults: read }) => read(surveyId));
          const decoded = yield* strictDecode(
            SchoolSurveyResultsResource,
            results,
            "internal.error",
          );
          return privateJsonResponse(decoded);
        }),
      ),
    );
  });

const exportAdminResults = (request: Request, surveyId: SurveyId) =>
  Effect.gen(function* () {
    yield* noQuery(request);
    return yield* Database.use((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
          const now = yield* transactionInstant();
          const authorization = yield* resolveSurveyAuthority(request, now, "None");
          const survey = yield* readAdminSurvey(surveyId);
          yield* requireResultsAccess(authorization.authority, survey);
          const results = yield* SchoolSurveys.use(({ readAdminResults: read }) => read(surveyId));
          const decoded = yield* strictDecode(
            SchoolSurveyResultsResource,
            results,
            "internal.error",
          );
          const safeSurveyId = encodeURIComponent(String(surveyId)).replace(
            /[!'()*]/gu,
            (character) => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`,
          );
          return new Response(encodeSchoolSurveyResultsCsv(decoded), {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": `attachment; filename="school-survey-${safeSurveyId}-results.csv"`,
              "cache-control": "private, no-store",
              vary: "Origin",
            },
          });
        }),
      ),
    );
  });

const schoolSurveyValidationProblem = (): Response =>
  validationProblemResponse("validation.failed", [makeNativeValidationError("", "invalid")]);

const errorResponse = (cause: unknown): Response => {
  if (cause instanceof HttpSemanticFailure) {
    return cause.code === "validation.failed"
      ? schoolSurveyValidationProblem()
      : nativeProblemResponse(
          cause.code,
          cause.status,
          cause.status === 401 ? { "www-authenticate": PERSON_CHALLENGE } : undefined,
        );
  }
  const tag =
    cause !== null && typeof cause === "object" && "_tag" in cause && typeof cause._tag === "string"
      ? cause._tag
      : undefined;
  switch (tag) {
    case "UnauthenticatedActor":
      return nativeProblemResponse("credential.invalid", 401, {
        "www-authenticate": PERSON_CHALLENGE,
      });
    case "SchoolSurveyNotFound":
      return nativeProblemResponse("resource.not-found", 404);
    case "SchoolSurveyScopeInvalid":
      return nativeProblemResponse("scope.invalid", 422);
    case "SchoolSurveyStaleRevision":
    case "SchoolSurveyInvalidState":
      return nativeProblemResponse("precondition.failed", 412);
    case "SchoolSurveyCommandConflict":
      return nativeProblemResponse("idempotency.digest-conflict", 409);
    case "SchoolSurveyValidationFailed":
      return schoolSurveyValidationProblem();
    case "OrganizationDecodeError":
    case "OrganizationPersistenceError":
      return nativeProblemResponse("organization.unavailable", 503);
    case "SchoolSurveyPersistenceError":
    case "IdentityEngineError":
    case "SqlError":
      return nativeProblemResponse("dependency.unavailable", 503);
    case "NativeHttpReceiptPersistenceError":
      return nativeProblemResponse("idempotency.unavailable", 503);
    case "SchoolSurveyDecodeError":
      return nativeProblemResponse("internal.error", 500);
    default:
      return nativeProblemResponse("internal.error", 500);
  }
};

/** Native HttpApi handlers for anonymous participation and authorized school-survey operations. */
export const SchoolSurveysApiHandlers = () =>
  HttpApiBuilder.group(ExternalNativeApi, "surveys", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("readSchoolSurvey", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => read(webRequest, params.surveyId),
            errorResponse,
          ),
        )
        .handleRaw("submitSchoolSurveyResponse", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => submit(webRequest, params.surveyId),
            errorResponse,
          ),
        )
        .handleRaw("readAdminCatalog", ({ request }) =>
          toHttpApiResponse(request, readAdminCatalog, errorResponse),
        )
        .handleRaw("listAdminSurveys", ({ request }) =>
          toHttpApiResponse(request, listAdminSurveys, errorResponse),
        )
        .handleRaw("createAdminSurvey", ({ request }) =>
          toHttpApiResponse(request, createAdminSurvey, errorResponse),
        )
        .handleRaw("closeAdminSurvey", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => closeAdminSurvey(webRequest, params.surveyId),
            errorResponse,
          ),
        )
        .handleRaw("readAdminResults", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readAdminResults(webRequest, params.surveyId),
            errorResponse,
          ),
        )
        .handleRaw("exportAdminResults", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => exportAdminResults(webRequest, params.surveyId),
            errorResponse,
          ),
        ),
    ),
  );
