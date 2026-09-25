import { DomainId, Scope } from "@vektorprogrammet/domain/authz";
import { randomUUID } from "node:crypto";
import {
  DepartmentId,
  SchoolSurveyCommandId,
  SchoolSurveys,
  SurveyId,
  SurveyResponseId,
  SemesterId,
  encodeSchoolSurveyResultsCsv,
  type SchoolSurveyFailure,
} from "@vektorprogrammet/domain";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
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
  schoolSurveyResultsCsvContentDisposition,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { type CredentialPresentation, Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Predicate, Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  resolveRequestCredentialInTransaction,
  type OrganizationResolutionError,
} from "../authority.js";
import {
  authorizeAnonymous,
  authorizePerson,
  commandOutcomeResponse,
  commandReceiptProblems,
  decodeRequest,
  httpIdentity,
  idempotencyKeyOf,
  personPresentation,
  problemMapper,
  readJsonBody,
  requestInvalid,
  requireNoQuery,
  strictOutput,
  unreachable,
  webHandler,
} from "../http-api/problem.js";
import {
  deriveStrongETag,
  encodePathIdentity,
  jsonBodyBytes,
  semanticRequestDigest,
} from "../http-semantics.js";
import { genericContext, type NativePersonAuthorization } from "../native-operation.js";

const maxSubmitBodyBytes = 65_536;

const maxAdminBodyBytes = 65_536;

/**
 * The media type of every survey command body: application/json in any case,
 * optionally with parameters, and with whitespace around the type ignored.
 */
const jsonMediaType = /^\s*application\/json\s*(?:;|$)/iu;

const adminListQueryKeys = {
  departmentId: true,
  semesterId: true,
} as const;

const AdminListScope = Schema.Struct({
  departmentId: DepartmentId,
  semesterId: SemesterId,
});

type AnonymousEndpoint =
  | typeof ReadSchoolSurveyEndpoint
  | typeof SubmitSchoolSurveyResponseEndpoint;

type AdminEndpoint =
  | typeof ReadAdminCatalogEndpoint
  | typeof ListAdminSurveysEndpoint
  | typeof CreateAdminSurveyEndpoint
  | typeof CloseAdminSurveyEndpoint
  | typeof ReadAdminResultsEndpoint
  | typeof ExportAdminResultsEndpoint;

/**
 * The one answer for every school-survey and Organization authority failure.
 */
const schoolSurveyProblems = problemMapper<SchoolSurveyFailure | OrganizationResolutionError>()({
  SchoolSurveyNotFound: () => Problem.make("resource.not-found"),
  SchoolSurveyScopeInvalid: () => Problem.make("scope.invalid"),
  SchoolSurveyStaleRevision: () => Problem.make("precondition.failed"),
  SchoolSurveyInvalidState: () => Problem.make("precondition.failed"),
  SchoolSurveyCommandConflict: () => Problem.make("idempotency.digest-conflict"),
  SchoolSurveyValidationFailed: requestInvalid,
  SchoolSurveyDecodeError: () => Problem.make("internal.error"),
  SchoolSurveyPersistenceError: () => Problem.make("dependency.unavailable"),
  OrganizationDecodeError: () => Problem.make("organization.unavailable"),
  OrganizationPersistenceError: () => Problem.make("organization.unavailable"),
});

/**
 * A person credential rejected inside the transaction is answered from the request's evidence.
 */
const surveyCredentialProblems = (presentation: CredentialPresentation) =>
  problemMapper<UnauthenticatedActor | IdentityEngineError>()({
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
    IdentityEngineError: () => Problem.make("dependency.unavailable"),
  });

/**
 * The administration list scope: exactly one department and one semester query parameter.
 */
const adminListScope = (request: Request) =>
  Effect.suspend(() => {
    const values = [...new URL(request.url).searchParams];

    return values.length !== 2 ||
      values.some(([name]) => !Object.hasOwn(adminListQueryKeys, name)) ||
      values.filter(([name]) => name === "departmentId").length !== 1 ||
      values.filter(([name]) => name === "semesterId").length !== 1
      ? Effect.fail(Problem.make("request.malformed"))
      : Schema.decodeUnknownEffect(AdminListScope)(Object.fromEntries(values), {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(() => Problem.make("request.malformed")));
  });

/**
 * The instant of the caller's transaction, at millisecond precision in UTC.
 * A database that cannot answer it is unavailable.
 */
const transactionInstant = Database.use((sql) =>
  sql<{ readonly now: string }>`
    SELECT to_char(
      transaction_timestamp() AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) AS now
  `.pipe(
    Effect.flatMap(([row]) =>
      row === undefined
        ? Effect.die(new Error("the transaction instant query returned no row"))
        : Effect.succeed(row.now),
    ),
  ),
).pipe(Effect.catchTag("SqlError", () => Effect.fail(Problem.make("dependency.unavailable"))));

/**
 * Runs one read in a read-only snapshot; a snapshot the database cannot open or
 * commit is a dependency outage.
 */
const snapshotRead = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Database.use((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;

        return yield* effect;
      }),
    ),
  ).pipe(Effect.catchTag("SqlError", () => Effect.fail(Problem.make("dependency.unavailable"))));

const resolveSurveyAuthority = (
  request: Request,
  observedAt: string,
  lockMode: OrganizationAuthorityRowLockMode,
) =>
  Effect.gen(function* () {
    const authenticated = yield* resolveRequestCredentialInTransaction(request, "OAuthUserBearer", {
      now: () => observedAt,
    });

    const principal = authenticated.credential.principal;

    if (!Predicate.isTagged(principal, "Person")) {
      return yield* new UnauthenticatedActor({ message: "authentication required" });
    }

    const authority = yield* Database.use((sql) =>
      resolveOrganizationPersonAuthorityWithSql(
        sql,
        principal.personId,
        OrganizationAuthorityInstantSchema.make(observedAt),
        lockMode,
      ),
    );

    return { ...authenticated, authority };
  });

const managesDepartment = (authority: OrganizationPersonAuthority, departmentId: string): boolean =>
  authority.globalAdministrator === "Active" ||
  authority.memberships.some(
    (membership) =>
      membership.active &&
      membership.teamLeader &&
      String(membership.departmentId) === departmentId,
  );

/**
 * Fails with `denial` unless the person manages the department's surveys.
 */
const requireDepartmentManager = <const Code extends "authority.denied" | "resource.not-found">(
  authority: OrganizationPersonAuthority,
  departmentId: string,
  denial: Code,
) => (managesDepartment(authority, departmentId) ? Effect.void : Effect.fail(Problem.make(denial)));

const hasResultsAccess = (
  authority: OrganizationPersonAuthority,
  survey: typeof SchoolSurveyAdminResource.Type,
): boolean =>
  authority.globalAdministrator === "Active" ||
  (survey.resultsVisibility === "DepartmentManagers" &&
    managesDepartment(authority, String(survey.departmentId)));

const redactResponseCount = (
  survey: typeof SchoolSurveyAdminResource.Type,
): typeof SchoolSurveyAdminResource.Type => ({ ...survey, responseCount: null });

const projectListedSurvey = (
  authority: OrganizationPersonAuthority,
  survey: typeof SchoolSurveyAdminResource.Type,
): typeof SchoolSurveyAdminResource.Type =>
  hasResultsAccess(authority, survey) ? survey : redactResponseCount(survey);

const projectMutationSurvey = (
  survey: typeof SchoolSurveyAdminResource.Type,
): typeof SchoolSurveyAdminResource.Type =>
  survey.resultsVisibility === "GlobalAdministrators" ? redactResponseCount(survey) : survey;

/**
 * Results a person may not see do not exist for them.
 */
const requireResultsAccess = (
  authority: OrganizationPersonAuthority,
  survey: typeof SchoolSurveyAdminResource.Type,
) =>
  hasResultsAccess(authority, survey)
    ? Effect.void
    : Effect.fail(Problem.make("resource.not-found"));

const privateJsonResponse = (body: Schema.Json): Response =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
      vary: "Origin",
    },
  });

/**
 * Evaluates an anonymous participation AccessSpec for one survey.
 */
const authorizeParticipant = (endpoint: AnonymousEndpoint, surveyId: SurveyId, now: string) =>
  authorizeAnonymous(
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

/**
 * Evaluates an administration AccessSpec for the resolved Person at one instant.
 */
const authorizeAdmin = (
  credential: NativePersonAuthorization["credential"],
  endpoint: AdminEndpoint,
  authority: OrganizationPersonAuthority,
  now: string,
  departmentId: DepartmentId | null,
  presentation: CredentialPresentation,
) =>
  authorizePerson(
    {
      spec: Option.getOrThrow(reflectAccessSpec(endpoint)),
      credential,
      personId: authority.personId,
      resolution: {
        selection: "ExactlyOne",
        contexts: [
          genericContext({
            domainId: "surveys",
            departmentId: departmentId ?? undefined,
            authorityVersion: now,
          }),
        ],
      },
      grantScopes:
        departmentId === null
          ? [Scope.Domain({ domainId: DomainId.make("surveys") })]
          : [Scope.Department({ departmentId })],
      now,
    },
    presentation,
  );

/**
 * One survey's administration resource; a stored survey outside its schema is a defect.
 */
const readAdminSurvey = (surveyId: SurveyId) =>
  SchoolSurveys.use(({ readAdminSurvey: read }) => read(surveyId)).pipe(
    Effect.flatMap(strictOutput(SchoolSurveyAdminResource)),
  );

const read = (request: Request, surveyId: SurveyId) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);

    return yield* snapshotRead(
      Effect.gen(function* () {
        const now = yield* transactionInstant;
        yield* authorizeParticipant(ReadSchoolSurveyEndpoint, surveyId, now);
        const body = yield* SchoolSurveys.use(({ readForm }) => readForm(surveyId));
        const response = yield* strictOutput(SchoolSurveyFormResource)(body);

        return new Response(JSON.stringify(response), {
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            vary: "Origin",
          },
        });
      }),
    ).pipe(
      schoolSurveyProblems,
      // A form read changes nothing, so it cannot fail a scope, lifecycle, command, or answer.
      unreachable(
        "scope.invalid",
        "precondition.failed",
        "idempotency.digest-conflict",
        "validation.failed",
      ),
    );
  });

/**
 * Answers are keyed by question and Check selections are sets, so their order carries no
 * meaning. The digest orders both from the request alone, so an accepted response still
 * replays after its survey closes. A repeated question never validates, so ordering by
 * question alone is canonical for every body that can own a receipt.
 */
const unorderedSubmission = (body: SubmitSchoolSurveyResponseRequest) => ({
  schoolId: body.schoolId,
  answers: body.answers
    .map((answer): SubmitSchoolSurveyResponseRequest["answers"][number] =>
      answer.kind === "Check" ? { ...answer, values: answer.values.toSorted() } : answer,
    )
    .toSorted((left, right) =>
      left.questionId < right.questionId ? -1 : left.questionId > right.questionId ? 1 : 0,
    ),
});

const submit = (request: Request, surveyId: SurveyId) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);

    const body = yield* decodeRequest(SubmitSchoolSurveyResponseRequest)(
      yield* readJsonBody(request, jsonMediaType, maxSubmitBodyBytes),
    );

    const idempotencyKey = yield* idempotencyKeyOf(request);

    const operationId = "surveys.submitSchoolSurveyResponse";

    // Domain failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const now = yield* transactionInstant;
        yield* authorizeParticipant(SubmitSchoolSurveyResponseEndpoint, surveyId, now);

        const identity = yield* httpIdentity({
          credentialSubject: "Anonymous",
          qualifiedOperationId: operationId,
          normalizedTarget: `/api/surveys/public/${encodePathIdentity(surveyId)}/responses`,
          idempotencyKey,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ body: unorderedSubmission(body) }),
            operationId,
          },
          execute: SchoolSurveys.use(({ prepareResponse, persistResponse }) =>
            Effect.gen(function* () {
              const prepared = yield* prepareResponse({ surveyId, request: body });

              const response = yield* persistResponse({
                responseId: SurveyResponseId.make(`survey_response_${randomUUID()}`),
                prepared,
              });

              const decoded = yield* strictOutput(SchoolSurveyResponseResource)(response);

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
                  location: `/api/surveys/public/${encodePathIdentity(surveyId)}/responses/${encodePathIdentity(decoded.responseId)}`,
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
    ).pipe(
      schoolSurveyProblems,
      commandReceiptProblems,
      // A response is prepared against its open survey and neither scopes nor revises a survey.
      unreachable("scope.invalid", "precondition.failed"),
    );

    return yield* commandOutcomeResponse(outcome);
  });

const readAdminCatalog = (request: Request) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);

    const presentation = personPresentation(request);

    return yield* snapshotRead(
      Effect.gen(function* () {
        const now = yield* transactionInstant;
        const authorization = yield* resolveSurveyAuthority(request, now, "None");

        if (
          authorization.authority.globalAdministrator !== "Active" &&
          !authorization.authority.memberships.some(
            (membership) => membership.active && membership.teamLeader,
          )
        ) {
          return yield* Problem.make("authority.denied");
        }

        yield* authorizeAdmin(
          authorization.credential,
          ReadAdminCatalogEndpoint,
          authorization.authority,
          now,
          null,
          presentation,
        );

        const catalog = yield* SchoolSurveys.use(({ readAdminCatalog: read }) =>
          read(authorization.authority),
        );

        const decoded = yield* strictOutput(SchoolSurveyAdminCatalogResource)(catalog);

        return privateJsonResponse(decoded);
      }),
    ).pipe(
      schoolSurveyProblems,
      surveyCredentialProblems(presentation),
      // The catalog reveals every scope it concerns and reads no survey, command, or answer.
      unreachable(
        "resource.not-found",
        "scope.invalid",
        "precondition.failed",
        "idempotency.digest-conflict",
        "validation.failed",
      ),
    );
  });

const listAdminSurveys = (request: Request) =>
  Effect.gen(function* () {
    const scope = yield* adminListScope(request);

    const presentation = personPresentation(request);

    return yield* snapshotRead(
      Effect.gen(function* () {
        const now = yield* transactionInstant;
        const authorization = yield* resolveSurveyAuthority(request, now, "None");
        yield* requireDepartmentManager(
          authorization.authority,
          String(scope.departmentId),
          "authority.denied",
        );
        yield* authorizeAdmin(
          authorization.credential,
          ListAdminSurveysEndpoint,
          authorization.authority,
          now,
          scope.departmentId,
          presentation,
        );
        const surveys = yield* SchoolSurveys.use(({ listAdminSurveys: list }) => list(scope));

        const decoded = yield* strictOutput(SchoolSurveyAdminListResource)({
          ...surveys,
          surveys: surveys.surveys.map((survey) =>
            projectListedSurvey(authorization.authority, survey),
          ),
        });

        return privateJsonResponse(decoded);
      }),
    ).pipe(
      schoolSurveyProblems,
      surveyCredentialProblems(presentation),
      // A list changes nothing, so it cannot fail a lifecycle, command, or answer.
      unreachable("precondition.failed", "idempotency.digest-conflict", "validation.failed"),
    );
  });

const createAdminSurvey = (request: Request) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);

    const body = yield* decodeRequest(CreateSchoolSurveyRequest)(
      yield* readJsonBody(request, jsonMediaType, maxAdminBodyBytes),
    );

    const idempotencyKey = yield* idempotencyKeyOf(request);

    const presentation = personPresentation(request);

    const operationId = "surveys.createAdminSurvey";

    // Domain and credential failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const now = yield* transactionInstant;
        const authorization = yield* resolveSurveyAuthority(request, now, "ForShare");
        yield* requireDepartmentManager(
          authorization.authority,
          String(body.departmentId),
          "authority.denied",
        );
        yield* authorizeAdmin(
          authorization.credential,
          CreateAdminSurveyEndpoint,
          authorization.authority,
          now,
          body.departmentId,
          presentation,
        );

        const identity = yield* httpIdentity({
          credentialSubject: `Person:${authorization.authority.personId}`,
          qualifiedOperationId: operationId,
          normalizedTarget: "/api/surveys/admin",
          idempotencyKey,
        });

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

              const decoded = yield* strictOutput(SchoolSurveyAdminResource)(
                projectMutationSurvey(survey),
              );

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
                  location: `/api/surveys/public/${encodePathIdentity(decoded.surveyId)}`,
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
    ).pipe(
      schoolSurveyProblems,
      commandReceiptProblems,
      surveyCredentialProblems(presentation),
      // Create conceals no scope and reads back the survey it inserted, which has no
      // revision to contest.
      unreachable("resource.not-found", "precondition.failed"),
    );

    return yield* commandOutcomeResponse(outcome);
  });

const closeAdminSurvey = (request: Request, surveyId: SurveyId) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);

    const body = yield* decodeRequest(CloseSchoolSurveyRequest)(
      yield* readJsonBody(request, jsonMediaType, maxAdminBodyBytes),
    );

    const idempotencyKey = yield* idempotencyKeyOf(request);

    const presentation = personPresentation(request);

    const operationId = "surveys.closeAdminSurvey";

    // Domain and credential failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const now = yield* transactionInstant;
        const authorization = yield* resolveSurveyAuthority(request, now, "ForShare");
        const survey = yield* readAdminSurvey(surveyId);
        yield* requireDepartmentManager(
          authorization.authority,
          String(survey.departmentId),
          "resource.not-found",
        );
        yield* authorizeAdmin(
          authorization.credential,
          CloseAdminSurveyEndpoint,
          authorization.authority,
          now,
          survey.departmentId,
          presentation,
        );

        const identity = yield* httpIdentity({
          credentialSubject: `Person:${authorization.authority.personId}`,
          qualifiedOperationId: operationId,
          normalizedTarget: `/api/surveys/admin/${encodePathIdentity(surveyId)}/close`,
          idempotencyKey,
        });

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

              const decoded = yield* strictOutput(SchoolSurveyAdminResource)(
                projectMutationSurvey(closed),
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
    ).pipe(
      schoolSurveyProblems,
      commandReceiptProblems,
      surveyCredentialProblems(presentation),
      // Close changes one survey's lifecycle, never its owner scope.
      unreachable("scope.invalid"),
    );

    return yield* commandOutcomeResponse(outcome);
  });

const readAdminResults = (request: Request, surveyId: SurveyId) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);

    const presentation = personPresentation(request);

    return yield* snapshotRead(
      Effect.gen(function* () {
        const now = yield* transactionInstant;
        const authorization = yield* resolveSurveyAuthority(request, now, "None");
        const survey = yield* readAdminSurvey(surveyId);
        yield* requireResultsAccess(authorization.authority, survey);
        yield* authorizeAdmin(
          authorization.credential,
          ReadAdminResultsEndpoint,
          authorization.authority,
          now,
          survey.departmentId,
          presentation,
        );
        const results = yield* SchoolSurveys.use(({ readAdminResults: read }) => read(surveyId));

        const decoded = yield* strictOutput(SchoolSurveyResultsResource)(results);

        return privateJsonResponse(decoded);
      }),
    ).pipe(
      schoolSurveyProblems,
      surveyCredentialProblems(presentation),
      // A results read changes nothing, so it cannot fail a scope, lifecycle, command, or answer.
      unreachable(
        "scope.invalid",
        "precondition.failed",
        "idempotency.digest-conflict",
        "validation.failed",
      ),
    );
  });

const exportAdminResults = (request: Request, surveyId: SurveyId) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);

    const presentation = personPresentation(request);

    return yield* snapshotRead(
      Effect.gen(function* () {
        const now = yield* transactionInstant;
        const authorization = yield* resolveSurveyAuthority(request, now, "None");
        const survey = yield* readAdminSurvey(surveyId);
        yield* requireResultsAccess(authorization.authority, survey);
        yield* authorizeAdmin(
          authorization.credential,
          ExportAdminResultsEndpoint,
          authorization.authority,
          now,
          survey.departmentId,
          presentation,
        );
        const results = yield* SchoolSurveys.use(({ readAdminResults: read }) => read(surveyId));

        const decoded = yield* strictOutput(SchoolSurveyResultsResource)(results);

        const contentDisposition = schoolSurveyResultsCsvContentDisposition(surveyId);

        return new Response(encodeSchoolSurveyResultsCsv(decoded), {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": contentDisposition,
            "cache-control": "private, no-store",
            vary: "Origin",
          },
        });
      }),
    ).pipe(
      schoolSurveyProblems,
      surveyCredentialProblems(presentation),
      // An export changes nothing, so it cannot fail a scope, lifecycle, command, or answer.
      unreachable(
        "scope.invalid",
        "precondition.failed",
        "idempotency.digest-conflict",
        "validation.failed",
      ),
    );
  });

/** Native HttpApi handlers for anonymous participation and authorized school-survey operations. */
export const SchoolSurveysApiHandlers = () =>
  HttpApiBuilder.group(ExternalNativeApi, "surveys", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("readSchoolSurvey", ({ request, params }) =>
          webHandler(request, (webRequest) => read(webRequest, params.surveyId)),
        )
        .handleRaw("submitSchoolSurveyResponse", ({ request, params }) =>
          webHandler(request, (webRequest) => submit(webRequest, params.surveyId)),
        )
        .handleRaw("readAdminCatalog", ({ request }) => webHandler(request, readAdminCatalog))
        .handleRaw("listAdminSurveys", ({ request }) => webHandler(request, listAdminSurveys))
        .handleRaw("createAdminSurvey", ({ request }) => webHandler(request, createAdminSurvey))
        .handleRaw("closeAdminSurvey", ({ request, params }) =>
          webHandler(request, (webRequest) => closeAdminSurvey(webRequest, params.surveyId)),
        )
        .handleRaw("readAdminResults", ({ request, params }) =>
          webHandler(request, (webRequest) => readAdminResults(webRequest, params.surveyId)),
        )
        .handleRaw("exportAdminResults", ({ request, params }) =>
          webHandler(request, (webRequest) => exportAdminResults(webRequest, params.surveyId)),
        ),
    ),
  );
