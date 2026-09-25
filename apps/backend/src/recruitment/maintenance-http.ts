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
import {
  authorizePersonNativeOperation,
  genericContext,
  nativeCommandOutcomeResponse,
} from "../native-operation.js";
import { isSerializationConflict } from "../http-api/problem.js";
import {
  executeNativeHttpCommandPostgres,
  NativeHttpReceiptInvalid,
  NativeHttpReceiptPersistenceError,
} from "../http-api/receipt-transaction.js";
import { readBoundedJson } from "../http-api/read-json.js";
import {
  deriveHttpIdentity,
  deriveStrongETag,
  HttpSemanticFailure,
  nativeProblemResponse,
  parseIdempotencyKey,
  semanticRequestDigest,
} from "../http-semantics.js";

const authorizeTransport = Effect.fn("Recruitment.authorizeMaintenanceTransport")(function* (
  request: Request,
  operation: "questionnaires" | "staffing" | "command",
) {
  const resolved = yield* resolveRequestCredentialInTransaction(request, "OAuthUserBearer");

  if (!Predicate.isTagged(resolved.credential.principal, "Person"))
    return yield* new UnauthenticatedActor({ message: "authentication required" });
  const personId = resolved.credential.principal.personId;
  yield* authorizePersonNativeOperation({
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
  });

  return personId;
});

export const recruitmentMaintenanceErrorResponse = (cause: unknown): Response => {
  if (cause instanceof HttpSemanticFailure) return nativeProblemResponse(cause.code, cause.status);

  // The receipt store is the transport's own, answered as every command answers it.
  if (cause instanceof NativeHttpReceiptPersistenceError)
    return isSerializationConflict(cause)
      ? nativeProblemResponse("transaction.conflict", 409)
      : nativeProblemResponse("idempotency.unavailable", 503);

  if (cause instanceof NativeHttpReceiptInvalid)
    return nativeProblemResponse("internal.error", 500);

  if (cause instanceof RecruitmentMaintenanceFailure) {
    switch (cause.code) {
      case "Denied":
        return nativeProblemResponse("authority.denied", 403);
      case "NotFound":
        return nativeProblemResponse("resource.not-found", 404);
      case "Stale":
        return nativeProblemResponse("precondition.failed", 412);
      case "Conflict":
        return nativeProblemResponse("idempotency.digest-conflict", 409);
      case "Invalid":
        return nativeProblemResponse("recruitment.invalid-command", 422);
      case "Ineligible":
        return nativeProblemResponse("recruitment.ineligible", 422);
      case "Terminal":
        return nativeProblemResponse("recruitment.terminal", 409);
      case "EmptyActiveQuestionnaire":
        return nativeProblemResponse("recruitment.empty-active-questionnaire", 422);
    }
  }

  if (Predicate.isTagged(cause, "UnauthenticatedActor"))
    return nativeProblemResponse("credential.invalid", 401, {
      "www-authenticate": 'VektorSession realm="native-api", Bearer realm="native-api"',
    });

  if (Predicate.isTagged(cause, "RecruitmentScopeDenied"))
    return nativeProblemResponse("authority.denied", 403);

  if (Predicate.isTagged(cause, "RecruitmentInterviewNotFound"))
    return nativeProblemResponse("resource.not-found", 404);

  return nativeProblemResponse("recruitment.unavailable", 503);
};

export const readRecruitmentMaintenanceHttp = (
  request: Request,
  operation: "questionnaires" | "staffing",
) =>
  Effect.gen(function* () {
    if (new URL(request.url).search !== "")
      return yield* Effect.fail(new HttpSemanticFailure("request.malformed", 400));
    const personId = yield* authorizeTransport(request, operation);

    const encoded =
      operation === "questionnaires"
        ? yield* Recruitment.use((service) => service.readQuestionnaires(personId)).pipe(
            Effect.flatMap(Schema.encodeEffect(QuestionnaireManagement)),
          )
        : yield* Recruitment.use((service) => service.readInterviewStaffing(personId)).pipe(
            Effect.flatMap(Schema.encodeEffect(InterviewStaffingManagement)),
          );

    return new Response(JSON.stringify(encoded), {
      headers: {
        "content-type": "application/json",
        "cache-control": "private, no-store",
        vary: "Origin",
      },
    });
  });

export const maintainRecruitmentHttp = (request: Request) =>
  Effect.gen(function* () {
    if (new URL(request.url).search !== "")
      return yield* Effect.fail(new HttpSemanticFailure("request.malformed", 400));

    if (
      request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json"
    )
      return yield* Effect.fail(new HttpSemanticFailure("media-type.unsupported", 415));
    const body = yield* readBoundedJson(request, 1_048_576);

    const command = yield* Schema.decodeUnknownEffect(RecruitmentMaintenanceCommand)(body, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => new RecruitmentMaintenanceFailure({ code: "Invalid" })));

    const key = yield* Effect.try({
      try: () =>
        parseIdempotencyKey(
          request.headers.has("idempotency-key") ? [request.headers.get("idempotency-key")!] : [],
        ),
      catch: (cause) =>
        cause instanceof HttpSemanticFailure
          ? cause
          : new HttpSemanticFailure("request.malformed", 400),
    });

    if (key !== command.commandId)
      return yield* new RecruitmentMaintenanceFailure({ code: "Conflict" });

    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const personId = yield* authorizeTransport(request, "command");
        // Current authority is resolved inside the receipt transaction, before replay.
        yield* Recruitment.use((service) => service.authorizeMaintenance(command, personId));

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

            const encoded = yield* Schema.encodeEffect(RecruitmentMaintenanceResult)(result);

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

    return nativeCommandOutcomeResponse(outcome);
  });
