/**
 * EX-0021: native stable SQL carries upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import { Database } from "./service.js";
import { AdvisoryLockKey, lockAdvisory } from "./advisory-lock.js";
import { withoutCursorTimestamp, type CursorPositioned } from "./receipt/cursor.js";
import {
  AuthzRuleSubjectSchema,
  AuthzRuleScopeSchema,
  AuthorizationInstant,
  AuthzRuleSchema,
  CreateServicePrincipalGrantInputSchema,
  EndServicePrincipalGrantInputSchema,
  NATIVE_API_PROTECTED_RESOURCE,
  OAuthClientId,
  RECEIPT_APPROVAL_QUEUE_OPERATION,
  RevokeServicePrincipalGrantInputSchema,
  ServicePrincipalGrantAuthority,
  ServicePrincipalGrantAuthorityError,
  ServicePrincipalReceiptCandidateSchema,
  ServicePrincipalReceiptGrantSchema,
  evaluateServicePrincipalReceiptApprovalAccess,
  type ServicePrincipalReceiptGrantCandidate,
  type AcceptedOAuthServiceCredential,
  type CreateServicePrincipalGrantInput,
  type EndServicePrincipalGrantInput,
  type RevokeServicePrincipalGrantInput,
  type ServicePrincipalGrantAuditContext,
  type ServicePrincipalGrantAuthorityOperations,
  type ServicePrincipalReceiptGrant,
  type ServicePrincipalReceiptGrantAuthority,
} from "@vektorprogrammet/domain/authz";
import {
  RECEIPT_PAGE_SIZE,
  decodeReceiptCursor,
  encodeReceiptCursor,
  type ReceiptCursorPosition,
  type ReceiptStatus,
} from "@vektorprogrammet/domain/receipt";
import { Data, Predicate, Match, Effect, Layer, Schema } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";

type CurrentServiceBindingRow = {
  readonly client_id: string;
};

type PersistedServiceReceiptGrantRow = {
  readonly grant_id: string;
  readonly service_principal_id: string;
  readonly client_id: string;
  readonly protected_resource: string;
  readonly operation_id: string;
  readonly capability_id: string;
  readonly resource_kind: string;
  readonly resource_id: string;
  readonly start_at: Date;
  readonly end_at: Date | null;
  readonly revoked_at: Date | null;
  readonly grant_revision: number;
};

type ServiceReceiptGrantRow = PersistedServiceReceiptGrantRow & {
  readonly cursor_timestamp: string;
  readonly visual_id: string;
  readonly owner_person_id: string;
  readonly department_id: string;
  readonly amount_ore: string;
  readonly currency: string;
  readonly description: string;
  readonly receipt_date: string;
  readonly receipt_status: string;
  readonly approved_at: Date | null;
  readonly receipt_revision: number;
};

type PersistedServiceRuleRow = {
  readonly rule_id: string;
  readonly capability_id: string;
  readonly effect_kind: string;
  readonly subject_kind: string;
  readonly subject_person_id: string | null;
  readonly subject_tag_id: string | null;
  readonly subject_service_principal_id: string | null;
  readonly scope: string;
  readonly domain_id: string | null;
  readonly department_id: string | null;
  readonly resource_kind: string | null;
  readonly resource_id: string | null;
  readonly params: unknown;
  readonly start_at: Date;
  readonly end_at: Date | null;
  readonly revision: number;
};

const acquireSharedAuthorizationLock = (client: SqlClient.SqlClient) =>
  lockAdvisory(client, AdvisoryLockKey.authorizationRules, "shared");

const acquireExclusiveAuthorizationLock = (client: SqlClient.SqlClient) =>
  lockAdvisory(client, AdvisoryLockKey.authorizationRules);

const decodeReceiptCandidate = Schema.decodeUnknownEffect(ServicePrincipalReceiptCandidateSchema, {
  onExcessProperty: "error",
});

const credentialEvidencePattern =
  /^oauth:ServicePrincipal:([^:]{1,160}):([^:]{1,160}):([0-9]{1,20})$/u;

const decodeGrant = Schema.decodeUnknownEffect(ServicePrincipalReceiptGrantSchema);

const decodePersistedGrant = (row: PersistedServiceReceiptGrantRow) =>
  Effect.try({
    try: () => ({
      grantId: row.grant_id,
      servicePrincipalId: row.service_principal_id,
      clientId: row.client_id,
      protectedResource: row.protected_resource,
      operationId: row.operation_id,
      capabilityId: row.capability_id,
      resourceKind: row.resource_kind,
      receiptId: row.resource_id,
      startAt: row.start_at.toISOString(),
      endAt: row.end_at?.toISOString() ?? null,
      revokedAt: row.revoked_at?.toISOString() ?? null,
      revision: row.grant_revision,
    }),
    catch: (cause) => new PersistedRowRejected({ cause }),
  }).pipe(Effect.flatMap(decodeGrant));

const decodeServiceRule = Schema.decodeUnknownEffect(AuthzRuleSchema);

const decodePersonSubjectId = Schema.decodeUnknownEffect(
  AuthzRuleSubjectSchema.cases.Person.fields.personId,
);

const decodeTagSubjectId = Schema.decodeUnknownEffect(
  AuthzRuleSubjectSchema.cases.Tag.fields.tagId,
);

const decodeServiceSubjectId = Schema.decodeUnknownEffect(
  AuthzRuleSubjectSchema.cases.ServicePrincipal.fields.servicePrincipalId,
);

const decodeServiceSubjectKind = Schema.decodeUnknownEffect(Schema.Literals(["ServicePrincipal"]));

const decodeDomainScopeId = Schema.decodeUnknownEffect(
  AuthzRuleScopeSchema.cases.Domain.fields.domainId,
);

const decodeDepartmentScopeId = Schema.decodeUnknownEffect(
  AuthzRuleScopeSchema.cases.Department.fields.departmentId,
);

const decodeResourceScope = Schema.decodeUnknownEffect(
  AuthzRuleScopeSchema.cases.Resource.fields.resource,
);

const decodeResourceScopeKind = Schema.decodeUnknownEffect(Schema.Literals(["Resource"]));

const decodePersistedServiceRule = Effect.fnUntraced(function* (row: PersistedServiceRuleRow) {
  const subject = yield* Match.value(row.subject_kind).pipe(
    Match.when("Person", () =>
      decodePersonSubjectId(row.subject_person_id).pipe(
        Effect.map((personId) => AuthzRuleSubjectSchema.cases.Person.make({ personId })),
      ),
    ),
    Match.when("Tag", () =>
      decodeTagSubjectId(row.subject_tag_id).pipe(
        Effect.map((tagId) => AuthzRuleSubjectSchema.cases.Tag.make({ tagId })),
      ),
    ),
    Match.orElse(() =>
      Effect.gen(function* () {
        yield* decodeServiceSubjectKind(row.subject_kind);
        const servicePrincipalId = yield* decodeServiceSubjectId(row.subject_service_principal_id);

        return AuthzRuleSubjectSchema.cases.ServicePrincipal.make({ servicePrincipalId });
      }),
    ),
  );

  const scope = yield* Match.value(row.scope).pipe(
    Match.when("Global", () => Effect.succeed(AuthzRuleScopeSchema.cases.Global.make({}))),
    Match.when("Domain", () =>
      decodeDomainScopeId(row.domain_id).pipe(
        Effect.map((domainId) => AuthzRuleScopeSchema.cases.Domain.make({ domainId })),
      ),
    ),
    Match.when("Department", () =>
      decodeDepartmentScopeId(row.department_id).pipe(
        Effect.map((departmentId) => AuthzRuleScopeSchema.cases.Department.make({ departmentId })),
      ),
    ),
    Match.orElse(() =>
      Effect.gen(function* () {
        yield* decodeResourceScopeKind(row.scope);

        const resource = yield* decodeResourceScope({
          kind: row.resource_kind,
          id: row.resource_id,
        });

        return AuthzRuleScopeSchema.cases.Resource.make({ resource });
      }),
    ),
  );

  const encoded = yield* Effect.try({
    try: () => ({
      ruleId: row.rule_id,
      capabilityId: row.capability_id,
      effectKind: row.effect_kind,
      subject,
      scope,
      params: row.params,
      startAt: row.start_at.toISOString(),
      endAt: row.end_at?.toISOString() ?? null,
      revision: row.revision,
    }),
    catch: (cause) => new PersistedRowRejected({ cause }),
  });

  return yield* decodeServiceRule(encoded);
});

/** A persisted grant, rule, or receipt row outside its schema. */
class PersistedRowRejected extends Data.TaggedError("PersistedRowRejected")<{
  readonly cause: unknown;
}> {}

const decodePersistedRow = <Row, A>(
  row: Row,
  decode: (row: Row) => Effect.Effect<A, Schema.SchemaError | PersistedRowRejected>,
) => decode(row).pipe(Effect.mapError((cause) => new PersistedRowRejected({ cause })));

const currentServiceBinding = (
  client: SqlClient.SqlClient,
  credential: AcceptedOAuthServiceCredential,
  authorizationInstant: string,
) =>
  Effect.gen(function* () {
    const evidence = credentialEvidencePattern.exec(credential.evidenceRef);

    if (evidence === null) {
      return yield* new ServicePrincipalGrantAuthorityError({
        reason: "InvalidCredentialEvidence",
        message: "OAuth service credential evidence is not canonical",
      });
    }

    const [, jti, clientId, issuedAt] = evidence;

    const result = yield* client.unsafe<CurrentServiceBindingRow>(
      `SELECT binding.client_id
     FROM auth.oauth_access_token_state AS state
     JOIN auth.oauth_client_bindings AS binding
       ON binding.client_id = state.client_id
     JOIN auth."oauthClient" AS provider_client
       ON provider_client."clientId" = binding.client_id
     JOIN public.service_principals AS principal
       ON principal.service_principal_id = binding.service_principal_id
     JOIN auth."oauthClientResource" AS client_resource
       ON client_resource."clientId" = binding.client_id
      AND client_resource."resourceId" = $6
     JOIN auth."oauthResource" AS protected_resource
       ON protected_resource.identifier = client_resource."resourceId"
    WHERE state.jti = $1
      AND state.client_id = $2
      AND state.service_principal_id = $3
      AND floor(extract(epoch FROM state.issued_at)) = $4::numeric
      AND state.principal_kind = 'ServicePrincipal'
      AND state.person_id IS NULL
      AND state.session_id IS NULL
      AND state.family_id IS NULL
      AND state.revoked_at IS NULL
      AND state.expires_at > $5::timestamptz
      AND binding.client_kind = 'Service'
      AND binding.service_principal_id = state.service_principal_id
      AND (binding.secret_expires_at IS NULL OR binding.secret_expires_at > $5::timestamptz)
      AND provider_client.disabled IS NOT TRUE
      AND provider_client.scopes = '["native-api"]'::jsonb
      AND provider_client."clientCredentialsScopes" = '["native-api"]'::jsonb
      AND principal.state = 'Active'
      AND protected_resource.disabled IS NOT TRUE`,
      [
        jti,
        clientId,
        credential.principal.servicePrincipalId,
        issuedAt,
        authorizationInstant,
        NATIVE_API_PROTECTED_RESOURCE,
      ],
    );

    if (result.length !== 1 || result[0] === undefined) {
      return yield* new ServicePrincipalGrantAuthorityError({
        reason: "CurrentBindingRejected",
        message: "OAuth service credential binding is not current",
      });
    }

    return result[0].client_id;
  });

type PositionedServiceCandidate = CursorPositioned<ServicePrincipalReceiptGrantCandidate>;

const readExactGrantCandidates = (
  client: SqlClient.SqlClient,
  credential: AcceptedOAuthServiceCredential,
  clientId: string,
  authorizationInstant: string,
  after: ReceiptCursorPosition | undefined,
) =>
  client
    .unsafe<ServiceReceiptGrantRow>(
      `WITH receipt_page AS (
     SELECT receipt.* FROM public.economy_receipts AS receipt
     WHERE ($6::timestamptz IS NULL OR receipt.submitted_at < $6::timestamptz
       OR (receipt.submitted_at = $6::timestamptz AND receipt.receipt_id > $7::text))
       AND EXISTS (
         SELECT 1 FROM public.service_principal_grants AS grant_row
         WHERE grant_row.resource_id = receipt.receipt_id
           AND grant_row.service_principal_id = $1 AND grant_row.client_id = $2
           AND grant_row.protected_resource = $3 AND grant_row.operation_id = $4
           AND grant_row.capability_id = 'approveReceipt' AND grant_row.resource_kind = 'receipt'
           AND grant_row.start_at <= $5::timestamptz
           AND (grant_row.end_at IS NULL OR $5::timestamptz < grant_row.end_at)
           AND grant_row.revoked_at IS NULL
       )
     ORDER BY receipt.submitted_at DESC, receipt.receipt_id ASC
     LIMIT $8
   ) SELECT
     to_char(receipt.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_timestamp,
     grant_row.grant_id,
     grant_row.service_principal_id,
     grant_row.client_id,
     grant_row.protected_resource,
     grant_row.operation_id,
     grant_row.capability_id,
     grant_row.resource_kind,
     grant_row.resource_id,
     grant_row.start_at,
     grant_row.end_at,
     grant_row.revoked_at,
     grant_row.revision AS grant_revision,
     receipt.visual_id,
     receipt.owner_person_id,
     receipt.department_id,
     receipt.amount_ore::text,
     receipt.currency,
     receipt.description,
     receipt.receipt_date::text,
     receipt.status AS receipt_status,
     receipt.approved_at,
     receipt.revision AS receipt_revision
   FROM public.service_principal_grants AS grant_row
   JOIN receipt_page AS receipt
     ON receipt.receipt_id = grant_row.resource_id
   WHERE grant_row.service_principal_id = $1
     AND grant_row.client_id = $2
     AND grant_row.protected_resource = $3
     AND grant_row.operation_id = $4
     AND grant_row.capability_id = 'approveReceipt'
     AND grant_row.resource_kind = 'receipt'
     AND grant_row.start_at <= $5::timestamptz
     AND (grant_row.end_at IS NULL OR $5::timestamptz < grant_row.end_at)
     AND grant_row.revoked_at IS NULL
   ORDER BY receipt.submitted_at DESC, receipt.receipt_id ASC, grant_row.grant_id ASC`,
      [
        credential.principal.servicePrincipalId,
        clientId,
        NATIVE_API_PROTECTED_RESOURCE,
        RECEIPT_APPROVAL_QUEUE_OPERATION,
        authorizationInstant,
        after?.timestamp ?? null,
        after?.receiptId ?? null,
        RECEIPT_PAGE_SIZE + 1,
      ],
    )
    .pipe(
      Effect.flatMap((result) =>
        Effect.forEach(result, (candidateRow) =>
          decodePersistedRow(candidateRow, (row) =>
            Effect.gen(function* () {
              const grant = yield* decodePersistedGrant(row);

              const encodedReceipt = yield* Effect.try({
                try: () => ({
                  receiptId: row.resource_id,
                  visualId: row.visual_id,
                  ownerPersonId: row.owner_person_id,
                  departmentId: row.department_id,
                  amountOre: row.amount_ore,
                  currency: row.currency,
                  description: row.description,
                  receiptDate: row.receipt_date,
                  status: row.receipt_status,
                  approvedAt: row.approved_at?.toISOString() ?? null,
                  revision: row.receipt_revision,
                }),
                catch: (cause) => new PersistedRowRejected({ cause }),
              });

              const receipt = yield* decodeReceiptCandidate(encodedReceipt);

              return { cursorTimestamp: row.cursor_timestamp, grant, receipt };
            }),
          ),
        ),
      ),
    );

const readServicePrincipalRules = (
  client: SqlClient.SqlClient,
  servicePrincipalId: string,
  authorizationInstant: string,
  receiptIds: ReadonlyArray<string>,
) =>
  client<PersistedServiceRuleRow>`SELECT
     rule_id,
     capability_id,
     effect_kind,
     subject_kind,
     subject_person_id,
     subject_tag_id,
     subject_service_principal_id,
     scope,
     domain_id,
     department_id,
     resource_kind,
     resource_id,
     params,
     start_at,
     end_at,
     revision
   FROM public.authz_rules
   WHERE capability_id = 'approveReceipt'
     AND effect_kind = 'requirement'
     AND subject_kind = 'ServicePrincipal'
     AND subject_service_principal_id = ${servicePrincipalId}
     AND scope = 'Resource'
     AND resource_kind = 'receipt'
     AND ${client.in("resource_id", receiptIds)}
     AND start_at <= ${authorizationInstant}::timestamptz
     AND (end_at IS NULL OR ${authorizationInstant}::timestamptz < end_at)
   ORDER BY resource_id ASC, rule_id ASC`.pipe(
    Effect.flatMap((result) =>
      Effect.forEach(result, (ruleRow) => decodePersistedRow(ruleRow, decodePersistedServiceRule)),
    ),
  );

const readInCurrentSnapshot = (
  pool: SqlClient.SqlClient,
  credential: AcceptedOAuthServiceCredential,
  authorizationInstant: AuthorizationInstant,
  status: ReceiptStatus | undefined,
  after: ReceiptCursorPosition | undefined,
) =>
  pool
    .withTransaction(
      Effect.gen(function* () {
        const client = pool;
        yield* client.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        yield* acquireSharedAuthorizationLock(client);
        const clientId = yield* currentServiceBinding(client, credential, authorizationInstant);

        let position = after;
        const visible: PositionedServiceCandidate[] = [];
        const visibleIds = new Set<string>();
        let fallback: ServicePrincipalReceiptGrantAuthority | undefined;

        const base = {
          servicePrincipalId: credential.principal.servicePrincipalId,
          clientId: yield* Schema.decodeEffect(OAuthClientId)(clientId, {
            onExcessProperty: "error",
          }),
          protectedResource: NATIVE_API_PROTECTED_RESOURCE,
        };

        let denied: ServicePrincipalReceiptGrantAuthority = { ...base, candidates: [], rules: [] };

        while (visibleIds.size <= RECEIPT_PAGE_SIZE) {
          const candidates = yield* readExactGrantCandidates(
            client,
            credential,
            clientId,
            authorizationInstant,
            position,
          );

          if (candidates.length === 0) break;
          const candidateIds = [...new Set(candidates.map(({ receipt }) => receipt.receiptId))];

          const rules = yield* readServicePrincipalRules(
            client,
            credential.principal.servicePrincipalId,
            authorizationInstant,
            candidateIds,
          );

          const batch = { ...base, candidates, rules };

          const evaluation = evaluateServicePrincipalReceiptApprovalAccess(
            credential,
            batch,
            authorizationInstant,
          );

          if (Predicate.isTagged(evaluation, "Allow")) {
            const allowed = new Set<string>(
              evaluation.resolution.contexts.flatMap((context) =>
                context.resource === null ? [] : [context.resource.id],
              ),
            );

            if (fallback === undefined) {
              const first = candidates.find((candidate) =>
                allowed.has(candidate.receipt.receiptId),
              )!;

              const firstCandidates = candidates.filter(
                (candidate) => candidate.receipt.receiptId === first.receipt.receiptId,
              );

              fallback = {
                ...base,
                candidates: firstCandidates,
                rules: yield* readServicePrincipalRules(
                  client,
                  credential.principal.servicePrincipalId,
                  authorizationInstant,
                  [first.receipt.receiptId],
                ),
              };
            }

            for (const candidate of candidates) {
              if (
                !allowed.has(candidate.receipt.receiptId) ||
                (status !== undefined && candidate.receipt.status !== status)
              )
                continue;

              if (
                !visibleIds.has(candidate.receipt.receiptId) &&
                visibleIds.size > RECEIPT_PAGE_SIZE
              )
                break;
              visibleIds.add(candidate.receipt.receiptId);
              visible.push(candidate);
            }
          } else if (denied.candidates.length === 0) {
            denied = batch;
          }

          if (candidateIds.length <= RECEIPT_PAGE_SIZE) break;
          const last = candidates[candidates.length - 1]!;
          position = { timestamp: last.cursorTimestamp, receiptId: last.receipt.receiptId };
        }

        let authority: ServicePrincipalReceiptGrantAuthority;

        if (visible.length === 0) {
          authority = fallback ?? denied;
        } else {
          const pageIds = [...visibleIds].slice(0, RECEIPT_PAGE_SIZE);
          const retained = new Set(pageIds);

          const candidates = visible.filter((candidate) =>
            retained.has(candidate.receipt.receiptId),
          );

          const last = candidates[candidates.length - 1]!;
          authority = {
            ...base,
            candidates: candidates.map(withoutCursorTimestamp),
            rules: yield* readServicePrincipalRules(
              client,
              credential.principal.servicePrincipalId,
              authorizationInstant,
              pageIds,
            ),
          };

          if (visibleIds.size > RECEIPT_PAGE_SIZE) {
            authority = {
              ...authority,
              nextCursor: encodeReceiptCursor({
                timestamp: last.cursorTimestamp,
                receiptId: last.receipt.receiptId,
              }),
            };
          }
        }

        return authority;
      }),
    )
    .pipe(
      Effect.mapError((cause) =>
        cause instanceof ServicePrincipalGrantAuthorityError
          ? cause
          : new ServicePrincipalGrantAuthorityError({
              reason: "PersistenceFailure",
              message: "Service-principal grant authority read failed",
            }),
      ),
    );

type ServicePrincipalGrantAuditEventKind =
  | "service-principal-grant-created"
  | "service-principal-grant-ended"
  | "service-principal-grant-revoked";

const appendGrantAudit = (
  client: SqlClient.SqlClient,
  eventKind: ServicePrincipalGrantAuditEventKind,
  grant: ServicePrincipalReceiptGrant,
  audit: ServicePrincipalGrantAuditContext,
) =>
  client.unsafe(
    `INSERT INTO public.service_principal_grant_audit (
     event_id,
     occurred_at,
     event_kind,
     grant_id,
     service_principal_id,
     client_id,
     protected_resource,
     operation_id,
     capability_id,
     resource_id,
     revision,
     operator_actor,
     request_correlation
   ) VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      audit.eventId,
      audit.occurredAt,
      eventKind,
      grant.grantId,
      grant.servicePrincipalId,
      grant.clientId,
      grant.protectedResource,
      grant.operationId,
      grant.capabilityId,
      grant.receiptId,
      grant.revision,
      audit.operatorActor,
      audit.requestCorrelation,
    ],
  );

const mutationRejected = (): ServicePrincipalGrantAuthorityError =>
  new ServicePrincipalGrantAuthorityError({
    reason: "MutationRejected",
    message: "Service-principal grant mutation was rejected",
  });

/** Decodes the one grant row that a mutation returned and appends its audit event. */
const auditMutatedGrant = (
  client: SqlClient.SqlClient,
  result: ReadonlyArray<PersistedServiceReceiptGrantRow>,
  eventKind: ServicePrincipalGrantAuditEventKind,
  audit: ServicePrincipalGrantAuditContext,
) =>
  Effect.gen(function* () {
    const row = result[0];

    if (result.length !== 1 || row === undefined) return yield* mutationRejected();
    const grant = yield* decodePersistedRow(row, decodePersistedGrant);
    yield* appendGrantAudit(client, eventKind, grant, audit);

    return grant;
  });

const createGrant = (client: SqlClient.SqlClient, input: CreateServicePrincipalGrantInput) =>
  client
    .unsafe<PersistedServiceReceiptGrantRow>(
      `INSERT INTO public.service_principal_grants (
     grant_id,
     service_principal_id,
     client_id,
     protected_resource,
     operation_id,
     capability_id,
     resource_kind,
     resource_id,
     start_at,
     end_at,
     revoked_at,
     revision,
     created_at,
     updated_at
   ) VALUES (
     $1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz,
     $10::timestamptz, $11::timestamptz, $12, $13::timestamptz, $13::timestamptz
   )
   RETURNING
     grant_id,
     service_principal_id,
     client_id,
     protected_resource,
     operation_id,
     capability_id,
     resource_kind,
     resource_id,
     start_at,
     end_at,
     revoked_at,
     revision AS grant_revision`,
      [
        input.grant.grantId,
        input.grant.servicePrincipalId,
        input.grant.clientId,
        input.grant.protectedResource,
        input.grant.operationId,
        input.grant.capabilityId,
        input.grant.resourceKind,
        input.grant.receiptId,
        input.grant.startAt,
        input.grant.endAt,
        input.grant.revokedAt,
        input.grant.revision,
        input.audit.occurredAt,
      ],
    )
    .pipe(
      Effect.flatMap((result) =>
        auditMutatedGrant(client, result, "service-principal-grant-created", input.audit),
      ),
    );

const endGrant = (client: SqlClient.SqlClient, input: EndServicePrincipalGrantInput) =>
  client
    .unsafe<PersistedServiceReceiptGrantRow>(
      `UPDATE public.service_principal_grants
      SET end_at = $2::timestamptz,
          revision = revision + 1,
          updated_at = $4::timestamptz
    WHERE grant_id = $1
      AND revision = $3
      AND end_at IS NULL
      AND revoked_at IS NULL
      AND $2::timestamptz > start_at
    RETURNING
      grant_id,
      service_principal_id,
      client_id,
      protected_resource,
      operation_id,
      capability_id,
      resource_kind,
      resource_id,
      start_at,
      end_at,
      revoked_at,
      revision AS grant_revision`,
      [input.grantId, input.endAt, input.expectedRevision, input.audit.occurredAt],
    )
    .pipe(
      Effect.flatMap((result) =>
        auditMutatedGrant(client, result, "service-principal-grant-ended", input.audit),
      ),
    );

const revokeGrant = (client: SqlClient.SqlClient, input: RevokeServicePrincipalGrantInput) =>
  client
    .unsafe<PersistedServiceReceiptGrantRow>(
      `UPDATE public.service_principal_grants
      SET revoked_at = $2::timestamptz,
          revision = revision + 1,
          updated_at = $4::timestamptz
    WHERE grant_id = $1
      AND revision = $3
      AND revoked_at IS NULL
      AND $2::timestamptz >= start_at
    RETURNING
      grant_id,
      service_principal_id,
      client_id,
      protected_resource,
      operation_id,
      capability_id,
      resource_kind,
      resource_id,
      start_at,
      end_at,
      revoked_at,
      revision AS grant_revision`,
      [input.grantId, input.revokedAt, input.expectedRevision, input.audit.occurredAt],
    )
    .pipe(
      Effect.flatMap((result) =>
        auditMutatedGrant(client, result, "service-principal-grant-revoked", input.audit),
      ),
    );

/** Runs `mutation` in one transaction under the exclusive authorization lock. */
const mutateGrant = <A, E>(
  pool: SqlClient.SqlClient,
  mutation: (
    client: SqlClient.SqlClient,
  ) => Effect.Effect<A, E | ServicePrincipalGrantAuthorityError>,
) =>
  pool
    .withTransaction(acquireExclusiveAuthorizationLock(pool).pipe(Effect.andThen(mutation(pool))))
    .pipe(
      Effect.mapError((cause) =>
        cause instanceof ServicePrincipalGrantAuthorityError
          ? cause
          : new ServicePrincipalGrantAuthorityError({
              reason: "PersistenceFailure",
              message: "Service-principal grant mutation failed",
            }),
      ),
    );

export const makeServicePrincipalGrantAuthorityService = (
  pool: SqlClient.SqlClient,
): ServicePrincipalGrantAuthorityOperations => ({
  readReceiptApprovalCandidates: (credential, authorizationInstant, status, after) =>
    Schema.decodeEffect(AuthorizationInstant)(authorizationInstant, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        () =>
          new ServicePrincipalGrantAuthorityError({
            reason: "InvalidCredentialEvidence",
            message: "Authorization instant is invalid",
          }),
      ),
      Effect.flatMap((instant) =>
        Effect.gen(function* () {
          const position =
            after === undefined
              ? undefined
              : yield* decodeReceiptCursor(after).pipe(
                  Effect.mapError(
                    () =>
                      new ServicePrincipalGrantAuthorityError({
                        reason: "InvalidCredentialEvidence",
                        message: "Receipt cursor is invalid",
                      }),
                  ),
                );

          return yield* readInCurrentSnapshot(pool, credential, instant, status, position);
        }),
      ),
    ),
  createGrant: (input) =>
    Schema.decodeEffect(CreateServicePrincipalGrantInputSchema)(input, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(mutationRejected),
      Effect.flatMap((decoded) => mutateGrant(pool, (client) => createGrant(client, decoded))),
    ),
  endGrant: (input) =>
    Schema.decodeEffect(EndServicePrincipalGrantInputSchema)(input, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(mutationRejected),
      Effect.flatMap((decoded) => mutateGrant(pool, (client) => endGrant(client, decoded))),
    ),
  revokeGrant: (input) =>
    Schema.decodeEffect(RevokeServicePrincipalGrantInputSchema)(input, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(mutationRejected),
      Effect.flatMap((decoded) => mutateGrant(pool, (client) => revokeGrant(client, decoded))),
    ),
});

export const ServicePrincipalGrantAuthorityLive = Layer.effect(
  ServicePrincipalGrantAuthority,
  Effect.map(Database, makeServicePrincipalGrantAuthorityService),
);
