/**
 * The CertificatesRpcs handlers: days served and certificates. Reads answer from one
 * repeatable-read snapshot. Commands run through the receipt executor: current authority before
 * any replay, taken as `DaysServedConfirmationAuthorization` or `CertificateIssueAuthorization`
 * evidence, the `ifMatch` precondition on the fresh entry or certificate, and one retry of a
 * serialization conflict. The certificate PDF is rendered from the recorded issue inside the
 * transaction, and its bytes are the issue's answer and receipt.
 */
import { Database } from "@vektorprogrammet/database";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import { type CredentialOutcome, DomainId, Scope } from "@vektorprogrammet/domain/authz";
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import type { DepartmentId } from "@vektorprogrammet/domain/organization";
import {
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
  CertificatesRpcs,
  ConfirmDaysServed,
  DaysServedEntryResource,
  DaysServedListResponse,
  IssueCertificate,
  ListCertificates,
  ListDaysServed,
  ReadCertificate,
  ReadCertificateScopes,
  reflectAccessSpec,
} from "@vektorprogrammet/rpc";
import { type CredentialPresentation, Problem } from "@vektorprogrammet/rpc/problem";
import { Effect, Layer, Match, Option, Predicate } from "effect";
import type { Headers } from "effect/unstable/http";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { resolveRequestCredentialInTransaction } from "../authority.js";
import {
  deriveStrongETag,
  normalizeTarget,
  semanticMutationRequest,
  semanticRequestDigest,
} from "../http-semantics.js";
import { genericContext } from "../native-operation.js";
import { credentialRequestOf } from "../rpc/credential.js";
import type { NativeRpcOptions } from "../rpc/options.js";
import {
  authorizePerson,
  commandIdentity,
  commandOutcome,
  commandReceiptProblems,
  isSerializationConflict,
  personPresentation,
  problemMapper,
  requireCurrentETag,
  strictOutput,
  unreachable,
} from "../rpc/problem.js";
import {
  executeNativeHttpCommandPostgres,
  NativeHttpReceiptInvalid,
  type NativeHttpCommandOutcome,
  type NativeHttpResponseCapsule,
  successCapsule,
} from "../rpc/receipt-transaction.js";
import { CertificateFonts, CertificateFontsLive, renderCertificatePdf } from "./certificate-pdf.js";
import type { CertificateUnprintable } from "./certificate-pdf.js";

type AcceptedCredential = Extract<CredentialOutcome, { readonly _tag: "Accepted" }>;

interface Reader {
  readonly credential: AcceptedCredential;
  readonly principal: CertificatePrincipal;
}

type CertificateRpc =
  | typeof ReadCertificateScopes
  | typeof ListDaysServed
  | typeof ConfirmDaysServed
  | typeof ListCertificates
  | typeof ReadCertificate
  | typeof IssueCertificate;

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

/** Resolves the current Person credential through the caller's transaction at one instant. */
const reader = (headers: Headers.Headers) =>
  Effect.gen(function* () {
    const authenticated = yield* resolveRequestCredentialInTransaction(
      credentialRequestOf(headers),
      "OAuthUserBearer",
    );

    const principal = authenticated.credential.principal;

    if (!Predicate.isTagged(principal, "Person")) {
      return yield* UnauthenticatedActor.make({ message: "authentication required" });
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
  headers: Headers.Headers,
  rpc: CertificateRpc,
  current: Reader,
  departmentId: DepartmentId | null,
) =>
  authorizePerson(
    {
      spec: Option.getOrThrow(reflectAccessSpec(rpc)),
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
    personPresentation(headers),
  ).pipe(
    // Certificate AccessSpecs reveal every denial, so none is answered as not found.
    unreachable("resource.not-found"),
  );

/** Answers one read from a repeatable-read snapshot; every check runs inside it. */
const snapshotRead = <A, E, R>(headers: Headers.Headers, read: Effect.Effect<A, E, R>) =>
  Database.use((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;

        return yield* read;
      }),
    ),
  ).pipe(snapshotProblems, certificateProblems, credentialProblems(personPresentation(headers)));

/** The PDF that an issue receipt stores; a receipt of anything else is a defect. */
const storedPdf = (capsule: NativeHttpResponseCapsule) =>
  capsule.bodyBytes === null || capsule.mediaType !== "application/pdf"
    ? Effect.die(new NativeHttpReceiptInvalid({ reason: "an issue receipt stores no PDF" }))
    : Effect.succeed<Uint8Array>(capsule.bodyBytes);

/** The PDF of a committed or replayed issue, or its idempotency problem. */
const issueOutcome = (outcome: NativeHttpCommandOutcome) =>
  Match.value(outcome).pipe(
    Match.tag("Committed", "Replay", ({ response }) => storedPdf(response)),
    Match.tag("InFlight", () => Effect.fail(Problem.make("idempotency.in-flight"))),
    Match.tag("DigestConflict", () => Effect.fail(Problem.make("idempotency.digest-conflict"))),
    Match.tag("ResponseExpired", () => Effect.fail(Problem.make("idempotency.response-expired"))),
    Match.exhaustive,
  );

/**
 * The CertificatesRpcs handlers. The certificate fonts load once, when the handlers are built, as
 * the HTTP router provided them to the HTTP group.
 */
export const CertificatesRpcHandlers = (_options: NativeRpcOptions) =>
  CertificatesRpcs.toLayer(
    Effect.gen(function* () {
      const faces = yield* CertificateFonts;

      return CertificatesRpcs.of({
        "certificates.readCertificateScopes": (_payload, { headers }) =>
          snapshotRead(
            headers,
            Effect.gen(function* () {
              const current = yield* reader(headers);

              const scopes = yield* Placements.use((placements) =>
                placements.readCertificateScopes(current.principal),
              );

              yield* authorizeReader(headers, ReadCertificateScopes, current, null);

              return yield* strictOutput(CertificateScopes)(scopes);
            }),
          ).pipe(
            // The scope read names no department and pages nothing.
            unreachable("request.malformed"),
          ),

        "certificates.listDaysServed": ({ departmentId, semesterId, cursor }, { headers }) =>
          snapshotRead(
            headers,
            Effect.gen(function* () {
              const current = yield* reader(headers);

              const page = yield* Placements.use((placements) =>
                placements.readDaysServed(current.principal, { departmentId, semesterId }, cursor),
              );

              yield* authorizeReader(headers, ListDaysServed, current, departmentId);

              const body = {
                departmentId,
                departmentName: page.departmentName,
                semester: page.semester,
                items: page.items.map(entryResource),
              };

              return yield* strictOutput(DaysServedListResponse)(
                page.nextCursor === undefined ? body : { ...body, nextCursor: page.nextCursor },
              );
            }),
          ),

        "certificates.listCertificates": ({ departmentId, cursor }, { headers }) =>
          snapshotRead(
            headers,
            Effect.gen(function* () {
              const current = yield* reader(headers);

              const page = yield* Placements.use((placements) =>
                placements.listCertificates(current.principal, departmentId, cursor),
              );

              yield* authorizeReader(headers, ListCertificates, current, departmentId);

              const body = { departmentId, departmentName: page.departmentName, items: page.items };

              return yield* strictOutput(CertificateListResponse)(
                page.nextCursor === undefined ? body : { ...body, nextCursor: page.nextCursor },
              );
            }),
          ),

        "certificates.readCertificate": ({ departmentId, personId }, { headers }) =>
          snapshotRead(
            headers,
            Effect.gen(function* () {
              const current = yield* reader(headers);

              const preview = yield* Placements.use((placements) =>
                placements.readCertificate(current.principal, departmentId, personId),
              );

              yield* authorizeReader(headers, ReadCertificate, current, departmentId);

              return yield* strictOutput(CertificatePreviewResource)({
                ...preview,
                etag: certificateETag(preview),
              });
            }),
          ).pipe(
            // A preview pages nothing.
            unreachable("request.malformed"),
          ),

        "certificates.confirmDaysServed": (
          { departmentId, semesterId, personId, idempotencyKey, ifMatch, request },
          { headers },
        ) =>
          Effect.gen(function* () {
            const operationId = "certificates.confirmDaysServed";

            // Domain and credential failures are mapped after the executor, whose retry reads their causes.
            const outcome = yield* executeNativeHttpCommandPostgres(
              Effect.gen(function* () {
                const current = yield* reader(headers);

                // Authority is current before any stored response can be replayed.
                const authorization = yield* Placements.use((placements) =>
                  placements.authorizeDaysServedConfirmation(current.principal, {
                    departmentId,
                    semesterId,
                  }),
                );

                yield* authorizeReader(headers, ConfirmDaysServed, current, departmentId);

                // The HTTP route stays the normalized target, so receipts and command IDs are stable.
                const identity = yield* commandIdentity({
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
                    requestSha256: semanticRequestDigest(
                      semanticMutationRequest({ total: request.total }, ifMatch),
                    ),
                    operationId,
                  },
                  execute: Placements.use((placements) =>
                    placements.confirmDaysServed(
                      authorization,
                      { commandId: identity.identitySha256, personId, total: request.total },
                      (entry) => requireCurrentETag(entryETag(entry), ifMatch),
                    ),
                  ).pipe(
                    Effect.flatMap((entry) =>
                      strictOutput(DaysServedEntryResource)(entryResource(entry)),
                    ),
                    Effect.flatMap(successCapsule(DaysServedEntryResource)),
                  ),
                };
              }),
              { retry: "serialization-once" },
            ).pipe(
              certificateProblems,
              commandReceiptProblems,
              credentialProblems(personPresentation(headers)),
              // A confirmation pages nothing.
              unreachable("request.malformed"),
            );

            return yield* commandOutcome(DaysServedEntryResource)(outcome);
          }),

        "certificates.issueCertificate": (
          { departmentId, personId, idempotencyKey, ifMatch },
          { headers },
        ) =>
          Effect.gen(function* () {
            const operationId = "certificates.issueCertificate";

            // Domain and credential failures are mapped after the executor, whose retry reads their causes.
            const outcome = yield* executeNativeHttpCommandPostgres(
              Effect.gen(function* () {
                const current = yield* reader(headers);

                // A revoked seat cannot replay a stored certificate.
                const authorization = yield* Placements.use((placements) =>
                  placements.authorizeCertificateIssue(current.principal, departmentId, personId),
                );

                yield* authorizeReader(headers, IssueCertificate, current, departmentId);

                // The HTTP route stays the normalized target, so receipts and command IDs are stable.
                const identity = yield* commandIdentity({
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
                      authorization,
                      { commandId: identity.identitySha256 },
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
            ).pipe(
              certificateProblems,
              commandReceiptProblems,
              credentialProblems(personPresentation(headers)),
              // An issue pages nothing.
              unreachable("request.malformed"),
            );

            return yield* issueOutcome(outcome);
          }),
      });
    }),
  ).pipe(Layer.provide(CertificateFontsLive));
