/**
 * Native HTTP handlers of days served and certificates. Reads answer from one repeatable-read
 * snapshot. Commands run through the receipt executor: current authority before any replay, the
 * `If-Match` precondition on the fresh entry or certificate, and one retry of a serialization
 * conflict. The certificate PDF is rendered from the recorded issue inside the transaction.
 */
import { Database } from "@vektorprogrammet/database";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import { type CredentialOutcome, DomainId, Scope } from "@vektorprogrammet/domain/authz";
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import type { DepartmentId, PersonId, SemesterId } from "@vektorprogrammet/domain/organization";
import {
  CertificateCommandTarget,
  daysServedEntryVersion,
  Placements,
  type CertificateCommandFailure,
  type CertificatePreview,
  type CertificatePrincipal,
  type CertificateReadFailure,
  type DaysServedEntry,
} from "@vektorprogrammet/domain/placements";
import {
  CertificateListResponse,
  CertificatePreviewResource,
  CertificateScopes,
  ConfirmDaysServedEndpoint,
  ConfirmDaysServedInput,
  DaysServedEntryResource,
  DaysServedListResponse,
  ExternalNativeApi,
  IssueCertificateEndpoint,
  ListCertificatesEndpoint,
  ListDaysServedEndpoint,
  ReadCertificateEndpoint,
  ReadCertificateScopesEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import {
  type CredentialPresentation,
  makeNativeValidationError,
  Problem,
} from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Option, Predicate, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { resolveRequestCredentialInTransaction } from "../authority.js";
import {
  authorizePerson,
  commandOutcomeResponse,
  commandReceiptProblems,
  httpIdentity,
  idempotencyKeyOf,
  isSerializationConflict,
  jsonText,
  personPresentation,
  problemMapper,
  readJsonBody,
  requireCurrentETag,
  requiredIfMatchOf,
  requireNoQuery,
  strictOutput,
  webHandler,
} from "../http-api/problem.js";
import {
  executeNativeHttpCommandPostgres,
  type NativeHttpResponseCapsule,
} from "../http-api/receipt-transaction.js";
import {
  deriveStrongETag,
  jsonBodyBytes,
  normalizeTarget,
  PRIVATE_NO_STORE,
  semanticMutationRequest,
  semanticRequestDigest,
} from "../http-semantics.js";
import { genericContext } from "../native-operation.js";
import {
  type CertificateFaces,
  CertificateFonts,
  type CertificateUnprintable,
  renderCertificatePdf,
} from "./certificate-pdf.js";

/** A total is a small integer; the body is bounded well above it. */
const MAX_CONFIRMATION_BYTES = 1_024;

type AcceptedCredential = Extract<CredentialOutcome, { readonly _tag: "Accepted" }>;

interface Reader {
  readonly credential: AcceptedCredential;
  readonly principal: CertificatePrincipal;
}

type CertificateEndpoint =
  | typeof ReadCertificateScopesEndpoint
  | typeof ListDaysServedEndpoint
  | typeof ConfirmDaysServedEndpoint
  | typeof ListCertificatesEndpoint
  | typeof ReadCertificateEndpoint
  | typeof IssueCertificateEndpoint;

/** The one answer for every days-served and certificate failure. */
const certificateProblems = problemMapper<
  CertificateReadFailure | CertificateCommandFailure | CertificateUnprintable
>()({
  CertificateAccessDenied: () => Problem.make("authority.denied"),
  CertificateScopeNotFound: () => Problem.make("resource.not-found"),
  CertificateAssistantNotFound: () => Problem.make("resource.not-found"),
  CertificateInvalidCursor: () => Problem.make("request.malformed"),
  CertificateEmpty: () => Problem.make("certificate.empty"),
  CertificateUnprintable: () => Problem.make("certificate.unprintable"),
  CertificatePersistenceError: (failure) =>
    failure.conflict ? Problem.make("transaction.conflict") : Problem.make("internal.error"),
});

/** A person credential rejected inside the transaction is answered from the request's evidence. */
const credentialProblems = (presentation: CredentialPresentation) =>
  problemMapper<UnauthenticatedActor | IdentityEngineError>()({
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
    IdentityEngineError: () => Problem.make("internal.error"),
  });

/** The snapshot transaction of a read: a lost serialization race is a conflict. */
const snapshotProblems = problemMapper<SqlError>()({
  SqlError: (failure) =>
    isSerializationConflict(failure)
      ? Problem.make("transaction.conflict")
      : Problem.make("internal.error"),
});

/** An entry's tag names its revision and the evidence that a confirmation would record. */
const entryETag = (entry: DaysServedEntry) =>
  deriveStrongETag({
    representationKind: "DaysServedEntry",
    resourceIdentity: `${entry.departmentId}/${entry.semesterId}/${entry.personId}`,
    version: daysServedEntryVersion(entry),
  });

/** A certificate's tag names the content that an issue would record. */
const certificateETag = (
  preview: Pick<CertificatePreview, "departmentId" | "personId" | "contentSha256">,
) =>
  deriveStrongETag({
    representationKind: "Certificate",
    resourceIdentity: `${preview.departmentId}/${preview.personId}`,
    version: preview.contentSha256 ?? "empty",
  });

const entryResource = (entry: DaysServedEntry) => ({ ...entry, etag: entryETag(entry) });

const privateJson =
  <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S) =>
  (body: S["Type"]) =>
    Effect.gen(function* () {
      const checked = yield* strictOutput(schema)(body);

      return new Response(yield* jsonText(checked), {
        headers: {
          "content-type": "application/json",
          "cache-control": PRIVATE_NO_STORE,
          vary: "Origin",
        },
      });
    });

/** Resolves the current Person credential through the caller's transaction at one instant. */
const reader = (request: Request) =>
  Effect.gen(function* () {
    const authenticated = yield* resolveRequestCredentialInTransaction(request, "OAuthUserBearer");
    const principal = authenticated.credential.principal;

    if (!Predicate.isTagged(principal, "Person")) {
      return yield* new UnauthenticatedActor({ message: "authentication required" });
    }

    return {
      credential: authenticated.credential,
      principal: {
        personId: principal.personId,
        authorizationInstant: authenticated.authorizationInstant,
      },
    } satisfies Reader;
  });

/** Evaluates the declared AccessSpec in the department the domain decided for, or organization-wide. */
const authorizeReader = (
  request: Request,
  endpoint: CertificateEndpoint,
  current: Reader,
  departmentId: DepartmentId | null,
) =>
  authorizePerson(
    {
      spec: Option.getOrThrow(reflectAccessSpec(endpoint)),
      credential: current.credential,
      personId: current.principal.personId,
      resolution: {
        selection: "ExactlyOne",
        contexts: [
          genericContext({
            domainId: "organization",
            departmentId: departmentId ?? undefined,
            authorityVersion: `certificates:${current.principal.authorizationInstant}`,
          }),
        ],
      },
      grantScopes:
        departmentId === null
          ? [Scope.Domain({ domainId: DomainId.make("organization") })]
          : [Scope.Department({ departmentId })],
      now: current.principal.authorizationInstant,
    },
    personPresentation(request),
  );

/** Answers one read from a repeatable-read snapshot; every check runs inside it. */
const snapshotRead = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Database.use((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;

        return yield* effect;
      }),
    ),
  ).pipe(snapshotProblems);

/** The only query member is one optional cursor. */
const cursorQuery = (request: Request) =>
  Effect.suspend(() => {
    const parameters = new URL(request.url).searchParams;

    return [...parameters.keys()].some((key) => key !== "cursor") ||
      parameters.getAll("cursor").length > 1
      ? Effect.fail(Problem.make("request.malformed"))
      : Effect.succeed(parameters.get("cursor") ?? undefined);
  });

const readScopes = (request: Request) => {
  const presentation = personPresentation(request);

  return snapshotRead(
    Effect.gen(function* () {
      yield* requireNoQuery(request);
      const current = yield* reader(request);

      const scopes = yield* Placements.use((placements) =>
        placements.readCertificateScopes(current.principal),
      );

      yield* authorizeReader(request, ReadCertificateScopesEndpoint, current, null);

      return yield* privateJson(CertificateScopes)(scopes);
    }),
  ).pipe(certificateProblems, credentialProblems(presentation));
};

const listDaysServed = (request: Request, departmentId: DepartmentId, semesterId: SemesterId) => {
  const presentation = personPresentation(request);

  return snapshotRead(
    Effect.gen(function* () {
      const cursor = yield* cursorQuery(request);
      const current = yield* reader(request);

      const page = yield* Placements.use((placements) =>
        placements.readDaysServed(current.principal, { departmentId, semesterId }, cursor),
      );

      yield* authorizeReader(request, ListDaysServedEndpoint, current, departmentId);

      const body = {
        departmentId,
        departmentName: page.departmentName,
        semester: page.semester,
        items: page.items.map(entryResource),
      };

      return yield* privateJson(DaysServedListResponse)(
        page.nextCursor === undefined ? body : { ...body, nextCursor: page.nextCursor },
      );
    }),
  ).pipe(certificateProblems, credentialProblems(presentation));
};

const listCertificates = (request: Request, departmentId: DepartmentId) => {
  const presentation = personPresentation(request);

  return snapshotRead(
    Effect.gen(function* () {
      const cursor = yield* cursorQuery(request);
      const current = yield* reader(request);

      const page = yield* Placements.use((placements) =>
        placements.listCertificates(current.principal, departmentId, cursor),
      );

      yield* authorizeReader(request, ListCertificatesEndpoint, current, departmentId);

      const body = { departmentId, departmentName: page.departmentName, items: page.items };

      return yield* privateJson(CertificateListResponse)(
        page.nextCursor === undefined ? body : { ...body, nextCursor: page.nextCursor },
      );
    }),
  ).pipe(certificateProblems, credentialProblems(presentation));
};

const readCertificate = (request: Request, departmentId: DepartmentId, personId: PersonId) => {
  const presentation = personPresentation(request);

  return snapshotRead(
    Effect.gen(function* () {
      yield* requireNoQuery(request);
      const current = yield* reader(request);

      const preview = yield* Placements.use((placements) =>
        placements.readCertificate(current.principal, departmentId, personId),
      );

      yield* authorizeReader(request, ReadCertificateEndpoint, current, departmentId);

      return yield* privateJson(CertificatePreviewResource)({
        ...preview,
        etag: certificateETag(preview),
      });
    }),
  ).pipe(certificateProblems, credentialProblems(presentation));
};

const confirmDaysServed = (
  request: Request,
  departmentId: DepartmentId,
  semesterId: SemesterId,
  personId: PersonId,
) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);

    const body = yield* readJsonBody(
      request,
      /^application\/json(?:\s*;|$)/iu,
      MAX_CONFIRMATION_BYTES,
    );

    const input = Schema.decodeUnknownOption(ConfirmDaysServedInput)(body, {
      onExcessProperty: "error",
    });

    if (Option.isNone(input)) {
      return yield* Problem.validation("validation.failed", [
        makeNativeValidationError("/total", "invalid"),
      ]);
    }

    const ifMatch = yield* requiredIfMatchOf(request);
    const idempotencyKey = yield* idempotencyKeyOf(request);
    const presentation = personPresentation(request);
    const operationId = "certificates.confirmDaysServed";

    // Domain and credential failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const current = yield* reader(request);

        // Authority is current before any stored response can be replayed.
        yield* Placements.use((placements) =>
          placements.authorizeCertificateCommand(
            current.principal,
            CertificateCommandTarget.ConfirmDaysServed({ departmentId, semesterId }),
          ),
        );
        yield* authorizeReader(request, ConfirmDaysServedEndpoint, current, departmentId);

        const identity = yield* httpIdentity({
          credentialSubject: `Person:${current.principal.personId}`,
          qualifiedOperationId: operationId,
          normalizedTarget: normalizeTarget(
            "/api/departments/{departmentId}/semesters/{semesterId}/days-served/{personId}",
            { departmentId, semesterId, personId },
          ),
          idempotencyKey,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest(semanticMutationRequest(body, ifMatch)),
            operationId,
          },
          execute: Placements.use((placements) =>
            placements.confirmDaysServed(
              current.principal,
              {
                commandId: identity.identitySha256,
                departmentId,
                semesterId,
                personId,
                total: input.value.total,
              },
              (entry) => requireCurrentETag(entryETag(entry), ifMatch),
            ),
          ).pipe(
            Effect.flatMap((entry) => strictOutput(DaysServedEntryResource)(entryResource(entry))),
            Effect.map(
              (resource): NativeHttpResponseCapsule => ({
                status: 200,
                mediaType: "application/json",
                headers: { "content-type": "application/json", etag: resource.etag },
                bodyBytes: jsonBodyBytes(resource),
              }),
            ),
          ),
        };
      }),
      { retry: "serialization-once" },
    ).pipe(certificateProblems, commandReceiptProblems, credentialProblems(presentation));

    return yield* commandOutcomeResponse(outcome);
  });

const issueCertificate = (
  request: Request,
  departmentId: DepartmentId,
  personId: PersonId,
  faces: CertificateFaces,
) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);

    const ifMatch = yield* requiredIfMatchOf(request);
    const idempotencyKey = yield* idempotencyKeyOf(request);
    const presentation = personPresentation(request);
    const operationId = "certificates.issueCertificate";

    // Domain and credential failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const current = yield* reader(request);

        // A revoked seat cannot replay a stored certificate.
        yield* Placements.use((placements) =>
          placements.authorizeCertificateCommand(
            current.principal,
            CertificateCommandTarget.IssueCertificate({ departmentId, personId }),
          ),
        );
        yield* authorizeReader(request, IssueCertificateEndpoint, current, departmentId);

        const identity = yield* httpIdentity({
          credentialSubject: `Person:${current.principal.personId}`,
          qualifiedOperationId: operationId,
          normalizedTarget: normalizeTarget(
            "/api/departments/{departmentId}/certificates/{personId}/issues",
            { departmentId, personId },
          ),
          idempotencyKey,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ ifMatch }),
            operationId,
          },
          // The PDF renders before commit, so an unprintable certificate records no issue.
          execute: Placements.use((placements) =>
            placements.issueCertificate(
              current.principal,
              { commandId: identity.identitySha256, departmentId, personId },
              (preview) => requireCurrentETag(certificateETag(preview), ifMatch),
            ),
          ).pipe(
            Effect.flatMap((issue) =>
              Effect.map(
                Effect.fromResult(renderCertificatePdf(issue, faces)),
                (pdf): NativeHttpResponseCapsule => ({
                  status: 200,
                  mediaType: "application/pdf",
                  headers: {
                    "content-type": "application/pdf",
                    etag: certificateETag({
                      departmentId,
                      personId,
                      contentSha256: issue.contentSha256,
                    }),
                  },
                  bodyBytes: pdf,
                }),
              ),
            ),
          ),
        };
      }),
      { retry: "serialization-once" },
    ).pipe(certificateProblems, commandReceiptProblems, credentialProblems(presentation));

    return yield* commandOutcomeResponse(outcome);
  });

/** Native HttpApi handlers of days served and certificates; the fonts load once, with the group. */
export const CertificatesApiHandlers = HttpApiBuilder.group(
  ExternalNativeApi,
  "certificates",
  (handlers) =>
    CertificateFonts.useSync((faces) =>
      handlers
        .handleRaw("readCertificateScopes", ({ request }) => webHandler(request, readScopes))
        .handleRaw("listDaysServed", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            listDaysServed(webRequest, params.departmentId, params.semesterId),
          ),
        )
        .handleRaw("confirmDaysServed", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            confirmDaysServed(webRequest, params.departmentId, params.semesterId, params.personId),
          ),
        )
        .handleRaw("listCertificates", ({ request, params }) =>
          webHandler(request, (webRequest) => listCertificates(webRequest, params.departmentId)),
        )
        .handleRaw("readCertificate", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            readCertificate(webRequest, params.departmentId, params.personId),
          ),
        )
        .handleRaw("issueCertificate", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            issueCertificate(webRequest, params.departmentId, params.personId, faces),
          ),
        ),
    ),
);
