import { Effect, Option, Predicate, Schema } from "effect";
import {
  Schools,
  SchoolCommand,
  SchoolCommandResult,
  SchoolManagement,
  SchoolCommandFailure,
} from "@vektorprogrammet/domain/schools";
import { Scope } from "@vektorprogrammet/domain/authz";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import {
  ReadSchoolManagementEndpoint,
  ExecuteSchoolCommandEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import type { CredentialPresentation } from "@vektorprogrammet/http-api/http-semantics";
import { resolveRequestCredentialInTransaction } from "../authority.js";
import { genericContext } from "../native-operation.js";
import {
  authorizePerson,
  commandOutcomeResponse,
  commandReceiptProblems,
  httpIdentity,
  idempotencyKeyOf,
  personPresentation,
  readJsonBody,
  requireNoQuery,
} from "../http-api/problem.js";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import { deriveStrongETag, semanticRequestDigest } from "../http-semantics.js";
import { schoolsCredentialProblems, schoolsProblems } from "./http.js";

const operationId = "directory.executeSchoolCommand";

const authorizeTransport = Effect.fn("Schools.authorizeTransport")(function* (
  request: Request,
  mutation: boolean,
  presentation: CredentialPresentation,
) {
  const resolved = yield* resolveRequestCredentialInTransaction(request, "OAuthUserBearer");

  if (!Predicate.isTagged(resolved.credential.principal, "Person"))
    return yield* new UnauthenticatedActor({ message: "authentication required" });
  const personId = resolved.credential.principal.personId;
  yield* authorizePerson(
    {
      spec: Option.getOrThrow(
        reflectAccessSpec(mutation ? ExecuteSchoolCommandEndpoint : ReadSchoolManagementEndpoint),
      ),
      credential: resolved.credential,
      personId,
      resolution: {
        selection: "ExactlyOne",
        contexts: [genericContext({ domainId: "schools", authorityVersion: "school-management" })],
      },
      grantScopes: [Scope.Global()],
      now: resolved.authorizationInstant,
    },
    presentation,
  );

  return personId;
});

export const readSchoolManagementHttp = (request: Request) => {
  const presentation = personPresentation(request);

  return Effect.gen(function* () {
    yield* requireNoQuery(request);
    const personId = yield* authorizeTransport(request, false, presentation);
    const snapshot = yield* Schools.use((schools) => schools.readManagement(personId));
    const encoded = yield* Schema.encodeEffect(SchoolManagement)(snapshot);

    return new Response(JSON.stringify(encoded), {
      headers: {
        "content-type": "application/json",
        "cache-control": "private, no-store",
        vary: "Origin",
      },
    });
  }).pipe(schoolsProblems, schoolsCredentialProblems(presentation));
};

export const executeSchoolCommandHttp = (request: Request) => {
  const presentation = personPresentation(request);

  return Effect.gen(function* () {
    yield* requireNoQuery(request);

    const body = yield* readJsonBody(request, /^application\/json(?:\s*;|$)/iu, 32_768);

    const command = yield* Schema.decodeUnknownEffect(SchoolCommand)(body, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => new SchoolCommandFailure({ code: "Invalid" })));

    const key = yield* idempotencyKeyOf(request);

    if (key !== command.commandId) return yield* new SchoolCommandFailure({ code: "Conflict" });

    // Domain and credential failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const personId = yield* authorizeTransport(request, true, presentation);
        yield* Schools.use((schools) => schools.authorizeCommand(command, personId));

        const identity = yield* httpIdentity({
          credentialSubject: `Person:${personId}`,
          qualifiedOperationId: operationId,
          normalizedTarget: "/api/schools/commands",
          idempotencyKey: key,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ body: command }),
            operationId,
          },
          execute: Effect.gen(function* () {
            const result = yield* Schools.use((schools) =>
              schools.executeCommand(command, personId),
            );

            const encoded = yield* Schema.encodeEffect(SchoolCommandResult)(result);

            return {
              status: 200,
              mediaType: "application/json",
              headers: {
                "content-type": "application/json",
                etag: deriveStrongETag({
                  representationKind: "SchoolCommandResult",
                  resourceIdentity: `${result.schoolId}:${result.capacityId ?? "school"}`,
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
  }).pipe(schoolsProblems, commandReceiptProblems, schoolsCredentialProblems(presentation));
};
