import {
  AUTHZ_LOCK_PROTOCOL,
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
  type AcceptedOAuthServiceCredential,
  type AuthzRule,
  type CreateServicePrincipalGrantInput,
  type EndServicePrincipalGrantInput,
  type RevokeServicePrincipalGrantInput,
  type ServicePrincipalGrantAuditContext,
  type ServicePrincipalGrantAuthorityShape,
  type ServicePrincipalReceiptGrant,
  type ServicePrincipalReceiptGrantAuthority,
} from "@vektorprogrammet/domain/authz";
import { Effect, Layer, Schema } from "effect";
import type { Pool, PoolClient } from "pg";

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
  readonly owner_person_id: string;
  readonly department_id: string;
  readonly receipt_status: string;
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

const acquireSharedAuthorizationLock = async (client: PoolClient): Promise<void> => {
  await client.query(
    `SELECT pg_catalog.pg_advisory_xact_lock_shared(
       pg_catalog.hashtextextended($1, 0)
     )`,
    [AUTHZ_LOCK_PROTOCOL.advisoryKey],
  );
};

const acquireExclusiveAuthorizationLock = async (client: PoolClient): Promise<void> => {
  await client.query(
    `SELECT pg_catalog.pg_advisory_xact_lock(
       pg_catalog.hashtextextended($1, 0)
     )`,
    [AUTHZ_LOCK_PROTOCOL.advisoryKey],
  );
};

const credentialEvidencePattern =
  /^oauth:ServicePrincipal:([^:]{1,160}):([^:]{1,160}):([0-9]{1,20})$/u;

const decodePersistedGrant = (
  row: PersistedServiceReceiptGrantRow,
): ServicePrincipalReceiptGrant =>
  Schema.decodeUnknownSync(ServicePrincipalReceiptGrantSchema)(
    {
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
    },
    { onExcessProperty: "error" },
  );
const decodePersistedServiceRule = (row: PersistedServiceRuleRow): AuthzRule => {
  const subject =
    row.subject_kind === "Person"
      ? { _tag: "Person", personId: row.subject_person_id }
      : row.subject_kind === "Tag"
        ? { _tag: "Tag", tagId: row.subject_tag_id }
        : {
            _tag: row.subject_kind,
            servicePrincipalId: row.subject_service_principal_id,
          };
  const scope =
    row.scope === "Global"
      ? { _tag: "Global" }
      : row.scope === "Domain"
        ? { _tag: "Domain", domainId: row.domain_id }
        : row.scope === "Department"
          ? { _tag: "Department", departmentId: row.department_id }
          : {
              _tag: row.scope,
              resource: {
                kind: row.resource_kind,
                id: row.resource_id,
              },
            };
  return Schema.decodeUnknownSync(AuthzRuleSchema)(
    {
      ruleId: row.rule_id,
      capabilityId: row.capability_id,
      effectKind: row.effect_kind,
      subject,
      scope,
      params: row.params,
      startAt: row.start_at.toISOString(),
      endAt: row.end_at?.toISOString() ?? null,
      revision: row.revision,
    },
    { onExcessProperty: "error" },
  );
};
const currentServiceBinding = async (
  client: PoolClient,
  credential: AcceptedOAuthServiceCredential,
  authorizationInstant: string,
): Promise<string> => {
  const evidence = credentialEvidencePattern.exec(credential.evidenceRef);
  if (evidence === null) {
    throw new ServicePrincipalGrantAuthorityError({
      reason: "InvalidCredentialEvidence",
      message: "OAuth service credential evidence is not canonical",
    });
  }
  const [, jti, clientId, issuedAt] = evidence;
  const result = await client.query<CurrentServiceBindingRow>(
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
  if (result.rowCount !== 1 || result.rows[0] === undefined) {
    throw new ServicePrincipalGrantAuthorityError({
      reason: "CurrentBindingRejected",
      message: "OAuth service credential binding is not current",
    });
  }
  return result.rows[0].client_id;
};

const readExactGrantCandidates = async (
  client: PoolClient,
  credential: AcceptedOAuthServiceCredential,
  clientId: string,
  authorizationInstant: string,
): Promise<ServicePrincipalReceiptGrantAuthority["candidates"]> => {
  const result = await client.query<ServiceReceiptGrantRow>(
    `SELECT
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
       receipt.owner_person_id,
       receipt.department_id,
       receipt.status AS receipt_status,
       receipt.revision AS receipt_revision
     FROM public.service_principal_grants AS grant_row
     JOIN public.economy_receipts AS receipt
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
     ORDER BY grant_row.resource_id ASC, grant_row.grant_id ASC`,
    [
      credential.principal.servicePrincipalId,
      clientId,
      NATIVE_API_PROTECTED_RESOURCE,
      RECEIPT_APPROVAL_QUEUE_OPERATION,
      authorizationInstant,
    ],
  );

  return result.rows.map((row) => ({
    grant: decodePersistedGrant(row),
    receipt: Schema.decodeUnknownSync(ServicePrincipalReceiptCandidateSchema)(
      {
        receiptId: row.resource_id,
        ownerPersonId: row.owner_person_id,
        departmentId: row.department_id,
        status: row.receipt_status,
        revision: row.receipt_revision,
      },
      { onExcessProperty: "error" },
    ),
  }));
};

const readServicePrincipalRules = async (
  client: PoolClient,
  servicePrincipalId: string,
  authorizationInstant: string,
  receiptIds: ReadonlyArray<string>,
): Promise<ReadonlyArray<AuthzRule>> => {
  const result = await client.query<PersistedServiceRuleRow>(
    `SELECT
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
       AND subject_service_principal_id = $1
       AND scope = 'Resource'
       AND resource_kind = 'receipt'
       AND resource_id = ANY($3::text[])
       AND start_at <= $2::timestamptz
       AND (end_at IS NULL OR $2::timestamptz < end_at)
     ORDER BY resource_id ASC, rule_id ASC`,
    [servicePrincipalId, authorizationInstant, receiptIds],
  );
  return result.rows.map(decodePersistedServiceRule);
};
const readInCurrentSnapshot = async (
  pool: Pool,
  credential: AcceptedOAuthServiceCredential,
  authorizationInstant: string,
): Promise<ServicePrincipalReceiptGrantAuthority> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await acquireSharedAuthorizationLock(client);
    const clientId = await currentServiceBinding(client, credential, authorizationInstant);
    const candidates = await readExactGrantCandidates(
      client,
      credential,
      clientId,
      authorizationInstant,
    );
    const rules = await readServicePrincipalRules(
      client,
      credential.principal.servicePrincipalId,
      authorizationInstant,
      candidates.map(({ receipt }) => receipt.receiptId),
    );
    const authority = {
      servicePrincipalId: credential.principal.servicePrincipalId,
      clientId: Schema.decodeUnknownSync(OAuthClientId)(clientId, {
        onExcessProperty: "error",
      }),
      protectedResource: NATIVE_API_PROTECTED_RESOURCE,
      candidates,
      rules,
    } satisfies ServicePrincipalReceiptGrantAuthority;
    await client.query("COMMIT");
    return authority;
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (cause instanceof ServicePrincipalGrantAuthorityError) throw cause;
    throw new ServicePrincipalGrantAuthorityError({
      reason: "PersistenceFailure",
      message: "Service-principal grant authority read failed",
    });
  } finally {
    client.release();
  }
};

type ServicePrincipalGrantAuditEventKind =
  | "service-principal-grant-created"
  | "service-principal-grant-ended"
  | "service-principal-grant-revoked";

const appendGrantAudit = async (
  client: PoolClient,
  eventKind: ServicePrincipalGrantAuditEventKind,
  grant: ServicePrincipalReceiptGrant,
  audit: ServicePrincipalGrantAuditContext,
): Promise<void> => {
  await client.query(
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
};

const mutationRejected = (): ServicePrincipalGrantAuthorityError =>
  new ServicePrincipalGrantAuthorityError({
    reason: "MutationRejected",
    message: "Service-principal grant mutation was rejected",
  });

const createGrant = async (
  client: PoolClient,
  input: CreateServicePrincipalGrantInput,
): Promise<ServicePrincipalReceiptGrant> => {
  const grant = input.grant;
  const result = await client.query<PersistedServiceReceiptGrantRow>(
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
      grant.grantId,
      grant.servicePrincipalId,
      grant.clientId,
      grant.protectedResource,
      grant.operationId,
      grant.capabilityId,
      grant.resourceKind,
      grant.receiptId,
      grant.startAt,
      grant.endAt,
      grant.revokedAt,
      grant.revision,
      input.audit.occurredAt,
    ],
  );
  const row = result.rows[0];
  if (result.rowCount !== 1 || row === undefined) throw mutationRejected();
  const created = decodePersistedGrant(row);
  await appendGrantAudit(client, "service-principal-grant-created", created, input.audit);
  return created;
};

const endGrant = async (
  client: PoolClient,
  input: EndServicePrincipalGrantInput,
): Promise<ServicePrincipalReceiptGrant> => {
  const result = await client.query<PersistedServiceReceiptGrantRow>(
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
  );
  const row = result.rows[0];
  if (result.rowCount !== 1 || row === undefined) throw mutationRejected();
  const ended = decodePersistedGrant(row);
  await appendGrantAudit(client, "service-principal-grant-ended", ended, input.audit);
  return ended;
};

const revokeGrant = async (
  client: PoolClient,
  input: RevokeServicePrincipalGrantInput,
): Promise<ServicePrincipalReceiptGrant> => {
  const result = await client.query<PersistedServiceReceiptGrantRow>(
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
  );
  const row = result.rows[0];
  if (result.rowCount !== 1 || row === undefined) throw mutationRejected();
  const revoked = decodePersistedGrant(row);
  await appendGrantAudit(client, "service-principal-grant-revoked", revoked, input.audit);
  return revoked;
};

const mutateGrant = async <A>(
  pool: Pool,
  mutation: (client: PoolClient) => Promise<A>,
): Promise<A> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await acquireExclusiveAuthorizationLock(client);
    const result = await mutation(client);
    await client.query("COMMIT");
    return result;
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (cause instanceof ServicePrincipalGrantAuthorityError) throw cause;
    throw new ServicePrincipalGrantAuthorityError({
      reason: "PersistenceFailure",
      message: "Service-principal grant mutation failed",
    });
  } finally {
    client.release();
  }
};
export const makeServicePrincipalGrantAuthorityService = (
  pool: Pool,
): ServicePrincipalGrantAuthorityShape => ({
  readReceiptApprovalCandidates: (credential, authorizationInstant) =>
    Schema.decodeUnknownEffect(AuthorizationInstant)(authorizationInstant, {
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
        Effect.tryPromise({
          try: () => readInCurrentSnapshot(pool, credential, instant),
          catch: (cause) =>
            cause instanceof ServicePrincipalGrantAuthorityError
              ? cause
              : new ServicePrincipalGrantAuthorityError({
                  reason: "PersistenceFailure",
                  message: "Service-principal grant authority read failed",
                }),
        }),
      ),
    ),
  createGrant: (input) =>
    Effect.try({
      try: () =>
        Schema.decodeUnknownSync(CreateServicePrincipalGrantInputSchema)(input, {
          onExcessProperty: "error",
        }),
      catch: mutationRejected,
    }).pipe(
      Effect.flatMap((decoded) =>
        Effect.tryPromise({
          try: () => mutateGrant(pool, (client) => createGrant(client, decoded)),
          catch: (cause) =>
            cause instanceof ServicePrincipalGrantAuthorityError
              ? cause
              : new ServicePrincipalGrantAuthorityError({
                  reason: "PersistenceFailure",
                  message: "Service-principal grant mutation failed",
                }),
        }),
      ),
    ),
  endGrant: (input) =>
    Effect.try({
      try: () =>
        Schema.decodeUnknownSync(EndServicePrincipalGrantInputSchema)(input, {
          onExcessProperty: "error",
        }),
      catch: mutationRejected,
    }).pipe(
      Effect.flatMap((decoded) =>
        Effect.tryPromise({
          try: () => mutateGrant(pool, (client) => endGrant(client, decoded)),
          catch: (cause) =>
            cause instanceof ServicePrincipalGrantAuthorityError
              ? cause
              : new ServicePrincipalGrantAuthorityError({
                  reason: "PersistenceFailure",
                  message: "Service-principal grant mutation failed",
                }),
        }),
      ),
    ),
  revokeGrant: (input) =>
    Effect.try({
      try: () =>
        Schema.decodeUnknownSync(RevokeServicePrincipalGrantInputSchema)(input, {
          onExcessProperty: "error",
        }),
      catch: mutationRejected,
    }).pipe(
      Effect.flatMap((decoded) =>
        Effect.tryPromise({
          try: () => mutateGrant(pool, (client) => revokeGrant(client, decoded)),
          catch: (cause) =>
            cause instanceof ServicePrincipalGrantAuthorityError
              ? cause
              : new ServicePrincipalGrantAuthorityError({
                  reason: "PersistenceFailure",
                  message: "Service-principal grant mutation failed",
                }),
        }),
      ),
    ),
});

export const ServicePrincipalGrantAuthorityLive = (pool: Pool) =>
  Layer.succeed(ServicePrincipalGrantAuthority)(makeServicePrincipalGrantAuthorityService(pool));
