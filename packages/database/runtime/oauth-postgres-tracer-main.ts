import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { createLocalAccountIssuer } from "better-auth";
import { IdentityRequestContext } from "@vektorprogrammet/domain/identity";
import { makeAuthEngine, makeAuthPool, type AuthEngineConfig } from "../src/auth-engine.js";
import { databaseMigrationDefinitions } from "../src/migrations.js";
import {
  makeOAuthClientOperatorService,
  makeOAuthCredentialAuthorityService,
  makeOAuthInternalIntrospectionHandler,
  makeOAuthReleaseBarrier,
} from "../src/oauth-live.js";

const databaseUrl =
  process.env.OAUTH_PROOF_PG_URL ?? "postgres://postgres@127.0.0.1:45121/oauth_0082_proof";
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

const migrationPool = new Pool({ connectionString: databaseUrl, max: 1 });
for (const migration of databaseMigrationDefinitions) {
  await migrationPool.query(await readFile(migration.url, "utf8"));
}
await migrationPool.end();

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
const pool = makeAuthPool(config);
const engine = makeAuthEngine(config, pool);
const engineContext = await engine.$context;
await pool.query(
  `INSERT INTO public.person_profiles (person_id, first_name, last_name)
   VALUES ('oauth-proof-person', 'OAuth', 'Proof')`,
);
const delegatedPassword = "oauth-proof-person-password";
const delegatedPasswordHash = await engineContext.password.hash(delegatedPassword);
await engineContext.internalAdapter.createUser(
  {
    id: "oauth-proof-person",
    name: "OAuth Proof",
    email: "oauth-proof-person@example.invalid",
    emailVerified: true,
  },
  { method: "email-password" },
);
await engineContext.internalAdapter.linkAccount({
  accountId: "oauth-proof-person",
  providerId: "credential",
  issuer: createLocalAccountIssuer("credential"),
  userId: "oauth-proof-person",
  password: delegatedPasswordHash,
});
const operator = makeOAuthClientOperatorService(pool, engine);
const execution = {
  dryRun: false,
  target: parsedDatabaseUrl.pathname.slice(1),
  authority: "operator",
  requestCorrelation: "oauth-0082-postgres-proof",
} as const;

const key = await operator.bootstrapSigningKey(execution);
assert.equal(typeof key.keyId, "string");
const service = await operator.provision(
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
assert.equal(typeof service.clientSecret, "string");
const resourceServer = await operator.provision(
  {
    clientId: "oauth-proof-resource-server",
    name: "OAuth proof resource server",
    clientKind: "ResourceServer",
    redirectUris: [],
    scopes: [],
  },
  execution,
);
assert.equal(typeof resourceServer.clientSecret, "string");
const delegated = await operator.provision(
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
const release = makeOAuthReleaseBarrier(engine, pool, config.oauth);
const issueServiceToken = async (): Promise<string> => {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "native-api",
    resource: "urn:vektorprogrammet:native-api",
  });
  const response = await release(
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
  const payload = (await response.json()) as {
    readonly access_token?: unknown;
    readonly refresh_token?: unknown;
  };
  assert.equal(typeof payload.access_token, "string");
  assert.equal(payload.refresh_token, undefined);
  return payload.access_token as string;
};

const [firstToken, secondToken] = await Promise.all([issueServiceToken(), issueServiceToken()]);
assert.notEqual(firstToken, secondToken);
const authority = makeOAuthCredentialAuthorityService(pool, config.oauth);
const accepted = await authority.resolve(
  new Request("http://127.0.0.1:4173/api/proof", {
    headers: { authorization: `Bearer ${firstToken}` },
  }),
  "OAuthServiceBearer",
);
assert.equal(accepted._tag, "Accepted");
if (accepted._tag === "Accepted") {
  assert.equal(accepted.mechanism._tag, "OAuthServiceBearer");
  assert.equal(accepted.principal._tag, "ServicePrincipal");
  if (accepted.principal._tag === "ServicePrincipal") {
    assert.equal(accepted.principal.servicePrincipalId, "oauth-proof-principal");
  }
}
const tracked = await pool.query<{ readonly count: string }>(
  "SELECT count(*)::text AS count FROM auth.oauth_access_token_state WHERE client_id = $1",
  [service.clientId],
);
assert.equal(tracked.rows[0]?.count, "2");
const serviceRuleSubjectColumn = await pool.query(
  `SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'authz_rules'
      AND column_name = 'subject_service_principal_id'`,
);
assert.equal(serviceRuleSubjectColumn.rowCount, 1);

const introspection = makeOAuthInternalIntrospectionHandler(engine, pool);
const introspectionRequest = (token: string): Request =>
  new Request("http://127.0.0.1:4173/api/auth/oauth2/introspect", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${resourceServer.clientId}:${resourceServer.clientSecret!}`, "utf8").toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token }),
  });
const activeIntrospection = await introspection(introspectionRequest(firstToken), requestContext);
assert.equal(((await activeIntrospection.json()) as { readonly active?: unknown }).active, true);

const revoke = await release(
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
const revoked = await authority.resolve(
  new Request("http://127.0.0.1:4173/api/proof", {
    headers: { authorization: `Bearer ${firstToken}` },
  }),
  "OAuthServiceBearer",
);
assert.deepEqual(revoked, { _tag: "Rejected", reason: "Revoked" });
const inactiveIntrospection = await introspection(introspectionRequest(firstToken), requestContext);
assert.deepEqual(await inactiveIntrospection.json(), { active: false });

await operator.disableServicePrincipal("oauth-proof-principal", execution);
const disabled = await authority.resolve(
  new Request("http://127.0.0.1:4173/api/proof", {
    headers: { authorization: `Bearer ${secondToken}` },
  }),
  "OAuthServiceBearer",
);
assert.deepEqual(disabled, { _tag: "Rejected", reason: "Revoked" });

const signInResponse = await engine.api.signInEmail({
  body: {
    email: "oauth-proof-person@example.invalid",
    password: delegatedPassword,
  },
  asResponse: true,
});
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
const authorizationResponse = await release(
  new Request(authorizeUrl, {
    headers: { cookie: sessionCookie, accept: "application/json" },
  }),
  requestContext,
);
assert.equal(authorizationResponse.status, 200);
const authorizationResult = (await authorizationResponse.json()) as {
  readonly redirect?: unknown;
  readonly url?: unknown;
};
assert.equal(authorizationResult.redirect, true);
assert.equal(typeof authorizationResult.url, "string");
const consentUrl = new URL(authorizationResult.url as string);
assert.equal(
  consentUrl.origin + consentUrl.pathname,
  "http://127.0.0.1:4173/dashboard/oauth/consent",
);
const oauthQuery = consentUrl.search.slice(1);
assert.ok(oauthQuery.length > 0 && oauthQuery.length <= 8 * 1024);
const consentResponse = await release(
  new Request("http://127.0.0.1:4173/api/auth/oauth2/consent", {
    method: "POST",
    headers: {
      cookie: sessionCookie,
      origin: "http://127.0.0.1:4173",
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      accept: true,
      scope: "native-api offline_access",
      oauth_query: oauthQuery,
    }),
  }),
  requestContext,
);
assert.equal(consentResponse.status, 200);
const consentResult = (await consentResponse.json()) as {
  readonly redirect?: unknown;
  readonly url?: unknown;
};
assert.equal(consentResult.redirect, true);
assert.equal(typeof consentResult.url, "string");
const callback = new URL(consentResult.url as string);
assert.equal(callback.origin + callback.pathname, "http://127.0.0.1:4173/dashboard/oauth/callback");
assert.equal(callback.searchParams.get("state"), state);
assert.equal(callback.searchParams.get("iss"), "http://127.0.0.1:4173/api/auth");
const authorizationCode = callback.searchParams.get("code");
assert.ok(authorizationCode !== null);
const codeExchange = await release(
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
const delegatedTokens = (await codeExchange.json()) as {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
};
assert.equal(typeof delegatedTokens.access_token, "string");
assert.equal(typeof delegatedTokens.refresh_token, "string");
const delegatedAccepted = await authority.resolve(
  new Request("http://127.0.0.1:4173/api/proof", {
    headers: { authorization: `Bearer ${delegatedTokens.access_token as string}` },
  }),
  "OAuthUserBearer",
);
assert.equal(delegatedAccepted._tag, "Accepted");
if (delegatedAccepted._tag === "Accepted") {
  assert.equal(delegatedAccepted.mechanism._tag, "OAuthUserBearer");
  assert.deepEqual(delegatedAccepted.principal, {
    _tag: "Person",
    personId: "oauth-proof-person",
  });
}
const refreshRequest = (): Request =>
  new Request("http://127.0.0.1:4173/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: delegatedTokens.refresh_token as string,
      client_id: delegated.clientId,
      scope: "native-api offline_access",
      resource: "urn:vektorprogrammet:native-api",
    }),
  });
const refreshResponses = await Promise.all([
  release(refreshRequest(), requestContext),
  release(refreshRequest(), requestContext),
]);
const refreshDiagnostics = await Promise.all(
  refreshResponses.map(async (response) => await response.clone().text()),
);
assert.deepEqual(
  refreshResponses.map(({ status }) => status).sort(),
  [200, 400],
  refreshDiagnostics.join(" | "),
);
const rotatedResponse = refreshResponses.find(({ status }) => status === 200)!;
const rotatedTokens = (await rotatedResponse.json()) as {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
};
assert.equal(typeof rotatedTokens.access_token, "string");
assert.equal(typeof rotatedTokens.refresh_token, "string");
const replayRevoked = await authority.resolve(
  new Request("http://127.0.0.1:4173/api/proof", {
    headers: { authorization: `Bearer ${rotatedTokens.access_token as string}` },
  }),
  "OAuthUserBearer",
);
assert.deepEqual(replayRevoked, { _tag: "Rejected", reason: "Revoked" });
const family = await pool.query<{ readonly revocation_reason: string | null }>(
  `SELECT revocation_reason FROM auth.oauth_refresh_families
    WHERE client_id = $1`,
  [delegated.clientId],
);
assert.deepEqual(family.rows, [{ revocation_reason: "refresh-replay" }]);
const delegatedCredentialEvidence = [
  authorizationCode,
  delegatedTokens.access_token as string,
  delegatedTokens.refresh_token as string,
  rotatedTokens.access_token as string,
  rotatedTokens.refresh_token as string,
];

const audits = await pool.query<{ readonly details: unknown }>(
  "SELECT details FROM auth.oauth_security_audit ORDER BY occurred_at",
);
const boundedEvidence = JSON.stringify(audits.rows);
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

process.stdout.write(
  JSON.stringify({
    serviceCredential: "accepted-then-revoked",
    serviceGrant: "absent",
    concurrentTrackedJtis: 2,
    internalIntrospection: "active-then-inactive",
    delegatedAuthorization: "code-pkce-consent-accepted",
    refreshReplay: "family-and-access-token-revoked",
    redaction: "bounded",
  }) + "\n",
);
await pool.end();
