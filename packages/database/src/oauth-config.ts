import { createHash } from "node:crypto";
import {
  oauthProvider,
  type OAuthOptions,
  type Scope,
  type StoreTokenType,
} from "@better-auth/oauth-provider";
import { jwt } from "better-auth/plugins";
import { Schema } from "effect";

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

export const sha256Base64Url = async (domain: string, value: string): Promise<string> =>
  createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("base64url");

export const hashOAuthClientSecret = (secret: string): Promise<string> =>
  sha256Base64Url("vektor-oauth-client-secret", secret);

export const hashOAuthToken = (token: string, type: StoreTokenType): Promise<string> =>
  sha256Base64Url(`vektor-oauth-${type}`, token);

export const makeOAuthOptions = (config: OAuthProviderRuntimeConfig): OAuthOptions<Scope[]> => ({
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
  storeClientSecret: { hash: hashOAuthClientSecret },
  storeTokens: { hash: hashOAuthToken },
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
export const makeOAuthPlugins = (config: OAuthProviderRuntimeConfig) =>
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
    oauthProvider(makeOAuthOptions(config)),
  ] as const;
