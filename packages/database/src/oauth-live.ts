import { createHash, randomBytes, randomUUID, timingSafeEqual, webcrypto } from "node:crypto";
import { Context, Schema } from "effect";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  CredentialEvidenceRef,
  ServicePrincipalId,
  type CredentialOutcome,
} from "@vektorprogrammet/domain/authz";
import { PersonId } from "@vektorprogrammet/domain/organization";
import type { IdentityRequestContext } from "@vektorprogrammet/domain/identity";
import {
  NativeAccessTokenClaimsSchema,
  NativeAccessTokenHeaderSchema,
  OAUTH_NATIVE_API_RESOURCE,
  OAUTH_SCOPES,
  OAUTH_REFRESH_TOKEN_PREFIX,
  OAuthClientManifestSchema,
  hashOAuthClientSecret,
  hashOAuthToken,
  oauthIssuer,
  type NativeAccessTokenClaims,
  type OAuthClientKind,
  type OAuthClientManifest,
  type OAuthProviderRuntimeConfig,
} from "./oauth-config.js";

const TOKEN_RESPONSE_LIMIT = 64 * 1024;
const TOKEN_INPUT_LIMIT = 8 * 1024;
const FORM_INPUT_LIMIT = 16 * 1024;
const CLIENT_SECRET_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000;
const REFRESH_INACTIVITY_MS = 7 * 24 * 60 * 60 * 1_000;
const REFRESH_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1_000;

export const DELEGATED_RECEIPT_APPROVAL_PUBLIC_CLIENT = {
  clientId: "vektor-0077-2-delegated-receipt-approval",
  name: "Vektorprogrammet delegated receipt approval tracer",
  clientKind: "DelegatedPublic",
  redirectUris: ["http://127.0.0.1:4173/dashboard/oauth/callback"],
  scopes: ["native-api", "offline_access"],
} as const satisfies OAuthClientManifest;

export type OAuthExpectedMechanism = "OAuthUserBearer" | "OAuthServiceBearer" | "Either";

export interface OAuthCredentialAuthorityService {
  readonly resolve: (
    request: Request,
    expected: OAuthExpectedMechanism,
    now?: Date,
  ) => Promise<CredentialOutcome>;
}

export class OAuthCredentialAuthority extends Context.Service<
  OAuthCredentialAuthority,
  OAuthCredentialAuthorityService
>()("@vektorprogrammet/database/OAuthCredentialAuthority") {}

export interface OAuthOperatorExecution {
  readonly dryRun: boolean;
  readonly target: string;
  readonly authority: string;
  readonly requestCorrelation: string;
}

export interface OAuthProvisionResult {
  readonly clientId: string;
  readonly servicePrincipalId?: string;
  readonly clientSecret?: string;
}

export interface OAuthClientOperatorService {
  readonly provision: (
    manifest: unknown,
    execution: OAuthOperatorExecution,
  ) => Promise<OAuthProvisionResult>;
  readonly rotateSecret: (
    clientId: string,
    execution: OAuthOperatorExecution,
  ) => Promise<{ readonly clientId: string; readonly clientSecret?: string }>;
  readonly disableClient: (clientId: string, execution: OAuthOperatorExecution) => Promise<void>;
  readonly disableServicePrincipal: (
    servicePrincipalId: string,
    execution: OAuthOperatorExecution,
  ) => Promise<void>;
  readonly bootstrapSigningKey: (
    execution: OAuthOperatorExecution,
  ) => Promise<{ readonly keyId?: string }>;
  readonly retireSigningKeys: (execution: OAuthOperatorExecution, now?: Date) => Promise<number>;
}

export class OAuthClientOperator extends Context.Service<
  OAuthClientOperator,
  OAuthClientOperatorService
>()("@vektorprogrammet/database/OAuthClientOperator") {}

interface OAuthEngineBoundary {
  readonly handler: (request: Request) => Promise<Response>;
  readonly $context: Promise<{
    readonly adapter: {
      readonly create: (input: {
        readonly model: string;
        readonly data: Record<string, unknown>;
        readonly forceAllowId?: boolean;
      }) => Promise<Record<string, unknown>>;
    };
  }>;
  readonly api: {
    readonly signJWT: (input: {
      readonly body: { readonly payload: Record<string, unknown> };
    }) => Promise<{ readonly token: string }>;
  };
}

interface TokenStateRow extends QueryResultRow {
  readonly jti: string;
  readonly family_id: string | null;
  readonly client_id: string;
  readonly principal_kind: "Person" | "ServicePrincipal";
  readonly person_id: string | null;
  readonly service_principal_id: string | null;
  readonly session_id: string | null;
  readonly issued_at: Date;
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
  readonly client_kind: OAuthClientKind;
  readonly client_disabled: boolean | null;
  readonly secret_expires_at: Date | null;
  readonly client_scopes: ReadonlyArray<string> | null;
  readonly client_credentials_scopes: ReadonlyArray<string> | null;
  readonly service_state: "Active" | "Disabled" | null;
  readonly session_expires_at: Date | null;
  readonly family_revoked_at: Date | null;
  readonly family_inactivity_expires_at: Date | null;
  readonly family_absolute_expires_at: Date | null;
  readonly consent_live: boolean;
  readonly public_key: string;
  readonly key_alg: string | null;
}

interface DecodedNativeJwt {
  readonly header: typeof NativeAccessTokenHeaderSchema.Type;
  readonly claims: NativeAccessTokenClaims;
  readonly signingInput: Uint8Array;
  readonly signature: Uint8Array;
}

interface ClientAuthorityRow extends QueryResultRow {
  readonly client_id: string;
  readonly client_kind: OAuthClientKind;
  readonly service_principal_id: string | null;
  readonly secret_expires_at: Date | null;
  readonly disabled: boolean | null;
  readonly client_secret: string | null;
  readonly redirect_uris: ReadonlyArray<string>;
  readonly scopes: ReadonlyArray<string> | null;
  readonly client_credentials_scopes: ReadonlyArray<string> | null;
  readonly token_endpoint_auth_method: string | null;
  readonly grant_types: ReadonlyArray<string> | null;
  readonly require_pkce: boolean | null;
}

interface RefreshLookupRow extends QueryResultRow {
  readonly authorization_code_id: string | null;
  readonly client_id: string;
  readonly session_id: string | null;
  readonly user_id: string;
  readonly revoked: Date | null;
  readonly rotated_at: Date | null;
  readonly expires_at: Date;
  readonly family_id: string | null;
}

interface AccessTokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in: number;
  readonly expires_at?: number;
  readonly refresh_token?: string;
  readonly scope?: string;
}

const AccessTokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  expires_in: Schema.Number,
  expires_at: Schema.optional(Schema.Number),
  refresh_token: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
});

const decodeHeaderJson = (text: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(NativeAccessTokenHeaderSchema))(text, {
    onExcessProperty: "error",
  });

const decodeClaimsJson = (text: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(NativeAccessTokenClaimsSchema))(text, {
    onExcessProperty: "error",
  });

const decodeUnknownRecordJson = (text: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
    text,
  );

const decodeTokenResponseJson = (text: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(AccessTokenResponseSchema))(text, {
    onExcessProperty: "error",
  });
const base64UrlBytes = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError("invalid compact JWT segment");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value)
    throw new TypeError("non-canonical compact JWT segment");
  return bytes;
};

const decodeJwt = (token: string): DecodedNativeJwt => {
  if (token.length === 0 || token.length > TOKEN_INPUT_LIMIT) {
    throw new TypeError("bounded bearer required");
  }
  const parts = token.split(".");
  if (parts.length !== 3) throw new TypeError("compact JWT required");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined
  ) {
    throw new TypeError("compact JWT required");
  }
  const header = decodeHeaderJson(new TextDecoder().decode(base64UrlBytes(encodedHeader)));
  const claims = decodeClaimsJson(new TextDecoder().decode(base64UrlBytes(encodedPayload)));
  return {
    header,
    claims,
    signingInput: new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    signature: base64UrlBytes(encodedSignature),
  };
};

const verifyJwtSignature = async (
  decoded: DecodedNativeJwt,
  publicKey: string,
): Promise<boolean> => {
  const publicJwk = decodeUnknownRecordJson(publicKey);
  const verificationKey = await webcrypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    verificationKey,
    decoded.signature,
    decoded.signingInput,
  );
};

const verifyIssuedJwtSignature = async (
  pool: Pool,
  decoded: DecodedNativeJwt,
): Promise<boolean> => {
  const selected = await pool.query<{ readonly public_key: string; readonly alg: string | null }>(
    `SELECT "publicKey" AS public_key, alg FROM auth.jwks WHERE id = $1`,
    [decoded.header.kid],
  );
  const key = selected.rows[0];
  return key !== undefined && key.alg === "ES256" && verifyJwtSignature(decoded, key.public_key);
};
const refreshTokenDigest = (token: string): Promise<string> | undefined => {
  if (
    !token.startsWith(OAUTH_REFRESH_TOKEN_PREFIX) ||
    token.length === OAUTH_REFRESH_TOKEN_PREFIX.length
  ) {
    return undefined;
  }
  return hashOAuthToken(token.slice(OAUTH_REFRESH_TOKEN_PREFIX.length), "refresh_token");
};

const bearerFromRequest = (
  request: Request,
): { readonly token?: string; readonly malformed: boolean } => {
  const value = request.headers.get("authorization");
  if (value === null) return { malformed: false };
  if (value.includes(",")) return { malformed: true };
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u.exec(value);
  return match === null ? { malformed: true } : { token: match[1], malformed: false };
};

const hasBetterAuthCookie = (request: Request): boolean =>
  /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/u.test(request.headers.get("cookie") ?? "");

const constantDigestEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

const selectTokenState = async (
  pool: Pool,
  claims: NativeAccessTokenClaims,
  kid: string,
): Promise<TokenStateRow | undefined> => {
  const result = await pool.query<TokenStateRow>(
    `SELECT state.*, binding.client_kind, binding.secret_expires_at,
            client.disabled AS client_disabled, client.scopes AS client_scopes,
            client."clientCredentialsScopes" AS client_credentials_scopes,
            principal.state AS service_state, session."expiresAt" AS session_expires_at,
            family.revoked_at AS family_revoked_at,
            family.inactivity_expires_at AS family_inactivity_expires_at,
            family.absolute_expires_at AS family_absolute_expires_at,
            CASE WHEN state.principal_kind = 'Person' THEN EXISTS (
              SELECT 1 FROM auth."oauthConsent" consent
              WHERE consent."clientId" = state.client_id
                AND consent."userId" = state.person_id
                AND consent.resources ? $3
                AND consent.scopes ? 'native-api'
                AND ($4 <> 'native-api offline_access' OR consent.scopes ? 'offline_access')
            ) ELSE TRUE END AS consent_live,
            jwks."publicKey" AS public_key, jwks.alg AS key_alg
       FROM auth.oauth_access_token_state state
       JOIN auth.oauth_client_bindings binding ON binding.client_id = state.client_id
       JOIN auth."oauthClient" client ON client."clientId" = state.client_id
       JOIN auth.jwks jwks ON jwks.id = $2
       LEFT JOIN public.service_principals principal
         ON principal.service_principal_id = state.service_principal_id
       LEFT JOIN auth."session" session ON session.id = state.session_id
       LEFT JOIN auth.oauth_refresh_families family ON family.family_id = state.family_id
      WHERE state.jti = $1`,
    [claims.jti, kid, OAUTH_NATIVE_API_RESOURCE, claims.scope],
  );
  return result.rows[0];
};

const canonicalClientScopes = (
  kind: OAuthClientKind,
  values: ReadonlyArray<string> | null,
  clientCredentials: ReadonlyArray<string> | null,
): boolean => {
  if (kind === "Service") {
    return (
      values?.length === 1 &&
      values[0] === "native-api" &&
      clientCredentials?.length === 1 &&
      clientCredentials[0] === "native-api"
    );
  }
  if (kind === "ResourceServer") return values?.length === 0 && clientCredentials?.length === 0;
  return (
    clientCredentials?.length === 0 &&
    ((values?.length === 1 && values[0] === "native-api") ||
      (values?.length === 2 && values[0] === "native-api" && values[1] === "offline_access"))
  );
};

export const makeOAuthCredentialAuthorityService = (
  pool: Pool,
  config: OAuthProviderRuntimeConfig,
): OAuthCredentialAuthorityService => ({
  resolve: async (request, expected, now = new Date()) => {
    const bearer = bearerFromRequest(request);
    if (bearer.malformed) return { _tag: "Rejected", reason: "Malformed" };
    if (bearer.token === undefined) return { _tag: "Rejected", reason: "Missing" };
    if (hasBetterAuthCookie(request)) return { _tag: "Rejected", reason: "AmbiguousMechanism" };

    let decoded: DecodedNativeJwt;
    try {
      decoded = decodeJwt(bearer.token);
    } catch {
      return { _tag: "Rejected", reason: "Malformed" };
    }
    if (decoded.claims.iss !== oauthIssuer(config)) {
      return { _tag: "Rejected", reason: "Invalid" };
    }
    if (decoded.claims.client_id !== decoded.claims.azp) {
      return { _tag: "Rejected", reason: "Invalid" };
    }
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    if (decoded.claims.iat > nowSeconds || decoded.claims.exp <= decoded.claims.iat) {
      return { _tag: "Rejected", reason: "Invalid" };
    }

    let state: TokenStateRow | undefined;
    try {
      state = await selectTokenState(pool, decoded.claims, decoded.header.kid);
      if (state === undefined || state.key_alg !== "ES256") {
        return { _tag: "Rejected", reason: "Invalid" };
      }
      const signatureValid = await verifyJwtSignature(decoded, state.public_key);
      if (!signatureValid) return { _tag: "Rejected", reason: "Invalid" };
    } catch {
      return { _tag: "Rejected", reason: "Invalid" };
    }

    const immutableClaimsMatch =
      state.client_id === decoded.claims.client_id &&
      Math.floor(state.issued_at.getTime() / 1_000) === decoded.claims.iat &&
      Math.floor(state.expires_at.getTime() / 1_000) === decoded.claims.exp;
    if (
      !immutableClaimsMatch ||
      !canonicalClientScopes(
        state.client_kind,
        state.client_scopes,
        state.client_credentials_scopes,
      )
    ) {
      return { _tag: "Rejected", reason: "Invalid" };
    }
    if (decoded.claims.exp <= nowSeconds || state.expires_at.getTime() <= now.getTime()) {
      return { _tag: "Rejected", reason: "Expired" };
    }
    if (
      state.revoked_at !== null ||
      state.family_revoked_at !== null ||
      state.client_disabled === true ||
      (state.secret_expires_at !== null && state.secret_expires_at.getTime() <= now.getTime()) ||
      (state.family_inactivity_expires_at !== null &&
        state.family_inactivity_expires_at.getTime() <= now.getTime()) ||
      (state.family_absolute_expires_at !== null &&
        state.family_absolute_expires_at.getTime() <= now.getTime())
    ) {
      return { _tag: "Rejected", reason: "Revoked" };
    }

    const evidenceRef = CredentialEvidenceRef.make(
      `oauth:${state.principal_kind}:${state.jti}:${state.client_id}:${decoded.claims.iat}`,
    );
    if (state.client_kind === "DelegatedPublic" || state.client_kind === "DelegatedConfidential") {
      if (
        expected === "OAuthServiceBearer" ||
        state.principal_kind !== "Person" ||
        state.person_id !== decoded.claims.sub ||
        state.session_id === null ||
        decoded.claims.sid !== state.session_id ||
        state.session_expires_at === null ||
        state.session_expires_at.getTime() <= now.getTime() ||
        !state.consent_live ||
        (decoded.claims.scope !== "native-api" &&
          decoded.claims.scope !== "native-api offline_access")
      ) {
        return {
          _tag: "Rejected",
          reason: expected === "OAuthServiceBearer" ? "WrongMechanism" : "Revoked",
        };
      }
      return {
        _tag: "Accepted",
        mechanism: { _tag: "OAuthUserBearer" },
        principal: { _tag: "Person", personId: PersonId.make(state.person_id) },
        evidenceRef,
      };
    }

    if (
      state.client_kind !== "Service" ||
      expected === "OAuthUserBearer" ||
      state.principal_kind !== "ServicePrincipal" ||
      state.service_principal_id === null ||
      state.service_state !== "Active" ||
      decoded.claims.sub !== state.client_id ||
      decoded.claims.sid !== undefined ||
      decoded.claims.scope !== "native-api"
    ) {
      return {
        _tag: "Rejected",
        reason: expected === "OAuthUserBearer" ? "WrongMechanism" : "Revoked",
      };
    }
    return {
      _tag: "Accepted",
      mechanism: { _tag: "OAuthServiceBearer" },
      principal: {
        _tag: "ServicePrincipal",
        servicePrincipalId: ServicePrincipalId.make(state.service_principal_id),
      },
      evidenceRef,
    };
  },
});

const inTransaction = async <A>(
  pool: Pool,
  use: (client: PoolClient) => Promise<A>,
): Promise<A> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await use(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

const sanitizedRequestContext = (
  context: IdentityRequestContext,
): {
  readonly correlation: string;
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
} => ({
  correlation: context.requestCorrelation.slice(0, 160),
  sourceIp:
    context.sourceIp !== null &&
    context.sourceIp.length <= 64 &&
    /^[A-Fa-f0-9.:]+$/u.test(context.sourceIp)
      ? context.sourceIp
      : null,
  userAgent:
    context.userAgent !== null &&
    context.userAgent.length <= 512 &&
    /^[\x20-\x7e]+$/u.test(context.userAgent)
      ? context.userAgent
      : null,
});

const appendAudit = async (
  client: PoolClient,
  input: {
    readonly eventKind: string;
    readonly clientId?: string;
    readonly familyId?: string;
    readonly jti?: string;
    readonly personId?: string;
    readonly servicePrincipalId?: string;
    readonly actorPrincipal: string;
    readonly requestCorrelation: string;
    readonly sourceIp?: string | null;
    readonly userAgent?: string | null;
    readonly details?: Readonly<Record<string, unknown>>;
  },
): Promise<void> => {
  await client.query(
    `INSERT INTO auth.oauth_security_audit (
       event_id, occurred_at, event_kind, client_id, family_id, jti,
       subject_person_id, subject_service_principal_id, actor_principal,
       request_correlation, source_ip, user_agent, details
     ) VALUES ($1, CURRENT_TIMESTAMP, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
    [
      randomUUID(),
      input.eventKind,
      input.clientId ?? null,
      input.familyId ?? null,
      input.jti ?? null,
      input.personId ?? null,
      input.servicePrincipalId ?? null,
      input.actorPrincipal.slice(0, 160),
      input.requestCorrelation.slice(0, 160),
      input.sourceIp ?? null,
      input.userAgent ?? null,
      JSON.stringify(input.details ?? {}),
    ],
  );
};

const validateRedirect = (value: string): void => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("redirect URI must be absolute");
  }
  if (url.toString() !== value || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new TypeError("redirect URI contains a forbidden or non-canonical component");
  }
  const fixedLoopback = url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "";
  if (url.protocol !== "https:" && !fixedLoopback) {
    throw new TypeError("redirect URI must use https or fixed-port http://127.0.0.1");
  }
};

const validateManifest = (input: unknown): OAuthClientManifest => {
  const manifest = Schema.decodeUnknownSync(OAuthClientManifestSchema)(input, {
    onExcessProperty: "error",
  });
  if (
    !/^[A-Za-z0-9._~-]{1,128}$/u.test(manifest.clientId) ||
    manifest.name.trim() !== manifest.name ||
    manifest.name.length === 0 ||
    manifest.name.length > 160
  ) {
    throw new TypeError("client identifier or name is invalid");
  }
  if (new Set(manifest.redirectUris).size !== manifest.redirectUris.length) {
    throw new TypeError("redirect URIs must be unique");
  }
  for (const redirect of manifest.redirectUris) validateRedirect(redirect);
  const delegated =
    manifest.clientKind === "DelegatedPublic" || manifest.clientKind === "DelegatedConfidential";
  const scopesCanonical =
    manifest.scopes.length === 1 && manifest.scopes[0] === "native-api"
      ? true
      : manifest.scopes.length === 2 &&
        manifest.scopes[0] === "native-api" &&
        manifest.scopes[1] === "offline_access";
  if (delegated !== manifest.redirectUris.length > 0 || (delegated && !scopesCanonical)) {
    throw new TypeError("delegated client redirects or scopes are invalid");
  }
  if (
    manifest.clientKind === "Service" &&
    !(
      manifest.redirectUris.length === 0 &&
      manifest.scopes.length === 1 &&
      manifest.scopes[0] === "native-api" &&
      manifest.servicePrincipalId !== undefined &&
      manifest.servicePrincipalName !== undefined
    )
  ) {
    throw new TypeError("service client manifest is invalid");
  }
  if (
    manifest.clientKind === "ResourceServer" &&
    !(
      manifest.redirectUris.length === 0 &&
      manifest.scopes.length === 0 &&
      manifest.servicePrincipalId === undefined &&
      manifest.servicePrincipalName === undefined
    )
  ) {
    throw new TypeError("resource-server client manifest is invalid");
  }
  if (
    manifest.clientKind !== "Service" &&
    (manifest.servicePrincipalId !== undefined || manifest.servicePrincipalName !== undefined)
  ) {
    throw new TypeError("only a service client can bind a service principal");
  }
  if (
    manifest.servicePrincipalId !== undefined &&
    !/^[A-Za-z0-9._~-]{1,128}$/u.test(manifest.servicePrincipalId)
  ) {
    throw new TypeError("service-principal identifier is invalid");
  }
  if (
    manifest.servicePrincipalName !== undefined &&
    (manifest.servicePrincipalName.trim() !== manifest.servicePrincipalName ||
      manifest.servicePrincipalName.length === 0 ||
      manifest.servicePrincipalName.length > 160)
  ) {
    throw new TypeError("service-principal name is invalid");
  }
  return manifest;
};

const requireOperatorExecution = (execution: OAuthOperatorExecution): void => {
  if (execution.target.trim().length === 0 || execution.authority !== "operator") {
    throw new TypeError("an explicit target and operator authority are required");
  }
  if (
    execution.requestCorrelation.trim().length === 0 ||
    execution.requestCorrelation.length > 160
  ) {
    throw new TypeError("bounded request correlation is required");
  }
};

const clientProviderShape = (
  manifest: OAuthClientManifest,
  storedSecret: string | null,
  now: Date,
): Record<string, unknown> => {
  const delegated =
    manifest.clientKind === "DelegatedPublic" || manifest.clientKind === "DelegatedConfidential";
  return {
    clientId: manifest.clientId,
    clientSecret: storedSecret,
    disabled: false,
    skipConsent: false,
    enableEndSession: false,
    subjectType: "public",
    scopes: [...manifest.scopes],
    clientCredentialsScopes: manifest.clientKind === "Service" ? ["native-api"] : [],
    userId: null,
    createdAt: now,
    updatedAt: now,
    name: manifest.name,
    redirectUris: [...manifest.redirectUris],
    tokenEndpointAuthMethod:
      manifest.clientKind === "DelegatedPublic" ? "none" : "client_secret_basic",
    applicationType: manifest.clientKind === "DelegatedPublic" ? "native" : "web",
    grantTypes: delegated
      ? ["authorization_code", "refresh_token"]
      : manifest.clientKind === "Service"
        ? ["client_credentials"]
        : [],
    responseTypes: delegated ? ["code"] : [],
    requirePKCE: delegated,
    dpopBoundAccessTokens: false,
    metadata: null,
  };
};

export const makeOAuthClientOperatorService = (
  pool: Pool,
  engine: OAuthEngineBoundary,
): OAuthClientOperatorService => ({
  provision: async (unsafeManifest, execution) => {
    requireOperatorExecution(execution);
    const manifest = validateManifest(unsafeManifest);
    if (execution.dryRun) {
      return {
        clientId: manifest.clientId,
        ...(manifest.servicePrincipalId === undefined
          ? {}
          : { servicePrincipalId: manifest.servicePrincipalId }),
      };
    }
    const confidential = manifest.clientKind !== "DelegatedPublic";
    const rawSecret = confidential ? randomBytes(32).toString("base64url") : undefined;
    const clientSecret = rawSecret === undefined ? undefined : `vkr_cs_${rawSecret}`;
    const storedSecret = rawSecret === undefined ? null : await hashOAuthClientSecret(rawSecret);
    const now = new Date();
    const context = await engine.$context;
    await context.adapter.create({
      model: "oauthClient",
      data: clientProviderShape(manifest, storedSecret, now),
    });
    await context.adapter.create({
      model: "oauthClientResource",
      data: {
        clientId: manifest.clientId,
        resourceId: OAUTH_NATIVE_API_RESOURCE,
        createdAt: now,
      },
    });
    await inTransaction(pool, async (client) => {
      if (manifest.clientKind === "Service") {
        await client.query(
          `INSERT INTO public.service_principals (
             service_principal_id, name, state, revision, created_at, updated_at
           ) VALUES ($1, $2, 'Active', 0, $3, $3)`,
          [manifest.servicePrincipalId, manifest.servicePrincipalName, now],
        );
      }
      await client.query(
        `INSERT INTO auth.oauth_client_bindings (
           client_id, client_kind, service_principal_id, secret_expires_at,
           revision, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 0, $5, $5)`,
        [
          manifest.clientId,
          manifest.clientKind,
          manifest.servicePrincipalId ?? null,
          confidential ? new Date(now.getTime() + CLIENT_SECRET_LIFETIME_MS) : null,
          now,
        ],
      );
      await appendAudit(client, {
        eventKind: "oauth-client-provisioned",
        clientId: manifest.clientId,
        servicePrincipalId: manifest.servicePrincipalId,
        actorPrincipal: "operator",
        requestCorrelation: execution.requestCorrelation,
        details: { client_kind: manifest.clientKind, resource: OAUTH_NATIVE_API_RESOURCE },
      });
    });
    return {
      clientId: manifest.clientId,
      ...(manifest.servicePrincipalId === undefined
        ? {}
        : { servicePrincipalId: manifest.servicePrincipalId }),
      ...(clientSecret === undefined ? {} : { clientSecret }),
    };
  },
  rotateSecret: async (clientId, execution) => {
    requireOperatorExecution(execution);
    if (execution.dryRun) return { clientId };
    const rawSecret = randomBytes(32).toString("base64url");
    const secret = `vkr_cs_${rawSecret}`;
    const digest = await hashOAuthClientSecret(rawSecret);
    await inTransaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [clientId]);
      const updated = await client.query(
        `UPDATE auth."oauthClient" provider
            SET "clientSecret" = $2, "updatedAt" = CURRENT_TIMESTAMP
           FROM auth.oauth_client_bindings binding
          WHERE provider."clientId" = $1
            AND binding.client_id = provider."clientId"
            AND binding.client_kind <> 'DelegatedPublic'
            AND COALESCE(provider.disabled, false) = false`,
        [clientId, digest],
      );
      if (updated.rowCount !== 1) throw new Error("live confidential client not found");
      await client.query(
        `UPDATE auth.oauth_client_bindings
            SET secret_expires_at = CURRENT_TIMESTAMP + interval '90 days',
                revision = revision + 1,
                updated_at = CURRENT_TIMESTAMP
          WHERE client_id = $1`,
        [clientId],
      );
      await appendAudit(client, {
        eventKind: "oauth-client-secret-rotated",
        clientId,
        actorPrincipal: "operator",
        requestCorrelation: execution.requestCorrelation,
      });
    });
    return { clientId, clientSecret: secret };
  },
  disableClient: async (clientId, execution) => {
    requireOperatorExecution(execution);
    if (execution.dryRun) return;
    await inTransaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [clientId]);
      const updated = await client.query(
        `UPDATE auth."oauthClient" SET disabled = true, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "clientId" = $1 AND COALESCE(disabled, false) = false`,
        [clientId],
      );
      if (updated.rowCount !== 1) throw new Error("live OAuth client not found");
      await client.query(
        `UPDATE auth.oauth_access_token_state SET revoked_at = CURRENT_TIMESTAMP,
           revocation_reason = 'client-disabled'
         WHERE client_id = $1 AND revoked_at IS NULL`,
        [clientId],
      );
      await client.query(
        `UPDATE auth.oauth_refresh_families SET revoked_at = CURRENT_TIMESTAMP,
           revocation_reason = 'client-disabled'
         WHERE client_id = $1 AND revoked_at IS NULL`,
        [clientId],
      );
      await appendAudit(client, {
        eventKind: "oauth-client-disabled",
        clientId,
        actorPrincipal: "operator",
        requestCorrelation: execution.requestCorrelation,
      });
    });
  },
  disableServicePrincipal: async (servicePrincipalId, execution) => {
    requireOperatorExecution(execution);
    if (execution.dryRun) return;
    await inTransaction(pool, async (client) => {
      const selected = await client.query<{ readonly client_id: string }>(
        `SELECT client_id FROM auth.oauth_client_bindings
          WHERE service_principal_id = $1 FOR UPDATE`,
        [servicePrincipalId],
      );
      const binding = selected.rows[0];
      if (binding === undefined) throw new Error("service-principal binding not found");
      await client.query(
        `UPDATE public.service_principals
            SET state = 'Disabled', revision = revision + 1, updated_at = CURRENT_TIMESTAMP
          WHERE service_principal_id = $1 AND state = 'Active'`,
        [servicePrincipalId],
      );
      await client.query(
        `UPDATE auth."oauthClient" SET disabled = true, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "clientId" = $1`,
        [binding.client_id],
      );
      await client.query(
        `UPDATE auth.oauth_access_token_state
            SET revoked_at = CURRENT_TIMESTAMP, revocation_reason = 'service-principal-disabled'
          WHERE service_principal_id = $1 AND revoked_at IS NULL`,
        [servicePrincipalId],
      );
      await appendAudit(client, {
        eventKind: "oauth-service-principal-disabled",
        clientId: binding.client_id,
        servicePrincipalId,
        actorPrincipal: "operator",
        requestCorrelation: execution.requestCorrelation,
      });
    });
  },
  bootstrapSigningKey: async (execution) => {
    requireOperatorExecution(execution);
    const selected = await pool.query<{ readonly id: string }>(
      `SELECT id FROM auth.jwks
        WHERE COALESCE(alg, '') = 'ES256'
          AND ("expiresAt" IS NULL OR "expiresAt" > CURRENT_TIMESTAMP)
        ORDER BY "createdAt" DESC`,
    );
    if (selected.rows.length > 1) throw new Error("multiple active ES256 signing keys");
    if (selected.rows[0] !== undefined) return { keyId: selected.rows[0].id };
    if (execution.dryRun) return {};
    await engine.api.signJWT({
      body: { payload: { sub: "oauth-signing-key-bootstrap", aud: OAUTH_NATIVE_API_RESOURCE } },
    });
    const created = await pool.query<{ readonly id: string }>(
      `SELECT id FROM auth.jwks
        WHERE COALESCE(alg, '') = 'ES256'
          AND ("expiresAt" IS NULL OR "expiresAt" > CURRENT_TIMESTAMP)
        ORDER BY "createdAt" DESC`,
    );
    if (created.rows.length !== 1)
      throw new Error("signing key bootstrap did not create exactly one key");
    const keyId = created.rows[0]!.id;
    await inTransaction(pool, (client) =>
      appendAudit(client, {
        eventKind: "oauth-signing-key-rotated",
        actorPrincipal: "operator",
        requestCorrelation: execution.requestCorrelation,
        details: { key_id: keyId },
      }),
    );
    return { keyId };
  },
  retireSigningKeys: async (execution, now = new Date()) => {
    requireOperatorExecution(execution);
    if (execution.dryRun) return 0;
    const result = await pool.query(
      `DELETE FROM auth.jwks
        WHERE "expiresAt" IS NOT NULL
          AND "expiresAt" + interval '15 minutes' <= $1`,
      [now],
    );
    return result.rowCount ?? 0;
  },
});

const readClientAuthority = async (
  pool: Pool,
  clientId: string,
): Promise<ClientAuthorityRow | undefined> => {
  const result = await pool.query<ClientAuthorityRow>(
    `SELECT binding.client_id, binding.client_kind, binding.service_principal_id,
            binding.secret_expires_at, client.disabled, client."clientSecret" AS client_secret,
            client."redirectUris" AS redirect_uris, client.scopes,
            client."clientCredentialsScopes" AS client_credentials_scopes,
            client."tokenEndpointAuthMethod" AS token_endpoint_auth_method,
            client."grantTypes" AS grant_types, client."requirePKCE" AS require_pkce
       FROM auth.oauth_client_bindings binding
       JOIN auth."oauthClient" client ON client."clientId" = binding.client_id
      WHERE binding.client_id = $1`,
    [clientId],
  );
  return result.rows[0];
};

const basicClientCredential = (
  request: Request,
): { readonly clientId: string; readonly secret: string } | undefined => {
  const value = request.headers.get("authorization");
  if (value === null || !value.startsWith("Basic ") || value.includes(",")) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(value.slice(6), "base64").toString("utf8");
  } catch {
    return undefined;
  }
  const separator = decoded.indexOf(":");
  if (separator <= 0) return undefined;
  return {
    clientId: decodeURIComponent(decoded.slice(0, separator)),
    secret: decodeURIComponent(decoded.slice(separator + 1)),
  };
};

const authorizeTokenClient = async (
  pool: Pool,
  request: Request,
  form: URLSearchParams,
  now: Date,
): Promise<ClientAuthorityRow | undefined> => {
  const basic = basicClientCredential(request);
  const formClientId = form.get("client_id");
  const clientId = basic?.clientId ?? formClientId;
  if (clientId === null || clientId === undefined) return undefined;
  const client = await readClientAuthority(pool, clientId);
  if (
    client === undefined ||
    client.disabled === true ||
    (client.secret_expires_at !== null && client.secret_expires_at.getTime() <= now.getTime())
  ) {
    return undefined;
  }
  if (client.client_kind === "DelegatedPublic") {
    if (basic !== undefined || client.token_endpoint_auth_method !== "none") return undefined;
  } else {
    if (
      basic === undefined ||
      !basic.secret.startsWith("vkr_cs_") ||
      client.token_endpoint_auth_method !== "client_secret_basic" ||
      client.client_secret === null ||
      !constantDigestEqual(
        await hashOAuthClientSecret(basic.secret.slice("vkr_cs_".length)),
        client.client_secret,
      )
    ) {
      return undefined;
    }
  }
  return client;
};

export const authorizeOAuthIntrospectionClient = async (
  pool: Pool,
  request: Request,
  now = new Date(),
): Promise<boolean> => {
  const basic = basicClientCredential(request);
  if (basic === undefined) return false;
  const client = await readClientAuthority(pool, basic.clientId);
  if (
    client === undefined ||
    client.client_kind !== "ResourceServer" ||
    client.disabled === true ||
    client.token_endpoint_auth_method !== "client_secret_basic" ||
    client.client_secret === null ||
    client.secret_expires_at === null ||
    client.secret_expires_at.getTime() <= now.getTime() ||
    client.scopes?.length !== 0 ||
    !basic.secret.startsWith("vkr_cs_") ||
    !constantDigestEqual(
      await hashOAuthClientSecret(basic.secret.slice("vkr_cs_".length)),
      client.client_secret,
    )
  ) {
    return false;
  }
  const linked = await pool.query(
    `SELECT 1 FROM auth."oauthClientResource"
      WHERE "clientId" = $1 AND "resourceId" = $2`,
    [client.client_id, OAUTH_NATIVE_API_RESOURCE],
  );
  return linked.rowCount === 1;
};

const inactiveIntrospectionResponse = (): Response =>
  Response.json(
    { active: false },
    { status: 200, headers: { "cache-control": "no-store", pragma: "no-cache" } },
  );

export const makeOAuthInternalIntrospectionHandler =
  (
    engine: OAuthEngineBoundary,
    pool: Pool,
  ): ((request: Request, context: IdentityRequestContext) => Promise<Response>) =>
  async (request, context) => {
    const pathname = new URL(request.url).pathname;
    if (request.method !== "POST" || pathname !== "/api/auth/oauth2/introspect") {
      return new Response("Not Found", { status: 404 });
    }
    const reject = async (reason: string): Promise<Response> => {
      await inTransaction(pool, (transaction) =>
        appendAudit(transaction, {
          eventKind: "oauth-introspection-rejected",
          actorPrincipal: "resource-server",
          requestCorrelation: context.requestCorrelation,
          sourceIp: sanitizedRequestContext(context).sourceIp,
          userAgent: sanitizedRequestContext(context).userAgent,
          details: { denial_category: reason },
        }),
      ).catch(() => undefined);
      return inactiveIntrospectionResponse();
    };
    if (
      request.headers.get("cookie") !== null ||
      request.headers.get("content-type")?.split(";", 1)[0] !== "application/x-www-form-urlencoded"
    ) {
      return reject("invalid-request");
    }
    const body = await request.clone().text();
    if (new TextEncoder().encode(body).byteLength > FORM_INPUT_LIMIT) {
      return reject("input-limit");
    }
    if (!(await authorizeOAuthIntrospectionClient(pool, request))) {
      return reject("invalid-client");
    }
    const provider = await boundedProviderResponse(await engine.handler(request));
    const parsed = decodeUnknownRecordJson(provider.body);
    if (
      parsed.active !== true ||
      typeof parsed.jti !== "string" ||
      typeof parsed.client_id !== "string" ||
      typeof parsed.sub !== "string" ||
      typeof parsed.scope !== "string"
    ) {
      return inactiveIntrospectionResponse();
    }
    const tracked = await pool.query(
      `SELECT 1
         FROM auth.oauth_access_token_state state
         JOIN auth.oauth_client_bindings binding ON binding.client_id = state.client_id
         JOIN auth."oauthClient" client ON client."clientId" = state.client_id
         LEFT JOIN public.service_principals principal
           ON principal.service_principal_id = state.service_principal_id
         LEFT JOIN auth."session" session ON session.id = state.session_id
         LEFT JOIN auth.oauth_refresh_families family ON family.family_id = state.family_id
        WHERE state.jti = $1
          AND state.client_id = $2
          AND state.revoked_at IS NULL
          AND state.issued_at <= CURRENT_TIMESTAMP
          AND CURRENT_TIMESTAMP < state.expires_at
          AND COALESCE(client.disabled, false) = false
          AND (binding.secret_expires_at IS NULL OR CURRENT_TIMESTAMP < binding.secret_expires_at)
          AND EXISTS (
            SELECT 1 FROM auth."oauthClientResource" linked
             WHERE linked."clientId" = state.client_id
               AND linked."resourceId" = $5
          )
          AND (
            (binding.client_kind = 'Service' AND $6 = 'native-api')
            OR
            (binding.client_kind IN ('DelegatedPublic', 'DelegatedConfidential')
             AND $6 IN ('native-api', 'native-api offline_access'))
          )
          AND (
            (state.principal_kind = 'Person'
             AND state.person_id = $3
             AND state.session_id IS NOT DISTINCT FROM $4
             AND session.id IS NOT NULL
             AND CURRENT_TIMESTAMP < session."expiresAt"
             AND EXISTS (
               SELECT 1 FROM auth."oauthConsent" consent
                WHERE consent."clientId" = state.client_id
                  AND consent."userId" = state.person_id
             )
             AND (family.family_id IS NULL OR (
               family.revoked_at IS NULL
               AND CURRENT_TIMESTAMP < family.inactivity_expires_at
               AND CURRENT_TIMESTAMP < family.absolute_expires_at
             )))
            OR
            (state.principal_kind = 'ServicePrincipal'
             AND state.service_principal_id IS NOT NULL
             AND principal.state = 'Active'
             AND state.client_id = $3
             AND $4::text IS NULL)
          )`,
      [
        parsed.jti,
        parsed.client_id,
        parsed.sub,
        typeof parsed.sid === "string" ? parsed.sid : null,
        OAUTH_NATIVE_API_RESOURCE,
        parsed.scope,
      ],
    );
    if (tracked.rowCount !== 1) return inactiveIntrospectionResponse();
    const allowed = [
      "active",
      "client_id",
      "token_type",
      "scope",
      "sub",
      "aud",
      "iss",
      "exp",
      "iat",
      "jti",
      "sid",
    ] as const;
    const bounded: Record<string, unknown> = {};
    for (const name of allowed) {
      if (parsed[name] !== undefined) bounded[name] = parsed[name];
    }
    return Response.json(bounded, {
      status: 200,
      headers: { "cache-control": "no-store", pragma: "no-cache" },
    });
  };

const invalidOAuthResponse = (status: number, error: string): Response =>
  Response.json(
    { error },
    {
      status,
      headers: { "cache-control": "no-store", pragma: "no-cache" },
    },
  );

const boundedProviderResponse = async (
  response: Response,
): Promise<{ readonly response: Response; readonly body: string }> => {
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > TOKEN_RESPONSE_LIMIT) {
    throw new Error("provider response exceeded release barrier limit");
  }
  return {
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    body,
  };
};

const withSessionAdvisoryLock = async <A>(
  pool: Pool,
  key: string,
  use: (client: PoolClient) => Promise<A>,
): Promise<A> => {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
    return await use(client);
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key])
      .catch(() => undefined);
    client.release();
  }
};

const insertIssuedToken = async (
  transaction: PoolClient,
  claims: NativeAccessTokenClaims,
  client: ClientAuthorityRow,
  familyId: string | null,
  context: IdentityRequestContext,
): Promise<void> => {
  const requestContext = sanitizedRequestContext(context);
  await transaction.query(
    `INSERT INTO auth.oauth_access_token_state (
         jti, family_id, client_id, principal_kind, person_id,
         service_principal_id, session_id, issued_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8), to_timestamp($9))`,
    [
      claims.jti,
      familyId,
      claims.client_id,
      client.client_kind === "Service" ? "ServicePrincipal" : "Person",
      client.client_kind === "Service" ? null : claims.sub,
      client.client_kind === "Service" ? client.service_principal_id : null,
      claims.sid ?? null,
      claims.iat,
      claims.exp,
    ],
  );
  await appendAudit(transaction, {
    eventKind: "oauth-token-issued",
    clientId: claims.client_id,
    familyId: familyId ?? undefined,
    jti: claims.jti,
    personId: client.client_kind === "Service" ? undefined : claims.sub,
    servicePrincipalId:
      client.client_kind === "Service" ? (client.service_principal_id ?? undefined) : undefined,
    actorPrincipal:
      client.client_kind === "Service"
        ? `service:${client.service_principal_id}`
        : `person:${claims.sub}`,
    requestCorrelation: requestContext.correlation,
    sourceIp: requestContext.sourceIp,
    userAgent: requestContext.userAgent,
    details: {
      credential_kind: client.client_kind === "Service" ? "OAuthServiceBearer" : "OAuthUserBearer",
      resource: OAUTH_NATIVE_API_RESOURCE,
      scopes: claims.scope.split(" "),
    },
  });
};

const initialCodeExchange = async (
  engine: OAuthEngineBoundary,
  pool: Pool,
  request: Request,
  form: URLSearchParams,
  client: ClientAuthorityRow,
  context: IdentityRequestContext,
  config: OAuthProviderRuntimeConfig,
): Promise<Response> => {
  const code = form.get("code");
  if (code === null) return invalidOAuthResponse(400, "invalid_request");
  const codeDigest = await hashOAuthToken(code, "authorization_code");
  return withSessionAdvisoryLock(pool, `oauth-code:${codeDigest}`, async () => {
    const replay = await pool.query<{ readonly family_id: string }>(
      `SELECT family_id FROM auth.oauth_refresh_families WHERE authorization_code_id = $1`,
      [codeDigest],
    );
    if (replay.rows[0] !== undefined) {
      await inTransaction(pool, async (transaction) => {
        await transaction.query(
          `UPDATE auth.oauth_refresh_families SET revoked_at = CURRENT_TIMESTAMP,
             revocation_reason = 'code-replay'
           WHERE family_id = $1 AND revoked_at IS NULL`,
          [replay.rows[0]!.family_id],
        );
        await transaction.query(
          `UPDATE auth.oauth_access_token_state SET revoked_at = CURRENT_TIMESTAMP,
             revocation_reason = 'code-replay'
           WHERE family_id = $1 AND revoked_at IS NULL`,
          [replay.rows[0]!.family_id],
        );
        await appendAudit(transaction, {
          eventKind: "oauth-authorization-code-replay",
          clientId: client.client_id,
          familyId: replay.rows[0]!.family_id,
          actorPrincipal: "oauth-client",
          requestCorrelation: context.requestCorrelation,
        });
      });
      return invalidOAuthResponse(400, "invalid_grant");
    }
    const buffered = await boundedProviderResponse(await engine.handler(request));
    if (!buffered.response.ok) return buffered.response;
    const tokenResponse = decodeTokenResponseJson(buffered.body) as AccessTokenResponse;
    const decoded = decodeJwt(tokenResponse.access_token);
    if (
      !(await verifyIssuedJwtSignature(pool, decoded)) ||
      decoded.claims.iss !== oauthIssuer(config) ||
      decoded.claims.client_id !== client.client_id ||
      decoded.claims.aud !== OAUTH_NATIVE_API_RESOURCE ||
      decoded.claims.sid === undefined ||
      decoded.claims.exp - decoded.claims.iat !== 600
    ) {
      throw new Error("provider issued a token outside the delegated contract");
    }
    const familyId = randomUUID();
    const now = new Date(decoded.claims.iat * 1_000);
    const absolute = new Date(now.getTime() + REFRESH_ABSOLUTE_MS);
    const inactivity = new Date(
      Math.min(now.getTime() + REFRESH_INACTIVITY_MS, absolute.getTime()),
    );
    await inTransaction(pool, async (transaction) => {
      await transaction.query(
        `INSERT INTO auth.oauth_refresh_families (
           family_id, authorization_code_id, client_id, person_id, session_id,
           created_at, last_used_at, inactivity_expires_at, absolute_expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8)`,
        [
          familyId,
          codeDigest,
          client.client_id,
          decoded.claims.sub,
          decoded.claims.sid,
          now,
          inactivity,
          absolute,
        ],
      );
      await insertIssuedToken(transaction, decoded.claims, client, familyId, context);
    });
    return buffered.response;
  });
};

const refreshExchange = async (
  engine: OAuthEngineBoundary,
  pool: Pool,
  request: Request,
  form: URLSearchParams,
  client: ClientAuthorityRow,
  context: IdentityRequestContext,
  config: OAuthProviderRuntimeConfig,
): Promise<Response> => {
  const refreshToken = form.get("refresh_token");
  if (refreshToken === null) return invalidOAuthResponse(400, "invalid_request");
  const digest = await refreshTokenDigest(refreshToken);
  if (digest === undefined) return invalidOAuthResponse(400, "invalid_grant");
  const before = await pool.query<RefreshLookupRow>(
    `SELECT token."authorizationCodeId" AS authorization_code_id,
            token."clientId" AS client_id, token."sessionId" AS session_id,
            token."userId" AS user_id, token.revoked, token."rotatedAt" AS rotated_at,
            token."expiresAt" AS expires_at, family.family_id
       FROM auth."oauthRefreshToken" token
       LEFT JOIN auth.oauth_refresh_families family
         ON family.authorization_code_id = token."authorizationCodeId"
      WHERE token.token = $1`,
    [digest],
  );
  const lookup = before.rows[0];
  if (lookup === undefined || lookup.authorization_code_id === null || lookup.family_id === null) {
    return invalidOAuthResponse(400, "invalid_grant");
  }
  return withSessionAdvisoryLock(pool, `oauth-family:${lookup.authorization_code_id}`, async () => {
    const reread = await pool.query<RefreshLookupRow>(
      `SELECT token."authorizationCodeId" AS authorization_code_id,
              token."clientId" AS client_id, token."sessionId" AS session_id,
              token."userId" AS user_id, token.revoked, token."rotatedAt" AS rotated_at,
              token."expiresAt" AS expires_at, family.family_id
         FROM auth."oauthRefreshToken" token
         LEFT JOIN auth.oauth_refresh_families family
           ON family.authorization_code_id = token."authorizationCodeId"
        WHERE token.token = $1`,
      [digest],
    );
    const current = reread.rows[0];
    const family = await pool.query<{
      readonly revoked_at: Date | null;
      readonly inactivity_expires_at: Date;
      readonly absolute_expires_at: Date;
    }>(
      `SELECT revoked_at, inactivity_expires_at, absolute_expires_at
         FROM auth.oauth_refresh_families WHERE family_id = $1`,
      [lookup.family_id],
    );
    const state = family.rows[0];
    const now = new Date();
    if (
      state === undefined ||
      current === undefined ||
      current.family_id !== lookup.family_id ||
      state.revoked_at !== null ||
      current.rotated_at !== null ||
      current.revoked !== null ||
      current.expires_at.getTime() <= now.getTime() ||
      state.inactivity_expires_at.getTime() <= now.getTime() ||
      state.absolute_expires_at.getTime() <= now.getTime()
    ) {
      await inTransaction(pool, async (transaction) => {
        await transaction.query(
          `UPDATE auth.oauth_refresh_families SET revoked_at = CURRENT_TIMESTAMP,
             revocation_reason = 'refresh-replay'
           WHERE family_id = $1 AND revoked_at IS NULL`,
          [lookup.family_id],
        );
        await transaction.query(
          `UPDATE auth.oauth_access_token_state SET revoked_at = CURRENT_TIMESTAMP,
             revocation_reason = 'refresh-replay'
           WHERE family_id = $1 AND revoked_at IS NULL`,
          [lookup.family_id],
        );
        await appendAudit(transaction, {
          eventKind: "oauth-refresh-replay",
          clientId: client.client_id,
          familyId: lookup.family_id!,
          actorPrincipal: "oauth-client",
          requestCorrelation: context.requestCorrelation,
        });
      });
      return invalidOAuthResponse(400, "invalid_grant");
    }
    const buffered = await boundedProviderResponse(await engine.handler(request));
    if (!buffered.response.ok) return buffered.response;
    const tokenResponse = decodeTokenResponseJson(buffered.body) as AccessTokenResponse;
    const decoded = decodeJwt(tokenResponse.access_token);
    if (
      !(await verifyIssuedJwtSignature(pool, decoded)) ||
      decoded.claims.iss !== oauthIssuer(config) ||
      decoded.claims.client_id !== client.client_id ||
      decoded.claims.sub !== current.user_id ||
      decoded.claims.sid !== current.session_id ||
      decoded.claims.exp - decoded.claims.iat !== 600
    ) {
      throw new Error("provider issued a token outside the refresh contract");
    }
    await inTransaction(pool, async (transaction) => {
      await transaction.query(
        `UPDATE auth.oauth_refresh_families
            SET last_used_at = to_timestamp($2),
                inactivity_expires_at = LEAST(to_timestamp($2) + interval '7 days', absolute_expires_at)
          WHERE family_id = $1 AND revoked_at IS NULL`,
        [lookup.family_id, decoded.claims.iat],
      );
      await insertIssuedToken(transaction, decoded.claims, client, lookup.family_id, context);
    });
    return buffered.response;
  });
};

const serviceExchange = async (
  engine: OAuthEngineBoundary,
  pool: Pool,
  request: Request,
  client: ClientAuthorityRow,
  context: IdentityRequestContext,
  config: OAuthProviderRuntimeConfig,
): Promise<Response> => {
  const buffered = await boundedProviderResponse(await engine.handler(request));
  if (!buffered.response.ok) return buffered.response;
  const tokenResponse = decodeTokenResponseJson(buffered.body) as AccessTokenResponse;
  if (tokenResponse.refresh_token !== undefined)
    throw new Error("service token response contained refresh token");
  const decoded = decodeJwt(tokenResponse.access_token);
  if (
    !(await verifyIssuedJwtSignature(pool, decoded)) ||
    client.client_kind !== "Service" ||
    decoded.claims.iss !== oauthIssuer(config) ||
    decoded.claims.client_id !== client.client_id ||
    decoded.claims.sub !== client.client_id ||
    decoded.claims.sid !== undefined ||
    decoded.claims.scope !== "native-api" ||
    decoded.claims.exp - decoded.claims.iat !== 300
  ) {
    throw new Error("provider issued a token outside the service contract");
  }
  await inTransaction(pool, (transaction) =>
    insertIssuedToken(transaction, decoded.claims, client, null, context),
  );
  return buffered.response;
};

const handleToken = async (
  engine: OAuthEngineBoundary,
  pool: Pool,
  request: Request,
  context: IdentityRequestContext,
  config: OAuthProviderRuntimeConfig,
): Promise<Response> => {
  if (request.headers.get("cookie") !== null) return invalidOAuthResponse(400, "invalid_request");
  if (
    request.headers.get("content-type")?.split(";", 1)[0] !== "application/x-www-form-urlencoded"
  ) {
    return invalidOAuthResponse(400, "invalid_request");
  }
  const body = await request.clone().text();
  if (new TextEncoder().encode(body).byteLength > FORM_INPUT_LIMIT) {
    return invalidOAuthResponse(400, "invalid_request");
  }
  const form = new URLSearchParams(body);
  if (form.getAll("resource").length !== 1 || form.get("resource") !== OAUTH_NATIVE_API_RESOURCE) {
    return invalidOAuthResponse(400, "invalid_target");
  }
  const grantType = form.get("grant_type");
  const client = await authorizeTokenClient(pool, request, form, new Date());
  if (client === undefined) return invalidOAuthResponse(401, "invalid_client");
  if (grantType === "authorization_code") {
    if (
      client.client_kind !== "DelegatedPublic" &&
      client.client_kind !== "DelegatedConfidential"
    ) {
      return invalidOAuthResponse(400, "unauthorized_client");
    }
    const redirect = form.get("redirect_uri");
    if (redirect === null || !client.redirect_uris.some((registered) => registered === redirect)) {
      return invalidOAuthResponse(400, "invalid_grant");
    }
    return initialCodeExchange(engine, pool, request, form, client, context, config);
  }
  if (grantType === "refresh_token") {
    if (
      client.client_kind !== "DelegatedPublic" &&
      client.client_kind !== "DelegatedConfidential"
    ) {
      return invalidOAuthResponse(400, "unauthorized_client");
    }
    const scope = form.get("scope");
    if (scope !== null && scope !== "native-api" && scope !== "native-api offline_access") {
      return invalidOAuthResponse(400, "invalid_scope");
    }
    return refreshExchange(engine, pool, request, form, client, context, config);
  }
  if (grantType === "client_credentials") {
    if (client.client_kind !== "Service" || form.get("scope") !== "native-api") {
      return invalidOAuthResponse(400, "unauthorized_client");
    }
    return serviceExchange(engine, pool, request, client, context, config);
  }
  return invalidOAuthResponse(400, "unsupported_grant_type");
};

const handleRevocation = async (
  engine: OAuthEngineBoundary,
  pool: Pool,
  request: Request,
  context: IdentityRequestContext,
): Promise<Response> => {
  if (
    request.headers.get("cookie") !== null ||
    request.headers.get("content-type")?.split(";", 1)[0] !== "application/x-www-form-urlencoded"
  ) {
    return invalidOAuthResponse(400, "invalid_request");
  }
  const body = await request.clone().text();
  if (new TextEncoder().encode(body).byteLength > FORM_INPUT_LIMIT) {
    return invalidOAuthResponse(400, "invalid_request");
  }
  const form = new URLSearchParams(body);
  const token = form.get("token");
  if (token === null) return invalidOAuthResponse(400, "invalid_request");
  const client = await authorizeTokenClient(pool, request, form, new Date());
  if (client === undefined) return invalidOAuthResponse(401, "invalid_client");
  if (token.split(".").length === 3) {
    let decoded: DecodedNativeJwt;
    try {
      decoded = decodeJwt(token);
      if (!(await verifyIssuedJwtSignature(pool, decoded))) {
        return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
      }
    } catch {
      return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
    }
    await inTransaction(pool, async (transaction) => {
      const updated = await transaction.query<{ readonly family_id: string | null }>(
        `UPDATE auth.oauth_access_token_state
            SET revoked_at = CURRENT_TIMESTAMP, revocation_reason = 'explicit-access-token'
          WHERE jti = $1 AND client_id = $2 AND revoked_at IS NULL
          RETURNING family_id`,
        [decoded.claims.jti, client.client_id],
      );
      if (updated.rows[0] !== undefined) {
        await appendAudit(transaction, {
          eventKind: "oauth-access-token-revoked",
          clientId: client.client_id,
          familyId: updated.rows[0].family_id ?? undefined,
          jti: decoded.claims.jti,
          actorPrincipal: "oauth-client",
          requestCorrelation: context.requestCorrelation,
        });
      }
    });
    return new Response(null, {
      status: 200,
      headers: { "cache-control": "no-store", pragma: "no-cache" },
    });
  }
  const refreshDigest = await refreshTokenDigest(token);
  if (refreshDigest === undefined) {
    return new Response(null, {
      status: 200,
      headers: { "cache-control": "no-store", pragma: "no-cache" },
    });
  }
  await inTransaction(pool, async (transaction) => {
    const family = await transaction.query<{ readonly family_id: string }>(
      `SELECT family.family_id
         FROM auth.oauth_refresh_families family
         JOIN auth."oauthRefreshToken" refresh
           ON refresh."authorizationCodeId" = family.authorization_code_id
        WHERE refresh.token = $1
          AND family.client_id = $2
        FOR UPDATE OF family`,
      [refreshDigest, client.client_id],
    );
    const owned = family.rows[0];
    if (owned === undefined) return;
    await transaction.query(
      `UPDATE auth.oauth_refresh_families
          SET revoked_at = CURRENT_TIMESTAMP, revocation_reason = 'explicit-refresh-token'
        WHERE family_id = $1 AND revoked_at IS NULL`,
      [owned.family_id],
    );
    await transaction.query(
      `UPDATE auth.oauth_access_token_state
          SET revoked_at = CURRENT_TIMESTAMP, revocation_reason = 'explicit-refresh-token'
        WHERE family_id = $1 AND revoked_at IS NULL`,
      [owned.family_id],
    );
    await appendAudit(transaction, {
      eventKind: "oauth-refresh-family-revoked",
      clientId: client.client_id,
      familyId: owned.family_id,
      actorPrincipal: "oauth-client",
      requestCorrelation: context.requestCorrelation,
    });
  });
  const response = await engine.handler(request);
  if (!response.ok) throw new Error("provider refresh revocation failed after owned revocation");
  response.headers.set("cache-control", "no-store");
  response.headers.set("pragma", "no-cache");
  return response;
};

const handleConsentWithdrawal = async (
  engine: OAuthEngineBoundary,
  pool: Pool,
  request: Request,
  context: IdentityRequestContext,
): Promise<Response> => {
  const body = (await request
    .clone()
    .json()
    .catch(() => undefined)) as { readonly id?: unknown } | undefined;
  if (typeof body?.id !== "string") return invalidOAuthResponse(400, "invalid_request");
  const session = await engine.handler(
    new Request(new URL("/api/auth/get-session", request.url), {
      headers: { cookie: request.headers.get("cookie") ?? "" },
    }),
  );
  if (!session.ok) return invalidOAuthResponse(401, "invalid_request");
  const sessionBody = (await session.json()) as { readonly user?: { readonly id?: unknown } };
  if (typeof sessionBody.user?.id !== "string") return invalidOAuthResponse(401, "invalid_request");
  const consent = await pool.query<{ readonly client_id: string }>(
    `SELECT "clientId" AS client_id FROM auth."oauthConsent"
      WHERE id = $1 AND "userId" = $2`,
    [body.id, sessionBody.user.id],
  );
  const owned = consent.rows[0];
  if (owned === undefined) return invalidOAuthResponse(404, "invalid_request");
  await inTransaction(pool, async (transaction) => {
    const families = await transaction.query<{ readonly family_id: string }>(
      `UPDATE auth.oauth_refresh_families
          SET revoked_at = CURRENT_TIMESTAMP, revocation_reason = 'consent-withdrawn'
        WHERE client_id = $1 AND person_id = $2 AND revoked_at IS NULL
        RETURNING family_id`,
      [owned.client_id, sessionBody.user!.id],
    );
    await transaction.query(
      `UPDATE auth.oauth_access_token_state
          SET revoked_at = CURRENT_TIMESTAMP, revocation_reason = 'consent-withdrawn'
        WHERE client_id = $1 AND person_id = $2 AND revoked_at IS NULL`,
      [owned.client_id, sessionBody.user!.id],
    );
    await appendAudit(transaction, {
      eventKind: "oauth-consent-withdrawn",
      clientId: owned.client_id,
      personId: sessionBody.user!.id as string,
      actorPrincipal: `person:${sessionBody.user!.id}`,
      requestCorrelation: context.requestCorrelation,
      details: { affected_count: families.rowCount ?? 0 },
    });
  });
  const response = await engine.handler(request);
  if (!response.ok) throw new Error("provider consent cleanup failed after owned revocation");
  return response;
};
const handlePublicClient = async (
  engine: OAuthEngineBoundary,
  pool: Pool,
  request: Request,
): Promise<Response> => {
  const clientId = new URL(request.url).searchParams.get("client_id");
  if (clientId === null) return invalidOAuthResponse(400, "invalid_request");
  const client = await readClientAuthority(pool, clientId);
  if (
    client === undefined ||
    (client.client_kind !== "DelegatedPublic" && client.client_kind !== "DelegatedConfidential")
  ) {
    return invalidOAuthResponse(404, "invalid_request");
  }
  const buffered = await boundedProviderResponse(await engine.handler(request));
  if (!buffered.response.ok) return buffered.response;
  const provider = decodeUnknownRecordJson(buffered.body);
  if (
    provider.client_id !== clientId ||
    typeof provider.client_name !== "string" ||
    provider.client_name.length === 0 ||
    provider.client_name.length > 160
  ) {
    throw new Error("provider returned a malformed public client");
  }
  const headers = new Headers(buffered.response.headers);
  headers.set("cache-control", "no-store");
  headers.set("pragma", "no-cache");
  headers.set("content-type", "application/json; charset=utf-8");
  return Response.json(
    {
      client_id: clientId,
      client_name: provider.client_name,
      client_kind: client.client_kind,
    },
    { status: buffered.response.status, headers },
  );
};

export const makeOAuthReleaseBarrier =
  (
    engine: OAuthEngineBoundary,
    pool: Pool,
    config: OAuthProviderRuntimeConfig,
  ): ((request: Request, context: IdentityRequestContext) => Promise<Response>) =>
  async (request, context) => {
    const pathname = new URL(request.url).pathname;
    try {
      if (request.method === "GET" && pathname === "/api/auth/oauth2/public-client") {
        return await handlePublicClient(engine, pool, request);
      }
      if (request.method === "POST" && pathname === "/api/auth/oauth2/token") {
        return await handleToken(engine, pool, request, context, config);
      }
      if (request.method === "POST" && pathname === "/api/auth/oauth2/revoke") {
        return await handleRevocation(engine, pool, request, context);
      }
      if (request.method === "POST" && pathname === "/api/auth/oauth2/delete-consent") {
        return await handleConsentWithdrawal(engine, pool, request, context);
      }
      const response = await engine.handler(request);
      if (pathname === "/api/auth/jwks" && response.ok) {
        const body = await response.text();
        const etag = `"${createHash("sha256").update(body, "utf8").digest("base64url")}"`;
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: {
            ...Object.fromEntries(response.headers),
            "cache-control": "public, max-age=300, must-revalidate",
            etag,
          },
        });
      }
      if (pathname.startsWith("/api/auth/oauth2/")) {
        response.headers.set("cache-control", "no-store");
        response.headers.set("pragma", "no-cache");
      }
      return response;
    } catch {
      return Response.json(
        { error: "temporarily_unavailable" },
        {
          status: 503,
          headers: { "cache-control": "no-store", pragma: "no-cache" },
        },
      );
    }
  };

export const exactRedirectAccepted = async (
  pool: Pool,
  clientId: string,
  redirectUri: string,
  now = new Date(),
): Promise<boolean> => {
  const client = await readClientAuthority(pool, clientId);
  if (
    client === undefined ||
    client.disabled === true ||
    (client.client_kind !== "DelegatedPublic" && client.client_kind !== "DelegatedConfidential") ||
    client.require_pkce !== true ||
    client.grant_types?.join(" ") !== "authorization_code refresh_token" ||
    (client.secret_expires_at !== null && client.secret_expires_at.getTime() <= now.getTime()) ||
    !client.redirect_uris.some((registered) => registered === redirectUri)
  ) {
    return false;
  }
  const linked = await pool.query(
    `SELECT 1 FROM auth."oauthClientResource"
      WHERE "clientId" = $1 AND "resourceId" = $2`,
    [clientId, OAUTH_NATIVE_API_RESOURCE],
  );
  return linked.rowCount === 1;
};

export const verifyOAuthBootState = async (
  pool: Pool,
  config: OAuthProviderRuntimeConfig,
  requireSigningKey = true,
): Promise<void> => {
  if (config.nativeApiResource !== OAUTH_NATIVE_API_RESOURCE)
    throw new Error("OAuth resource drift");
  const resources = await pool.query<{
    readonly identifier: string;
    readonly name: string;
    readonly access_token_ttl: number | null;
    readonly refresh_token_ttl: number | null;
    readonly signing_algorithm: string | null;
    readonly allowed_scopes: ReadonlyArray<string> | null;
    readonly dpop_required: boolean | null;
    readonly disabled: boolean | null;
  }>(
    `SELECT identifier, name, "accessTokenTtl" AS access_token_ttl,
            "refreshTokenTtl" AS refresh_token_ttl,
            "signingAlgorithm" AS signing_algorithm,
            "allowedScopes" AS allowed_scopes,
            "dpopBoundAccessTokensRequired" AS dpop_required, disabled
       FROM auth."oauthResource" WHERE identifier = $1`,
    [OAUTH_NATIVE_API_RESOURCE],
  );
  const resource = resources.rows[0];
  if (
    resource === undefined ||
    resource.name !== "Vektorprogrammet native API" ||
    resource.access_token_ttl !== 600 ||
    resource.refresh_token_ttl !== 604800 ||
    resource.signing_algorithm !== "ES256" ||
    resource.allowed_scopes?.join(" ") !== OAUTH_SCOPES.join(" ") ||
    resource.dpop_required !== false ||
    resource.disabled === true
  ) {
    throw new Error("OAuth resource row drift");
  }
  if (!requireSigningKey) return;
  const keys = await pool.query<{
    readonly id: string;
    readonly private_key: string;
    readonly alg: string | null;
    readonly expires_at: Date | null;
  }>(
    `SELECT id, "privateKey" AS private_key, alg, "expiresAt" AS expires_at
       FROM auth.jwks
      WHERE ("expiresAt" IS NULL OR "expiresAt" > CURRENT_TIMESTAMP)
      ORDER BY "createdAt" DESC`,
  );
  if (
    keys.rows.length !== 1 ||
    keys.rows[0]!.alg !== "ES256" ||
    keys.rows[0]!.private_key.trim().startsWith("{")
  ) {
    throw new Error("OAuth signing-key state is invalid");
  }
};
