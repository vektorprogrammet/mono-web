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
import { resolveRequestCredentialInTransaction } from "../authority.js";
import {
  authorizePersonNativeOperation,
  genericContext,
  nativeCommandOutcomeResponse,
} from "../native-operation.js";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import { readBoundedJson } from "../http-api/read-json.js";
import {
  deriveHttpIdentity,
  deriveStrongETag,
  HttpSemanticFailure,
  parseIdempotencyKey,
  semanticRequestDigest,
} from "../http-semantics.js";

const authorizeTransport = Effect.fn("Schools.authorizeTransport")(function* (
  request: Request,
  mutation: boolean,
) {
  const resolved = yield* resolveRequestCredentialInTransaction(request, "OAuthUserBearer");

  if (!Predicate.isTagged(resolved.credential.principal, "Person"))
    return yield* new UnauthenticatedActor({ message: "authentication required" });
  const personId = resolved.credential.principal.personId;
  yield* authorizePersonNativeOperation({
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
  });

  return personId;
});

export const readSchoolManagementHttp = (request: Request) =>
  Effect.gen(function* () {
    if (new URL(request.url).search !== "")
      return yield* Effect.fail(new HttpSemanticFailure("request.malformed", 400));
    const personId = yield* authorizeTransport(request, false);
    const snapshot = yield* Schools.use((schools) => schools.readManagement(personId));
    const encoded = yield* Schema.encodeEffect(SchoolManagement)(snapshot);

    return new Response(JSON.stringify(encoded), {
      headers: {
        "content-type": "application/json",
        "cache-control": "private, no-store",
        vary: "Origin",
      },
    });
  });

export const executeSchoolCommandHttp = (request: Request) =>
  Effect.gen(function* () {
    if (new URL(request.url).search !== "")
      return yield* Effect.fail(new HttpSemanticFailure("request.malformed", 400));

    if (
      request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json"
    )
      return yield* Effect.fail(new HttpSemanticFailure("media-type.unsupported", 415));
    const body = yield* readBoundedJson(request, 32_768);

    const command = yield* Schema.decodeUnknownEffect(SchoolCommand)(body, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => new SchoolCommandFailure({ code: "Invalid" })));

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

    if (key !== command.commandId) return yield* new SchoolCommandFailure({ code: "Conflict" });

    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const personId = yield* authorizeTransport(request, true);
        yield* Schools.use((schools) => schools.authorizeCommand(command, personId));

        const identity = deriveHttpIdentity({
          credentialSubject: `Person:${personId}`,
          qualifiedOperationId: "directory.executeSchoolCommand",
          normalizedTarget: "/api/schools/commands",
          idempotencyKey: key,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ body: command }),
            operationId: "directory.executeSchoolCommand",
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

    return nativeCommandOutcomeResponse(outcome);
  });
