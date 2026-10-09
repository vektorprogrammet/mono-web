import {
  oauthProvider,
  type OAuthOptions,
  type Scope,
  type StoreTokenType,
} from "@better-auth/oauth-provider";
import { jwt } from "better-auth/plugins";
import { Crypto, Effect, Schema } from "effect";
import { Base64Url } from "effect/encoding";

export const OAUTH_NATIVE_API_RESOURCE = "urn:vektorprogrammet:native-api" as const;

export const OAUTH_SCOPES = ["native-api", "offline_access"] as const satisfies readonly Scope[];

export const OAUTH_ISSUER_PATH = "/api/auth" as const;

export const OAUTH_DASHBOARD_LOGIN_PATH = "/dashboard/login" as const;

export const OAUTH_DASHBOARD_CONSENT_PATH = "/dashboard/oauth/consent" as const;

export const OAUTH_REFRESH_TOKEN_PREFIX = "vkr_rt_" as const;

export const OAuthClientKindSchema = Schema.Literals([
  "DelegatedPublic",
  "DelegatedConfidential",
  "Service",
  "ResourceServer",
]);

export type OAuthClientKind = typeof OAuthClientKindSchema.Type;

export const NativeAccessTokenHeaderSchema = Schema.Struct({
  typ: Schema.Literals(["at+jwt"]),
  alg: Schema.Literals(["ES256"]),
  kid: Schema.String,
});

export const NativeAccessTokenClaimsSchema = Schema.Struct({
  iss: Schema.String,
  sub: Schema.String,
  aud: Schema.Literals([OAUTH_NATIVE_API_RESOURCE]),
  exp: Schema.Int,
  iat: Schema.Int,
  jti: Schema.String,
  client_id: Schema.String,
  azp: Schema.String,
  scope: Schema.Literals(["native-api", "native-api offline_access"]),
  sid: Schema.optional(Schema.String),
});

export type NativeAccessTokenClaims = typeof NativeAccessTokenClaimsSchema.Type;

export const OAuthClientManifestSchema = Schema.Struct({
  clientId: Schema.String,
  name: Schema.String,
  clientKind: OAuthClientKindSchema,
  redirectUris: Schema.Array(Schema.String),
  scopes: Schema.Array(Schema.Literals(OAUTH_SCOPES)),
  servicePrincipalId: Schema.optional(Schema.String),
  servicePrincipalName: Schema.optional(Schema.String),
});

export type OAuthClientManifest = typeof OAuthClientManifestSchema.Type;

export interface OAuthProviderRuntimeConfig {
  readonly canonicalOrigin: string;
  readonly dashboardOrigin: string;
  readonly nativeApiResource: typeof OAUTH_NATIVE_API_RESOURCE;
}

export const oauthIssuer = (config: OAuthProviderRuntimeConfig): string =>
  `${config.canonicalOrigin}${OAUTH_ISSUER_PATH}`;

const encoder = new TextEncoder();

/**
 * The SHA-256 digest of `value` under the domain label `domain`, as unpadded base64url. The input
 * is `domain`, one NUL byte, and `value`, each in UTF-8, so a digest of one domain never answers
 * for another.
 *
 * A digest failure cannot come from well-formed input, so it is a defect, never an answer.
 */
export const sha256Base64Url = (
  domain: string,
  value: string,
): Effect.Effect<string, never, Crypto.Crypto> =>
  Crypto.Crypto.use((crypto) =>
    crypto.digest("SHA-256", encoder.encode(`${domain}\0${value}`)),
  ).pipe(Effect.orDie, Effect.map(Base64Url.encode));

export const hashOAuthClientSecret = (secret: string) =>
  sha256Base64Url("vektor-oauth-client-secret", secret);

export const hashOAuthToken = (token: string, type: StoreTokenType) =>
  sha256Base64Url(`vektor-oauth-${type}`, token);

/**
 * Runs a digest program as the Promise that the OAuth plugin awaits. The plugin types its `hash`
 * callbacks as `Awaitable<string>` (`@better-auth/oauth-provider` 1.7.1, `oauth-1Ud-hvZY.d.mts`
 * lines 1628 and 1645) and awaits every call (`utils-B77ebneW.mjs` lines 454, 481, 493, 503), so
 * the callbacks need no synchronous digest. The callback ABI has no cancellation signal.
 */
export type OAuthCallbackRunner = <A>(
  program: Effect.Effect<A, never, Crypto.Crypto>,
) => Promise<A>;

export const makeOAuthOptions = (
  config: OAuthProviderRuntimeConfig,
  run: OAuthCallbackRunner,
): OAuthOptions<Scope[]> => ({
  loginPage: new URL(OAUTH_DASHBOARD_LOGIN_PATH, config.dashboardOrigin).toString(),
  consentPage: new URL(OAUTH_DASHBOARD_CONSENT_PATH, config.dashboardOrigin).toString(),
  scopes: [...OAUTH_SCOPES],
  resources: [
    {
      identifier: OAUTH_NATIVE_API_RESOURCE,
      name: "Vektorprogrammet native API",
      accessTokenTtl: 60 * 10,
      refreshTokenTtl: 60 * 60 * 24 * 7,
      allowedScopes: [...OAUTH_SCOPES],
      signingAlgorithm: "ES256",
      dpopBoundAccessTokensRequired: false,
    },
  ],
  resourceSeedMode: "insertOnly",
  enforcePerClientResources: true,
  grantTypes: ["authorization_code", "client_credentials", "refresh_token"],
  accessTokenExpiresIn: 60 * 10,
  m2mAccessTokenExpiresIn: 60 * 5,
  refreshTokenExpiresIn: 60 * 60 * 24 * 7,
  refreshTokenReuseInterval: 0,
  codeExpiresIn: 60,
  disableJwtPlugin: false,
  storeClientSecret: { hash: (secret) => run(hashOAuthClientSecret(secret)) },
  storeTokens: { hash: (token, type) => run(hashOAuthToken(token, type)) },
  allowDynamicClientRegistration: false,
  allowUnauthenticatedClientRegistration: false,
  allowPublicClientPrelogin: false,
  prefix: {
    clientSecret: "vkr_cs_",
    refreshToken: OAUTH_REFRESH_TOKEN_PREFIX,
  },
  rateLimit: {
    authorize: { window: 60, max: 30 },
    token: { window: 60, max: 20 },
    introspect: { window: 60, max: 100 },
    revoke: { window: 60, max: 30 },
    register: false,
    userinfo: false,
  },
});

/**
 * The plugins of the one Better Auth engine. `run` is the callback runner of that engine, which
 * supplies the `Crypto` service to the digests that the OAuth plugin awaits.
 */
export const oauthPlugins = (config: OAuthProviderRuntimeConfig, run: OAuthCallbackRunner) =>
  [
    jwt({
      jwks: {
        keyPairConfig: { alg: "ES256" },
        disablePrivateKeyEncryption: false,
        rotationInterval: 60 * 60 * 24 * 7,
        gracePeriod: 60 * 15,
      },
      jwt: { issuer: oauthIssuer(config) },
    }),
    oauthProvider(makeOAuthOptions(config, run)),
  ] as const;
