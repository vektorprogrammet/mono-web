/** Receipt read handlers: owner, approver, and finance lists; settlement evidence; files; evidence. */
import { Database, IdentitySnapshot } from "@vektorprogrammet/database";
import { readOwnedReceiptFile } from "@vektorprogrammet/database/receipt/postgres";
import {
  AcceptedOAuthServiceCredential,
  AuthorityRef,
  AuthorityVersion,
  AuthorizationInstant,
  CapabilityTypeId,
  CredentialEvidenceRef,
  CredentialMechanismSchema,
  CredentialOutcomeSchema,
  GrantId,
  INTERNAL_RECEIPT_EVIDENCE_ACCESS,
  READ_INTERNAL_RECEIPT_EVIDENCE_CAPABILITY,
  RECEIPT_DOMAIN_ID,
  RECEIPT_RESOURCE_KIND,
  ResourceId,
  Scope,
  ServicePrincipalGrantAuthority,
  decodeGrant,
  evaluateAccess,
  evaluateServicePrincipalReceiptApprovalAccess,
  type ReceiptAccessFacts,
} from "@vektorprogrammet/domain/authz";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import {
  Economy,
  ReceiptNotFound,
  ReceiptPersistenceError,
} from "@vektorprogrammet/domain/receipt";
import {
  ReadReceiptFileEndpoint,
  ReceiptLifecycleEvidenceResponse,
  reflectAccessSpec,
  type ReceiptSettlementQueueItem,
} from "@vektorprogrammet/http-api";
import { nativeCookieChallenge, Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Option, Predicate, Schema } from "effect";
import { currentInstant, resolveRequestCredentialInTransaction } from "../authority.js";
import { personPresentation, requireNoQuery } from "../http-api/problem.js";
import {
  RECEIPT_E2E_CONCURRENCY_RESPONSE_HEADER,
  type ReceiptE2ETransactionBarrier,
} from "./e2e-support.js";
import type { ReceiptFileStore } from "./filesystem.js";
import type { ReceiptApiHttpOptions, ReceiptIdentityFailure } from "./http-context.js";
import { decodeReceiptListQuery } from "./http-decode.js";
import {
  receiptCredentialProblems,
  receiptProblems,
  storedReceiptProblems,
} from "./http-problem.js";
import {
  jsonResponse,
  ownedReceiptResource,
  privateJsonResponse,
  projected,
  readPrivateReceiptFile,
  receiptEtag,
  receiptSettlementEvidenceResource,
} from "./http-representation.js";

interface ReceiptAccessRow {
  readonly ownerPersonId: string;
  readonly departmentId: string;
  readonly status: string;
  readonly revision: number;
}

export const listOwnedReceipts = <R>(
  request: Request,
  options: ReceiptApiHttpOptions<ReceiptIdentityFailure, R>,
) =>
  Effect.gen(function* () {
    const { status: selectedStatus, cursor } = yield* decodeReceiptListQuery(request);

    const principal = yield* options.identity.resolveAuthorizationPrincipal(request);

    const rows = yield* Economy.use(({ listOwnedReceipts }) =>
      listOwnedReceipts(principal.personId, selectedStatus, cursor),
    ).pipe(storedReceiptProblems);

    const items = yield* projected(() => rows.items.map(ownedReceiptResource));

    return jsonResponse(
      rows.nextCursor === undefined ? { items } : { items, nextCursor: rows.nextCursor },
      200,
      "private, no-store",
    );
  }).pipe(receiptProblems, receiptCredentialProblems(personPresentation(request)));

export const listReceiptsForApproval = <R>(
  request: Request,
  options: ReceiptApiHttpOptions<ReceiptIdentityFailure, R>,
) =>
  Effect.gen(function* () {
    const { status, cursor } = yield* decodeReceiptListQuery(request);

    const resolved =
      options.identity.resolveApprovalCredential === undefined
        ? undefined
        : yield* options.identity.resolveApprovalCredential(request);

    if (
      resolved !== undefined &&
      Predicate.isTagged(resolved.credential.mechanism, "OAuthServiceBearer") &&
      Predicate.isTagged(resolved.credential.principal, "ServicePrincipal")
    ) {
      const credential = AcceptedOAuthServiceCredential.make({
        mechanism: resolved.credential.mechanism,
        principal: resolved.credential.principal,
        evidenceRef: resolved.credential.evidenceRef,
      });

      const authority = yield* ServicePrincipalGrantAuthority.use(
        ({ readReceiptApprovalCandidates }) =>
          readReceiptApprovalCandidates(credential, resolved.authorizationInstant, status, cursor),
      ).pipe(
        Effect.mapError(
          () =>
            new ReceiptPersistenceError({
              operation: "read service receipt approval authority",
              message: "service receipt approval authority is unavailable",
            }),
        ),
      );

      const evaluation = evaluateServicePrincipalReceiptApprovalAccess(
        credential,
        authority,
        resolved.authorizationInstant,
      );

      if (!Predicate.isTagged(evaluation, "Allow")) {
        return yield* Problem.make("authority.denied");
      }

      const items = yield* projected(() => {
        const allowed = new Set<string>(
          evaluation.resolution.contexts.flatMap((context) =>
            context.resource === null ? [] : [context.resource.id],
          ),
        );

        const seen = new Set<string>();

        return authority.candidates.flatMap(({ receipt }) => {
          if (seen.has(receipt.receiptId) || !allowed.has(receipt.receiptId)) return [];
          seen.add(receipt.receiptId);

          if (status !== undefined && receipt.status !== status) return [];
          const amountOre = Number(receipt.amountOre);

          if (!Number.isSafeInteger(amountOre) || amountOre <= 0) {
            throw new ReceiptPersistenceError({
              operation: "decode service approver projection",
              message: "invalid amount",
            });
          }

          return [
            {
              receiptId: receipt.receiptId,
              visualId: receipt.visualId,
              ownerPersonId: receipt.ownerPersonId,
              departmentId: receipt.departmentId,
              amountOre,
              currency: receipt.currency,
              description: receipt.description,
              receiptDate: receipt.receiptDate,
              status: receipt.status,
              approvedAt: receipt.approvedAt,
              revision: receipt.revision,
              etag: receiptEtag(receipt.receiptId, receipt.revision),
            },
          ];
        });
      });

      return jsonResponse(
        authority.nextCursor === undefined
          ? { items }
          : { items, nextCursor: authority.nextCursor },
        200,
        "private, no-store",
      );
    }

    const principal =
      resolved !== undefined && Predicate.isTagged(resolved.credential.principal, "Person")
        ? {
            personId: resolved.credential.principal.personId,
            authorizationInstant: resolved.authorizationInstant,
          }
        : yield* options.identity.resolveAuthorizationPrincipal(request);

    const rows = yield* Economy.use(({ listReceiptsForApproval }) =>
      listReceiptsForApproval(principal.personId, principal.authorizationInstant, status, cursor),
    ).pipe(storedReceiptProblems);

    const items = yield* projected(() =>
      rows.items.map((row) => {
        const amountOre = Number(row.amountOre);

        if (!Number.isSafeInteger(amountOre) || amountOre <= 0) {
          throw new ReceiptPersistenceError({
            operation: "decode approver projection",
            message: "invalid amount",
          });
        }

        return {
          receiptId: row.receiptId,
          visualId: row.visualId,
          ownerPersonId: row.ownerPersonId,
          departmentId: row.departmentId,
          amountOre,
          currency: row.currency,
          description: row.description,
          receiptDate: row.receiptDate,
          status: row.status,
          approvedAt: row.approvedAt,
          revision: row.revision,
          etag: receiptEtag(row.receiptId, row.revision),
        };
      }),
    );

    return jsonResponse(
      rows.nextCursor === undefined ? { items } : { items, nextCursor: rows.nextCursor },
      200,
      "private, no-store",
    );
  }).pipe(receiptProblems, receiptCredentialProblems(personPresentation(request)));

export const readSettlementForFinance = <R>(
  request: Request,
  receiptId: string,
  options: ReceiptApiHttpOptions<ReceiptIdentityFailure, R>,
) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const principal = yield* options.identity.resolveAuthorizationPrincipal(request);

    const settlement = yield* Economy.use(({ readReceiptSettlementForFinance }) =>
      readReceiptSettlementForFinance(
        receiptId,
        principal.personId,
        principal.authorizationInstant,
      ),
    ).pipe(storedReceiptProblems);

    return privateJsonResponse(receiptSettlementEvidenceResource(settlement));
  }).pipe(receiptProblems, receiptCredentialProblems(personPresentation(request)));

export const listReceiptsForSettlement = <R>(
  request: Request,
  options: ReceiptApiHttpOptions<ReceiptIdentityFailure, R>,
) =>
  Effect.gen(function* () {
    const { cursor } = yield* decodeReceiptListQuery(request, false);
    const principal = yield* options.identity.resolveAuthorizationPrincipal(request);

    const rows = yield* Economy.use(({ listReceiptsForSettlement }) =>
      listReceiptsForSettlement(principal.personId, principal.authorizationInstant, cursor),
    ).pipe(storedReceiptProblems);

    const items = yield* projected(() =>
      rows.items.map((row): typeof ReceiptSettlementQueueItem.Type => {
        const amountOre = Number(row.amountOre);

        if (
          !Number.isSafeInteger(amountOre) ||
          amountOre <= 0 ||
          row.status !== "Approved" ||
          row.approvedAt.length === 0
        ) {
          throw new ReceiptPersistenceError({
            operation: "decode settlement queue projection",
            message: "invalid settlement queue item",
          });
        }

        return {
          receiptId: row.receiptId,
          visualId: row.visualId,
          ownerPersonId: row.ownerPersonId,
          departmentId: row.departmentId,
          description: row.description,
          amountOre,
          currency: row.currency,
          receiptDate: row.receiptDate,
          status: row.status,
          approvedAt: row.approvedAt,
          revision: row.revision,
          etag: receiptEtag(row.receiptId, row.revision),
        };
      }),
    );

    return privateJsonResponse(
      rows.nextCursor === undefined ? { items } : { items, nextCursor: rows.nextCursor },
    );
  }).pipe(receiptProblems, receiptCredentialProblems(personPresentation(request)));

/** Reads the owner's receipt file after an owner grant evaluates inside one snapshot. */
export const readOwnerReceiptFile = <R>(
  request: Request,
  receiptId: string,
  options: ReceiptApiHttpOptions<ReceiptIdentityFailure, R>,
  fileStore: ReceiptFileStore,
) => {
  const presentation = personPresentation(request);

  return Effect.gen(function* () {
    const sql = yield* Database;

    const file = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;

        const authenticated = yield* resolveRequestCredentialInTransaction(
          request,
          "OAuthUserBearer",
          { now: options.now },
        );

        const principal = authenticated.credential.principal;

        if (!Predicate.isTagged(principal, "Person")) {
          return yield* Problem.unauthenticated(presentation);
        }

        const owned = yield* readOwnedReceiptFile(receiptId, principal.personId);

        if (owned === undefined) {
          return yield* Problem.make("resource.not-found");
        }

        const resource = {
          kind: RECEIPT_RESOURCE_KIND,
          id: ResourceId.make(receiptId),
        };

        const evaluation = evaluateAccess({
          spec: Option.getOrThrow(reflectAccessSpec(ReadReceiptFileEndpoint)),
          credential: authenticated.credential,
          resolution: {
            selection: "ExactlyOne",
            contexts: [
              {
                domainId: RECEIPT_DOMAIN_ID,
                departmentId: DepartmentId.make(owned.departmentId),
                resource,
                facts: {
                  ownerPersonId: principal.personId,
                  state: owned.status,
                  approverPersonIds: [],
                  approverServicePrincipalIds: [],
                  internalEvidenceEnabled: false,
                } satisfies ReceiptAccessFacts,
                authorityVersion: AuthorityVersion.make(`receipt:${owned.revision}`),
              },
            ],
          },
          grants: [
            decodeGrant({
              grantId: GrantId.make(`receipt-owner:${receiptId}`),
              subject: principal,
              capability: { type: CapabilityTypeId.make("receipts.read-owned") },
              scope: Scope.Resource({ resource }),
              startAt: AuthorizationInstant.make("1970-01-01T00:00:00.000Z"),
              endAt: null,
              requirements: [],
              source: AuthorityRef.make("economy_receipts.owner_person_id"),
              revision: owned.revision,
            }),
          ],
          authorizationInstant: authenticated.authorizationInstant,
        });

        if (!Predicate.isTagged(evaluation, "Allow")) {
          return yield* Problem.make("authority.denied");
        }

        return owned.file;
      }),
    );

    return yield* readPrivateReceiptFile(file, fileStore, options.config.maxFileBytes);
  }).pipe(receiptProblems, receiptCredentialProblems(presentation));
};

/**
 * Reads one approver-visible receipt file without granting owner access.
 * Credential resolution and rule-aware metadata selection share one snapshot.
 */
export const readApprovalReceiptFile = <R>(
  request: Request,
  receiptId: string,
  options: ReceiptApiHttpOptions<ReceiptIdentityFailure, R>,
  fileStore: ReceiptFileStore,
  barrier: ReceiptE2ETransactionBarrier | undefined,
) => {
  const presentation = personPresentation(request);
  let synchronized = false;

  return Effect.gen(function* () {
    const sql = yield* Database;

    const file = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;

        const authenticated = yield* resolveRequestCredentialInTransaction(
          request,
          "OAuthUserBearer",
          { now: options.now },
        );

        const principal = authenticated.credential.principal;

        if (!Predicate.isTagged(principal, "Person")) {
          return yield* Problem.unauthenticated(presentation);
        }

        if (barrier !== undefined) {
          synchronized = yield* barrier(request, receiptId, "file-read");
        }

        return yield* Economy.use(({ readReceiptFileForApproval }) =>
          readReceiptFileForApproval(
            receiptId,
            principal.personId,
            authenticated.authorizationInstant,
          ),
        ).pipe(
          Effect.catchTag("ReceiptNotFound", () => Effect.fail(Problem.make("resource.not-found"))),
          storedReceiptProblems,
        );
      }),
    );

    return yield* readPrivateReceiptFile(
      file,
      fileStore,
      options.config.maxFileBytes,
      synchronized ? { [RECEIPT_E2E_CONCURRENCY_RESPONSE_HEADER]: "1" } : {},
    );
  }).pipe(receiptProblems, receiptCredentialProblems(presentation));
};

/** Internal lifecycle evidence; enabled only by the E2E test-mode access fact. */
export const readReceiptLifecycleEvidence = <R>(
  request: Request,
  receiptId: string,
  options: ReceiptApiHttpOptions<ReceiptIdentityFailure, R>,
) =>
  Effect.gen(function* () {
    const authorizationInstant = AuthorizationInstant.make(yield* currentInstant(options.now));

    const sql = yield* Database;

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY
        `.pipe(Effect.asVoid);

        // Only the Cookie credential reaches this operation, so a rejection challenges for it alone.
        const actor = yield* IdentitySnapshot.use(({ resolveSession }) =>
          resolveSession(request.headers.get("cookie") ?? undefined, authorizationInstant),
        ).pipe(
          Effect.catchTag("IdentitySessionNotFound", () =>
            Effect.fail(
              Problem.unauthenticated(personPresentation(request, nativeCookieChallenge)),
            ),
          ),
        );

        const personId = actor.personId;

        const rows = yield* sql<ReceiptAccessRow>`
          SELECT owner_person_id AS "ownerPersonId", department_id AS "departmentId",
            status, revision
          FROM public.economy_receipts
          WHERE receipt_id = ${receiptId}
        `;

        const row = rows[0];

        if (row === undefined) return yield* new ReceiptNotFound({ receiptId });
        const principal = { _tag: "Person" as const, personId };

        const context = {
          domainId: RECEIPT_DOMAIN_ID,
          departmentId: DepartmentId.make(row.departmentId),
          resource: {
            kind: RECEIPT_RESOURCE_KIND,
            id: ResourceId.make(receiptId),
          },
          facts: {
            ownerPersonId: PersonId.make(row.ownerPersonId),
            state: row.status,
            approverPersonIds: [],
            approverServicePrincipalIds: [],
            internalEvidenceEnabled: options.config.e2e !== undefined,
          } satisfies ReceiptAccessFacts,
          authorityVersion: AuthorityVersion.make(`receipt:${row.revision}`),
        };

        const grant = decodeGrant({
          grantId: GrantId.make(`internal-evidence:${receiptId}:${personId}`),
          subject: principal,
          capability: { type: READ_INTERNAL_RECEIPT_EVIDENCE_CAPABILITY },
          scope: Scope.And({
            left: Scope.Domain({ domainId: RECEIPT_DOMAIN_ID }),
            right: Scope.And({
              left: Scope.Department({ departmentId: context.departmentId }),
              right: Scope.Resource({ resource: context.resource }),
            }),
          }),
          startAt: AuthorizationInstant.make("1970-01-01T00:00:00.000Z"),
          endAt: null,
          requirements: [],
          source: AuthorityRef.make("backend.receipt.internal-evidence"),
          revision: row.revision,
        });

        const evaluation = evaluateAccess({
          spec: INTERNAL_RECEIPT_EVIDENCE_ACCESS,
          credential: CredentialOutcomeSchema.cases.Accepted.make({
            mechanism: CredentialMechanismSchema.cases.BetterAuthCookie.make({}),
            principal,
            evidenceRef: CredentialEvidenceRef.make("better-auth:resolved-session"),
          }),
          resolution: { selection: "ExactlyOne", contexts: [context] },
          grants: [grant],
          authorizationInstant,
        });

        // The evidence spec reveals every denial of its accepted credential.
        if (!Predicate.isTagged(evaluation, "Allow")) {
          return yield* Problem.make("authority.denied");
        }

        const evidence = yield* Economy.use(({ readReceiptLifecycleEvidence }) =>
          readReceiptLifecycleEvidence(receiptId, personId),
        );

        const encoded = yield* Schema.encodeEffect(ReceiptLifecycleEvidenceResponse)(evidence).pipe(
          Effect.mapError(() => Problem.make("receipts.unavailable")),
        );

        return jsonResponse(encoded);
      }),
    );
  }).pipe(receiptProblems);
