/**
 * EX-0021: native stable SQL carries upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import { AuthPoolLive } from "../src/pg-pool.js";
import { DatabaseLive } from "../src/layers.js";
import { BetterAuthStartupOptions, NativeDatabaseStartupOptions } from "../src/search-path.js";
import { Database } from "../src/service.js";
import { Redacted } from "effect";
import { ReceiptId } from "@vektorprogrammet/domain/receipt";
import {
  Config,
  ConfigProvider,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";
import { AuthEngine, AuthLive } from "../src/auth-live.js";
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
import {
  AUTHZ_LOCK_PROTOCOL,
  AuthorizationInstant,
  CredentialEvidenceRef,
  NATIVE_API_PROTECTED_RESOURCE,
  RECEIPT_APPROVAL_QUEUE_OPERATION,
  ServicePrincipalId,
  composeServicePrincipalReceiptRuleRequirements,
  evaluateServicePrincipalReceiptApprovalAccess,
} from "@vektorprogrammet/domain/authz";
import { IdentityRequestContext } from "@vektorprogrammet/domain/identity";
import { type AuthEngineConfig } from "../src/auth-engine.js";
import { databaseSchemaRevision } from "../src/migrations.js";
import { TestPlatform } from "../src/test-support/platform.js";

const trace = (target: string) =>
  Effect.gen(function* () {
    const pool = yield* Database;
    const operator = yield* OAuthClientOperator;

    const execution = {
      dryRun: false,
      target,
      authority: "operator",
      requestCorrelation: "service-principal-grants-postgres-proof",
    } as const;

    yield* operator.bootstrapSigningKey(execution);

    const provisionedService = yield* operator.provision(
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
    );

    assert.ok(Predicate.isString(provisionedService.clientSecret));

    yield* operator.provision(
      {
        clientId: "service-receipt-approval-resource-server",
        name: "Service receipt approval resource server",
        clientKind: "ResourceServer",
        redirectUris: [],
        scopes: [],
      },
      execution,
    );

    yield* pool.unsafe(`INSERT INTO public.person_profiles (person_id, first_name, last_name)
     VALUES ('service-receipt-owner', 'Service receipt', 'Owner')`);

    yield* pool.unsafe(`INSERT INTO public.organization_departments (
       department_id, name, short_name, email, city
     ) VALUES (
       'service-receipt-department', 'Service receipt department', 'SRD',
       'service-receipt-department@example.invalid', 'Oslo'
     )`);

    yield* pool.unsafe(`INSERT INTO public.economy_receipts (
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
     )`);

    const requestContext = new IdentityRequestContext({
      requestCorrelation: "service-principal-grants-token-request",
      sourceIp: "127.0.0.1",
      userAgent: "service-principal-grants-postgres-proof",
    });

    const authEngine = yield* AuthEngine;

    const tokenResponse = yield* authEngine.oauthHandler(
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

    const tokenPayload = yield* Effect.tryPromise(() => tokenResponse.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))),
    );

    assert.ok(Predicate.isString(tokenPayload.access_token));

    const bearer = tokenPayload.access_token;

    const credentialAuthority = yield* OAuthCredentialAuthority;

    const resolved = yield* credentialAuthority.resolve(
      new Request("http://127.0.0.1:4173/api/receipt-approval-queue", {
        headers: { authorization: `Bearer ${bearer}` },
      }),
      "OAuthServiceBearer",
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
      return yield* Effect.die(
        new TypeError("service credential proof did not resolve the exact principal"),
      );
    }

    const credential: AcceptedOAuthServiceCredential = AcceptedOAuthServiceCredential.make({
      mechanism: CredentialMechanismSchema.cases.OAuthServiceBearer.make({}),
      principal: PrincipalSchema.cases.ServicePrincipal.make({
        servicePrincipalId: ServicePrincipalId.make(resolved.principal.servicePrincipalId),
      }),
      evidenceRef: CredentialEvidenceRef.make(resolved.evidenceRef),
    });

    const authorizationInstant = AuthorizationInstant.make(DateTime.formatIso(yield* DateTime.now));

    const grantAuthority = yield* ServicePrincipalGrantAuthority;

    yield* pool.withTransaction(
      Effect.gen(function* () {
        const ruleFixtureClient = pool;
        yield* ruleFixtureClient.unsafe(
          `SELECT pg_catalog.pg_advisory_xact_lock(
       pg_catalog.hashtextextended($1, 0)
     )`,
          [AUTHZ_LOCK_PROTOCOL.advisoryKey],
        );
        yield* ruleFixtureClient.unsafe(
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
      }),
    );

    // The blocker owns the lock in its own fiber, so the reader starts outside the blocker's
    // transaction context: it takes its own transaction and waits for the lock like any caller.
    const lockHeld = yield* Deferred.make<void>();
    const releaseLock = yield* Deferred.make<void>();

    const blocker = yield* pool
      .withTransaction(
        Effect.gen(function* () {
          yield* pool.unsafe(
            `SELECT pg_catalog.pg_advisory_xact_lock(
       pg_catalog.hashtextextended($1, 0)
     )`,
            [AUTHZ_LOCK_PROTOCOL.advisoryKey],
          );

          yield* Deferred.succeed(lockHeld, undefined);
          yield* Deferred.await(releaseLock);
        }),
      )
      .pipe(Effect.forkChild);

    yield* Effect.raceFirst(Deferred.await(lockHeld), Fiber.join(blocker));

    const read = yield* grantAuthority
      .readReceiptApprovalCandidates(credential, authorizationInstant)
      .pipe(Effect.forkChild);

    // A reader that settled within the window never proves the lock held it: its failure
    // fails the proof with its own cause, and a success means the lock did not block it.
    const settledReader = yield* Effect.timeoutOption(Fiber.await(read), Duration.millis(50));

    if (Option.isSome(settledReader)) {
      if (Exit.isFailure(settledReader.value)) {
        return yield* Effect.failCause(settledReader.value.cause);
      }

      assert.fail("the receipt-approval reader completed while the exclusive lock was held");
    }

    const authorizationReadBlockedByExclusiveLock = Option.isNone(settledReader);
    assert.equal(authorizationReadBlockedByExclusiveLock, true);

    yield* Deferred.succeed(releaseLock, undefined);
    yield* Fiber.join(blocker);
    const before = yield* Fiber.join(read);

    assert.deepEqual(before.candidates, []);

    assert.deepEqual(before.rules, []);

    assert.deepEqual(
      evaluateServicePrincipalReceiptApprovalAccess(credential, before, authorizationInstant),
      AccessEvaluation.Deny({
        stage: "Capability",
        reason: "CapabilityMissing",
      }),
    );

    const created = yield* grantAuthority.createGrant({
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
    });

    assert.equal(created.grantId, "service-receipt-approval-grant");

    const active = yield* grantAuthority.readReceiptApprovalCandidates(
      credential,
      authorizationInstant,
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
      return yield* Effect.die(
        new TypeError("active service grant did not produce an allowed context"),
      );
    }

    const allowedContext = allowed.resolution.contexts[0];

    assert.ok(allowedContext);

    const ruleComposition = composeServicePrincipalReceiptRuleRequirements(
      active,
      allowedContext,
      authorizationInstant,
    );

    assert.deepEqual(ruleComposition.contributingRuleIds, ["service-receipt-pending-requirement"]);

    const revokedAt = AuthorizationInstant.make(
      DateTime.formatIso(DateTime.add(yield* DateTime.now, { seconds: 1 })),
    );

    yield* grantAuthority.revokeGrant({
      grantId: created.grantId,
      revokedAt,
      expectedRevision: created.revision,
      audit: {
        eventId: "service-receipt-approval-grant-revoked",
        occurredAt: revokedAt,
        operatorActor: "operator",
        requestCorrelation: "service-principal-grants-revoke",
      },
    });

    const afterRevocation = yield* grantAuthority.readReceiptApprovalCandidates(
      credential,
      revokedAt,
    );

    assert.deepEqual(afterRevocation.candidates, []);

    const stillAccepted = yield* credentialAuthority.resolve(
      new Request("http://127.0.0.1:4173/api/receipt-approval-queue", {
        headers: { authorization: `Bearer ${bearer}` },
      }),
      "OAuthServiceBearer",
    );

    assert.equal(stillAccepted._tag, "Accepted");

    yield* operator.disableServicePrincipal("service-receipt-approval", execution);

    const disabled = yield* credentialAuthority.resolve(
      new Request("http://127.0.0.1:4173/api/receipt-approval-queue", {
        headers: { authorization: `Bearer ${bearer}` },
      }),
      "OAuthServiceBearer",
    );

    assert.deepEqual(disabled, CredentialOutcomeSchema.cases.Rejected.make({ reason: "Revoked" }));

    const auditRows = yield* pool.unsafe<{
      readonly event_kind: string;
      readonly grant_id: string;
    }>(`SELECT event_kind, grant_id
       FROM public.service_principal_grant_audit
      ORDER BY occurred_at ASC, event_id ASC`);

    assert.deepEqual(auditRows, [
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
        created: auditRows.filter((row) => row.event_kind === "service-principal-grant-created")
          .length,
        ended: auditRows.filter((row) => row.event_kind === "service-principal-grant-ended").length,
        revoked: auditRows.filter((row) => row.event_kind === "service-principal-grant-revoked")
          .length,
      },
    };

    const boundedEvidence = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
      evidence,
    );

    assert.equal(boundedEvidence.includes(bearer), false);

    assert.equal(boundedEvidence.includes(provisionedService.clientSecret!), false);

    yield* Effect.sync(() => process.stdout.write(`${boundedEvidence}\n`));
  });

const program = Effect.gen(function* () {
  const databaseUrl = yield* Config.String("SERVICE_PRINCIPAL_GRANTS_PROOF_PG_URL").pipe(
    Config.withDefault("postgres://postgres@127.0.0.1:45128/service_principal_grants_0056_3_proof"),
  );

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

  yield* trace(parsedDatabaseUrl.pathname.slice(1)).pipe(
    Effect.provide(
      AuthLive(config, globalThis.crypto.subtle).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            AuthPoolLive(config, {
              maxConnections: 4,
              applicationName: "stable-auth-proof",
              pipeline: true,
              startupOptions: BetterAuthStartupOptions,
            }),
            DatabaseLive({
              url: Redacted.make(config.postgresUrl),
              maxConnections: 4,
              applicationName: "stable-auth-proof-sql",
              startupOptions: NativeDatabaseStartupOptions,
            }),
          ),
        ),
      ),
    ),
  );
});

// A set but empty variable is present, not absent: it never selects the default database.
void Effect.runPromise(
  program.pipe(
    Effect.provide(
      Layer.mergeAll(
        TestPlatform,
        ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
      ),
    ),
  ),
).catch((cause: unknown) => {
  process.stderr.write(`${String(cause)}\n`);
  process.exitCode = 1;
});
