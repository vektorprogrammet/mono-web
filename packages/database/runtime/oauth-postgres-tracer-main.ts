import { PersonId } from "@vektorprogrammet/domain/organization";
import { CredentialOutcomeSchema, PrincipalSchema } from "@vektorprogrammet/domain/authz";
import { Config, ConfigProvider, Effect, FileSystem, Layer, Path, Predicate, Schema } from "effect";
import { AuthLive, AuthEngine } from "../src/auth-live.js";
import { AuthPoolLive } from "../src/auth-engine.js";
import { DatabasePgPool, pgQuery } from "../src/pg-pool.js";
import { OAuthClientOperator, OAuthCredentialAuthority } from "../src/oauth-live.js";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";
import { createLocalAccountIssuer } from "better-auth";
import { IdentityRequestContext } from "@vektorprogrammet/domain/identity";
import { type AuthEngineConfig } from "../src/auth-engine.js";
import { databaseMigrationDefinitions } from "../src/migrations.js";
import { TestPlatform } from "../src/test-support/platform.js";

/** The bytes that `JSON.stringify` writes for `value`. */
const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** The JSON object of a response body. */
const jsonRecordBody = (response: Response) =>
  Effect.tryPromise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))),
  );

const trace = (target: string) =>
  Effect.gen(function* () {
    const pool = yield* DatabasePgPool;
    const authEngine = yield* AuthEngine;
    const engine = authEngine.engine;
    const engineContext = yield* Effect.promise(() => engine.$context);

    yield* pgQuery(
      pool,
      `INSERT INTO public.person_profiles (person_id, first_name, last_name)
       VALUES ('oauth-proof-person', 'OAuth', 'Proof')`,
    );

    const delegatedPassword = "oauth-proof-person-password";

    const delegatedPasswordHash = yield* Effect.tryPromise(() =>
      engineContext.password.hash(delegatedPassword),
    );

    yield* Effect.tryPromise(() =>
      engineContext.internalAdapter.createUser(
        {
          id: "oauth-proof-person",
          name: "OAuth Proof",
          email: "oauth-proof-person@example.invalid",
          emailVerified: true,
        },
        { method: "email-password" },
      ),
    );

    yield* Effect.tryPromise(() =>
      engineContext.internalAdapter.linkAccount({
        accountId: "oauth-proof-person",
        providerId: "credential",
        issuer: createLocalAccountIssuer("credential"),
        userId: "oauth-proof-person",
        password: delegatedPasswordHash,
      }),
    );

    const operator = yield* OAuthClientOperator;

    const execution = {
      dryRun: false,
      target,
      authority: "operator",
      requestCorrelation: "oauth-0082-postgres-proof",
    } as const;

    const key = yield* operator.bootstrapSigningKey(execution);

    assert.ok(Predicate.isString(key.keyId));

    const service = yield* operator.provision(
      {
        clientId: "oauth-proof-service",
        name: "OAuth proof service",
        clientKind: "Service",
        redirectUris: [],
        scopes: ["native-api"],
        servicePrincipalId: "oauth-proof-principal",
        servicePrincipalName: "OAuth proof principal",
      },
      execution,
    );

    assert.ok(Predicate.isString(service.clientSecret));

    const resourceServer = yield* operator.provision(
      {
        clientId: "oauth-proof-resource-server",
        name: "OAuth proof resource server",
        clientKind: "ResourceServer",
        redirectUris: [],
        scopes: [],
      },
      execution,
    );

    assert.ok(Predicate.isString(resourceServer.clientSecret));

    const delegated = yield* operator.provision(
      {
        clientId: "oauth-proof-delegated",
        name: "OAuth proof delegated client",
        clientKind: "DelegatedPublic",
        redirectUris: ["http://127.0.0.1:4173/dashboard/oauth/callback"],
        scopes: ["native-api", "offline_access"],
      },
      execution,
    );

    assert.equal(delegated.clientSecret, undefined);

    const requestContext = new IdentityRequestContext({
      requestCorrelation: "oauth-0082-postgres-proof-request",
      sourceIp: "127.0.0.1",
      userAgent: "oauth-0082-postgres-proof",
    });

    const issueServiceToken = Effect.gen(function* () {
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        scope: "native-api",
        resource: "urn:vektorprogrammet:native-api",
      });

      const response = yield* authEngine.oauthHandler(
        new Request("http://127.0.0.1:4173/api/auth/oauth2/token", {
          method: "POST",
          headers: {
            authorization: `Basic ${Buffer.from(`${service.clientId}:${service.clientSecret!}`, "utf8").toString("base64")}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body,
        }),
        requestContext,
      );

      assert.equal(response.status, 200, "service token release must succeed");

      const payload = yield* jsonRecordBody(response);

      assert.ok(Predicate.isString(payload.access_token));
      assert.equal(payload.refresh_token, undefined);

      return payload.access_token;
    });

    const [firstToken, secondToken] = yield* Effect.all([issueServiceToken, issueServiceToken], {
      concurrency: "unbounded",
    });

    assert.notEqual(firstToken, secondToken);

    const authority = yield* OAuthCredentialAuthority;

    const accepted = yield* authority.resolve(
      new Request("http://127.0.0.1:4173/api/proof", {
        headers: { authorization: `Bearer ${firstToken}` },
      }),
      "OAuthServiceBearer",
    );

    assert.equal(accepted._tag, "Accepted");

    if (Predicate.isTagged(accepted, "Accepted")) {
      assert.equal(accepted.mechanism._tag, "OAuthServiceBearer");
      assert.equal(accepted.principal._tag, "ServicePrincipal");

      if (Predicate.isTagged(accepted.principal, "ServicePrincipal")) {
        assert.equal(accepted.principal.servicePrincipalId, "oauth-proof-principal");
      }
    }

    const tracked = yield* pgQuery<{ readonly count: string }>(
      pool,
      "SELECT count(*)::text AS count FROM auth.oauth_access_token_state WHERE client_id = $1",
      [service.clientId],
    );

    assert.equal(tracked.rows[0]?.count, "2");

    const serviceRuleSubjectColumn = yield* pgQuery(
      pool,
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'authz_rules'
          AND column_name = 'subject_service_principal_id'`,
    );

    assert.equal(serviceRuleSubjectColumn.rowCount, 1);

    const introspectionRequest = (token: string): Request =>
      new Request("http://127.0.0.1:4173/api/auth/oauth2/introspect", {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${resourceServer.clientId}:${resourceServer.clientSecret!}`, "utf8").toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token }),
      });

    const activeIntrospection = yield* authEngine.oauthIntrospectionHandler(
      introspectionRequest(firstToken),
      requestContext,
    );

    assert.equal((yield* jsonRecordBody(activeIntrospection)).active, true);

    const revoke = yield* authEngine.oauthHandler(
      new Request("http://127.0.0.1:4173/api/auth/oauth2/revoke", {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${service.clientId}:${service.clientSecret!}`, "utf8").toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token: firstToken }),
      }),
      requestContext,
    );

    assert.equal(revoke.status, 200);

    const revoked = yield* authority.resolve(
      new Request("http://127.0.0.1:4173/api/proof", {
        headers: { authorization: `Bearer ${firstToken}` },
      }),
      "OAuthServiceBearer",
    );

    assert.deepEqual(revoked, CredentialOutcomeSchema.cases.Rejected.make({ reason: "Revoked" }));

    const inactiveIntrospection = yield* authEngine.oauthIntrospectionHandler(
      introspectionRequest(firstToken),
      requestContext,
    );

    assert.deepEqual(yield* Effect.tryPromise(() => inactiveIntrospection.json()), {
      active: false,
    });

    yield* operator.disableServicePrincipal("oauth-proof-principal", execution);

    const disabled = yield* authority.resolve(
      new Request("http://127.0.0.1:4173/api/proof", {
        headers: { authorization: `Bearer ${secondToken}` },
      }),
      "OAuthServiceBearer",
    );

    assert.deepEqual(disabled, CredentialOutcomeSchema.cases.Rejected.make({ reason: "Revoked" }));

    const signInResponse = yield* Effect.tryPromise(() =>
      engine.api.signInEmail({
        body: {
          email: "oauth-proof-person@example.invalid",
          password: delegatedPassword,
        },
        asResponse: true,
      }),
    );

    assert.equal(signInResponse.status, 200);

    const sessionSetCookie = signInResponse.headers
      .getSetCookie()
      .find((value) => value.startsWith("better-auth.session_token="));

    assert.ok(sessionSetCookie !== undefined);

    const sessionCookie = sessionSetCookie.split(";", 1)[0]!;

    const verifier = randomBytes(32).toString("base64url");

    const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");

    const state = randomBytes(32).toString("base64url");

    const authorizeUrl = new URL("http://127.0.0.1:4173/api/auth/oauth2/authorize");

    authorizeUrl.searchParams.set("response_type", "code");

    authorizeUrl.searchParams.set("client_id", delegated.clientId);

    authorizeUrl.searchParams.set("redirect_uri", "http://127.0.0.1:4173/dashboard/oauth/callback");

    authorizeUrl.searchParams.set("state", state);

    authorizeUrl.searchParams.set("code_challenge", challenge);

    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    authorizeUrl.searchParams.set("resource", "urn:vektorprogrammet:native-api");

    authorizeUrl.searchParams.set("scope", "native-api offline_access");

    authorizeUrl.searchParams.set("prompt", "consent");

    const authorizationResponse = yield* authEngine.oauthHandler(
      new Request(authorizeUrl, {
        headers: { cookie: sessionCookie, accept: "application/json" },
      }),
      requestContext,
    );

    assert.equal(authorizationResponse.status, 200);

    const authorizationResult = yield* jsonRecordBody(authorizationResponse);

    assert.equal(authorizationResult.redirect, true);

    assert.ok(Predicate.isString(authorizationResult.url));

    const consentUrl = new URL(authorizationResult.url);

    assert.equal(
      consentUrl.origin + consentUrl.pathname,
      "http://127.0.0.1:4173/dashboard/oauth/consent",
    );

    const oauthQuery = consentUrl.search.slice(1);

    assert.ok(oauthQuery.length > 0 && oauthQuery.length <= 8 * 1024);

    const consentBody = yield* jsonText({
      accept: true,
      scope: "native-api offline_access",
      oauth_query: oauthQuery,
    });

    const consentResponse = yield* authEngine.oauthHandler(
      new Request("http://127.0.0.1:4173/api/auth/oauth2/consent", {
        method: "POST",
        headers: {
          cookie: sessionCookie,
          origin: "http://127.0.0.1:4173",
          accept: "application/json",
          "content-type": "application/json",
        },
        body: consentBody,
      }),
      requestContext,
    );

    assert.equal(consentResponse.status, 200);

    const consentResult = yield* jsonRecordBody(consentResponse);

    assert.equal(consentResult.redirect, true);

    assert.ok(Predicate.isString(consentResult.url));

    const callback = new URL(consentResult.url);

    assert.equal(
      callback.origin + callback.pathname,
      "http://127.0.0.1:4173/dashboard/oauth/callback",
    );

    assert.equal(callback.searchParams.get("state"), state);

    assert.equal(callback.searchParams.get("iss"), "http://127.0.0.1:4173/api/auth");

    const authorizationCode = callback.searchParams.get("code");

    assert.ok(authorizationCode !== null);

    const codeExchange = yield* authEngine.oauthHandler(
      new Request("http://127.0.0.1:4173/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: authorizationCode,
          client_id: delegated.clientId,
          redirect_uri: "http://127.0.0.1:4173/dashboard/oauth/callback",
          code_verifier: verifier,
          resource: "urn:vektorprogrammet:native-api",
        }),
      }),
      requestContext,
    );

    assert.equal(codeExchange.status, 200);

    const delegatedTokens = yield* jsonRecordBody(codeExchange);

    assert.ok(Predicate.isString(delegatedTokens.access_token));

    assert.ok(Predicate.isString(delegatedTokens.refresh_token));

    const delegatedAccepted = yield* authority.resolve(
      new Request("http://127.0.0.1:4173/api/proof", {
        headers: { authorization: `Bearer ${delegatedTokens.access_token}` },
      }),
      "OAuthUserBearer",
    );

    assert.equal(delegatedAccepted._tag, "Accepted");

    if (Predicate.isTagged(delegatedAccepted, "Accepted")) {
      assert.equal(delegatedAccepted.mechanism._tag, "OAuthUserBearer");
      assert.deepEqual(
        delegatedAccepted.principal,
        PrincipalSchema.cases.Person.make({
          personId: PersonId.make("oauth-proof-person"),
        }),
      );
    }

    const delegatedRefreshToken = delegatedTokens.refresh_token;

    const refreshRequest = (): Request =>
      new Request("http://127.0.0.1:4173/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: delegatedRefreshToken,
          client_id: delegated.clientId,
          scope: "native-api offline_access",
          resource: "urn:vektorprogrammet:native-api",
        }),
      });

    const refreshResponses = yield* Effect.all(
      [
        authEngine.oauthHandler(refreshRequest(), requestContext),
        authEngine.oauthHandler(refreshRequest(), requestContext),
      ],
      { concurrency: "unbounded" },
    );

    const refreshDiagnostics = yield* Effect.forEach(
      refreshResponses,
      (response) => Effect.tryPromise(() => response.clone().text()),
      { concurrency: "unbounded" },
    );

    assert.deepEqual(
      refreshResponses.map(({ status }) => status).sort((left, right) => left - right),
      [200, 400],
      refreshDiagnostics.join(" | "),
    );

    const rotatedResponse = refreshResponses.find(({ status }) => status === 200)!;

    const rotatedTokens = yield* jsonRecordBody(rotatedResponse);

    assert.ok(Predicate.isString(rotatedTokens.access_token));

    assert.ok(Predicate.isString(rotatedTokens.refresh_token));

    const replayRevoked = yield* authority.resolve(
      new Request("http://127.0.0.1:4173/api/proof", {
        headers: { authorization: `Bearer ${rotatedTokens.access_token}` },
      }),
      "OAuthUserBearer",
    );

    assert.deepEqual(
      replayRevoked,
      CredentialOutcomeSchema.cases.Rejected.make({ reason: "Revoked" }),
    );

    const family = yield* pgQuery<{ readonly revocation_reason: string | null }>(
      pool,
      `SELECT revocation_reason FROM auth.oauth_refresh_families
        WHERE client_id = $1`,
      [delegated.clientId],
    );

    assert.deepEqual(family.rows, [{ revocation_reason: "refresh-replay" }]);

    const delegatedCredentialEvidence = [
      authorizationCode,
      delegatedTokens.access_token,
      delegatedTokens.refresh_token,
      rotatedTokens.access_token,
      rotatedTokens.refresh_token,
    ];

    const audits = yield* pgQuery<{ readonly details: unknown }>(
      pool,
      "SELECT details FROM auth.oauth_security_audit ORDER BY occurred_at",
    );

    const boundedEvidence = yield* jsonText(audits.rows);

    for (const forbidden of [
      firstToken,
      secondToken,
      service.clientSecret!,
      resourceServer.clientSecret!,
      ...delegatedCredentialEvidence,
    ]) {
      assert.equal(
        boundedEvidence.includes(forbidden),
        false,
        "security audit contained forbidden credential evidence",
      );
    }

    const summary = yield* jsonText({
      serviceCredential: "accepted-then-revoked",
      serviceGrant: "absent",
      concurrentTrackedJtis: 2,
      internalIntrospection: "active-then-inactive",
      delegatedAuthorization: "code-pkce-consent-accepted",
      refreshReplay: "family-and-access-token-revoked",
      redaction: "bounded",
    });

    yield* Effect.sync(() => process.stdout.write(`${summary}\n`));
  });

const program = Effect.gen(function* () {
  const databaseUrl = yield* Config.String("OAUTH_PROOF_PG_URL").pipe(
    Config.withDefault("postgres://postgres@127.0.0.1:45121/oauth_0082_proof"),
  );

  const parsedDatabaseUrl = new URL(databaseUrl);

  assert.ok(
    ["127.0.0.1", "localhost", "::1"].includes(parsedDatabaseUrl.hostname),
    "OAuth proof database must use a loopback host",
  );

  assert.match(
    parsedDatabaseUrl.pathname,
    /(?:proof|test)/u,
    "OAuth proof database name must be disposable",
  );

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* Effect.acquireUseRelease(
    Effect.sync(() => new Pool({ connectionString: databaseUrl, max: 1 })),
    (migrationPool) =>
      Effect.forEach(
        databaseMigrationDefinitions,
        (migration) =>
          path.fromFileUrl(migration.url).pipe(
            Effect.flatMap((file) => fs.readFileString(file)),
            Effect.flatMap((source) => pgQuery(migrationPool, source)),
          ),
        { discard: true },
      ),
    (migrationPool) => Effect.promise(() => migrationPool.end()),
  );

  const config: AuthEngineConfig = {
    postgresUrl: databaseUrl,
    secret: "oauth-0082-disposable-proof-secret-at-least-32-characters",
    oauth: {
      canonicalOrigin: "http://127.0.0.1:4173",
      dashboardOrigin: "http://127.0.0.1:4173",
      nativeApiResource: "urn:vektorprogrammet:native-api",
    },
    trustedOrigins: ["http://127.0.0.1:4173"],
    secureCookies: false,
  };

  yield* trace(parsedDatabaseUrl.pathname.slice(1)).pipe(
    Effect.provide(AuthLive(config).pipe(Layer.provideMerge(AuthPoolLive(config)))),
  );
});

// A set but empty variable is present, not absent: it never selects the default database.
void Effect.runPromise(
  program.pipe(
    Effect.provide(
      Layer.merge(
        TestPlatform,
        ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
      ),
    ),
  ),
).catch((cause: unknown) => {
  process.stderr.write(`${String(cause)}\n`);
  process.exitCode = 1;
});
