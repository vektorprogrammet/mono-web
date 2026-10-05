import { Effect, Match, Predicate, Schema } from "effect";
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

import { Problem } from "@vektorprogrammet/http-api/http-semantics";
import { resolveRequestCredentialInTransaction } from "../authority.js";
import { genericContext } from "../native-operation.js";
import {
  commandOutcomeResponse,
  idempotencyKeyOf,
  personPresentation,
  requireNoQuery,
  unreachable,
  jsonText,
} from "../http-api/problem.js";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  deriveHttpIdentity,
  deriveStrongETag,
  PRIVATE_NO_STORE,
  semanticRequestDigest,
} from "../http-semantics.js";
import { readRecruitmentBody } from "./http-decode.js";
import { authorizeAt, type RecruitmentPersonAuthorize } from "./http-guard.js";
import {
  admissionPeriodProblems,
  assignmentProblems,
  conductProblems,
  maintenanceCommandProblems,
  maintenanceProblems,
  recruitmentProblems,
  schedulingProblems,
} from "./http-problem.js";

const authorizeTransport = Effect.fn("Recruitment.authorizeMaintenanceTransport")(function* (
  request: Request,
  operation: "questionnaires" | "staffing" | "command",
  authorize: RecruitmentPersonAuthorize,
) {
  const resolved = yield* resolveRequestCredentialInTransaction(request, "OAuthUserBearer");

  if (!Predicate.isTagged(resolved.credential.principal, "Person"))
    return yield* new UnauthenticatedActor({ message: "authentication required" });
  const personId = resolved.credential.principal.personId;
  yield* authorizeAt(authorize, {
    kind: "Person",
    operation: Match.value(operation).pipe(
      Match.when("command", () => "recruitment.maintainRecruitment" as const),
      Match.when("questionnaires", () => "recruitment.readQuestionnaires" as const),
      Match.when("staffing", () => "recruitment.readInterviewStaffing" as const),
      Match.exhaustive,
    ),
    request,
    input: {
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
  });

  return personId;
});

export const readRecruitmentMaintenanceHttp = (
  request: Request,
  operation: "questionnaires" | "staffing",
  authorize: RecruitmentPersonAuthorize,
) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const personId = yield* authorizeTransport(request, operation, authorize);

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

    return new Response(yield* jsonText(encoded), {
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

export const maintainRecruitmentHttp = (request: Request, authorize: RecruitmentPersonAuthorize) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const body = yield* readRecruitmentBody(request, 1_048_576);

    const command = yield* Schema.decodeUnknownEffect(RecruitmentMaintenanceCommand)(body, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => new RecruitmentMaintenanceFailure({ code: "Invalid" })));

    // The command is already decoded; failure to encode its digest is a server contract fault.
    const encodedCommand = yield* Schema.encodeEffect(RecruitmentMaintenanceCommand)(command).pipe(
      Effect.mapError(() => Problem.make("internal.error")),
    );

    const key = yield* idempotencyKeyOf(request);

    if (key !== command.commandId)
      return yield* new RecruitmentMaintenanceFailure({ code: "Conflict" });

    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const personId = yield* authorizeTransport(request, "command", authorize);
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
            requestSha256: semanticRequestDigest({ body: encodedCommand }),
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
                  version: "revision" in result ? result.revision : result.sequence,
                }),
              },
              bodyBytes: new TextEncoder().encode(yield* jsonText(encoded)),
            };
          }),
        };
      }),
      { retry: "serialization-once" },
    );

    return yield* commandOutcomeResponse(outcome);
  }).pipe(
    maintenanceCommandProblems(personPresentation(request)),
    // Maintenance answers no assignment, scheduling, conduct, or invitation problem.
    unreachable(
      ...admissionPeriodProblems,
      ...assignmentProblems,
      ...schedulingProblems,
      ...conductProblems,
      "invitation.already-responded",
    ),
  );
