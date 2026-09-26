import type { AuthEngine } from "./auth-engine.js";
import {
  DatabasePgPool,
  pgQuery,
  pgTransaction,
  pgWithClient,
  type PgQueryError,
} from "./pg-pool.js";
import { NativeAuthEngine } from "./auth-engine.js";
import {
  CredentialOutcomeSchema,
  CredentialMechanismSchema,
  PrincipalSchema,
} from "@vektorprogrammet/domain/authz";
import { createHash, randomBytes, randomUUID, timingSafeEqual, webcrypto } from "node:crypto";
import {
  Types,
  flow,
  Layer,
  Predicate,
  Context,
  Data,
  DateTime,
  Effect,
  Result,
  Schema,
} from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  CredentialEvidenceRef,
  ServicePrincipalId,
  type CredentialOutcome,
} from "@vektorprogrammet/domain/authz";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { Database } from "./service.js";
import type { IdentityRequestContext } from "@vektorprogrammet/domain/identity";
import {
  NativeAccessTokenClaimsSchema,
  NativeAccessTokenHeaderSchema,
  OAUTH_NATIVE_API_RESOURCE,
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
    now?: DateTime.Utc,
  ) => Effect.Effect<CredentialOutcome>;
  /**
   * Resolves current bearer state through the ambient Effect SQL transaction.
   * Native mutations use this path so token/client/session revocation and the
   * protected write observe one database snapshot.
   */
  readonly resolveInTransaction: (
    request: Request,
    expected: OAuthExpectedMechanism,
    now?: DateTime.Utc,
  ) => Effect.Effect<CredentialOutcome, never, Database>;
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

/** An operator command that failed before or while it changed OAuth client state. */
export class OAuthClientOperatorError extends Data.TaggedError("OAuthClientOperatorError")<{
  readonly operation: keyof OAuthClientOperatorService;
  readonly message: string;
  readonly cause: unknown;
}> {}

/**
 * An OAuth protocol exchange that could not complete inside the contract this module enforces: a
 * provider answer, token, or key outside it, or an unreadable request or provider body.
 */
export class OAuthExchangeFailure extends Data.TaggedError("OAuthExchangeFailure")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The frozen external OAuth protocol surface. It answers every failure itself, with 503. */
export type OAuthReleaseHandler = (
  request: Request,
  context: IdentityRequestContext,
) => Effect.Effect<Response>;

/** The independent internal-only OAuth introspection surface. */
export type OAuthIntrospectionHandler = (
  request: Request,
  context: IdentityRequestContext,
) => Effect.Effect<Response, OAuthExchangeFailure | PgQueryError | Schema.SchemaError>;

export interface OAuthClientOperatorService {
  readonly provision: (
    manifest: OAuthClientManifest,
    execution: OAuthOperatorExecution,
  ) => Effect.Effect<OAuthProvisionResult, OAuthClientOperatorError>;
  readonly rotateSecret: (
    clientId: string,
    execution: OAuthOperatorExecution,
  ) => Effect.Effect<
    { readonly clientId: string; readonly clientSecret?: string },
    OAuthClientOperatorError
  >;
  readonly disableClient: (
    clientId: string,
    execution: OAuthOperatorExecution,
  ) => Effect.Effect<void, OAuthClientOperatorError>;
  readonly disableServicePrincipal: (
    servicePrincipalId: string,
    execution: OAuthOperatorExecution,
  ) => Effect.Effect<void, OAuthClientOperatorError>;
  readonly bootstrapSigningKey: (
    execution: OAuthOperatorExecution,
  ) => Effect.Effect<{ readonly keyId?: string }, OAuthClientOperatorError>;
  readonly retireSigningKeys: (
    execution: OAuthOperatorExecution,
    now?: DateTime.Utc,
  ) => Effect.Effect<number, OAuthClientOperatorError>;
}

export class OAuthClientOperator extends Context.Service<
  OAuthClientOperator,
  OAuthClientOperatorService
>()("@vektorprogrammet/database/OAuthClientOperator") {}

type OAuthEngineBoundary = Pick<AuthEngine, "handler" | "$context"> & {
  readonly api: Pick<AuthEngine["api"], "signJWT">;
};

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

const AccessTokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  expires_in: Schema.Finite,
  expires_at: Schema.optional(Schema.Finite),
  refresh_token: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
});

const decodeHeaderJson = (text: string) =>
  Schema.decodeSync(Schema.fromJsonString(NativeAccessTokenHeaderSchema))(text, {
    onExcessProperty: "error",
  });

const decodeClaimsJson = (text: string) =>
  Schema.decodeSync(Schema.fromJsonString(NativeAccessTokenClaimsSchema))(text, {
    onExcessProperty: "error",
  });

const decodeUnknownRecordJson = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

const decodeTokenResponseJson = Schema.decodeEffect(
  Schema.fromJsonString(AccessTokenResponseSchema),
  { onExcessProperty: "error" },
);

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

/** Decodes a provider-issued compact JWT; a token outside the native shape fails the exchange. */
const decodeIssuedJwt = (token: string) =>
  Effect.try({
    try: () => decodeJwt(token),
    catch: (cause) =>
      new OAuthExchangeFailure({ message: "provider issued a malformed token", cause }),
  });

const verifyJwtSignature = (decoded: DecodedNativeJwt, publicKey: string) =>
  Effect.gen(function* () {
    const publicJwk = yield* decodeUnknownRecordJson(publicKey);

    const verificationKey = yield* Effect.tryPromise({
      try: () =>
        webcrypto.subtle.importKey(
          "jwk",
          publicJwk,
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["verify"],
        ),
      catch: (cause) => new OAuthExchangeFailure({ message: "signing key is unusable", cause }),
    });

    return yield* Effect.tryPromise({
      try: () =>
        webcrypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          verificationKey,
          decoded.signature,
          decoded.signingInput,
        ),
      catch: (cause) => new OAuthExchangeFailure({ message: "signature check failed", cause }),
    });
  });

const verifyIssuedJwtSignature = (pool: Pool, decoded: DecodedNativeJwt) =>
  Effect.gen(function* () {
    const selected = yield* pgQuery<{ readonly public_key: string; readonly alg: string | null }>(
      pool,
      `SELECT "publicKey" AS public_key, alg FROM auth.jwks WHERE id = $1`,
      [decoded.header.kid],
    );

    const key = selected.rows[0];

    if (key === undefined || key.alg !== "ES256") return false;

    return yield* verifyJwtSignature(decoded, key.public_key);
  });

const refreshTokenDigest = (token: string): string | undefined => {
  if (
    !token.startsWith(OAUTH_REFRESH_TOKEN_PREFIX) ||
    token.length === OAUTH_REFRESH_TOKEN_PREFIX.length
  ) {
    return undefined;
  }

  return hashOAuthToken(token.slice(OAUTH_REFRESH_TOKEN_PREFIX.length), "refresh_token");
};

const bearerFromRequest = (request: Request) => {
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

const selectTokenState = (pool: Pool, claims: NativeAccessTokenClaims, kid: string) =>
  pgQuery<TokenStateRow>(
    pool,
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
       LEFT JOIN auth.usable_human_sessions session ON session.id = state.session_id
       LEFT JOIN auth.oauth_refresh_families family ON family.family_id = state.family_id
      WHERE state.jti = $1`,
    [claims.jti, kid, OAUTH_NATIVE_API_RESOURCE, claims.scope],
  ).pipe(Effect.map((result) => result.rows[0]));

const selectTokenStateInTransaction = (
  claims: NativeAccessTokenClaims,
  kid: string,
): Effect.Effect<TokenStateRow | undefined, SqlError, Database> =>
  Database.use((sql) =>
    sql<TokenStateRow>`
      SELECT state.*, binding.client_kind, binding.secret_expires_at,
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
                 AND consent.resources ? ${OAUTH_NATIVE_API_RESOURCE}
                 AND consent.scopes ? 'native-api'
                 AND (${claims.scope} <> 'native-api offline_access'
                   OR consent.scopes ? 'offline_access')
             ) ELSE TRUE END AS consent_live,
             jwks."publicKey" AS public_key, jwks.alg AS key_alg
        FROM auth.oauth_access_token_state state
        JOIN auth.oauth_client_bindings binding ON binding.client_id = state.client_id
        JOIN auth."oauthClient" client ON client."clientId" = state.client_id
        JOIN auth.jwks jwks ON jwks.id = ${kid}
        LEFT JOIN public.service_principals principal
          ON principal.service_principal_id = state.service_principal_id
        LEFT JOIN auth.usable_human_sessions session ON session.id = state.session_id
        LEFT JOIN auth.oauth_refresh_families family ON family.family_id = state.family_id
       WHERE state.jti = ${claims.jti}
    `.pipe(Effect.map((rows) => rows[0])),
  );

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

type TokenStateLookup<E, R> = (
  claims: NativeAccessTokenClaims,
  kid: string,
) => Effect.Effect<TokenStateRow | undefined, E, R>;

const resolveOAuthCredential = <E, R>(
  request: Request,
  expected: OAuthExpectedMechanism,
  now: DateTime.Utc,
  lookup: TokenStateLookup<E, R>,
  config: OAuthProviderRuntimeConfig,
): Effect.Effect<CredentialOutcome, never, R> =>
  Effect.gen(function* () {
    const bearer = bearerFromRequest(request);

    if (bearer.malformed)
      return CredentialOutcomeSchema.cases.Rejected.make({ reason: "Malformed" });

    if (bearer.token === undefined)
      return CredentialOutcomeSchema.cases.Rejected.make({ reason: "Missing" });

    if (hasBetterAuthCookie(request)) {
      return CredentialOutcomeSchema.cases.Rejected.make({ reason: "AmbiguousMechanism" });
    }

    const token = bearer.token;
    const decodedJwt = Result.try(() => decodeJwt(token));

    if (Result.isFailure(decodedJwt)) {
      return CredentialOutcomeSchema.cases.Rejected.make({ reason: "Malformed" });
    }

    const decoded = decodedJwt.success;

    if (
      decoded.claims.iss !== oauthIssuer(config) ||
      decoded.claims.client_id !== decoded.claims.azp
    ) {
      return CredentialOutcomeSchema.cases.Rejected.make({ reason: "Invalid" });
    }

    const nowMillis = DateTime.toEpochMillis(now);
    const nowSeconds = Math.floor(nowMillis / 1_000);

    if (decoded.claims.iat > nowSeconds || decoded.claims.exp <= decoded.claims.iat) {
      return CredentialOutcomeSchema.cases.Rejected.make({ reason: "Invalid" });
    }

    const state = yield* lookup(decoded.claims, decoded.header.kid).pipe(
      Effect.catch(() => Effect.undefined),
    );

    if (state === undefined || state.key_alg !== "ES256") {
      return CredentialOutcomeSchema.cases.Rejected.make({ reason: "Invalid" });
    }

    const signatureValid = yield* verifyJwtSignature(decoded, state.public_key).pipe(
      Effect.orElseSucceed(() => false),
    );

    if (!signatureValid) return CredentialOutcomeSchema.cases.Rejected.make({ reason: "Invalid" });

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
      return CredentialOutcomeSchema.cases.Rejected.make({ reason: "Invalid" });
    }

    if (decoded.claims.exp <= nowSeconds || state.expires_at.getTime() <= nowMillis) {
      return CredentialOutcomeSchema.cases.Rejected.make({ reason: "Expired" });
    }

    if (
      state.revoked_at !== null ||
      state.family_revoked_at !== null ||
      state.client_disabled === true ||
      (state.secret_expires_at !== null && state.secret_expires_at.getTime() <= nowMillis) ||
      (state.family_inactivity_expires_at !== null &&
        state.family_inactivity_expires_at.getTime() <= nowMillis) ||
      (state.family_absolute_expires_at !== null &&
        state.family_absolute_expires_at.getTime() <= nowMillis)
    ) {
      return CredentialOutcomeSchema.cases.Rejected.make({ reason: "Revoked" });
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
        state.session_expires_at.getTime() <= nowMillis ||
        !state.consent_live ||
        (decoded.claims.scope !== "native-api" &&
          decoded.claims.scope !== "native-api offline_access")
      ) {
        return CredentialOutcomeSchema.cases.Rejected.make({
          reason: expected === "OAuthServiceBearer" ? "WrongMechanism" : "Revoked",
        });
      }

      return CredentialOutcomeSchema.cases.Accepted.make({
        mechanism: CredentialMechanismSchema.cases.OAuthUserBearer.make({}),
        principal: PrincipalSchema.cases.Person.make({ personId: PersonId.make(state.person_id) }),
        evidenceRef,
      });
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
      return CredentialOutcomeSchema.cases.Rejected.make({
        reason: expected === "OAuthUserBearer" ? "WrongMechanism" : "Revoked",
      });
    }

    return CredentialOutcomeSchema.cases.Accepted.make({
      mechanism: CredentialMechanismSchema.cases.OAuthServiceBearer.make({}),
      principal: PrincipalSchema.cases.ServicePrincipal.make({
        servicePrincipalId: ServicePrincipalId.make(state.service_principal_id),
      }),
      evidenceRef,
    });
  });

export const makeOAuthCredentialAuthorityService = (
  pool: Pool,
  config: OAuthProviderRuntimeConfig,
): OAuthCredentialAuthorityService => ({
  resolve: (request, expected, now) =>
    Effect.flatMap(now === undefined ? DateTime.now : Effect.succeed(now), (instant) =>
      resolveOAuthCredential(
        request,
        expected,
        instant,
        (claims, kid) => selectTokenState(pool, claims, kid),
        config,
      ),
    ),
  resolveInTransaction: (request, expected, now) =>
    Effect.flatMap(now === undefined ? DateTime.now : Effect.succeed(now), (instant) =>
      resolveOAuthCredential(request, expected, instant, selectTokenStateInTransaction, config),
    ),
});

const sanitizedRequestContext = (context: IdentityRequestContext) => ({
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

const encodeAuditDetails = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

const appendAudit = (
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
    readonly details?: Readonly<Record<string, Schema.Json>>;
  },
) =>
  Effect.gen(function* () {
    const details = yield* encodeAuditDetails(input.details ?? {});

    yield* pgQuery(
      client,
      `INSERT INTO auth.oauth_security_audit (
       event_id, occurred_at, event_kind, client_id, family_id, jti,
       subject_person_id, subject_service_principal_id, actor_principal,
       request_correlation, source_ip, user_agent, details
     ) VALUES ($1, date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC'), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
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
        details,
      ],
    );
  });

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

const validateManifest = flow(
  Schema.decodeUnknownSync(OAuthClientManifestSchema, { onExcessProperty: "error" }),
  (manifest) => {
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
  },
);

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

const clientProviderRecord = (
  manifest: OAuthClientManifest,
  storedSecret: string | null,
  now: Date,
) => {
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

const operatorFailure =
  (operation: keyof OAuthClientOperatorService) =>
  (cause: unknown): OAuthClientOperatorError =>
    cause instanceof OAuthClientOperatorError
      ? cause
      : new OAuthClientOperatorError({
          operation,
          message: cause instanceof Error ? cause.message : "OAuth client operation failed",
          cause,
        });

const selectActiveSigningKeys = (pool: Pool) =>
  pgQuery<{ readonly id: string }>(
    pool,
    `SELECT id FROM auth.jwks
        WHERE COALESCE(alg, '') = 'ES256'
          AND ("expiresAt" IS NULL OR "expiresAt" > CURRENT_TIMESTAMP)
        ORDER BY "createdAt" DESC`,
  );

export const makeOAuthClientOperatorService = (
  pool: Pool,
  engine: OAuthEngineBoundary,
): OAuthClientOperatorService => ({
  provision: (unsafeManifest, execution) =>
    Effect.gen(function* () {
      const manifest = yield* Effect.try({
        try: () => {
          requireOperatorExecution(execution);

          return validateManifest(unsafeManifest);
        },
        catch: operatorFailure("provision"),
      });

      if (execution.dryRun) {
        const result: OAuthProvisionResult = { clientId: manifest.clientId };

        if (manifest.servicePrincipalId !== undefined)
          return { ...result, servicePrincipalId: manifest.servicePrincipalId };

        return result;
      }

      const confidential = manifest.clientKind !== "DelegatedPublic";
      const rawSecret = confidential ? randomBytes(32).toString("base64url") : undefined;
      const clientSecret = rawSecret === undefined ? undefined : `vkr_cs_${rawSecret}`;

      const storedSecret = rawSecret === undefined ? null : hashOAuthClientSecret(rawSecret);

      const instant = yield* DateTime.now;
      const now = DateTime.toDateUtc(instant);

      const context = yield* Effect.tryPromise({
        try: () => engine.$context,
        catch: operatorFailure("provision"),
      });

      yield* Effect.tryPromise({
        try: () =>
          context.adapter.create({
            model: "oauthClient",
            data: clientProviderRecord(manifest, storedSecret, now),
          }),
        catch: operatorFailure("provision"),
      });
      yield* Effect.tryPromise({
        try: () =>
          context.adapter.create({
            model: "oauthClientResource",
            data: {
              clientId: manifest.clientId,
              resourceId: OAUTH_NATIVE_API_RESOURCE,
              createdAt: now,
            },
          }),
        catch: operatorFailure("provision"),
      });
      yield* pgTransaction(pool, (client) =>
        Effect.gen(function* () {
          if (manifest.clientKind === "Service") {
            yield* pgQuery(
              client,
              `INSERT INTO public.service_principals (
             service_principal_id, name, state, revision, created_at, updated_at
           ) VALUES ($1, $2, 'Active', 0, $3, $3)`,
              [manifest.servicePrincipalId, manifest.servicePrincipalName, now],
            );
          }

          yield* pgQuery(
            client,
            `INSERT INTO auth.oauth_client_bindings (
           client_id, client_kind, service_principal_id, secret_expires_at,
           revision, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 0, $5, $5)`,
            [
              manifest.clientId,
              manifest.clientKind,
              manifest.servicePrincipalId ?? null,
              confidential
                ? DateTime.toDateUtc(
                    DateTime.add(instant, { milliseconds: CLIENT_SECRET_LIFETIME_MS }),
                  )
                : null,
              now,
            ],
          );
          yield* appendAudit(client, {
            eventKind: "oauth-client-provisioned",
            clientId: manifest.clientId,
            servicePrincipalId: manifest.servicePrincipalId,
            actorPrincipal: "operator",
            requestCorrelation: execution.requestCorrelation,
            details: { client_kind: manifest.clientKind, resource: OAUTH_NATIVE_API_RESOURCE },
          });
        }),
      );

      const result: Types.Mutable<OAuthProvisionResult> = { clientId: manifest.clientId };

      if (manifest.servicePrincipalId !== undefined)
        result.servicePrincipalId = manifest.servicePrincipalId;

      if (clientSecret !== undefined) result.clientSecret = clientSecret;

      return result;
    }).pipe(Effect.mapError(operatorFailure("provision"))),
  rotateSecret: (clientId, execution) =>
    Effect.gen(function* () {
      yield* Effect.try({
        try: () => requireOperatorExecution(execution),
        catch: operatorFailure("rotateSecret"),
      });

      if (execution.dryRun) return { clientId };
      const rawSecret = randomBytes(32).toString("base64url");
      const secret = `vkr_cs_${rawSecret}`;

      const digest = hashOAuthClientSecret(rawSecret);

      yield* pgTransaction(pool, (client) =>
        Effect.gen(function* () {
          yield* pgQuery(client, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
            clientId,
          ]);

          const updated = yield* pgQuery(
            client,
            `UPDATE auth."oauthClient" provider
            SET "clientSecret" = $2, "updatedAt" = date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC')
           FROM auth.oauth_client_bindings binding
          WHERE provider."clientId" = $1
            AND binding.client_id = provider."clientId"
            AND binding.client_kind <> 'DelegatedPublic'
            AND COALESCE(provider.disabled, false) = false`,
            [clientId, digest],
          );

          if (updated.rowCount !== 1) {
            return yield* new OAuthClientOperatorError({
              operation: "rotateSecret",
              message: "live confidential client not found",
              cause: undefined,
            });
          }

          yield* pgQuery(
            client,
            `UPDATE auth.oauth_client_bindings
            SET secret_expires_at = date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC')
                  + make_interval(secs => $2),
                revision = revision + 1,
                updated_at = date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC')
          WHERE client_id = $1`,
            [clientId, CLIENT_SECRET_LIFETIME_MS / 1_000],
          );
          yield* appendAudit(client, {
            eventKind: "oauth-client-secret-rotated",
            clientId,
            actorPrincipal: "operator",
            requestCorrelation: execution.requestCorrelation,
          });
        }),
      );

      return { clientId, clientSecret: secret };
    }).pipe(Effect.mapError(operatorFailure("rotateSecret"))),
  disableClient: (clientId, execution) =>
    Effect.gen(function* () {
      yield* Effect.try({
        try: () => requireOperatorExecution(execution),
        catch: operatorFailure("disableClient"),
      });

      if (execution.dryRun) return;
      yield* pgTransaction(pool, (client) =>
        Effect.gen(function* () {
          yield* pgQuery(client, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
            clientId,
          ]);

          const updated = yield* pgQuery(
            client,
            `UPDATE auth."oauthClient" SET disabled = true, "updatedAt" = date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC')
          WHERE "clientId" = $1 AND COALESCE(disabled, false) = false`,
            [clientId],
          );

          if (updated.rowCount !== 1) {
            return yield* new OAuthClientOperatorError({
              operation: "disableClient",
              message: "live OAuth client not found",
              cause: undefined,
            });
          }

          yield* pgQuery(
            client,
            `UPDATE auth.oauth_access_token_state SET revoked_at = date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC'),
           revocation_reason = 'client-disabled'
         WHERE client_id = $1 AND revoked_at IS NULL`,
            [clientId],
          );
          yield* pgQuery(
            client,
            `UPDATE auth.oauth_refresh_families SET revoked_at = date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC'),
           revocation_reason = 'client-disabled'
         WHERE client_id = $1 AND revoked_at IS NULL`,
            [clientId],
          );
          yield* appendAudit(client, {
            eventKind: "oauth-client-disabled",
            clientId,
            actorPrincipal: "operator",
            requestCorrelation: execution.requestCorrelation,
          });
        }),
      );
    }).pipe(Effect.mapError(operatorFailure("disableClient"))),
  disableServicePrincipal: (servicePrincipalId, execution) =>
    Effect.gen(function* () {
      yield* Effect.try({
        try: () => requireOperatorExecution(execution),
        catch: operatorFailure("disableServicePrincipal"),
      });

      if (execution.dryRun) return;
      yield* pgTransaction(pool, (client) =>
        Effect.gen(function* () {
          const selected = yield* pgQuery<{ readonly client_id: string }>(
            client,
            `SELECT client_id FROM auth.oauth_client_bindings
          WHERE service_principal_id = $1 FOR UPDATE`,
            [servicePrincipalId],
          );

          const binding = selected.rows[0];

          if (binding === undefined) {
            return yield* new OAuthClientOperatorError({
              operation: "disableServicePrincipal",
              message: "service-principal binding not found",
              cause: undefined,
            });
          }

          yield* pgQuery(
            client,
            `UPDATE public.service_principals
            SET state = 'Disabled', revision = revision + 1, updated_at = date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC')
          WHERE service_principal_id = $1 AND state = 'Active'`,
            [servicePrincipalId],
          );
          yield* pgQuery(
            client,
            `UPDATE auth."oauthClient" SET disabled = true, "updatedAt" = date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC')
          WHERE "clientId" = $1`,
            [binding.client_id],
          );
          yield* pgQuery(
            client,
            `UPDATE auth.oauth_access_token_state
            SET revoked_at = date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC'), revocation_reason = 'service-principal-disabled'
          WHERE service_principal_id = $1 AND revoked_at IS NULL`,
            [servicePrincipalId],
          );
          yield* appendAudit(client, {
            eventKind: "oauth-service-principal-disabled",
            clientId: binding.client_id,
            servicePrincipalId,
            actorPrincipal: "operator",
            requestCorrelation: execution.requestCorrelation,
          });
        }),
      );
    }).pipe(Effect.mapError(operatorFailure("disableServicePrincipal"))),
  bootstrapSigningKey: (execution) =>
    Effect.gen(function* () {
      yield* Effect.try({
        try: () => requireOperatorExecution(execution),
        catch: operatorFailure("bootstrapSigningKey"),
      });

      const selected = yield* selectActiveSigningKeys(pool);

      if (selected.rows.length > 1) {
        return yield* new OAuthClientOperatorError({
          operation: "bootstrapSigningKey",
          message: "multiple active ES256 signing keys",
          cause: undefined,
        });
      }

      if (selected.rows[0] !== undefined) return { keyId: selected.rows[0].id };

      if (execution.dryRun) return {};
      yield* Effect.tryPromise({
        try: () =>
          engine.api.signJWT({
            body: {
              payload: { sub: "oauth-signing-key-bootstrap", aud: OAUTH_NATIVE_API_RESOURCE },
            },
          }),
        catch: operatorFailure("bootstrapSigningKey"),
      });

      const created = yield* selectActiveSigningKeys(pool);

      const [key] = created.rows;

      if (created.rows.length !== 1 || key === undefined) {
        return yield* new OAuthClientOperatorError({
          operation: "bootstrapSigningKey",
          message: "signing key bootstrap did not create exactly one key",
          cause: undefined,
        });
      }

      yield* pgTransaction(pool, (client) =>
        appendAudit(client, {
          eventKind: "oauth-signing-key-rotated",
          actorPrincipal: "operator",
          requestCorrelation: execution.requestCorrelation,
          details: { key_id: key.id },
        }),
      );

      return { keyId: key.id };
    }).pipe(Effect.mapError(operatorFailure("bootstrapSigningKey"))),
  retireSigningKeys: (execution, now) =>
    Effect.gen(function* () {
      yield* Effect.try({
        try: () => requireOperatorExecution(execution),
        catch: operatorFailure("retireSigningKeys"),
      });

      if (execution.dryRun) return 0;

      const cutoff = now ?? (yield* DateTime.now);

      const result = yield* pgQuery(
        pool,
        `DELETE FROM auth.jwks
        WHERE "expiresAt" IS NOT NULL
          AND "expiresAt" + interval '15 minutes' <= $1`,
        [DateTime.toDateUtc(cutoff)],
      );

      return result.rowCount ?? 0;
    }).pipe(Effect.mapError(operatorFailure("retireSigningKeys"))),
});

const clientAuthoritySql = `SELECT binding.client_id, binding.client_kind, binding.service_principal_id,
            binding.secret_expires_at, client.disabled, client."clientSecret" AS client_secret,
            client."redirectUris" AS redirect_uris, client.scopes,
            client."clientCredentialsScopes" AS client_credentials_scopes,
            client."tokenEndpointAuthMethod" AS token_endpoint_auth_method,
            client."grantTypes" AS grant_types, client."requirePKCE" AS require_pkce
       FROM auth.oauth_client_bindings binding
       JOIN auth."oauthClient" client ON client."clientId" = binding.client_id
      WHERE binding.client_id = $1`;

const readClientAuthority = (pool: Pool, clientId: string) =>
  pgQuery<ClientAuthorityRow>(pool, clientAuthoritySql, [clientId]).pipe(
    Effect.map((result) => result.rows[0]),
  );

/** The HTTP Basic client credential of `request`; malformed percent-encoding fails. */
const basicClientCredential = (request: Request) =>
  Effect.try({
    try: (): { readonly clientId: string; readonly secret: string } | undefined => {
      const value = request.headers.get("authorization");

      if (value === null || !value.startsWith("Basic ") || value.includes(",")) return undefined;
      const decoded = Buffer.from(value.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");

      if (separator <= 0) return undefined;

      return {
        clientId: decodeURIComponent(decoded.slice(0, separator)),
        secret: decodeURIComponent(decoded.slice(separator + 1)),
      };
    },
    catch: (cause) =>
      new OAuthExchangeFailure({ message: "client credential is malformed", cause }),
  });

const authorizeTokenClient = (
  pool: Pool,
  request: Request,
  form: URLSearchParams,
  now: DateTime.Utc,
) =>
  Effect.gen(function* () {
    const basic = yield* basicClientCredential(request);
    const formClientId = form.get("client_id");
    const clientId = basic?.clientId ?? formClientId;

    if (clientId === null || clientId === undefined) return undefined;
    const client = yield* readClientAuthority(pool, clientId);

    if (
      client === undefined ||
      client.disabled === true ||
      (client.secret_expires_at !== null &&
        client.secret_expires_at.getTime() <= DateTime.toEpochMillis(now))
    ) {
      return undefined;
    }

    if (client.client_kind === "DelegatedPublic") {
      if (basic !== undefined || client.token_endpoint_auth_method !== "none") return undefined;
    } else if (
      basic === undefined ||
      !basic.secret.startsWith("vkr_cs_") ||
      client.token_endpoint_auth_method !== "client_secret_basic" ||
      client.client_secret === null ||
      !constantDigestEqual(
        hashOAuthClientSecret(basic.secret.slice("vkr_cs_".length)),
        client.client_secret,
      )
    ) {
      return undefined;
    }

    return client;
  });

const authorizeOAuthIntrospectionClient = (pool: Pool, request: Request, now: DateTime.Utc) =>
  Effect.gen(function* () {
    const basic = yield* basicClientCredential(request);

    if (basic === undefined) return false;
    const client = yield* readClientAuthority(pool, basic.clientId);

    if (
      client === undefined ||
      client.client_kind !== "ResourceServer" ||
      client.disabled === true ||
      client.token_endpoint_auth_method !== "client_secret_basic" ||
      client.client_secret === null ||
      client.secret_expires_at === null ||
      client.secret_expires_at.getTime() <= DateTime.toEpochMillis(now) ||
      client.scopes?.length !== 0 ||
      !basic.secret.startsWith("vkr_cs_") ||
      !constantDigestEqual(
        hashOAuthClientSecret(basic.secret.slice("vkr_cs_".length)),
        client.client_secret,
      )
    ) {
      return false;
    }

    const linked = yield* pgQuery(
      pool,
      `SELECT 1 FROM auth."oauthClientResource"
      WHERE "clientId" = $1 AND "resourceId" = $2`,
      [client.client_id, OAUTH_NATIVE_API_RESOURCE],
    );

    return linked.rowCount === 1;
  });

const requestText = (request: Request) =>
  Effect.tryPromise({
    try: () => request.clone().text(),
    catch: (cause) => new OAuthExchangeFailure({ message: "request body is unreadable", cause }),
  });

const providerResponse = (engine: OAuthEngineBoundary, request: Request) =>
  Effect.tryPromise({
    try: () => engine.handler(request),
    catch: (cause) => new OAuthExchangeFailure({ message: "OAuth provider failed", cause }),
  });

const responseText = (response: Response) =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) =>
      new OAuthExchangeFailure({ message: "provider response body is unreadable", cause }),
  });

/** The provider's answer to `request`, read into memory up to the release barrier limit. */
const boundedProviderResponse = (engine: OAuthEngineBoundary, request: Request) =>
  Effect.gen(function* () {
    const response = yield* providerResponse(engine, request);
    const body = yield* responseText(response);

    if (new TextEncoder().encode(body).byteLength > TOKEN_RESPONSE_LIMIT) {
      return yield* new OAuthExchangeFailure({
        message: "provider response exceeded release barrier limit",
      });
    }

    return {
      response: new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
      body,
    };
  });

const inactiveIntrospectionResponse = (): Response =>
  Response.json(
    { active: false },
    { status: 200, headers: { "cache-control": "no-store", pragma: "no-cache" } },
  );

export const makeOAuthInternalIntrospectionHandler =
  (engine: OAuthEngineBoundary, pool: Pool): OAuthIntrospectionHandler =>
  (request, context) =>
    Effect.gen(function* () {
      const pathname = new URL(request.url).pathname;

      if (request.method !== "POST" || pathname !== "/api/auth/oauth2/introspect") {
        return new Response("Not Found", { status: 404 });
      }

      // The rejection answers inactive even when its audit row cannot be written.
      const reject = (reason: string) =>
        pgTransaction(pool, (transaction) =>
          appendAudit(transaction, {
            eventKind: "oauth-introspection-rejected",
            actorPrincipal: "resource-server",
            requestCorrelation: context.requestCorrelation,
            sourceIp: sanitizedRequestContext(context).sourceIp,
            userAgent: sanitizedRequestContext(context).userAgent,
            details: { denial_category: reason },
          }),
        ).pipe(Effect.ignore, Effect.map(inactiveIntrospectionResponse));

      if (
        request.headers.get("cookie") !== null ||
        request.headers.get("content-type")?.split(";", 1)[0] !==
          "application/x-www-form-urlencoded"
      ) {
        return yield* reject("invalid-request");
      }

      const body = yield* requestText(request);

      if (new TextEncoder().encode(body).byteLength > FORM_INPUT_LIMIT) {
        return yield* reject("input-limit");
      }

      const now = yield* DateTime.now;

      if (!(yield* authorizeOAuthIntrospectionClient(pool, request, now))) {
        return yield* reject("invalid-client");
      }

      const provider = yield* boundedProviderResponse(engine, request);
      const parsed = yield* decodeUnknownRecordJson(provider.body);

      if (
        parsed.active !== true ||
        !Predicate.isString(parsed.jti) ||
        !Predicate.isString(parsed.client_id) ||
        !Predicate.isString(parsed.sub) ||
        !Predicate.isString(parsed.scope)
      ) {
        return inactiveIntrospectionResponse();
      }

      const tracked = yield* pgQuery(
        pool,
        `SELECT 1
         FROM auth.oauth_access_token_state state
         JOIN auth.oauth_client_bindings binding ON binding.client_id = state.client_id
         JOIN auth."oauthClient" client ON client."clientId" = state.client_id
         LEFT JOIN public.service_principals principal
           ON principal.service_principal_id = state.service_principal_id
         LEFT JOIN auth.usable_human_sessions session ON session.id = state.session_id
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
          Predicate.isString(parsed.sid) ? parsed.sid : null,
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

      const bounded: Partial<Record<(typeof allowed)[number], Schema.Json>> = {};

      for (const name of allowed) {
        if (parsed[name] !== undefined) bounded[name] = parsed[name];
      }

      return Response.json(bounded, {
        status: 200,
        headers: { "cache-control": "no-store", pragma: "no-cache" },
      });
    });

const invalidOAuthResponse = (status: number, error: string): Response =>
  Response.json(
    { error },
    {
      status,
      headers: { "cache-control": "no-store", pragma: "no-cache" },
    },
  );

/**
 * Runs `use` while one lent client holds the session advisory lock on `key`. The unlock runs
 * whatever `use` does; the client returns to the pool afterwards.
 */
const withSessionAdvisoryLock = <A, E, R>(
  pool: Pool,
  key: string,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | PgQueryError, R> =>
  pgWithClient(pool, (client) =>
    pgQuery(client, "SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]).pipe(
      Effect.andThen(use),
      Effect.ensuring(
        Effect.ignore(pgQuery(client, "SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key])),
      ),
    ),
  );

const insertIssuedToken = (
  transaction: PoolClient,
  claims: NativeAccessTokenClaims,
  client: ClientAuthorityRow,
  familyId: string | null,
  context: IdentityRequestContext,
) =>
  Effect.gen(function* () {
    const requestContext = sanitizedRequestContext(context);

    yield* pgQuery(
      transaction,
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
    yield* appendAudit(transaction, {
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
        credential_kind:
          client.client_kind === "Service" ? "OAuthServiceBearer" : "OAuthUserBearer",
        resource: OAUTH_NATIVE_API_RESOURCE,
        scopes: claims.scope.split(" "),
      },
    });
  });

/** The refresh family that the first token of an authorization code opens. */
interface OpenedRefreshFamily {
  readonly familyId: string;
  readonly authorizationCodeId: string;
  readonly clientId: string;
  readonly personId: string;
  readonly sessionId: string;
  /** The issue instant of the first token. */
  readonly issuedAt: DateTime.Utc;
}

/**
 * Opens a refresh family at the issue instant of its first token. Migration 0077 defines its
 * windows, which its checks enforce.
 */
export const openRefreshFamily = (transaction: PoolClient, family: OpenedRefreshFamily) =>
  pgQuery(
    transaction,
    `INSERT INTO auth.oauth_refresh_families (
       family_id, authorization_code_id, client_id, person_id, session_id,
       created_at, last_used_at, inactivity_expires_at, absolute_expires_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $6,
       auth.oauth_refresh_inactivity_expires_at($6, auth.oauth_refresh_absolute_expires_at($6)),
       auth.oauth_refresh_absolute_expires_at($6)
     )`,
    [
      family.familyId,
      family.authorizationCodeId,
      family.clientId,
      family.personId,
      family.sessionId,
      DateTime.toDateUtc(family.issuedAt),
    ],
  );

/** Records a refresh at `usedAt`, the issue instant of the new token in epoch seconds. */
export const recordRefreshFamilyUse = (transaction: PoolClient, familyId: string, usedAt: number) =>
  pgQuery(
    transaction,
    `UPDATE auth.oauth_refresh_families
        SET last_used_at = to_timestamp($2),
            inactivity_expires_at =
              auth.oauth_refresh_inactivity_expires_at(to_timestamp($2), absolute_expires_at)
      WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId, usedAt],
  );

const initialCodeExchange = (
  engine: OAuthEngineBoundary,
  pool: Pool,
  request: Request,
  form: URLSearchParams,
  client: ClientAuthorityRow,
  context: IdentityRequestContext,
  config: OAuthProviderRuntimeConfig,
) =>
  Effect.gen(function* () {
    const code = form.get("code");

    if (code === null) return invalidOAuthResponse(400, "invalid_request");
    const codeDigest = hashOAuthToken(code, "authorization_code");

    return yield* withSessionAdvisoryLock(
      pool,
      `oauth-code:${codeDigest}`,
      Effect.gen(function* () {
        const replay = yield* pgQuery<{ readonly family_id: string }>(
          pool,
          `SELECT family_id FROM auth.oauth_refresh_families WHERE authorization_code_id = $1`,
          [codeDigest],
        );

        const replayed = replay.rows[0];

        if (replayed !== undefined) {
          yield* pgTransaction(pool, (transaction) =>
            Effect.gen(function* () {
              yield* pgQuery(
                transaction,
                `UPDATE auth.oauth_refresh_families SET revoked_at = date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC'),
             revocation_reason = 'code-replay'
           WHERE family_id = $1 AND revoked_at IS NULL`,
                [replayed.family_id],
              );
              yield* pgQuery(
                transaction,
                `UPDATE auth.oauth_access_token_state SET revoked_at = date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC'),
             revocation_reason = 'code-replay'
           WHERE family_id = $1 AND revoked_at IS NULL`,
                [replayed.family_id],
              );
              yield* appendAudit(transaction, {
                eventKind: "oauth-authorization-code-replay",
                clientId: client.client_id,
                familyId: replayed.family_id,
                actorPrincipal: "oauth-client",
                requestCorrelation: context.requestCorrelation,
              });
            }),
          );

          return invalidOAuthResponse(400, "invalid_grant");
        }

        const buffered = yield* boundedProviderResponse(engine, request);

        if (!buffered.response.ok) return buffered.response;
        const tokenResponse = yield* decodeTokenResponseJson(buffered.body);
        const decoded = yield* decodeIssuedJwt(tokenResponse.access_token);

        if (
          !(yield* verifyIssuedJwtSignature(pool, decoded)) ||
          decoded.claims.iss !== oauthIssuer(config) ||
          decoded.claims.client_id !== client.client_id ||
          decoded.claims.aud !== OAUTH_NATIVE_API_RESOURCE ||
          decoded.claims.sid === undefined ||
          decoded.claims.exp - decoded.claims.iat !== 600
        ) {
          return yield* new OAuthExchangeFailure({
            message: "provider issued a token outside the delegated contract",
          });
        }

        const family = {
          familyId: randomUUID(),
          authorizationCodeId: codeDigest,
          clientId: client.client_id,
          personId: decoded.claims.sub,
          sessionId: decoded.claims.sid,
          issuedAt: DateTime.makeUnsafe(decoded.claims.iat * 1_000),
        };

        yield* pgTransaction(pool, (transaction) =>
          Effect.gen(function* () {
            yield* openRefreshFamily(transaction, family);
            yield* insertIssuedToken(transaction, decoded.claims, client, family.familyId, context);
          }),
        );

        return buffered.response;
      }),
    );
  });

const refreshExchange = (
  engine: OAuthEngineBoundary,
  pool: Pool,
  request: Request,
  form: URLSearchParams,
  client: ClientAuthorityRow,
  context: IdentityRequestContext,
  config: OAuthProviderRuntimeConfig,
) =>
  Effect.gen(function* () {
    const refreshToken = form.get("refresh_token");

    if (refreshToken === null) return invalidOAuthResponse(400, "invalid_request");
    const digest = refreshTokenDigest(refreshToken);

    if (digest === undefined) return invalidOAuthResponse(400, "invalid_grant");

    const before = yield* pgQuery<RefreshLookupRow>(
      pool,
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

    if (
      lookup === undefined ||
      lookup.authorization_code_id === null ||
      lookup.family_id === null
    ) {
      return invalidOAuthResponse(400, "invalid_grant");
    }

    const familyId = lookup.family_id;

    return yield* withSessionAdvisoryLock(
      pool,
      `oauth-family:${lookup.authorization_code_id}`,
      Effect.gen(function* () {
        const reread = yield* pgQuery<RefreshLookupRow>(
          pool,
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

        const family = yield* pgQuery<{
          readonly revoked_at: Date | null;
          readonly inactivity_expires_at: Date;
          readonly absolute_expires_at: Date;
        }>(
          pool,
          `SELECT revoked_at, inactivity_expires_at, absolute_expires_at
         FROM auth.oauth_refresh_families WHERE family_id = $1`,
          [familyId],
        );

        const state = family.rows[0];
        const now = DateTime.toEpochMillis(yield* DateTime.now);

        if (
          state === undefined ||
          current === undefined ||
          current.family_id !== familyId ||
          state.revoked_at !== null ||
          current.rotated_at !== null ||
          current.revoked !== null ||
          current.expires_at.getTime() <= now ||
          state.inactivity_expires_at.getTime() <= now ||
          state.absolute_expires_at.getTime() <= now
        ) {
          yield* pgTransaction(pool, (transaction) =>
            Effect.gen(function* () {
              yield* pgQuery(
                transaction,
                `UPDATE auth.oauth_refresh_families SET revoked_at = date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC'),
             revocation_reason = 'refresh-replay'
           WHERE family_id = $1 AND revoked_at IS NULL`,
                [familyId],
              );
              yield* pgQuery(
                transaction,
                `UPDATE auth.oauth_access_token_state SET revoked_at = date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC'),
             revocation_reason = 'refresh-replay'
           WHERE family_id = $1 AND revoked_at IS NULL`,
                [familyId],
              );
              yield* appendAudit(transaction, {
                eventKind: "oauth-refresh-replay",
                clientId: client.client_id,
                familyId,
                actorPrincipal: "oauth-client",
                requestCorrelation: context.requestCorrelation,
              });
            }),
          );

          return invalidOAuthResponse(400, "invalid_grant");
        }

        const usableSession = yield* pgQuery(
          pool,
          'SELECT 1 FROM auth.usable_human_sessions WHERE id=$1 AND "userId"=$2',
          [current.session_id, current.user_id],
        );

        if (usableSession.rowCount !== 1) return invalidOAuthResponse(400, "invalid_grant");

        const buffered = yield* boundedProviderResponse(engine, request);

        if (!buffered.response.ok) return buffered.response;
        const tokenResponse = yield* decodeTokenResponseJson(buffered.body);
        const decoded = yield* decodeIssuedJwt(tokenResponse.access_token);

        if (
          !(yield* verifyIssuedJwtSignature(pool, decoded)) ||
          decoded.claims.iss !== oauthIssuer(config) ||
          decoded.claims.client_id !== client.client_id ||
          decoded.claims.sub !== current.user_id ||
          decoded.claims.sid !== current.session_id ||
          decoded.claims.exp - decoded.claims.iat !== 600
        ) {
          return yield* new OAuthExchangeFailure({
            message: "provider issued a token outside the refresh contract",
          });
        }

        yield* pgTransaction(pool, (transaction) =>
          Effect.gen(function* () {
            yield* recordRefreshFamilyUse(transaction, familyId, decoded.claims.iat);
            yield* insertIssuedToken(transaction, decoded.claims, client, familyId, context);
          }),
        );

        return buffered.response;
      }),
    );
  });

const serviceExchange = (
  engine: OAuthEngineBoundary,
  pool: Pool,
  request: Request,
  client: ClientAuthorityRow,
  context: IdentityRequestContext,
  config: OAuthProviderRuntimeConfig,
) =>
  Effect.gen(function* () {
    const buffered = yield* boundedProviderResponse(engine, request);

    if (!buffered.response.ok) return buffered.response;
    const tokenResponse = yield* decodeTokenResponseJson(buffered.body);

    if (tokenResponse.refresh_token !== undefined) {
      return yield* new OAuthExchangeFailure({
        message: "service token response contained refresh token",
      });
    }

    const decoded = yield* decodeIssuedJwt(tokenResponse.access_token);

    if (
      !(yield* verifyIssuedJwtSignature(pool, decoded)) ||
      client.client_kind !== "Service" ||
      decoded.claims.iss !== oauthIssuer(config) ||
      decoded.claims.client_id !== client.client_id ||
      decoded.claims.sub !== client.client_id ||
      decoded.claims.sid !== undefined ||
      decoded.claims.scope !== "native-api" ||
      decoded.claims.exp - decoded.claims.iat !== 300
    ) {
      return yield* new OAuthExchangeFailure({
        message: "provider issued a token outside the service contract",
      });
    }

    yield* pgTransaction(pool, (transaction) =>
      insertIssuedToken(transaction, decoded.claims, client, null, context),
    );

    return buffered.response;
  });

const handleToken = (
  engine: OAuthEngineBoundary,
  pool: Pool,
  request: Request,
  context: IdentityRequestContext,
  config: OAuthProviderRuntimeConfig,
) =>
  Effect.gen(function* () {
    if (request.headers.get("cookie") !== null) {
      return invalidOAuthResponse(400, "invalid_request");
    }

    if (
      request.headers.get("content-type")?.split(";", 1)[0] !== "application/x-www-form-urlencoded"
    ) {
      return invalidOAuthResponse(400, "invalid_request");
    }

    const body = yield* requestText(request);

    if (new TextEncoder().encode(body).byteLength > FORM_INPUT_LIMIT) {
      return invalidOAuthResponse(400, "invalid_request");
    }

    const form = new URLSearchParams(body);

    if (
      form.getAll("resource").length !== 1 ||
      form.get("resource") !== OAUTH_NATIVE_API_RESOURCE
    ) {
      return invalidOAuthResponse(400, "invalid_target");
    }

    const grantType = form.get("grant_type");
    const client = yield* authorizeTokenClient(pool, request, form, yield* DateTime.now);

    if (client === undefined) return invalidOAuthResponse(401, "invalid_client");

    if (grantType === "authorization_code") {
      if (
        client.client_kind !== "DelegatedPublic" &&
        client.client_kind !== "DelegatedConfidential"
      ) {
        return invalidOAuthResponse(400, "unauthorized_client");
      }

      const redirect = form.get("redirect_uri");

      if (
        redirect === null ||
        !client.redirect_uris.some((registered) => registered === redirect)
      ) {
        return invalidOAuthResponse(400, "invalid_grant");
      }

      return yield* initialCodeExchange(engine, pool, request, form, client, context, config);
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

      return yield* refreshExchange(engine, pool, request, form, client, context, config);
    }

    if (grantType === "client_credentials") {
      if (client.client_kind !== "Service" || form.get("scope") !== "native-api") {
        return invalidOAuthResponse(400, "unauthorized_client");
      }

      return yield* serviceExchange(engine, pool, request, client, context, config);
    }

    return invalidOAuthResponse(400, "unsupported_grant_type");
  });

const handleRevocation = (
  engine: OAuthEngineBoundary,
  pool: Pool,
  request: Request,
  context: IdentityRequestContext,
) =>
  Effect.gen(function* () {
    if (
      request.headers.get("cookie") !== null ||
      request.headers.get("content-type")?.split(";", 1)[0] !== "application/x-www-form-urlencoded"
    ) {
      return invalidOAuthResponse(400, "invalid_request");
    }

    const body = yield* requestText(request);

    if (new TextEncoder().encode(body).byteLength > FORM_INPUT_LIMIT) {
      return invalidOAuthResponse(400, "invalid_request");
    }

    const form = new URLSearchParams(body);
    const token = form.get("token");

    if (token === null) return invalidOAuthResponse(400, "invalid_request");
    const client = yield* authorizeTokenClient(pool, request, form, yield* DateTime.now);

    if (client === undefined) return invalidOAuthResponse(401, "invalid_client");

    if (token.split(".").length === 3) {
      const decodedJwt = Result.try(() => decodeJwt(token));

      if (Result.isFailure(decodedJwt)) {
        return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
      }

      const decoded = decodedJwt.success;

      const verified = yield* verifyIssuedJwtSignature(pool, decoded).pipe(
        Effect.orElseSucceed(() => false),
      );

      if (!verified) {
        return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
      }

      yield* pgTransaction(pool, (transaction) =>
        Effect.gen(function* () {
          const updated = yield* pgQuery<{ readonly family_id: string | null }>(
            transaction,
            `UPDATE auth.oauth_access_token_state
            SET revoked_at = date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC'), revocation_reason = 'explicit-access-token'
          WHERE jti = $1 AND client_id = $2 AND revoked_at IS NULL
          RETURNING family_id`,
            [decoded.claims.jti, client.client_id],
          );

          const revoked = updated.rows[0];

          if (revoked !== undefined) {
            yield* appendAudit(transaction, {
              eventKind: "oauth-access-token-revoked",
              clientId: client.client_id,
              familyId: revoked.family_id ?? undefined,
              jti: decoded.claims.jti,
              actorPrincipal: "oauth-client",
              requestCorrelation: context.requestCorrelation,
            });
          }
        }),
      );

      return new Response(null, {
        status: 200,
        headers: { "cache-control": "no-store", pragma: "no-cache" },
      });
    }

    const refreshDigest = refreshTokenDigest(token);

    if (refreshDigest === undefined) {
      return new Response(null, {
        status: 200,
        headers: { "cache-control": "no-store", pragma: "no-cache" },
      });
    }

    yield* pgTransaction(pool, (transaction) =>
      Effect.gen(function* () {
        const family = yield* pgQuery<{ readonly family_id: string }>(
          transaction,
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
        yield* pgQuery(
          transaction,
          `UPDATE auth.oauth_refresh_families
          SET revoked_at = date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC'), revocation_reason = 'explicit-refresh-token'
        WHERE family_id = $1 AND revoked_at IS NULL`,
          [owned.family_id],
        );
        yield* pgQuery(
          transaction,
          `UPDATE auth.oauth_access_token_state
          SET revoked_at = date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC'), revocation_reason = 'explicit-refresh-token'
        WHERE family_id = $1 AND revoked_at IS NULL`,
          [owned.family_id],
        );
        yield* appendAudit(transaction, {
          eventKind: "oauth-refresh-family-revoked",
          clientId: client.client_id,
          familyId: owned.family_id,
          actorPrincipal: "oauth-client",
          requestCorrelation: context.requestCorrelation,
        });
      }),
    );

    const response = yield* providerResponse(engine, request);

    if (!response.ok) {
      return yield* new OAuthExchangeFailure({
        message: "provider refresh revocation failed after owned revocation",
      });
    }

    response.headers.set("cache-control", "no-store");
    response.headers.set("pragma", "no-cache");

    return response;
  });

const handleConsentWithdrawal = (
  engine: OAuthEngineBoundary,
  pool: Pool,
  request: Request,
  context: IdentityRequestContext,
) =>
  Effect.gen(function* () {
    const body = yield* requestText(request).pipe(
      Effect.flatMap(decodeUnknownRecordJson),
      Effect.orElseSucceed(() => undefined),
    );

    if (!Predicate.isString(body?.id)) return invalidOAuthResponse(400, "invalid_request");

    const session = yield* providerResponse(
      engine,
      new Request(new URL("/api/auth/get-session", request.url), {
        headers: { cookie: request.headers.get("cookie") ?? "" },
      }),
    );

    if (!session.ok) return invalidOAuthResponse(401, "invalid_request");
    const sessionBody = yield* decodeUnknownRecordJson(yield* responseText(session));
    const user = sessionBody.user;

    if (
      !Predicate.isObject(user) ||
      !Predicate.hasProperty(user, "id") ||
      !Predicate.isString(user.id)
    )
      return invalidOAuthResponse(401, "invalid_request");

    const personId = user.id;

    const consent = yield* pgQuery<{ readonly client_id: string }>(
      pool,
      `SELECT "clientId" AS client_id FROM auth."oauthConsent"
      WHERE id = $1 AND "userId" = $2`,
      [body.id, personId],
    );

    const owned = consent.rows[0];

    if (owned === undefined) return invalidOAuthResponse(404, "invalid_request");

    yield* pgTransaction(pool, (transaction) =>
      Effect.gen(function* () {
        const families = yield* pgQuery<{ readonly family_id: string }>(
          transaction,
          `UPDATE auth.oauth_refresh_families
          SET revoked_at = date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC'), revocation_reason = 'consent-withdrawn'
        WHERE client_id = $1 AND person_id = $2 AND revoked_at IS NULL
        RETURNING family_id`,
          [owned.client_id, personId],
        );

        yield* pgQuery(
          transaction,
          `UPDATE auth.oauth_access_token_state
          SET revoked_at = date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC'), revocation_reason = 'consent-withdrawn'
        WHERE client_id = $1 AND person_id = $2 AND revoked_at IS NULL`,
          [owned.client_id, personId],
        );
        yield* appendAudit(transaction, {
          eventKind: "oauth-consent-withdrawn",
          clientId: owned.client_id,
          personId,
          actorPrincipal: `person:${personId}`,
          requestCorrelation: context.requestCorrelation,
          details: { affected_count: families.rowCount ?? 0 },
        });
      }),
    );

    const response = yield* providerResponse(engine, request);

    if (!response.ok) {
      return yield* new OAuthExchangeFailure({
        message: "provider consent cleanup failed after owned revocation",
      });
    }

    return response;
  });

const handlePublicClient = (engine: OAuthEngineBoundary, pool: Pool, request: Request) =>
  Effect.gen(function* () {
    const clientId = new URL(request.url).searchParams.get("client_id");

    if (clientId === null) return invalidOAuthResponse(400, "invalid_request");
    const client = yield* readClientAuthority(pool, clientId);

    if (
      client === undefined ||
      (client.client_kind !== "DelegatedPublic" && client.client_kind !== "DelegatedConfidential")
    ) {
      return invalidOAuthResponse(404, "invalid_request");
    }

    const buffered = yield* boundedProviderResponse(engine, request);

    if (!buffered.response.ok) return buffered.response;
    const provider = yield* decodeUnknownRecordJson(buffered.body);

    if (
      provider.client_id !== clientId ||
      !Predicate.isString(provider.client_name) ||
      provider.client_name.length === 0 ||
      provider.client_name.length > 160
    ) {
      return yield* new OAuthExchangeFailure({
        message: "provider returned a malformed public client",
      });
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
  });

export const makeOAuthReleaseBarrier =
  (
    engine: OAuthEngineBoundary,
    pool: Pool,
    config: OAuthProviderRuntimeConfig,
  ): OAuthReleaseHandler =>
  (request, context) =>
    Effect.gen(function* () {
      const pathname = new URL(request.url).pathname;

      if (request.method === "GET" && pathname === "/api/auth/oauth2/public-client") {
        return yield* handlePublicClient(engine, pool, request);
      }

      if (request.method === "POST" && pathname === "/api/auth/oauth2/token") {
        return yield* handleToken(engine, pool, request, context, config);
      }

      if (request.method === "POST" && pathname === "/api/auth/oauth2/revoke") {
        return yield* handleRevocation(engine, pool, request, context);
      }

      if (request.method === "POST" && pathname === "/api/auth/oauth2/delete-consent") {
        return yield* handleConsentWithdrawal(engine, pool, request, context);
      }

      const response = yield* providerResponse(engine, request);

      if (pathname === "/api/auth/jwks" && response.ok) {
        const body = yield* responseText(response);
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
    }).pipe(
      // The barrier answers every failure and defect of the exchange as temporarily unavailable.
      Effect.catchCause(() =>
        Effect.succeed(
          Response.json(
            { error: "temporarily_unavailable" },
            {
              status: 503,
              headers: { "cache-control": "no-store", pragma: "no-cache" },
            },
          ),
        ),
      ),
    );

export const exactRedirectAccepted = (
  pool: Pool,
  clientId: string,
  redirectUri: string,
): Effect.Effect<boolean, PgQueryError> =>
  Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const client = yield* readClientAuthority(pool, clientId);

    if (
      client === undefined ||
      client.disabled === true ||
      (client.client_kind !== "DelegatedPublic" &&
        client.client_kind !== "DelegatedConfidential") ||
      client.require_pkce !== true ||
      client.grant_types?.join(" ") !== "authorization_code refresh_token" ||
      (client.secret_expires_at !== null && client.secret_expires_at.getTime() <= now) ||
      !client.redirect_uris.some((registered) => registered === redirectUri)
    ) {
      return false;
    }

    const linked = yield* pgQuery(
      pool,
      `SELECT 1 FROM auth."oauthClientResource"
      WHERE "clientId" = $1 AND "resourceId" = $2`,
      [clientId, OAUTH_NATIVE_API_RESOURCE],
    );

    return linked.rowCount === 1;
  });

export class OAuthHandlers extends Context.Service<
  OAuthHandlers,
  {
    readonly release: OAuthReleaseHandler;
    readonly introspection: OAuthIntrospectionHandler;
  }
>()("@vektorprogrammet/database/OAuthHandlers") {}

export const OAuthLive = (config: OAuthProviderRuntimeConfig) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const pool = yield* DatabasePgPool;
      const engine = yield* NativeAuthEngine;

      return Context.make(
        OAuthCredentialAuthority,
        makeOAuthCredentialAuthorityService(pool, config),
      ).pipe(
        Context.add(OAuthClientOperator, makeOAuthClientOperatorService(pool, engine)),
        Context.add(OAuthHandlers, {
          release: makeOAuthReleaseBarrier(engine, pool, config),
          introspection: makeOAuthInternalIntrospectionHandler(engine, pool),
        }),
      );
    }),
  );
