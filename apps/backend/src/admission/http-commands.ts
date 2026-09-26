/** Admission command handlers: returning assistants, admission periods, and public applications. */
import {
  AdmissionPeriodCommandId,
  AdmissionPeriodCommandSchema,
  AdmissionPeriodNotFound,
  type AdmissionPeriodId,
} from "@vektorprogrammet/domain/admission-period";
import { Admissions } from "@vektorprogrammet/domain/admissions";
import {
  PublicApplicationCommandIdSchema,
  PublicApplicationRateLimitExceeded,
  ReturningAssistantRegistrationInputSchema,
  ReturningAssistants,
  ReturningCommandIdSchema,
} from "@vektorprogrammet/domain/application";
import {
  CreateAdmissionPeriodEndpoint,
  CreateAdmissionPeriodRequest,
  RegisterReturningAssistantEndpoint,
  ReviseAdmissionPeriodEndpoint,
  SubmitApplicationEndpoint,
  SubmitApplicationRequest,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { Clock, DateTime, Effect, Option, Predicate } from "effect";
import { currentInstant, resolveRequestPersonAuthorityInTransaction } from "../authority.js";
import {
  authorizeAnonymous,
  commandOutcomeResponse,
  commandReceiptProblems,
  httpIdentity,
  idempotencyKeyOf,
  requireCurrentETag,
  requiredIfMatchOf,
  requireNoQuery,
  semanticProblem,
  unreachable,
} from "../http-api/problem.js";
import { publicRateLimitKey } from "../http-api/public-rate-limit.js";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  deriveStrongETag,
  encodePathIdentity,
  jsonBodyBytes,
  normalizeTarget,
  semanticMutationRequest,
  semanticRequestDigest,
} from "../http-semantics.js";
import { genericContext } from "../native-operation.js";
import {
  admissionGrantScopes,
  authorizeAdmissionPerson,
  returningAuthorization,
} from "./http-access.js";
import { admissionActorForAuthority, type AdmissionApiHttpOptions } from "./http-context.js";
import { decodeAdmissionPeriodPatch, decodeJson } from "./http-decode.js";
import { admissionProblems } from "./http-problem.js";

export const registerReturningAssistant = (request: Request, input: AdmissionApiHttpOptions) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);

    const payload = yield* decodeJson(
      request,
      ReturningAssistantRegistrationInputSchema,
      input.config.maxBodyBytes,
    );

    const idempotencyKey = yield* idempotencyKeyOf(request);

    const operationId = "admissions.registerReturningAssistant";

    // Domain failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;

        // Returning-assistant persistence reads the instant after it takes its locks.
        const now =
          input.config.now ??
          (() => DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe())));

        const authorization = yield* returningAuthorization(
          request,
          input,
          RegisterReturningAssistantEndpoint,
        );

        yield* ReturningAssistants.use(({ preflight }) =>
          preflight(
            {
              admissionPeriodId: payload.admissionPeriodId,
              teamIds: payload.teamIds,
            },
            {
              personId: authorization.authority.personId,
              now,
            },
          ),
        );

        const identity = yield* httpIdentity({
          credentialSubject: `Person:${authorization.authority.personId}`,
          qualifiedOperationId: operationId,
          normalizedTarget: "/api/returning-assistant/registrations",
          idempotencyKey,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ body: payload }),
            operationId,
          },
          execute: ReturningAssistants.use((returning) =>
            Effect.gen(function* () {
              const registered = yield* returning.register(
                {
                  ...payload,
                  commandId: ReturningCommandIdSchema.make(identity.commandId),
                },
                {
                  personId: authorization.authority.personId,
                  now,
                },
              );

              return {
                status: 201,
                mediaType: "application/json",
                headers: {
                  "content-type": "application/json",
                  location: `/api/returning-assistant/registrations/${encodePathIdentity(registered.observation.registrationId)}`,
                  etag: deriveStrongETag({
                    representationKind: "ReturningAssistantRegistration",
                    resourceIdentity: registered.observation.registrationId,
                    version: registered.observation.revision,
                  }),
                },
                bodyBytes: jsonBodyBytes(registered),
              };
            }),
          ),
        };
      }),
      { retry: "serialization-once" },
    );

    return yield* commandOutcomeResponse(outcome);
  }).pipe(admissionProblems(request, "returning.unavailable"), commandReceiptProblems);

export const createAdmissionPeriod = (request: Request, input: AdmissionApiHttpOptions) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);

    const payload = yield* decodeJson(
      request,
      CreateAdmissionPeriodRequest,
      input.config.maxBodyBytes,
    );

    const admissionPeriodId = input.config.nextAdmissionPeriodId();

    const idempotencyKey = yield* idempotencyKeyOf(request);

    const operationId = "admissions.createAdmissionPeriod";

    // Domain failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const authorization = yield* resolveRequestPersonAuthorityInTransaction(request, {
          now: input.config.now,
        });

        const actor = yield* admissionActorForAuthority(
          authorization.authority,
          payload.departmentId,
        );

        const now = authorization.authorizationInstant;
        yield* authorizeAdmissionPerson(request, {
          spec: Option.getOrThrow(reflectAccessSpec(CreateAdmissionPeriodEndpoint)),
          credential: authorization.credential,
          personId: actor.personId,
          resolution: {
            selection: "ExactlyOne",
            contexts: [
              genericContext({
                domainId: "admissions",
                departmentId: Predicate.isTagged(actor, "DepartmentAdministrator")
                  ? actor.departmentId
                  : (payload.departmentId ?? null),
                resourceKind: "admission-period",
                resourceId: admissionPeriodId,
                authorityVersion: `admissions:${actor._tag}`,
              }),
            ],
          },
          grantScopes: admissionGrantScopes(actor),
          now,
        });

        const identity = yield* httpIdentity({
          credentialSubject: `Person:${actor.personId}`,
          qualifiedOperationId: operationId,
          normalizedTarget: "/api/admission-periods",
          idempotencyKey,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ body: payload }),
            operationId,
          },
          execute: Admissions.use((admissions) =>
            Effect.gen(function* () {
              const created = yield* admissions.executeAdmissionPeriod(
                AdmissionPeriodCommandSchema.cases.CreateAdmissionPeriod.make({
                  commandId: AdmissionPeriodCommandId.make(identity.commandId),
                  ...payload,
                }),
                { actor, now, admissionPeriodId },
              );

              const period = created.period;

              const etag = deriveStrongETag({
                representationKind: "AdmissionPeriodManagementItem",
                resourceIdentity: period.id,
                version: period.revision,
              });

              return {
                status: 201,
                mediaType: "application/json",
                headers: {
                  "content-type": "application/json",
                  location: `/api/admission-periods/${encodePathIdentity(period.id)}`,
                  etag,
                },
                bodyBytes: jsonBodyBytes({
                  id: period.id,
                  departmentId: period.departmentId,
                  semesterId: period.semesterId,
                  startAt: period.startAt,
                  endAt: period.endAt,
                  revision: period.revision,
                  etag,
                }),
              };
            }),
          ),
        };
      }),
      // A concurrent create for the same department and semester commits after this
      // snapshot; the restarted transaction sees it and answers that the period exists.
      { retry: "serialization-once" },
    );

    return yield* commandOutcomeResponse(outcome);
  }).pipe(
    admissionProblems(request, "dependency.unavailable"),
    commandReceiptProblems,
    // A create looks up no period by id, and the period it writes has no earlier revision.
    unreachable("admission-period.not-found", "precondition.failed"),
  );

export const reviseAdmissionPeriod = (
  request: Request,
  admissionPeriodId: AdmissionPeriodId,
  input: AdmissionApiHttpOptions,
) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);

    const ifMatch = yield* requiredIfMatchOf(request);
    const idempotencyKey = yield* idempotencyKeyOf(request);

    const normalizedTarget = yield* semanticProblem(
      () => normalizeTarget("/api/admission-periods/{admissionPeriodId}", { admissionPeriodId }),
      ["request.malformed"],
    );

    const patch = yield* decodeAdmissionPeriodPatch(request, input.config.maxBodyBytes);
    const operationId = "admissions.reviseAdmissionPeriod";

    // Domain failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const authorization = yield* resolveRequestPersonAuthorityInTransaction(request, {
          now: input.config.now,
        });

        const actor = yield* admissionActorForAuthority(authorization.authority);
        const now = authorization.authorizationInstant;

        const periods = yield* Admissions.use(({ listAdmissionPeriodsForManagement }) =>
          listAdmissionPeriodsForManagement({ actor, now }),
        );

        const current = periods.find((period) => period.id === admissionPeriodId);

        if (current === undefined) {
          return yield* Effect.fail(new AdmissionPeriodNotFound({ admissionPeriodId }));
        }

        yield* authorizeAdmissionPerson(request, {
          spec: Option.getOrThrow(reflectAccessSpec(ReviseAdmissionPeriodEndpoint)),
          credential: authorization.credential,
          personId: actor.personId,
          resolution: {
            selection: "ExactlyOne",
            contexts: [
              genericContext({
                domainId: "admissions",
                departmentId: current.departmentId,
                resourceKind: "admission-period",
                resourceId: current.id,
                authorityVersion: `admissions:${actor._tag}`,
              }),
            ],
          },
          grantScopes: admissionGrantScopes(actor),
          now,
        });

        yield* requireCurrentETag(
          deriveStrongETag({
            representationKind: "AdmissionPeriodManagementItem",
            resourceIdentity: current.id,
            version: current.revision,
          }),
          ifMatch,
        );

        const identity = yield* httpIdentity({
          credentialSubject: `Person:${actor.personId}`,
          qualifiedOperationId: operationId,
          normalizedTarget,
          idempotencyKey,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest(semanticMutationRequest(patch, ifMatch)),
            operationId,
          },
          execute: Admissions.use((admissions) =>
            Effect.gen(function* () {
              const revised = yield* admissions.executeAdmissionPeriod(
                AdmissionPeriodCommandSchema.cases.ReviseAdmissionPeriod.make({
                  commandId: AdmissionPeriodCommandId.make(identity.commandId),
                  admissionPeriodId,
                  expectedRevision: current.revision,
                  startAt: patch.startAt ?? current.startAt,
                  endAt: patch.endAt ?? current.endAt,
                }),
                { actor, now, admissionPeriodId },
              );

              const period = revised.period;

              const etag = deriveStrongETag({
                representationKind: "AdmissionPeriodManagementItem",
                resourceIdentity: period.id,
                version: period.revision,
              });

              const body = {
                id: period.id,
                departmentId: period.departmentId,
                semesterId: period.semesterId,
                startAt: period.startAt,
                endAt: period.endAt,
                revision: period.revision,
                etag,
              };

              return {
                status: 200,
                mediaType: "application/json",
                headers: { "content-type": "application/json", etag },
                bodyBytes: jsonBodyBytes(body),
              };
            }),
          ),
        };
      }),
      // A concurrent revision commits after this snapshot; the restarted transaction reads
      // the new revision, so the stale If-Match answers precondition.failed.
      { retry: "serialization-once" },
    );

    return yield* commandOutcomeResponse(outcome);
  }).pipe(
    admissionProblems(request, "dependency.unavailable"),
    commandReceiptProblems,
    // A revision never creates a period.
    unreachable("admission-period.already-exists"),
  );

export const submitApplication = (request: Request, input: AdmissionApiHttpOptions) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const now = yield* currentInstant(input.config.now);

    if (!input.config.rateLimit.consume(publicRateLimitKey(request), now)) {
      return yield* Effect.fail(new PublicApplicationRateLimitExceeded({}));
    }

    const payload = yield* decodeJson(request, SubmitApplicationRequest, input.config.maxBodyBytes);

    const idempotencyKey = yield* idempotencyKeyOf(request);

    const operationId = "admissions.submitApplication";

    // Domain failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        yield* authorizeAnonymous(
          Option.getOrThrow(reflectAccessSpec(SubmitApplicationEndpoint)),
          {
            selection: "ExactlyOne",
            contexts: [
              genericContext({
                domainId: "admissions",
                authorityVersion: `admissions-application-create:${now}`,
              }),
            ],
          },
          now,
        );

        const identity = yield* httpIdentity({
          credentialSubject: "Anonymous",
          qualifiedOperationId: operationId,
          normalizedTarget: "/api/applications",
          idempotencyKey,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ body: payload }),
            operationId,
          },
          execute: Admissions.use((admissions) =>
            Effect.gen(function* () {
              const submitted = yield* admissions.executePublicApplication(
                {
                  commandId: PublicApplicationCommandIdSchema.make(identity.commandId),
                  ...payload,
                },
                {
                  now,
                  applicationId: input.config.nextApplicationId(),
                  applicantId: input.config.nextApplicantId(),
                  activationToken: input.config.nextActivationToken(),
                },
              );

              const confirmation = {
                _tag: "ApplicationConfirmed" as const,
                applicationId: submitted.observation.applicationId,
              };

              return {
                status: 201,
                mediaType: "application/json",
                headers: {
                  "content-type": "application/json",
                  location: `/api/applications/${encodePathIdentity(confirmation.applicationId)}`,
                  etag: deriveStrongETag({
                    representationKind: "PublicApplicationConfirmation",
                    resourceIdentity: confirmation.applicationId,
                    version: 0,
                  }),
                },
                bodyBytes: jsonBodyBytes(confirmation),
              };
            }),
          ),
        };
      }),
      // A concurrent submission for the same normalized email commits after this snapshot;
      // the restarted transaction sees it and answers the duplicate instead of a write failure.
      {
        retry: "serialization-or-unique-once",
        retryUniqueConstraints: [
          "admission_applicants_normalized_email_key",
          "native_http_idempotency_receipts_pkey",
        ],
      },
    );

    return yield* commandOutcomeResponse(outcome);
  }).pipe(
    admissionProblems(request, "dependency.unavailable"),
    commandReceiptProblems,
    // A submission looks up no confirmation.
    unreachable("application.not-found"),
  );
