import { Effect, Match, Option, Predicate, Schema } from "effect";
import {
  Recruitment,
  RecruitmentMaintenanceCommand,
  RecruitmentMaintenanceResult,
  RecruitmentMaintenanceFailure,
  QuestionnaireManagement,
  InterviewStaffingManagement,
} from "@vektorprogrammet/domain/recruitment";
import { Scope } from "@vektorprogrammet/domain/authz";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import {
  ReadQuestionnairesEndpoint,
  ReadInterviewStaffingEndpoint,
  MaintainRecruitmentEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { resolveRequestCredentialInTransaction } from "../authority.js";
import { genericContext } from "../native-operation.js";
import {
  authorizePerson,
  commandOutcomeResponse,
  commandReceiptProblems,
  idempotencyKeyOf,
  personPresentation,
  requireNoQuery,
  unreachable,
} from "../http-api/problem.js";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  deriveHttpIdentity,
  deriveStrongETag,
  PRIVATE_NO_STORE,
  semanticRequestDigest,
} from "../http-semantics.js";
import { readRecruitmentBody } from "./http-decode.js";
import {
  admissionPeriodProblems,
  assignmentProblems,
  conductProblems,
  maintenanceProblems,
  recruitmentProblems,
  schedulingProblems,
} from "./http-problem.js";

const authorizeTransport = Effect.fn("Recruitment.authorizeMaintenanceTransport")(function* (
  request: Request,
  operation: "questionnaires" | "staffing" | "command",
) {
  const resolved = yield* resolveRequestCredentialInTransaction(request, "OAuthUserBearer");

  if (!Predicate.isTagged(resolved.credential.principal, "Person"))
    return yield* new UnauthenticatedActor({ message: "authentication required" });
  const personId = resolved.credential.principal.personId;
  yield* authorizePerson(
    {
      spec: Option.getOrThrow(
        reflectAccessSpec(
          Match.value(operation).pipe(
            Match.when("command", () => MaintainRecruitmentEndpoint),
            Match.when("questionnaires", () => ReadQuestionnairesEndpoint),
            Match.when("staffing", () => ReadInterviewStaffingEndpoint),
            Match.exhaustive,
          ),
        ),
      ),
      credential: resolved.credential,
      personId,
      resolution: {
        selection: "ExactlyOne",
        contexts: [
          genericContext({ domainId: "recruitment", authorityVersion: "recruitment-maintenance" }),
        ],
      },
      grantScopes: [Scope.Global()],
      now: resolved.authorizationInstant,
    },
    personPresentation(request),
  );

  return personId;
});

export const readRecruitmentMaintenanceHttp = (
  request: Request,
  operation: "questionnaires" | "staffing",
) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const personId = yield* authorizeTransport(request, operation);

    // The domain decoded each view with its own schema, so encoding it cannot fail.
    const encoded =
      operation === "questionnaires"
        ? yield* Recruitment.use((service) => service.readQuestionnaires(personId)).pipe(
            Effect.flatMap((view) =>
              Schema.encodeEffect(QuestionnaireManagement)(view).pipe(Effect.orDie),
            ),
          )
        : yield* Recruitment.use((service) => service.readInterviewStaffing(personId)).pipe(
            Effect.flatMap((view) =>
              Schema.encodeEffect(InterviewStaffingManagement)(view).pipe(Effect.orDie),
            ),
          );

    return new Response(JSON.stringify(encoded), {
      headers: {
        "content-type": "application/json",
        "cache-control": PRIVATE_NO_STORE,
        vary: "Origin",
      },
    });
  }).pipe(
    maintenanceProblems,
    recruitmentProblems(personPresentation(request), "recruitment.unavailable"),
    // Maintenance answers no assignment, scheduling, conduct, or invitation problem.
    unreachable(
      ...admissionPeriodProblems,
      ...assignmentProblems,
      ...schedulingProblems,
      ...conductProblems,
      "invitation.already-responded",
    ),
  );

export const maintainRecruitmentHttp = (request: Request) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const body = yield* readRecruitmentBody(request, 1_048_576);

    const command = yield* Schema.decodeUnknownEffect(RecruitmentMaintenanceCommand)(body, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => new RecruitmentMaintenanceFailure({ code: "Invalid" })));

    const key = yield* idempotencyKeyOf(request);

    if (key !== command.commandId)
      return yield* new RecruitmentMaintenanceFailure({ code: "Conflict" });

    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const personId = yield* authorizeTransport(request, "command");
        // Current authority is resolved inside the receipt transaction, before replay.
        yield* Recruitment.use((service) => service.authorizeMaintenance(command, personId));

        // A person subject, this fixed operation and target, and a parsed key always derive.
        const identity = deriveHttpIdentity({
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
              service.maintainRecruitment(command, personId),
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
              bodyBytes: new TextEncoder().encode(JSON.stringify(encoded)),
            };
          }),
        };
      }),
      { retry: "serialization-once" },
    );

    return yield* commandOutcomeResponse(outcome);
  }).pipe(
    commandReceiptProblems,
    maintenanceProblems,
    recruitmentProblems(personPresentation(request), "recruitment.unavailable"),
    // Maintenance answers no assignment, scheduling, conduct, or invitation problem.
    unreachable(
      ...admissionPeriodProblems,
      ...assignmentProblems,
      ...schedulingProblems,
      ...conductProblems,
      "invitation.already-responded",
    ),
  );
