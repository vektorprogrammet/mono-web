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
  ReturningAssistantRegistrationResponseSchema,
  ReturningAssistants,
  ReturningCommandIdSchema,
  type ReturningAssistantRegistrationInput,
} from "@vektorprogrammet/domain/application";
import {
  AdmissionPeriodManagementItem,
  type AdmissionPeriodMergePatch,
  CreateAdmissionPeriod,
  type CreateAdmissionPeriodRequest,
  PublicApplicationConfirmationSchema,
  RegisterReturningAssistant,
  ReviseAdmissionPeriod,
  SubmitApplication,
  type SubmitApplicationRequest,
  reflectAccessSpec,
} from "@vektorprogrammet/rpc";
import {
  type IdempotencyKey,
  makeNativeValidationError,
  Problem,
  type StrongETag,
} from "@vektorprogrammet/rpc/problem";
import { Clock, DateTime, Effect, Option, Predicate } from "effect";
import type { Headers } from "effect/unstable/http";
import { currentInstant, resolveRequestPersonAuthorityInTransaction } from "../authority.js";
import {
  deriveStrongETag,
  interpretAdmissionPeriodMergePatchSource,
  normalizeTarget,
  semanticMutationRequest,
  semanticRequestDigest,
} from "../http-semantics.js";
import { genericContext } from "../native-operation.js";
import { credentialRequestOf } from "../rpc/credential.js";
import type { NativeRpcOptions } from "../rpc/options.js";
import {
  authorizeAnonymous,
  commandIdentity,
  commandOutcome,
  commandReceiptProblems,
  requireCurrentETag,
  semanticProblem,
  strictOutput,
  unreachable,
} from "../rpc/problem.js";
import { publicRateLimitKey } from "../rpc/public-rate-limit.js";
import { executeNativeHttpCommandPostgres, successCapsule } from "../rpc/receipt-transaction.js";
import {
  admissionGrantScopes,
  authorizeAdmissionPerson,
  returningAuthorization,
} from "./access.js";
import { admissionActorForAuthority } from "./context.js";
import { admissionProblems } from "./problem.js";
import { dual } from "effect/Function";

/** The management representation of one admission period, with the tag that a revision names. */
type ManagementItem = typeof AdmissionPeriodManagementItem.Type;

const managementItem = (period: Omit<ManagementItem, "etag">): ManagementItem => ({
  id: period.id,
  departmentId: period.departmentId,
  semesterId: period.semesterId,
  startAt: period.startAt,
  endAt: period.endAt,
  revision: period.revision,
  etag: deriveStrongETag({
    representationKind: "AdmissionPeriodManagementItem",
    resourceIdentity: period.id,
    version: period.revision,
  }),
});

const registerReturningAssistantEffect = (
  headers: Headers.Headers,
  payload: {
    readonly idempotencyKey: IdempotencyKey;
    readonly request: ReturningAssistantRegistrationInput;
  },
  options: NativeRpcOptions,
) =>
  Effect.gen(function* () {
    const { idempotencyKey, request } = payload;
    const operationId = "admissions.registerReturningAssistant";

    // Domain failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;

        // Returning-assistant persistence reads the instant after it takes its locks.
        const now =
          options.config.admission.now ??
          (() => DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe())));

        const authorization = yield* returningAuthorization(
          headers,
          options,
          RegisterReturningAssistant,
        );

        yield* ReturningAssistants.use(({ preflight }) =>
          preflight(
            {
              admissionPeriodId: request.admissionPeriodId,
              teamIds: request.teamIds,
            },
            {
              personId: authorization.authority.personId,
              now,
            },
          ),
        );

        // The HTTP route stays the normalized target, so receipts and command IDs are stable.
        const identity = yield* commandIdentity({
          credentialSubject: `Person:${authorization.authority.personId}`,
          qualifiedOperationId: operationId,
          normalizedTarget: "/api/returning-assistant/registrations",
          idempotencyKey,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ body: request }),
            operationId,
          },
          execute: ReturningAssistants.use((returning) =>
            returning.register(
              { ...request, commandId: ReturningCommandIdSchema.make(identity.commandId) },
              { personId: authorization.authority.personId, now },
            ),
          ).pipe(
            Effect.flatMap(strictOutput(ReturningAssistantRegistrationResponseSchema)),
            Effect.flatMap(successCapsule(ReturningAssistantRegistrationResponseSchema)),
          ),
        };
      }),
      { retry: "serialization-once" },
    );

    return yield* commandOutcome(ReturningAssistantRegistrationResponseSchema)(outcome);
  }).pipe(admissionProblems(headers, "returning.unavailable"), commandReceiptProblems);

export const registerReturningAssistant: {
  (
    payload: {
      readonly idempotencyKey: IdempotencyKey;
      readonly request: ReturningAssistantRegistrationInput;
    },
    options: NativeRpcOptions,
  ): (headers: Headers.Headers) => ReturnType<typeof registerReturningAssistantEffect>;
  (
    headers: Headers.Headers,
    payload: {
      readonly idempotencyKey: IdempotencyKey;
      readonly request: ReturningAssistantRegistrationInput;
    },
    options: NativeRpcOptions,
  ): ReturnType<typeof registerReturningAssistantEffect>;
} = dual(3, registerReturningAssistantEffect);

const createAdmissionPeriodEffect = (
  headers: Headers.Headers,
  payload: {
    readonly idempotencyKey: IdempotencyKey;
    readonly request: CreateAdmissionPeriodRequest;
  },
  options: NativeRpcOptions,
) =>
  Effect.gen(function* () {
    const { idempotencyKey, request } = payload;
    const admissionPeriodId = options.config.admission.nextAdmissionPeriodId();
    const operationId = "admissions.createAdmissionPeriod";

    // Domain failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const authorization = yield* resolveRequestPersonAuthorityInTransaction(
          credentialRequestOf(headers),
          { now: options.config.admission.now },
        );

        const actor = yield* admissionActorForAuthority(
          authorization.authority,
          request.departmentId,
        );

        const now = authorization.authorizationInstant;

        yield* authorizeAdmissionPerson(headers, {
          spec: Option.getOrThrow(reflectAccessSpec(CreateAdmissionPeriod)),
          credential: authorization.credential,
          personId: actor.personId,
          resolution: {
            selection: "ExactlyOne",
            contexts: [
              genericContext({
                domainId: "admissions",
                departmentId: Predicate.isTagged(actor, "DepartmentAdministrator")
                  ? actor.departmentId
                  : (request.departmentId ?? null),
                resourceKind: "admission-period",
                resourceId: admissionPeriodId,
                authorityVersion: `admissions:${actor._tag}`,
              }),
            ],
          },
          grantScopes: admissionGrantScopes(actor),
          now,
        });

        // The HTTP route stays the normalized target, so receipts and command IDs are stable.
        const identity = yield* commandIdentity({
          credentialSubject: `Person:${actor.personId}`,
          qualifiedOperationId: operationId,
          normalizedTarget: "/api/admission-periods",
          idempotencyKey,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ body: request }),
            operationId,
          },
          execute: Admissions.use((admissions) =>
            admissions.executeAdmissionPeriod(
              AdmissionPeriodCommandSchema.cases.CreateAdmissionPeriod.make({
                commandId: AdmissionPeriodCommandId.make(identity.commandId),
                ...request,
              }),
              { actor, now, admissionPeriodId },
            ),
          ).pipe(
            Effect.map((created) => managementItem(created.period)),
            Effect.flatMap(strictOutput(AdmissionPeriodManagementItem)),
            Effect.flatMap(successCapsule(AdmissionPeriodManagementItem)),
          ),
        };
      }),
      // A concurrent create for the same department and semester commits after this
      // snapshot; the restarted transaction sees it and answers that the period exists.
      { retry: "serialization-once" },
    );

    return yield* commandOutcome(AdmissionPeriodManagementItem)(outcome);
  }).pipe(
    admissionProblems(headers, "dependency.unavailable"),
    commandReceiptProblems,
    // A create looks up no period by id, and the period it writes has no earlier revision.
    unreachable("admission-period.not-found", "precondition.failed"),
  );

export const createAdmissionPeriod: {
  (
    payload: {
      readonly idempotencyKey: IdempotencyKey;
      readonly request: CreateAdmissionPeriodRequest;
    },
    options: NativeRpcOptions,
  ): (headers: Headers.Headers) => ReturnType<typeof createAdmissionPeriodEffect>;
  (
    headers: Headers.Headers,
    payload: {
      readonly idempotencyKey: IdempotencyKey;
      readonly request: CreateAdmissionPeriodRequest;
    },
    options: NativeRpcOptions,
  ): ReturnType<typeof createAdmissionPeriodEffect>;
} = dual(3, createAdmissionPeriodEffect);

/**
 * Judges the merge patch before the command: an empty patch changes nothing, and a null member
 * would delete a field that an admission period requires.
 */
const interpretPatch = (patch: AdmissionPeriodMergePatch) =>
  Effect.gen(function* () {
    // The payload schema decoded JSON, so each present member holds a string or null.
    const source: { [member: string]: string | null } = {};

    if (patch.startAt !== undefined) source.startAt = patch.startAt;

    if (patch.endAt !== undefined) source.endAt = patch.endAt;

    const interpretation = yield* Effect.sync(() =>
      interpretAdmissionPeriodMergePatchSource(source),
    );

    if (Predicate.isTagged(interpretation, "Rejected")) {
      return yield* Problem.validation(interpretation.code, interpretation.errors);
    }

    return { source, startAt: patch.startAt ?? undefined, endAt: patch.endAt ?? undefined };
  });

const reviseAdmissionPeriodEffect = (
  headers: Headers.Headers,
  payload: {
    readonly admissionPeriodId: AdmissionPeriodId;
    readonly idempotencyKey: IdempotencyKey;
    readonly ifMatch: StrongETag;
    readonly request: AdmissionPeriodMergePatch;
  },
  options: NativeRpcOptions,
) =>
  Effect.gen(function* () {
    const { admissionPeriodId, idempotencyKey, ifMatch } = payload;

    // An identifier that no path can spell names no admission period.
    const normalizedTarget = yield* semanticProblem(
      () => normalizeTarget("/api/admission-periods/{admissionPeriodId}", { admissionPeriodId }),
      ["request.malformed"],
    ).pipe(
      Effect.mapError(() =>
        Problem.validation("validation.failed", [
          makeNativeValidationError("/admissionPeriodId", "invalid"),
        ]),
      ),
    );

    const patch = yield* interpretPatch(payload.request);
    const operationId = "admissions.reviseAdmissionPeriod";

    // Domain failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const authorization = yield* resolveRequestPersonAuthorityInTransaction(
          credentialRequestOf(headers),
          { now: options.config.admission.now },
        );

        const actor = yield* admissionActorForAuthority(authorization.authority);
        const now = authorization.authorizationInstant;

        const periods = yield* Admissions.use(({ listAdmissionPeriodsForManagement }) =>
          listAdmissionPeriodsForManagement({ actor, now }),
        );

        const current = periods.find((period) => period.id === admissionPeriodId);

        if (current === undefined) {
          return yield* AdmissionPeriodNotFound.make({ admissionPeriodId });
        }

        yield* authorizeAdmissionPerson(headers, {
          spec: Option.getOrThrow(reflectAccessSpec(ReviseAdmissionPeriod)),
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

        yield* requireCurrentETag(managementItem(current).etag, ifMatch);

        // The HTTP route stays the normalized target, so receipts and command IDs are stable.
        const identity = yield* commandIdentity({
          credentialSubject: `Person:${actor.personId}`,
          qualifiedOperationId: operationId,
          normalizedTarget,
          idempotencyKey,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest(semanticMutationRequest(patch.source, ifMatch)),
            operationId,
          },
          execute: Admissions.use((admissions) =>
            admissions.executeAdmissionPeriod(
              AdmissionPeriodCommandSchema.cases.ReviseAdmissionPeriod.make({
                commandId: AdmissionPeriodCommandId.make(identity.commandId),
                admissionPeriodId,
                expectedRevision: current.revision,
                startAt: patch.startAt ?? current.startAt,
                endAt: patch.endAt ?? current.endAt,
              }),
              { actor, now, admissionPeriodId },
            ),
          ).pipe(
            Effect.map((revised) => managementItem(revised.period)),
            Effect.flatMap(strictOutput(AdmissionPeriodManagementItem)),
            Effect.flatMap(successCapsule(AdmissionPeriodManagementItem)),
          ),
        };
      }),
      // A concurrent revision commits after this snapshot; the restarted transaction reads
      // the new revision, so the stale If-Match answers precondition.failed.
      { retry: "serialization-once" },
    );

    return yield* commandOutcome(AdmissionPeriodManagementItem)(outcome);
  }).pipe(
    admissionProblems(headers, "dependency.unavailable"),
    commandReceiptProblems,
    // A revision never creates a period.
    unreachable("admission-period.already-exists"),
  );

export const reviseAdmissionPeriod: {
  (
    payload: {
      readonly admissionPeriodId: AdmissionPeriodId;
      readonly idempotencyKey: IdempotencyKey;
      readonly ifMatch: StrongETag;
      readonly request: AdmissionPeriodMergePatch;
    },
    options: NativeRpcOptions,
  ): (headers: Headers.Headers) => ReturnType<typeof reviseAdmissionPeriodEffect>;
  (
    headers: Headers.Headers,
    payload: {
      readonly admissionPeriodId: AdmissionPeriodId;
      readonly idempotencyKey: IdempotencyKey;
      readonly ifMatch: StrongETag;
      readonly request: AdmissionPeriodMergePatch;
    },
    options: NativeRpcOptions,
  ): ReturnType<typeof reviseAdmissionPeriodEffect>;
} = dual(3, reviseAdmissionPeriodEffect);

const submitApplicationEffect = (
  headers: Headers.Headers,
  payload: {
    readonly idempotencyKey: IdempotencyKey;
    readonly request: SubmitApplicationRequest;
  },
  options: NativeRpcOptions,
) =>
  Effect.gen(function* () {
    const { idempotencyKey, request } = payload;
    const config = options.config.admission;
    const now = yield* currentInstant(config.now);

    if (!config.rateLimit.consume(publicRateLimitKey(credentialRequestOf(headers)), now)) {
      return yield* PublicApplicationRateLimitExceeded.make({});
    }

    const operationId = "admissions.submitApplication";

    // Domain failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        yield* authorizeAnonymous(
          Option.getOrThrow(reflectAccessSpec(SubmitApplication)),
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

        // The HTTP route stays the normalized target, so receipts and command IDs are stable.
        const identity = yield* commandIdentity({
          credentialSubject: "Anonymous",
          qualifiedOperationId: operationId,
          normalizedTarget: "/api/applications",
          idempotencyKey,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ body: request }),
            operationId,
          },
          execute: Admissions.use((admissions) =>
            admissions.executePublicApplication(
              {
                commandId: PublicApplicationCommandIdSchema.make(identity.commandId),
                ...request,
              },
              {
                now,
                applicationId: config.nextApplicationId(),
                applicantId: config.nextApplicantId(),
                activationToken: config.nextActivationToken(),
              },
            ),
          ).pipe(
            Effect.map((submitted) =>
              PublicApplicationConfirmationSchema.make({
                applicationId: submitted.observation.applicationId,
              }),
            ),
            Effect.flatMap(successCapsule(PublicApplicationConfirmationSchema)),
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

    return yield* commandOutcome(PublicApplicationConfirmationSchema)(outcome);
  }).pipe(
    admissionProblems(headers, "dependency.unavailable"),
    commandReceiptProblems,
    // A submission looks up no confirmation, and the payload schema already bounded the request.
    unreachable("application.not-found", "request.too-large"),
  );

export const submitApplication: {
  (
    payload: {
      readonly idempotencyKey: IdempotencyKey;
      readonly request: SubmitApplicationRequest;
    },
    options: NativeRpcOptions,
  ): (headers: Headers.Headers) => ReturnType<typeof submitApplicationEffect>;
  (
    headers: Headers.Headers,
    payload: {
      readonly idempotencyKey: IdempotencyKey;
      readonly request: SubmitApplicationRequest;
    },
    options: NativeRpcOptions,
  ): ReturnType<typeof submitApplicationEffect>;
} = dual(3, submitApplicationEffect);
