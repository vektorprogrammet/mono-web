/**
 * Recruitment maintenance: questionnaire and interview staffing reads, and the maintenance
 * command, for a current global administrator or coordinator.
 */
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import { Scope } from "@vektorprogrammet/domain/authz";
import {
  Recruitment,
  RecruitmentMaintenanceFailure,
  RecruitmentMaintenanceResult,
  type RecruitmentMaintenanceCommand,
} from "@vektorprogrammet/domain/recruitment";
import {
  MaintainRecruitment,
  ReadInterviewStaffing,
  ReadQuestionnaires,
  reflectAccessSpec,
} from "@vektorprogrammet/rpc";
import { type IdempotencyKey, Problem } from "@vektorprogrammet/rpc/problem";
import { Effect, Match, Option, Predicate, Schema } from "effect";
import type { Headers } from "effect/unstable/http";
import type { Rpc } from "effect/unstable/rpc";
import { resolveRequestCredentialInTransaction } from "../authority.js";
import { deriveStrongETag, semanticRequestDigest } from "../http-semantics.js";
import { genericContext } from "../native-operation.js";
import { credentialRequestOf } from "../rpc/credential.js";
import {
  authorizePerson,
  commandIdentity,
  commandReceiptProblems,
  jsonText,
  personPresentation,
  unreachable,
} from "../rpc/problem.js";
import {
  executeNativeHttpCommandPostgres,
  NativeHttpReceiptInvalid,
  type NativeHttpCommandOutcome,
  type NativeHttpResponseCapsule,
} from "../rpc/receipt-transaction.js";
import {
  admissionPeriodProblems,
  assignmentProblems,
  conductProblems,
  maintenanceProblems,
  recruitmentProblems,
  schedulingProblems,
} from "./problem.js";
import type { RecruitmentCall } from "./context.js";

/**
 * Resolves the request's person inside the caller's transaction and evaluates the maintenance
 * AccessSpec of `rpc` over the global recruitment context.
 */
const authorizeMaintenanceTransport = Effect.fn("Recruitment.authorizeMaintenanceTransport")(
  function* (headers: Headers.Headers, rpc: Pick<Rpc.AnyWithProps, "annotations">) {
    const resolved = yield* resolveRequestCredentialInTransaction(
      credentialRequestOf(headers),
      "OAuthUserBearer",
    );

    if (!Predicate.isTagged(resolved.credential.principal, "Person"))
      return yield* UnauthenticatedActor.make({ message: "authentication required" });

    const personId = resolved.credential.principal.personId;

    yield* authorizePerson(
      {
        spec: Option.getOrThrow(reflectAccessSpec(rpc)),
        credential: resolved.credential,
        personId,
        resolution: {
          selection: "ExactlyOne",
          contexts: [
            genericContext({
              domainId: "recruitment",
              authorityVersion: "recruitment-maintenance",
            }),
          ],
        },
        grantScopes: [Scope.Global()],
        now: resolved.authorizationInstant,
      },
      personPresentation(headers),
    );

    return personId;
  },
);

/** Maintenance answers no assignment, scheduling, conduct, or invitation problem. */
const maintenanceAnswers =
  (headers: Headers.Headers) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      maintenanceProblems,
      recruitmentProblems({
        presentation: personPresentation(headers),
        unavailable: "recruitment.unavailable",
      }),
      unreachable(
        ...admissionPeriodProblems,
        ...assignmentProblems,
        ...schedulingProblems,
        ...conductProblems,
        "invitation.already-responded",
      ),
    );

export const readQuestionnaires = ({ headers }: RecruitmentCall<void>) =>
  Effect.gen(function* () {
    const personId = yield* authorizeMaintenanceTransport(headers, ReadQuestionnaires);

    return yield* Recruitment.use((service) => service.readQuestionnaires(personId));
  }).pipe(maintenanceAnswers(headers));

export const readInterviewStaffing = ({ headers }: RecruitmentCall<void>) =>
  Effect.gen(function* () {
    const personId = yield* authorizeMaintenanceTransport(headers, ReadInterviewStaffing);

    return yield* Recruitment.use((service) => service.readInterviewStaffing(personId));
  }).pipe(maintenanceAnswers(headers));

const MaintenanceResultJson = Schema.fromJsonString(RecruitmentMaintenanceResult);

/**
 * The result that a maintenance receipt stores, byte for byte what the HTTP contract stored: the
 * result as JSON, with its entity tag as the `etag` header. A mismatch is a defect.
 */
const storedMaintenanceResult = (capsule: NativeHttpResponseCapsule) =>
  capsule.bodyBytes === null
    ? Effect.die(new NativeHttpReceiptInvalid({ reason: "a maintenance receipt stores no result" }))
    : Schema.decodeEffect(MaintenanceResultJson)(new TextDecoder().decode(capsule.bodyBytes)).pipe(
        Effect.orDie,
      );

const maintenanceOutcome = (outcome: NativeHttpCommandOutcome) =>
  Match.value(outcome).pipe(
    Match.tag("Committed", "Replay", ({ response }) => storedMaintenanceResult(response)),
    Match.tag("InFlight", () => Effect.fail(Problem.make("idempotency.in-flight"))),
    Match.tag("DigestConflict", () => Effect.fail(Problem.make("idempotency.digest-conflict"))),
    Match.tag("ResponseExpired", () => Effect.fail(Problem.make("idempotency.response-expired"))),
    Match.exhaustive,
  );

export const maintainRecruitment = ({
  headers,
  payload,
}: RecruitmentCall<{
  readonly idempotencyKey: IdempotencyKey;
  readonly request: RecruitmentMaintenanceCommand;
}>) =>
  Effect.gen(function* () {
    const command = payload.request;
    const key = payload.idempotencyKey;

    if (key !== command.commandId)
      return yield* RecruitmentMaintenanceFailure.make({ code: "Conflict" });

    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const personId = yield* authorizeMaintenanceTransport(headers, MaintainRecruitment);

        // Current authority is resolved inside the receipt transaction, before replay.
        const authorization = yield* Recruitment.use((service) =>
          service.authorizeMaintenance(command, personId),
        );

        // The HTTP route stays the normalized target, so receipts and command IDs are stable.
        const identity = yield* commandIdentity({
          credentialSubject: `Person:${personId}`,
          qualifiedOperationId: "recruitment.maintainRecruitment",
          normalizedTarget: "/api/recruitment/maintenance/commands",
          idempotencyKey: key,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ body: command }),
            operationId: "recruitment.maintainRecruitment",
          },
          execute: Effect.gen(function* () {
            const result = yield* Recruitment.use((service) =>
              service.maintainRecruitment(authorization),
            );

            // The domain produced the result, so encoding it cannot fail.
            const encoded = yield* Schema.encodeEffect(RecruitmentMaintenanceResult)(result).pipe(
              Effect.orDie,
            );

            return {
              status: 200,
              mediaType: "application/json",
              headers: {
                "content-type": "application/json",
                etag: deriveStrongETag({
                  representationKind: "RecruitmentMaintenanceResult",
                  resourceIdentity: Predicate.isTagged(result, "QuestionnaireSaved")
                    ? result.interviewSchemaId
                    : result.interviewId,
                  version: result.revision,
                }),
              },
              bodyBytes: new TextEncoder().encode(yield* jsonText(encoded)),
            } satisfies NativeHttpResponseCapsule;
          }),
        };
      }),
      { retry: "serialization-once" },
    );

    return yield* maintenanceOutcome(outcome);
  }).pipe(commandReceiptProblems, maintenanceAnswers(headers));
