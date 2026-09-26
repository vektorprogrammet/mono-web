import { ReceiptId } from "@vektorprogrammet/domain/receipt";
import { Schema, ManagedRuntime, Layer } from "effect";
import { AuthEngine, AuthLive } from "../src/auth-live.js";
import { AuthPoolLive } from "../src/auth-engine.js";
import { DatabasePgPool } from "../src/pg-pool.js";
import { OAuthClientOperator, OAuthCredentialAuthority } from "../src/oauth-live.js";
import {
  GrantId,
  OAuthClientId,
  AcceptedOAuthServiceCredential,
  CredentialMechanismSchema,
  PrincipalSchema,
  AccessEvaluation,
  CredentialOutcomeSchema,
  ServicePrincipalGrantAuthority,
} from "@vektorprogrammet/domain/authz";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  AUTHZ_LOCK_PROTOCOL,
  AuthorizationInstant,
  CredentialEvidenceRef,
  NATIVE_API_PROTECTED_RESOURCE,
  RECEIPT_APPROVAL_QUEUE_OPERATION,
  ServicePrincipalId,
  composeServicePrincipalReceiptRuleRequirements,
  evaluateServicePrincipalReceiptApprovalAccess,
  type ServicePrincipalReceiptGrantAuthority,
} from "@vektorprogrammet/domain/authz";
import { IdentityRequestContext } from "@vektorprogrammet/domain/identity";
import { Predicate, Effect } from "effect";
import { Pool } from "pg";
import { type AuthEngineConfig } from "../src/auth-engine.js";
import { databaseMigrationDefinitions, databaseSchemaRevision } from "../src/migrations.js";

const databaseUrl =
  process.env.SERVICE_PRINCIPAL_GRANTS_PROOF_PG_URL ??
  "postgres://postgres@127.0.0.1:45128/service_principal_grants_0056_3_proof";

const parsedDatabaseUrl = new URL(databaseUrl);

assert.ok(
  ["127.0.0.1", "localhost", "::1"].includes(parsedDatabaseUrl.hostname),
  "Service-principal grant proof database must use a loopback host",
);

assert.match(
  parsedDatabaseUrl.pathname,
  /(?:proof|test)/u,
  "Service-principal grant proof database name must be disposable",
);

const migrationPool = new Pool({ connectionString: databaseUrl, max: 1 });

for (const migration of databaseMigrationDefinitions) {
  await migrationPool.query(await readFile(migration.url, "utf8"));
}

await migrationPool.end();

const config: AuthEngineConfig = {
  postgresUrl: databaseUrl,
  secret: "service-principal-grants-disposable-proof-secret-32-characters",
  oauth: {
    canonicalOrigin: "http://127.0.0.1:4173",
    dashboardOrigin: "http://127.0.0.1:4173",
    nativeApiResource: NATIVE_API_PROTECTED_RESOURCE,
  },
  trustedOrigins: ["http://127.0.0.1:4173"],
  secureCookies: false,
};

const authRuntime = ManagedRuntime.make(
  AuthLive(config).pipe(Layer.provideMerge(AuthPoolLive(config))),
);

const pool = await authRuntime.runPromise(DatabasePgPool);

const operator = await authRuntime.runPromise(OAuthClientOperator);

const execution = {
  dryRun: false,
  target: parsedDatabaseUrl.pathname.slice(1),
  authority: "operator",
  requestCorrelation: "service-principal-grants-postgres-proof",
} as const;

await authRuntime.runPromise(operator.bootstrapSigningKey(execution));

const provisionedService = await authRuntime.runPromise(
  operator.provision(
    {
      clientId: "service-receipt-approval-client",
      name: "Service receipt approval client",
      clientKind: "Service",
      redirectUris: [],
      scopes: ["native-api"],
      servicePrincipalId: "service-receipt-approval",
      servicePrincipalName: "Service receipt approval",
    },
    execution,
  ),
);

assert.ok(Predicate.isString(provisionedService.clientSecret));

await authRuntime.runPromise(
  operator.provision(
    {
      clientId: "service-receipt-approval-resource-server",
      name: "Service receipt approval resource server",
      clientKind: "ResourceServer",
      redirectUris: [],
      scopes: [],
    },
    execution,
  ),
);

await pool.query(
  `INSERT INTO public.person_profiles (person_id, first_name, last_name)
   VALUES ('service-receipt-owner', 'Service receipt', 'Owner')`,
);

await pool.query(
  `INSERT INTO public.organization_departments (
     department_id, name, short_name, email, city
   ) VALUES (
     'service-receipt-department', 'Service receipt department', 'SRD',
     'service-receipt-department@example.invalid', 'Oslo'
   )`,
);

await pool.query(
  `INSERT INTO public.economy_receipts (
     receipt_id, visual_id, owner_person_id, department_id, amount_ore,
     currency, description, receipt_date, submitted_at, status, approved_at,
     payment_account_ciphertext, file_ref, file_object_key, file_content_type,
     file_byte_length, file_sha256, revision
   ) VALUES
   (
     'service-receipt-approval-pending', 'SERVICE-PENDING', 'service-receipt-owner',
     'service-receipt-department', 1000, 'NOK', 'Pending service receipt', CURRENT_DATE,
     date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC'), 'Pending', NULL, 'ciphertext:service:pending',
     'service-file-pending', 'service-object-pending', 'application/pdf', 100,
     repeat('a', 64), 0
   ),
   (
     'service-receipt-approval-nonpending', 'SERVICE-NONPENDING', 'service-receipt-owner',
     'service-receipt-department', 2000, 'NOK', 'Nonpending service receipt', CURRENT_DATE,
     date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC'), 'Rejected', NULL, 'ciphertext:service:nonpending',
     'service-file-nonpending', 'service-object-nonpending', 'application/pdf', 200,
     repeat('b', 64), 0
   ),
   (
     'service-receipt-approval-foreign', 'SERVICE-FOREIGN', 'service-receipt-owner',
     'service-receipt-department', 3000, 'NOK', 'Foreign service receipt', CURRENT_DATE,
     date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC'), 'Pending', NULL, 'ciphertext:service:foreign',
     'service-file-foreign', 'service-object-foreign', 'application/pdf', 300,
     repeat('c', 64), 0
   )`,
);

const requestContext = new IdentityRequestContext({
  requestCorrelation: "service-principal-grants-token-request",
  sourceIp: "127.0.0.1",
  userAgent: "service-principal-grants-postgres-proof",
});

const authEngine = await authRuntime.runPromise(AuthEngine);

const release = (request: Request, context: IdentityRequestContext) =>
  authRuntime.runPromise(authEngine.oauthHandler(request, context));

const tokenResponse = await release(
  new Request("http://127.0.0.1:4173/api/auth/oauth2/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(
        `${provisionedService.clientId}:${provisionedService.clientSecret!}`,
        "utf8",
      ).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "native-api",
      resource: NATIVE_API_PROTECTED_RESOURCE,
    }),
  }),
  requestContext,
);

assert.equal(tokenResponse.status, 200);

const tokenPayload = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
  await tokenResponse.json(),
);

assert.ok(Predicate.isString(tokenPayload.access_token));

const bearer = tokenPayload.access_token;

const credentialAuthority = await authRuntime.runPromise(OAuthCredentialAuthority);

const resolved = await authRuntime.runPromise(
  credentialAuthority.resolve(
    new Request("http://127.0.0.1:4173/api/receipt-approval-queue", {
      headers: { authorization: `Bearer ${bearer}` },
    }),
    "OAuthServiceBearer",
  ),
);

assert.equal(resolved._tag, "Accepted");

assert.equal(
  Predicate.isTagged(resolved, "Accepted") && resolved.mechanism._tag,
  "OAuthServiceBearer",
);

assert.equal(
  Predicate.isTagged(resolved, "Accepted") && resolved.principal._tag,
  "ServicePrincipal",
);

if (
  !Predicate.isTagged(resolved, "Accepted") ||
  !Predicate.isTagged(resolved.mechanism, "OAuthServiceBearer") ||
  !Predicate.isTagged(resolved.principal, "ServicePrincipal")
) {
  throw new TypeError("service credential proof did not resolve the exact principal");
}

const credential: AcceptedOAuthServiceCredential = AcceptedOAuthServiceCredential.make({
  mechanism: CredentialMechanismSchema.cases.OAuthServiceBearer.make({}),
  principal: PrincipalSchema.cases.ServicePrincipal.make({
    servicePrincipalId: ServicePrincipalId.make(resolved.principal.servicePrincipalId),
  }),
  evidenceRef: CredentialEvidenceRef.make(resolved.evidenceRef),
});

const authorizationInstant = AuthorizationInstant.make(new Date().toISOString());

const grantAuthority = await authRuntime.runPromise(ServicePrincipalGrantAuthority);

const ruleFixtureClient = await pool.connect();

try {
  await ruleFixtureClient.query("BEGIN");
  await ruleFixtureClient.query(
    `SELECT pg_catalog.pg_advisory_xact_lock(
       pg_catalog.hashtextextended($1, 0)
     )`,
    [AUTHZ_LOCK_PROTOCOL.advisoryKey],
  );
  await ruleFixtureClient.query(
    `INSERT INTO public.authz_rules (
       rule_id, capability_id, effect_kind, subject_kind,
       subject_service_principal_id, scope, resource_kind, resource_id,
       params, start_at, end_at, revision
     ) VALUES (
       'service-receipt-pending-requirement',
       'approveReceipt',
       'requirement',
       'ServicePrincipal',
       $1,
       'Resource',
       'receipt',
       'service-receipt-approval-pending',
       '{"requirementId":"receipts.pending","parameters":{}}'::jsonb,
       $2::timestamptz,
       NULL,
       0
     )`,
    [credential.principal.servicePrincipalId, authorizationInstant],
  );
  await ruleFixtureClient.query("COMMIT");
} catch (cause) {
  await ruleFixtureClient.query("ROLLBACK");
  throw cause;
} finally {
  ruleFixtureClient.release();
}

const blocker = await pool.connect();

let authorizationReadBlockedByExclusiveLock = false;

let before: ServicePrincipalReceiptGrantAuthority;

try {
  await blocker.query("BEGIN");
  await blocker.query(
    `SELECT pg_catalog.pg_advisory_xact_lock(
       pg_catalog.hashtextextended($1, 0)
     )`,
    [AUTHZ_LOCK_PROTOCOL.advisoryKey],
  );
  let settled = false;

  const blockedRead = Effect.runPromise(
    grantAuthority.readReceiptApprovalCandidates(credential, authorizationInstant),
  );

  void blockedRead.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const timer = Promise.withResolvers<void>();
  setTimeout(timer.resolve, 50);
  await timer.promise;
  authorizationReadBlockedByExclusiveLock = !settled;
  assert.equal(authorizationReadBlockedByExclusiveLock, true);
  await blocker.query("COMMIT");
  before = await blockedRead;
} catch (cause) {
  await blocker.query("ROLLBACK");
  throw cause;
} finally {
  blocker.release();
}

assert.deepEqual(before.candidates, []);

assert.deepEqual(before.rules, []);

assert.deepEqual(
  evaluateServicePrincipalReceiptApprovalAccess(credential, before, authorizationInstant),
  AccessEvaluation.Deny({
    stage: "Capability",
    reason: "CapabilityMissing",
  }),
);

const created = await Effect.runPromise(
  grantAuthority.createGrant({
    grant: {
      grantId: GrantId.make("service-receipt-approval-grant"),
      servicePrincipalId: credential.principal.servicePrincipalId,
      clientId: OAuthClientId.make(provisionedService.clientId),
      protectedResource: NATIVE_API_PROTECTED_RESOURCE,
      operationId: RECEIPT_APPROVAL_QUEUE_OPERATION,
      capabilityId: "approveReceipt",
      resourceKind: "receipt",
      receiptId: ReceiptId.make("service-receipt-approval-pending"),
      startAt: authorizationInstant,
      endAt: null,
      revokedAt: null,
      revision: 0,
    },
    audit: {
      eventId: "service-receipt-approval-grant-created",
      occurredAt: authorizationInstant,
      operatorActor: "operator",
      requestCorrelation: "service-principal-grants-create",
    },
  }),
);

assert.equal(created.grantId, "service-receipt-approval-grant");

const active = await Effect.runPromise(
  grantAuthority.readReceiptApprovalCandidates(credential, authorizationInstant),
);

assert.deepEqual(
  active.candidates.map((candidate) => candidate.receipt.receiptId),
  ["service-receipt-approval-pending"],
);

const allowed = evaluateServicePrincipalReceiptApprovalAccess(
  credential,
  active,
  authorizationInstant,
);

assert.equal(allowed._tag, "Allow");

if (!Predicate.isTagged(allowed, "Allow")) {
  throw new TypeError("active service grant did not produce an allowed context");
}

const allowedContext = allowed.resolution.contexts[0];

assert.ok(allowedContext);

const ruleComposition = composeServicePrincipalReceiptRuleRequirements(
  active,
  allowedContext,
  authorizationInstant,
);

assert.deepEqual(ruleComposition.contributingRuleIds, ["service-receipt-pending-requirement"]);

const revokedAt = AuthorizationInstant.make(new Date(Date.now() + 1_000).toISOString());

await Effect.runPromise(
  grantAuthority.revokeGrant({
    grantId: created.grantId,
    revokedAt,
    expectedRevision: created.revision,
    audit: {
      eventId: "service-receipt-approval-grant-revoked",
      occurredAt: revokedAt,
      operatorActor: "operator",
      requestCorrelation: "service-principal-grants-revoke",
    },
  }),
);

const afterRevocation = await Effect.runPromise(
  grantAuthority.readReceiptApprovalCandidates(credential, revokedAt),
);

assert.deepEqual(afterRevocation.candidates, []);

const stillAccepted = await authRuntime.runPromise(
  credentialAuthority.resolve(
    new Request("http://127.0.0.1:4173/api/receipt-approval-queue", {
      headers: { authorization: `Bearer ${bearer}` },
    }),
    "OAuthServiceBearer",
  ),
);

assert.equal(stillAccepted._tag, "Accepted");

await authRuntime.runPromise(
  operator.disableServicePrincipal("service-receipt-approval", execution),
);

const disabled = await authRuntime.runPromise(
  credentialAuthority.resolve(
    new Request("http://127.0.0.1:4173/api/receipt-approval-queue", {
      headers: { authorization: `Bearer ${bearer}` },
    }),
    "OAuthServiceBearer",
  ),
);

assert.deepEqual(disabled, CredentialOutcomeSchema.cases.Rejected.make({ reason: "Revoked" }));

const auditRows = await pool.query<{
  readonly event_kind: string;
  readonly grant_id: string;
}>(
  `SELECT event_kind, grant_id
     FROM public.service_principal_grant_audit
    ORDER BY occurred_at ASC, event_id ASC`,
);

assert.deepEqual(auditRows.rows, [
  {
    event_kind: "service-principal-grant-created",
    grant_id: "service-receipt-approval-grant",
  },
  {
    event_kind: "service-principal-grant-revoked",
    grant_id: "service-receipt-approval-grant",
  },
]);

const evidence = {
  schemaRevision: databaseSchemaRevision,
  stageCounts: {
    credentialAcceptedBeforeGrant: 1,
    authorizationReadBlockedByExclusiveLock: authorizationReadBlockedByExclusiveLock ? 1 : 0,
    capabilityDeniedBeforeGrant: before.candidates.length === 0 ? 1 : 0,
    activeGrantAllowed: Predicate.isTagged(allowed, "Allow") ? 1 : 0,
    credentialAcceptedAfterRevocation: Predicate.isTagged(stillAccepted, "Accepted") ? 1 : 0,
    credentialRejectedAfterDisable: Predicate.isTagged(disabled, "Rejected") ? 1 : 0,
  },
  candidateCounts: {
    beforeGrant: before.candidates.length,
    activeGrant: active.candidates.length,
    activeRuleSnapshot: active.rules.length,
    afterRevocation: afterRevocation.candidates.length,
  },
  auditCounts: {
    created: auditRows.rows.filter((row) => row.event_kind === "service-principal-grant-created")
      .length,
    ended: auditRows.rows.filter((row) => row.event_kind === "service-principal-grant-ended")
      .length,
    revoked: auditRows.rows.filter((row) => row.event_kind === "service-principal-grant-revoked")
      .length,
  },
};

const boundedEvidence = JSON.stringify(evidence);

assert.equal(boundedEvidence.includes(bearer), false);

assert.equal(boundedEvidence.includes(provisionedService.clientSecret!), false);

process.stdout.write(`${boundedEvidence}\n`);

await authRuntime.dispose();
