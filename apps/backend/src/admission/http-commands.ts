/** Admission command handlers: returning assistants, admission periods, and public applications. */
import {
  AdmissionPeriodCommandId,
  AdmissionPeriodCommandSchema,
  AdmissionPeriodId,
  AdmissionPeriodNotFound,
} from "@vektorprogrammet/domain/admission-period";
import { Admissions } from "@vektorprogrammet/domain/admissions";
import {
  PublicApplicationCommandIdSchema,
  PublicApplicationRateLimitExceeded,
  ReturningAssistantRegistrationInputSchema,
  ReturningAssistants,
  ReturningCommandIdSchema,
} from "@vektorprogrammet/domain/application";
import { Scope } from "@vektorprogrammet/domain/authz";
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
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  HttpSemanticFailure,
  deriveHttpIdentity,
  deriveStrongETag,
  encodePathIdentity,
  evaluateMutationPrecondition,
  jsonBodyBytes,
  parseIdempotencyKey,
  parseRequiredIfMatch,
  semanticMutationRequest,
  semanticRequestDigest,
} from "../http-semantics.js";
import { publicRateLimitKey } from "../http-api/public-rate-limit.js";
import {
  authorizeAnonymousNativeOperation,
  authorizePersonNativeOperation,
  genericContext,
  nativeCommandOutcomeResponse,
} from "../native-operation.js";
import { admissionGrantScopes, returningAuthorization } from "./http-access.js";
import { admissionActorForAuthority, type AdmissionApiHttpOptions } from "./http-context.js";
import { decodeAdmissionPeriodPatch, decodeJson, rejectQueryString } from "./http-decode.js";
import { knownAdmissionFailure } from "./http-problem.js";

export const registerReturningAssistant = (request: Request, input: AdmissionApiHttpOptions) =>
  Effect.gen(function* () {
    yield* rejectQueryString(request);
    const contentType = request.headers.get("content-type") ?? "";

    if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
      return yield* Effect.fail(new HttpSemanticFailure("media-type.unsupported", 415));
    }

    const payload = yield* decodeJson(
      request,
      ReturningAssistantRegistrationInputSchema,
      input.config.maxBodyBytes,
    );

    const idempotencyKey = yield* Effect.try({
      try: () =>
        parseIdempotencyKey(
          request.headers.get("idempotency-key") === null
            ? []
            : [request.headers.get("idempotency-key")!],
        ),
      catch: knownAdmissionFailure,
    });

    const operationId = "admissions.registerReturningAssistant";

    const result = yield* executeNativeHttpCommandPostgres(
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

        const derived = yield* Effect.try({
          try: () =>
            deriveHttpIdentity({
              credentialSubject: `Person:${authorization.authority.personId}`,
              qualifiedOperationId: operationId,
              normalizedTarget: "/api/returning-assistant/registrations",
              idempotencyKey,
            }),
          catch: knownAdmissionFailure,
        });

        return {
          identity: {
            identitySha256: derived.identitySha256,
            requestSha256: semanticRequestDigest({ body: payload }),
            operationId,
          },
          execute: ReturningAssistants.use((returning) =>
            Effect.gen(function* () {
              const registered = yield* returning.register(
                {
                  ...payload,
                  commandId: ReturningCommandIdSchema.make(derived.commandId),
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

    return nativeCommandOutcomeResponse(result);
  });

export const createAdmissionPeriod = (request: Request, input: AdmissionApiHttpOptions) =>
  Effect.gen(function* () {
    yield* rejectQueryString(request);

    const payload = yield* decodeJson(
      request,
      CreateAdmissionPeriodRequest,
      input.config.maxBodyBytes,
    );

    const admissionPeriodId = input.config.nextAdmissionPeriodId();

    const idempotencyKey = yield* Effect.try({
      try: () =>
        parseIdempotencyKey(
          request.headers.get("idempotency-key") === null
            ? []
            : [request.headers.get("idempotency-key")!],
        ),
      catch: knownAdmissionFailure,
    });

    const operationId = "admissions.createAdmissionPeriod";

    const result = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const authorization = yield* resolveRequestPersonAuthorityInTransaction(request, {
          now: input.config.now,
        });

        const actor = yield* admissionActorForAuthority(
          authorization.authority,
          payload.departmentId,
        );

        const now = authorization.authorizationInstant;
        yield* authorizePersonNativeOperation({
          spec: Option.getOrThrow(reflectAccessSpec(CreateAdmissionPeriodEndpoint)),
          credential: authorization.credential,
          personId: actor.personId,
          resolution: {
            selection: "ExactlyOne",
            contexts: [
              genericContext({
                domainId: "admissions",
                departmentId: Predicate.isTagged(actor, "DepartmentLeader")
                  ? actor.departmentId
                  : (payload.departmentId ?? null),
                resourceKind: "admission-period",
                resourceId: admissionPeriodId,
                authorityVersion: `admissions:${actor._tag}`,
              }),
            ],
          },
          grantScopes: Predicate.isTagged(actor, "GlobalAdmin")
            ? [Scope.Global()]
            : Predicate.isTagged(actor, "DepartmentLeader")
              ? [Scope.Department({ departmentId: actor.departmentId })]
              : [],
          now,
        });

        const derived = yield* Effect.try({
          try: () =>
            deriveHttpIdentity({
              credentialSubject: `Person:${actor.personId}`,
              qualifiedOperationId: operationId,
              normalizedTarget: "/api/admission-periods",
              idempotencyKey,
            }),
          catch: knownAdmissionFailure,
        });

        return {
          identity: {
            identitySha256: derived.identitySha256,
            requestSha256: semanticRequestDigest({ body: payload }),
            operationId,
          },
          execute: Admissions.use((admissions) =>
            Effect.gen(function* () {
              const created = yield* admissions.executeAdmissionPeriod(
                AdmissionPeriodCommandSchema.cases.CreateAdmissionPeriod.make({
                  commandId: AdmissionPeriodCommandId.make(derived.commandId),
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
    );

    return nativeCommandOutcomeResponse(result);
  });

export const reviseAdmissionPeriod = (
  request: Request,
  admissionPeriodId: string,
  input: AdmissionApiHttpOptions,
) =>
  Effect.gen(function* () {
    yield* rejectQueryString(request);

    const { typedAdmissionPeriodId, ifMatch, idempotencyKey, normalizedTarget } = yield* Effect.try(
      {
        try: () => {
          const typedAdmissionPeriodId = AdmissionPeriodId.make(admissionPeriodId);

          return {
            typedAdmissionPeriodId,
            ifMatch: parseRequiredIfMatch(
              request.headers.get("if-match") === null ? [] : [request.headers.get("if-match")!],
            ),
            idempotencyKey: parseIdempotencyKey(
              request.headers.get("idempotency-key") === null
                ? []
                : [request.headers.get("idempotency-key")!],
            ),
            normalizedTarget: `/api/admission-periods/${encodePathIdentity(typedAdmissionPeriodId)}`,
          };
        },
        catch: knownAdmissionFailure,
      },
    );

    const patch = yield* decodeAdmissionPeriodPatch(request, input);
    const operationId = "admissions.reviseAdmissionPeriod";

    const result = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const authorization = yield* resolveRequestPersonAuthorityInTransaction(request, {
          now: input.config.now,
        });

        const actor = yield* admissionActorForAuthority(authorization.authority);
        const now = authorization.authorizationInstant;

        const periods = yield* Admissions.use(({ listAdmissionPeriodsForManagement }) =>
          listAdmissionPeriodsForManagement({ actor, now }),
        );

        const current = periods.find((period) => period.id === typedAdmissionPeriodId);

        if (current === undefined) {
          return yield* Effect.fail(
            new AdmissionPeriodNotFound({ admissionPeriodId: typedAdmissionPeriodId }),
          );
        }

        yield* authorizePersonNativeOperation({
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

        const currentETag = deriveStrongETag({
          representationKind: "AdmissionPeriodManagementItem",
          resourceIdentity: current.id,
          version: current.revision,
        });

        const precondition = yield* Effect.try({
          try: () => evaluateMutationPrecondition(currentETag, ifMatch),
          catch: knownAdmissionFailure,
        });

        if (Predicate.isTagged(precondition, "Failed")) {
          return yield* Effect.fail(
            new HttpSemanticFailure(precondition.code, precondition.status),
          );
        }

        const derived = yield* Effect.try({
          try: () =>
            deriveHttpIdentity({
              credentialSubject: `Person:${actor.personId}`,
              qualifiedOperationId: operationId,
              normalizedTarget,
              idempotencyKey,
            }),
          catch: knownAdmissionFailure,
        });

        return {
          identity: {
            identitySha256: derived.identitySha256,
            requestSha256: semanticRequestDigest(semanticMutationRequest(patch, ifMatch)),
            operationId,
          },
          execute: Admissions.use((admissions) =>
            Effect.gen(function* () {
              const revised = yield* admissions.executeAdmissionPeriod(
                AdmissionPeriodCommandSchema.cases.ReviseAdmissionPeriod.make({
                  commandId: AdmissionPeriodCommandId.make(derived.commandId),
                  admissionPeriodId: typedAdmissionPeriodId,
                  expectedRevision: current.revision,
                  startAt: patch.startAt ?? current.startAt,
                  endAt: patch.endAt ?? current.endAt,
                }),
                { actor, now, admissionPeriodId: typedAdmissionPeriodId },
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
    );

    return nativeCommandOutcomeResponse(result);
  });

export const submitApplication = (request: Request, input: AdmissionApiHttpOptions) =>
  Effect.gen(function* () {
    yield* rejectQueryString(request);
    const now = yield* currentInstant(input.config.now);

    if (!input.config.rateLimit.consume(publicRateLimitKey(request), now)) {
      return yield* Effect.fail(new PublicApplicationRateLimitExceeded({}));
    }

    const payload = yield* decodeJson(request, SubmitApplicationRequest, input.config.maxBodyBytes);

    const idempotencyKey = yield* Effect.try({
      try: () =>
        parseIdempotencyKey(
          request.headers.get("idempotency-key") === null
            ? []
            : [request.headers.get("idempotency-key")!],
        ),
      catch: knownAdmissionFailure,
    });

    const operationId = "admissions.submitApplication";

    const result = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        yield* authorizeAnonymousNativeOperation(
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

        const derived = yield* Effect.try({
          try: () =>
            deriveHttpIdentity({
              credentialSubject: "Anonymous",
              qualifiedOperationId: operationId,
              normalizedTarget: "/api/applications",
              idempotencyKey,
            }),
          catch: knownAdmissionFailure,
        });

        return {
          identity: {
            identitySha256: derived.identitySha256,
            requestSha256: semanticRequestDigest({ body: payload }),
            operationId,
          },
          execute: Admissions.use((admissions) =>
            Effect.gen(function* () {
              const submitted = yield* admissions.executePublicApplication(
                {
                  commandId: PublicApplicationCommandIdSchema.make(derived.commandId),
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
    );

    return nativeCommandOutcomeResponse(result);
  });
