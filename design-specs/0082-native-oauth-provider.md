# Design spec 0082 — native OAuth provider

## Metadata

| Field           | Value                                                                      |
| --------------- | -------------------------------------------------------------------------- |
| Status          | Frozen                                                                     |
| Base revision   | `8912ebe2975eddfd6447ee6abfbc2a1e9dd3bb91`                                 |
| Dependency      | `0054.1` native Identity session hardening                                 |
| Dependency      | `0055.1` principal, credential, and access algebra                         |
| Dependency      | `0056.2` declarative rule reconciliation                                   |
| Dependency      | `0077.2` external operation and access matrix                              |
| Provider        | Better Auth `1.7.1` with `@better-auth/oauth-provider` `1.7.1`             |
| Provider source | Better Auth commit `2344536054f9164ca5d1670c270d299049ee233e`              |
| License         | MIT                                                                        |
| Purpose         | OAuth 2.1 authorization server for delegated people and service principals |

## 1. Scope and authority

This amendment freezes the native OAuth provider contract. It does not replace the first-party Better Auth session contract.

The provider supports two access-token journeys:

1. A delegated person uses authorization code with mandatory S256 PKCE.
2. A service principal uses client credentials.

Both journeys issue audience-bound bearer access tokens. Only the delegated journey can issue a refresh token.

The following boundaries are mandatory:

- `BetterAuthCookie` remains the first-party browser credential from specification 0054.1.
- `OAuthUserBearer` resolves only to `Person(PersonId)`.
- `OAuthServiceBearer` resolves only to `ServicePrincipal(ServicePrincipalId)`.
- A service principal is never an `auth.user`, synthetic `Person`, membership, or role.
- An OAuth scope is not a domain capability, grant, role, membership, ownership fact, state fact, or requirement result.
- Each protected request recalculates dynamic authorization through specification 0055.1.
- OAuth endpoints remain Better Auth credential-engine endpoints. They do not become native resource operations.
- No compatibility route, token decoder, issuer, audience, client registry, or authorization path is added.

Service-principal domain-grant persistence is not yet available. This amendment authenticates `ServicePrincipal` but does not add a rule subject, grant table, or protected-operation assignment for it. Specification 0056.3 owns that authorization cutover.

## 2. Canonical evidence and source constraints

### 2.1 Repository evidence

The base revision has these relevant facts:

| Observation                                                                          | Evidence                                                                                                       | Frozen resolution                                                                                                                    |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| The canonical source revision is `d3deaaf6b9512dc3f0e08f33ecdb082d3e563a71`.         | The integration handoff identifies this revision as the 0082 design base.                                      | All repository citations and implementation work use this revision.                                                                  |
| Better Auth owns the first-party engine.                                             | `packages/database/src/auth-engine.ts:1-65` constructs one Better Auth engine.                                 | Compose the OAuth and JWT plugins into this engine. Do not construct a second identity store.                                        |
| The engine uses the shared PostgreSQL database and the `auth` search path.           | `packages/database/src/auth-engine.ts:23-35` and `packages/database/src/layers.ts:25-58`.                      | Provider records stay in `auth`; domain principals and grants stay in `public`.                                                      |
| The canonical Better Auth base URL is currently taken from the first trusted origin. | `apps/backend/src/config.ts:152-155`.                                                                          | Add one canonical issuer-origin setting. Trusted browser origins cannot select the issuer.                                           |
| `/api/auth/*` is forwarded to the Better Auth handler.                               | `apps/backend/src/router.ts:291-303`.                                                                          | Add an explicit OAuth route allowlist before the handler. Provider endpoints are not exposed merely because the plugin defines them. |
| `auth.user.id` is `PersonId`, and sessions have no authoritative cache.              | `design-specs/0054.1-native-identity-session-hardening.md:33-62`.                                              | A delegated token keeps the same person and live session boundary.                                                                   |
| The access algebra already separates principals from credential mechanisms.          | `design-specs/0055.1-principal-credential-access-algebra.md:69-141`.                                           | Implement an OAuth credential authority that returns its `CredentialOutcome`.                                                        |
| Dynamic access denial is distinct from credential failure.                           | `design-specs/0055.1-principal-credential-access-algebra.md:367-410`.                                          | Invalid OAuth credentials produce 401. Valid principals denied by current authority produce 403.                                     |
| The implemented rule subject is currently `Person \| Tag`.                           | `packages/domain/src/authz/schema.ts:79-82`; `design-specs/0056.2-declarative-rule-reconciliation.md:159-168`. | Keep this persistence unchanged. Defer a strict `ServicePrincipal` subject and its grant semantics to 0056.3.                        |
| Native OpenAPI derives from the external native API.                                 | `design-specs/0055.1-principal-credential-access-algebra.md:605-669`.                                          | OAuth routes stay outside `NativeApi`; 0077.2 references their authorization and token URLs in security schemes.                     |

Specification 0054.1 remains authoritative for cookies, session expiry, immediate session revocation, origin checks, and CSRF controls. This amendment does not weaken those decisions.

### 2.2 Provider evidence

The accepted package is the npm artifact `@better-auth/oauth-provider@1.7.1`. Its npm integrity is:

```text
sha512-VWIw7ti6rodlbbdSbn0mts/7TzCbWUj6YaoIjpREmv8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U
```

The source decision uses Better Auth commit `2344536054f9164ca5d1670c270d299049ee233e`. The package and repository license are MIT.

The following sources are normative for provider behavior:

- [Official OAuth provider documentation at the pinned commit](https://github.com/better-auth/better-auth/blob/2344536054f9164ca5d1670c270d299049ee233e/docs/content/docs/plugins/oauth-provider.mdx)
- [Authorization request and consent implementation](https://github.com/better-auth/better-auth/blob/2344536054f9164ca5d1670c270d299049ee233e/packages/oauth-provider/src/authorize.ts)
- [Token issuance, code consumption, and refresh rotation](https://github.com/better-auth/better-auth/blob/2344536054f9164ca5d1670c270d299049ee233e/packages/oauth-provider/src/token.ts)
- [JWT and opaque-token introspection](https://github.com/better-auth/better-auth/blob/2344536054f9164ca5d1670c270d299049ee233e/packages/oauth-provider/src/introspect.ts)
- [Revocation behavior](https://github.com/better-auth/better-auth/blob/2344536054f9164ca5d1670c270d299049ee233e/packages/oauth-provider/src/revoke.ts)
- [Provider schema](https://github.com/better-auth/better-auth/blob/2344536054f9164ca5d1670c270d299049ee233e/packages/oauth-provider/src/schema.ts)
- [JWT key schema](https://github.com/better-auth/better-auth/blob/2344536054f9164ca5d1670c270d299049ee233e/packages/better-auth/src/plugins/jwt/schema.ts)

The npm README is only an installation pointer. It is not the behavior contract. The pinned package types, official documentation, and pinned source are the behavior contract.
The published 1.7.1 declarations make `Scope` a string type. They make each protected resource a structured `resources` entry. This amendment uses those exact shapes.

A temporary compile-only fixture imported `OAuthOptions`, `Scope`, and `StoreTokenType` from the exact npm artifact. TypeScript accepted the literal in section 4 with `noEmit`, strict mode, and NodeNext resolution. The fixture is not a repository artifact.

The 1.7.1 declarations expose custom `storeClientSecret.hash`, `storeClientSecret.verify`, and `storeTokens.hash` callbacks. They also expose the Better Auth database adapter boundary. They do not expose a handler-wide transaction callback that binds provider writes and caller-owned writes to one transaction.

### 2.3 Supported provider behavior

Better Auth 1.7.1 directly supplies these required parts:

| Required behavior                                                                                | Provider evidence                                                        |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Authorization code, refresh token, and client credentials grants                                 | `OAuthOptions.grantTypes` and the three handlers in `token.ts`           |
| Public and confidential client authentication                                                    | `token_endpoint_auth_method`, including `none` and `client_secret_basic` |
| S256 PKCE validation                                                                             | `authorize.ts:646-700` and `token.ts:1550-1625`                          |
| Hashed authorization codes, refresh tokens, and client secrets                                   | `storeTokens`, `storeClientSecret`, and `authorize.ts:917-950`           |
| Atomic one-use authorization-code consumption                                                    | `token.ts:1370-1405`                                                     |
| Refresh-token compare-and-swap                                                                   | `token.ts:635-709`                                                       |
| Protected resources and per-client resource links                                                | `resources`, `enforcePerClientResources`, and `oauthClientResource`      |
| JWT access tokens with `iss`, `sub`, `aud`, `client_id`, `azp`, `scope`, `iat`, `exp`, and `jti` | `token.ts:230-290`                                                       |
| Active-client, audience, and live-session checks                                                 | `introspect.ts:110-250`                                                  |
| Client-authenticated introspection                                                               | `introspect.ts:640-755`                                                  |
| Consent persistence and re-consent for expanded scopes or resources                              | `authorize.ts:798-895`                                                   |
| JWT key persistence and rotation options                                                         | Better Auth JWT plugin `jwks` schema and options                         |
| Closed dynamic-registration switches and endpoint rate-limit options                             | `OAuthOptions`                                                           |

### 2.4 Unsupported gaps and thin adapters

The provider does not directly satisfy every frozen rule. The implementation MUST add only the bounded adapters below.

| Gap in provider 1.7.1                                                                                        | Required thin adapter                                                                                  |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Registered loopback redirects allow port variance.                                                           | `ExactRedirectGuard` requires byte-for-byte equality for every environment, including loopback.        |
| Plugin installation defines more routes than this contract exposes.                                          | `OAuthRouteBoundary` exposes only the frozen allowlists in section 5.                                  |
| The provider has no Vektor client-kind or service-principal model.                                           | `OAuthClientAuthority` owns the binding and lifecycle table in section 14.                             |
| A provider refresh token has a sliding row expiry but no family absolute cap.                                | `OAuthReleaseBarrier` owns the 30-day family record and seven-day inactivity window.                   |
| The provider documents a cross-worker refresh-family race around separate adapter calls.                     | `OAuthReleaseBarrier` serializes each code or family with a PostgreSQL advisory lock.                  |
| A JWT access token is self-contained, and the provider revocation endpoint reports `unsupported_token_type`. | `OAuthAccessTokenState` records `jti` before response release and checks or revokes it on every use.   |
| Provider code-replay cleanup cannot revoke an already returned self-contained JWT by itself.                 | The code lock and `jti` state revoke the complete tracked family on detected replay.                   |
| Provider output is not a 0055.1 `CredentialOutcome`.                                                         | `OAuthCredentialAuthority` performs the mapping in section 12.                                         |
| The provider has no required append-only Vektor OAuth audit.                                                 | `OAuthSecurityAudit` records the closed, redacted events in section 17.                                |
| Provider client administration routes are HTTP endpoints.                                                    | `OAuthClientOperator` uses the documented adapter boundary in process; HTTP administration is blocked. |

An adapter MUST call a public plugin API, documented option, storage adapter boundary, or endpoint handler. It MUST NOT copy, patch, or fork provider source.

This amendment does not claim one ACID transaction across provider and Vektor-owned rows. Better Auth 1.7.1 has no supported handler-wide transaction hook for that guarantee. Section 10 freezes a fail-closed release barrier and defers stronger atomicity.

### 2.5 Implementation-blocking 0077.2 dependency

Implementation of the delegated protected-resource journey MUST NOT begin until specification 0077.2 is frozen.

Specification 0077.2 must name all of these existing, concrete items:

1. One existing `ExternalNativeApi` endpoint by method, path, and operation ID. It cannot add a proof-only route.
2. That endpoint's one colocated `AccessSpec`, including `OAuthUserBearer`, `Person`, capability, resolver, concealment, and decision time.
3. One disposable domain fixture constructor and its exact person, target-resource, and direct-grant keys.
4. One static delegated public-client fixture with its exact loopback redirect URI and no client secret.

The selected fixture must allow one bearer request, then remove current domain authority and make the same bearer receive 403. A synthetic endpoint, duplicate access registry, or invented route cannot satisfy this dependency.

## 3. Frozen identifiers

### 3.1 Issuer

Each deployment has one required `OAUTH_CANONICAL_ORIGIN`. It is an origin only: scheme, host, and optional port. It has no path, query, fragment, user information, or trailing slash.

The issuer is exactly:

```text
${OAUTH_CANONICAL_ORIGIN}/api/auth
```

The following laws apply:

1. Preview and production require `https`.
2. Explicit local development can use `http://127.0.0.1:<fixed-port>`.
3. `localhost`, wildcard hosts, forwarded host headers, request origins, and the trusted-origin array cannot select the issuer.
4. Boot fails if Better Auth, JWT, OAuth metadata, or the configured canonical origin produce a different issuer.
5. Issuer comparison is exact. No trailing-slash normalization or alias is accepted.

### 3.2 Protected resource and audience

The native API protected-resource identifier is exactly:

```text
urn:vektorprogrammet:native-api
```

`OAUTH_NATIVE_API_RESOURCE` is the single source for this value.

Every issued native bearer has exactly this audience. A request or token with an absent audience, a different audience, or more than this one audience is invalid.

Every registered issuing client has exactly one `oauthClientResource` link to this resource. `enforcePerClientResources` is `true`.

Every authorization and token request supplies this exact RFC 8707 `resource` value. The provider does not infer a default audience for a missing value.

### 3.3 Closed OAuth scopes

The closed scope registry is:

| Scope            | Meaning                                     | Allowed clients               |
| ---------------- | ------------------------------------------- | ----------------------------- |
| `native-api`     | Request a token for the native API resource | Delegated and service clients |
| `offline_access` | Request a rotating delegated refresh token  | Delegated clients only        |

No other OAuth scope is accepted. `openid`, `profile`, `email`, role names, department names, capability IDs, and permission strings are not OAuth scopes in this contract.

A delegated authorization request includes `native-api`. It can also include `offline_access`. A service request includes exactly `native-api`.

Scope order is canonical: `native-api offline_access`. A refresh request omits `scope` or repeats the original canonical set. It cannot add, drop, or rename a scope.

The `scope` claim is a credential boundary only. The resource server still evaluates every dynamic capability, scope, requirement, state, ownership, interval, and transaction rule.

## 4. Provider composition

The semantic provider configuration uses the exact 1.7.1 `OAuthOptions` shape:

```ts
import {
  oauthProvider,
  type OAuthOptions,
  type Scope,
  type StoreTokenType,
} from "@better-auth/oauth-provider";

declare const sha256Base64Url: (domain: string, value: string) => Promise<string>;

const OAUTH_SCOPES = ["native-api", "offline_access"] as const satisfies readonly Scope[];

const storeClientSecret = {
  hash: (secret: string) => sha256Base64Url("vektor-oauth-client-secret", secret),
} as const;

const storeTokens = {
  hash: (token: string, type: StoreTokenType) => sha256Base64Url(`vektor-oauth-${type}`, token),
} as const;

const OAUTH_OPTIONS = {
  loginPage: new URL("/dashboard/login", OAUTH_DASHBOARD_ORIGIN).toString(),
  consentPage: new URL("/dashboard/oauth/consent", OAUTH_DASHBOARD_ORIGIN).toString(),
  scopes: OAUTH_SCOPES,
  resources: [
    {
      identifier: "urn:vektorprogrammet:native-api",
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
  storeClientSecret,
  storeTokens,
  allowDynamicClientRegistration: false,
  allowUnauthenticatedClientRegistration: false,
  allowPublicClientPrelogin: false,
  prefix: {
    clientSecret: "vkr_cs_",
    refreshToken: "vkr_rt_",
  },
  rateLimit: {
    authorize: { window: 60, max: 30 },
    token: { window: 60, max: 20 },
    introspect: { window: 60, max: 100 },
    revoke: { window: 60, max: 30 },
    register: false,
    userinfo: false,
  },
} as const satisfies OAuthOptions<typeof OAUTH_SCOPES>;

betterAuth({
  baseURL: OAUTH_CANONICAL_ORIGIN,
  basePath: "/api/auth",
  // Preserve all 0054.1 options.
  plugins: [
    jwt({
      jwks: {
        keyPairConfig: { alg: "ES256" },
        disablePrivateKeyEncryption: false,
        rotationInterval: 60 * 60 * 24 * 7,
        gracePeriod: 60 * 15,
      },
      jwt: { issuer: `${OAUTH_CANONICAL_ORIGIN}/api/auth` },
    }),
    oauthProvider(OAUTH_OPTIONS),
  ],
});
```

`OAUTH_DASHBOARD_ORIGIN` is a required origin only. It cannot contain a path, query, fragment, or user information. It must be one of the 0054.1 trusted first-party origins.

The mounted page URLs are exactly `${OAUTH_DASHBOARD_ORIGIN}/dashboard/login` and `${OAUTH_DASHBOARD_ORIGIN}/dashboard/oauth/consent`. An API-relative page value is invalid.

The digest callbacks use platform SHA-256 and unpadded base64url. Domain separation is exact. When `verify` is absent, Better Auth hashes the presented secret and uses its own constant-time comparison. Operator rotation and release-barrier lookups call the same digest function. They do not import provider-internal hash functions.

The resource row is operator-reconciled before traffic. `insertOnly` is not permission to accept drift. Boot reads the row and fails if its identifier, algorithm, lifetimes, allowed scopes, or disabled state differs from this contract.

## 5. Route and ingress boundary

### 5.1 External OAuth allowlist

The external ingress exposes exactly these new OAuth routes:

| Method | Path                                               | Purpose                                           |
| ------ | -------------------------------------------------- | ------------------------------------------------- |
| `GET`  | `/.well-known/oauth-authorization-server/api/auth` | RFC 8414 metadata for the path issuer             |
| `GET`  | `/api/auth/jwks`                                   | Current and grace-period public signing keys      |
| `GET`  | `/api/auth/oauth2/authorize`                       | Delegated authorization request                   |
| `GET`  | `/api/auth/oauth2/public-client`                   | Session-protected bounded client view for consent |
| `POST` | `/api/auth/oauth2/consent`                         | Accept or deny the pending request                |
| `POST` | `/api/auth/oauth2/token`                           | Code, refresh, or client-credentials exchange     |
| `POST` | `/api/auth/oauth2/revoke`                          | Revoke one owned token or family                  |
| `GET`  | `/api/auth/oauth2/get-consents`                    | List the current person's bounded consents        |
| `POST` | `/api/auth/oauth2/delete-consent`                  | Withdraw one owned consent and revoke its grants  |

The existing 0054.1 Better Auth credential-engine routes remain unchanged.

The external ingress returns route-not-found for every other provider OAuth route. This includes dynamic registration, client CRUD, resource CRUD, introspection, UserInfo, OpenID configuration, end-session, device flow, and every `/admin/oauth2/*` route.

`POST /oauth2/authorize` is not an alias. Only the method and paths above are accepted.

### 5.2 Internal introspection allowlist

Remote introspection exists only on an independent ingress:

```text
InternalOAuthIngress -> OAuthIntrospectionRouter -> Better Auth introspection handler
```

It exposes exactly:

```text
POST /api/auth/oauth2/introspect
```

The external auth handler graph cannot mount, dispatch, or fall through to this router. Hiding introspection from OpenAPI is not isolation.

The internal ingress requires all of these controls:

1. TLS terminates at the owned ingress.
2. The source network is in the operator-owned resource-server allowlist.
3. The caller is a live `ResourceServer` client.
4. The caller uses `client_secret_basic`.
5. The caller is linked to `urn:vektorprogrammet:native-api`.
6. The request meets the introspection rate limit.

An unauthorized, unknown, or wrong-resource caller receives the provider's non-enumerating inactive result or client-authentication error. It receives no token existence signal.

### 5.3 Native API and documentation

OAuth routes are outside `ExternalNativeApi` and `InternalNativeApi`. They do not get native operation IDs or `AccessSpec` values.

The 0077.2 OpenAPI security schemes use the frozen authorization URL, token URL, and scope registry. Public native OpenAPI does not list provider administration, consent storage, revocation, JWKS, metadata, or introspection as native resource operations.

## 6. Static client model

### 6.1 Client kinds

```ts
type OAuthClientKind = "DelegatedPublic" | "DelegatedConfidential" | "Service" | "ResourceServer";
```

The database is the sole runtime client registry. An operator manifest is command input, not a second live registry.

| Field           | Delegated public                        | Delegated confidential                | Service               | Resource server       |
| --------------- | --------------------------------------- | ------------------------------------- | --------------------- | --------------------- |
| Grant types     | `authorization_code`, `refresh_token`   | `authorization_code`, `refresh_token` | `client_credentials`  | none                  |
| Token auth      | `none`                                  | `client_secret_basic`                 | `client_secret_basic` | `client_secret_basic` |
| PKCE            | required S256                           | required S256                         | not applicable        | not applicable        |
| Redirect URIs   | nonempty exact set                      | nonempty exact set                    | empty                 | empty                 |
| Scopes          | `native-api`, optional `offline_access` | same                                  | `native-api`          | empty                 |
| Resource links  | native API only                         | native API only                       | native API only       | native API only       |
| Consent         | required                                | required                              | none                  | none                  |
| Refresh token   | optional when consented                 | optional when consented               | forbidden             | forbidden             |
| Service binding | forbidden                               | forbidden                             | exactly one           | forbidden             |

All clients have `skipConsent = false`, `enableEndSession = false`, and `subjectType = public`.

### 6.2 Registration

Dynamic client registration is disabled. Unauthenticated registration is disabled. Client-discovery extensions are absent.

Only `OAuthClientOperator` can create a client. It performs this fail-closed sequence:

1. Decode a strict operator manifest.
2. Reject an unknown field or client kind.
3. Validate exact redirects, grants, scopes, authentication method, and resource link.
4. Generate a 32-byte secret only for a confidential client.
5. Hash the unprefixed secret with the configured public callback.
6. Create the provider client and resource link through the documented storage adapter boundary.
7. In one Vektor-owned transaction, create the binding, create the service principal when required, and append the audit event.
8. Return a new confidential secret exactly once after both stages succeed.

The pre-provider `OAuthClientAuthority` rejects every client without a live Vektor binding. If the provider stage succeeds and the owned stage fails, no token endpoint accepts the orphan. The operator command reports failure and requires bounded repair. It never claims shared atomicity.

A migration, log, audit row, fixture, source file, process argument, or command history cannot contain a client secret.

### 6.3 Redirect URIs

Redirect comparison is byte-for-byte after strict URI decoding. There is no wildcard, suffix, prefix, regular expression, query wildcard, fragment, or hostname alias.

Preview and production redirects use `https`. Local development can register one explicit `http://127.0.0.1:<fixed-port>/<fixed-path>` value.

`localhost`, an unspecified loopback port, and provider loopback port variance are rejected. A redirect URI is sent only after the requested value equals one registered value.

### 6.4 Client credentials and rotation

A confidential client secret has 32 random bytes before base64url encoding. The `vkr_cs_` prefix is not part of its entropy.

The configured callback stores only its domain-separated SHA-256 digest. The security model relies on high-entropy generation, not password-hardening.

`auth.oauth_client_bindings.secret_expires_at` is the authoritative 90-day expiry. `OAuthClientAuthority` rejects expiry before provider dispatch. The provider's 1.7.1 client schema does not supply this Vektor lifecycle guarantee.

Rotation acquires the client advisory lock. One owned PostgreSQL transaction replaces the provider digest, advances binding expiry and revision, and appends the audit event. The new secret is emitted only after commit. The old secret then fails immediately.

There is no dual-secret overlap. A caller that needs overlap gets a second client ID and a separate operator-approved cutover.

Public clients never receive or store a secret.

## 7. Delegated authorization-code flow

A delegated authorization request is accepted only when it has all of these values:

- `response_type=code`
- one registered delegated `client_id`
- one exact registered `redirect_uri`
- a nonempty `state`
- `code_challenge_method=S256`
- a valid S256 `code_challenge`
- `resource=urn:vektorprogrammet:native-api`
- `scope=native-api` or `scope=native-api offline_access`

The state and PKCE verifier each have at least 32 random bytes of entropy. The authorization server does not log either value.

The provider hashes the authorization code before storage. The code lifetime is 60 seconds. The code is bound to the client, redirect URI, person, live session, resource, scope set, and S256 challenge.

The token exchange repeats the exact `client_id`, `redirect_uri`, resource, and verifier. A confidential client also authenticates with `client_secret_basic`. A public client sends no secret.

`ExactRedirectGuard` runs before the provider's redirect handling. An unregistered redirect never receives an OAuth error, code, or state.

The first valid exchange consumes the code through the provider's one-use path. A second or concurrent exchange returns `invalid_grant` and revokes the tracked grant family.

Authorization code, verifier, challenge, pending query, raw redirect query, and token response are never audit evidence.

## 8. Consent contract

The consent page uses the live Better Auth session from specification 0054.1. It displays:

- the registered client name;
- whether the client is public or confidential;
- the exact redirect origin;
- “Access the Vektorprogrammet native API” for `native-api`;
- “Stay connected for up to 30 days, with use at least every 7 days” for `offline_access`;
- the native API resource name;
- separate accept and deny actions.

The page does not display a client-provided HTML description. Client names and redirect values are rendered as text.

`skipConsent` is always false. The first grant requires an explicit acceptance. A stored consent can satisfy a later identical request. A new scope or resource always requires new consent. `prompt=consent` always shows consent. `prompt=none` never creates consent.

A person can list and withdraw only their own consent. Withdrawal uses the ordered boundary in section 10.5:

1. One owned transaction revokes every refresh family and tracked access-token `jti` for that person and client.
2. The provider deletes the owned consent.
3. The operation appends bounded audit and reports success only after both stages succeed.

A missing and non-owned consent have the same concealed result.

The consent response uses the existing first-party origin and CSRF rules. A client redirect origin is not a trusted first-party origin.

### 8.1 Dashboard page integration

The dashboard already mounts React Router below `/dashboard/`. The implementation adds the consent route there and extends the existing login route. It does not add an API-hosted HTML page.

The provider appends a signed, expiring OAuth query to each configured page URL. Dashboard code treats that query as opaque credential-engine state. It applies an 8 KiB limit and never logs, stores, normalizes, reorders, or adds parameters.

For OAuth login, the existing `/dashboard/login` action sends `oauth_query` in the JSON body of the same `/api/auth/sign-in/email` request. This activates the provider's documented before and after hooks. On success, those hooks create the session and continue authorization.

The login proxy forwards the browser `Origin` and request correlation. It forwards provider `Set-Cookie` headers to the browser. It does not forward a bearer header. Non-OAuth login continues to use `safeRedirect`; OAuth login never uses a client-supplied `redirectTo`.

The provider returns its continuation as JSON because the server proxy requests JSON. `OAuthContinuationGuard` accepts only:

1. the exact mounted consent URL with provider-signed query parameters; or
2. the original client's exact registered redirect URI with provider-owned OAuth response parameters.

For the second case, the guard re-reads the static client and exact original redirect. It requires the returned `state` and `iss` to equal the pending request and frozen issuer. Any other URL becomes a local no-store error.

### 8.2 Consent loader and action

The `/dashboard/oauth/consent` loader requires the live 0054.1 cookie. It fetches `/api/auth/oauth2/public-client` with the exact cookie, browser origin, client ID, and request correlation.

The loader uses provider-returned client data for the client name. It displays requested scope, resource, and redirect origin only as escaped text. It does not treat query data as trusted authority.

Accept and deny actions require the React Router origin check. They forward the exact cookie and browser `Origin` to `/api/auth/oauth2/consent`. Their JSON body contains only `accept`, the exact accepted scope when present, and the original `oauth_query`.

Better Auth verifies the query signature and expiry before consent handling. The dashboard does not duplicate that verification. It forwards provider `Set-Cookie` values and passes the returned URL through `OAuthContinuationGuard`.

A missing origin, changed query byte, expired signature, wrong cookie, untrusted origin, malformed provider response, or unapproved continuation fails locally. Every page and action response uses `Cache-Control: no-store`.

## 9. Token contract

### 9.1 Lifetimes

| Artifact                    |                                 Lifetime | Renewal                         |
| --------------------------- | ---------------------------------------: | ------------------------------- |
| Authorization code          |                               60 seconds | none                            |
| Delegated access token      |                               10 minutes | refresh or new authorization    |
| Service access token        |                                5 minutes | new client-credentials exchange |
| Refresh token row           |        7 days from its issue or rotation | rotate on every use             |
| Refresh family inactivity   | 7 days from its last successful rotation | successful rotation only        |
| Refresh family absolute     |       30 days from initial code exchange | never extended                  |
| Confidential client secret  |                                  90 days | operator rotation               |
| Signing key active interval |                                   7 days | automatic rotation              |
| Retired public-key grace    |                               15 minutes | none                            |

All intervals are half-open: `issuedAt <= now < expiresAt`. Runtime credential validation uses no expiry grace. Hosts require synchronized clocks.

### 9.2 JWT access token

Each native access token is a signed JWT with this required shape:

```ts
type NativeAccessTokenClaims = {
  readonly iss: OAuthIssuer;
  readonly sub: string;
  readonly aud: "urn:vektorprogrammet:native-api";
  readonly exp: number;
  readonly iat: number;
  readonly jti: string;
  readonly client_id: OAuthClientId;
  readonly azp: OAuthClientId;
  readonly scope: "native-api" | "native-api offline_access";
  readonly sid?: string;
};
```

The protected header has `typ = "at+jwt"`, `alg = "ES256"`, and a known `kid`.

For a delegated token:

- `sub` is the canonical `PersonId` from `auth.user.id`;
- `sid` is required and names the live Better Auth session;
- `scope` can include `offline_access`.

For a service token:

- `sub` equals the issuing OAuth `client_id`, as required by the provider's client-credentials implementation;
- `sid` is absent;
- `scope` is exactly `native-api`;
- `OAuthClientAuthority` maps the immutable client binding to `ServicePrincipalId`.

A token contains no role, membership, department, team, domain grant, capability, requirement result, ownership result, policy verdict, or authority revision.

The resource server accepts the bearer only in one `Authorization: Bearer` header. It rejects a bearer in a query, form field, cookie, or second authorization header. The maximum encoded token size is 8 KiB.

### 9.3 Refresh token

A refresh token is opaque, prefixed `vkr_rt_`, and stored only as a provider hash. It is bound to one client, person, Better Auth session, scope set, resource, and refresh family.

The provider rotates it on every successful use. `refreshTokenReuseInterval` is zero. A used parent token never returns a cached response.

A service or resource-server client never receives a refresh token.

## 10. Provider operation boundary and release barrier

### 10.1 Supported 1.7.1 boundary

Better Auth 1.7.1 owns its provider writes. Vektor code calls the public handler and documented storage adapter boundary. It does not reach into provider modules.

The public package does not provide a handler-wide transaction hook that shares the provider connection with Vektor-owned writes. `DBAdapter.transaction` does not make the complete OAuth handler join a caller transaction. This amendment therefore freezes no cross-store ACID claim.

`OAuthReleaseBarrier` is the smallest required boundary. It wraps code exchange, refresh, client-credentials issuance, JWT revocation, and consent withdrawal.

### 10.2 Lock and response release

For code and refresh requests, the barrier acquires one session-level PostgreSQL advisory lock on a dedicated pooled connection. A code uses its configured digest. A refresh uses its provider `authorizationCodeId` family key. Every application instance uses the same key derivation.

The barrier then calls the provider handler exactly once. It materializes at most 64 KiB of status, headers, and body in private memory. It rejects a larger or malformed OAuth response.

For a successful token response, the barrier verifies the returned access token locally. One Vektor-owned transaction then writes the family change, live `jti` state, and audit event. Only after that transaction commits does the barrier construct and return a new response.

If the owned transaction fails, no token response leaves the process. The provider may already have consumed a code or rotated a refresh token. The request fails closed and can require operator repair. The implementation must not describe this outcome as rollback.

Expected OAuth 4xx responses can leave after required replay or rejection state commits. An exception, malformed response, unexpected 5xx response, or missing owned state releases no credential.

The advisory connection is released in `finally`. No lock, response body, token, or request context survives the request.

### 10.3 Initial code exchange

For an authorization-code exchange, the barrier:

1. Computes the configured authorization-code digest without recording the code.
2. Acquires the code advisory lock.
3. Re-reads the provider verification row and owned family marker.
4. If a family already names the digest, revokes that tracked family and returns `invalid_grant`.
5. Calls the provider handler when no replay marker exists.
6. Buffers and decodes the successful response.
7. Verifies issuer, audience, client, person, session, lifetime, and `jti`.
8. Creates the family, live token state, and issuance audit in one owned transaction.
9. Releases the response only after commit.

The provider remains responsible for its atomic one-use verification-row consumption. The Vektor lock serializes all supported ingress calls for the same code.

### 10.4 Refresh rotation

For a refresh exchange, the barrier:

1. Computes the configured refresh-token digest without recording the token.
2. Reads its provider row only to obtain the immutable family key.
3. Acquires the family advisory lock and re-reads provider and owned state.
4. Rejects an inactive session, client, consent, family, parent, inactivity window, or absolute window.
5. Calls the provider rotation and requires its compare-and-swap to win.
6. Buffers and verifies the new token response.
7. In one owned transaction, updates family liveness, records the new `jti`, and appends the rotation event.
8. Releases the response only after commit.

A concurrent caller waits for the lock. It then sees the used parent, revokes the tracked family and all family `jti` values in one owned transaction, and returns `invalid_grant`.

### 10.5 Revocation and withdrawal ordering

Owned revocation state is the resource server's authoritative fail-closed gate. Family revocation first marks the family and every family `jti` revoked in one owned transaction. The provider cleanup runs next. Success is returned only after both stages succeed.

If provider cleanup fails, future refresh and access requests still fail through owned state. The operation reports failure and a bounded retry completes provider cleanup.

Consent withdrawal uses the same order: revoke owned families and `jti` values first, invoke the provider's owned-consent deletion second, and report success only after both succeed.

Stronger all-or-nothing atomicity across provider and owned writes is explicitly deferred. A later amendment requires a supported upstream handler transaction hook or a separately proven adapter design.

## 11. Revocation semantics

| Cause                                                 | Immediate result                                                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Explicit access-token revocation                      | The `jti` state becomes revoked. The next resource request is 401.                                       |
| Explicit refresh-token revocation                     | The complete refresh family and its tracked access tokens become revoked.                                |
| Consent withdrawal                                    | All person-and-client families and tracked access tokens become revoked.                                 |
| Refresh-token reuse                                   | The complete family becomes revoked.                                                                     |
| Better Auth session expiry or revocation              | Delegated access and refresh credentials for that `sid` become invalid.                                  |
| OAuth client disablement or secret expiry             | New issuance stops; every bearer from that client becomes invalid.                                       |
| Service-principal disablement                         | Every bearer mapped to that service principal becomes invalid.                                           |
| Resource deletion                                     | The provider audience check makes associated tokens inactive.                                            |
| Resource disablement                                  | New issuance stops. Existing tokens continue only until their other state or 10-minute expiry.           |
| Domain grant, role, scope, ownership, or state change | The credential can remain valid, but the next access decision uses current authority and can return 403. |

The application wrapper handles JWT access-token revocation. It does not call the provider branch that returns `unsupported_token_type` for a self-contained JWT.

The revocation endpoint authenticates the client according to its registered method. It never lets one client revoke another client's token.

## 12. OAuth credential authority

### 12.1 Resolver

`OAuthCredentialAuthority` is the only production bridge from a bearer to the 0055.1 credential algebra.

It performs these steps for each protected request:

1. Require exactly one bearer header.
2. Parse a bounded JWT.
3. Verify `typ`, `alg`, `kid`, signature, exact issuer, exact audience, `iat`, and `exp`.
4. Require a live `jti` row with matching immutable claims.
5. Load the live OAuth client and its Vektor binding.
6. Require the exact closed scope set for that client kind.
7. For a delegated binding, require `sub = auth.user.id` and a live matching `sid`.
8. For a service binding, require `sub = client_id`, no `sid`, and a live bound service principal.
9. Return a bounded evidence reference and principal.

It never accepts a JWT only because its signature is valid.

### 12.2 Mapping to 0055.1

| Outcome                                                                                 | 0055.1 result                                                                     |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| No bearer on a bearer-required endpoint                                                 | `Rejected("Missing")`                                                             |
| Bad header or JWT syntax                                                                | `Rejected("Malformed")`                                                           |
| Bad signature, issuer, audience, scope, client, binding, `jti`, or claim correspondence | `Rejected("Invalid")`                                                             |
| `exp` or row expiry reached                                                             | `Rejected("Expired")`                                                             |
| Revoked `jti`, family, session, client, consent, or service principal                   | `Rejected("Revoked")`                                                             |
| User bearer sent where only service bearer is accepted, or the reverse                  | `Rejected("WrongMechanism")`                                                      |
| Bearer plus another accepted credential                                                 | `Rejected("AmbiguousMechanism")`                                                  |
| Valid delegated bearer                                                                  | `Accepted(OAuthUserBearer, Person(PersonId), evidenceRef)`                        |
| Valid service bearer                                                                    | `Accepted(OAuthServiceBearer, ServicePrincipal(ServicePrincipalId), evidenceRef)` |

The evidence reference can contain only `jti`, `clientId`, credential kind, and issuance time. It cannot contain the JWT, a token hash, secret, code, verifier, raw header, or reconstructible credential.

Credential rejection projects to 401, with the standard Bearer challenge where applicable. A resolved principal denied by current domain authority projects to 403 unless its endpoint has explicit 0055.1 concealment.

## 13. Service-principal authority

```ts
type ServicePrincipal = {
  readonly servicePrincipalId: ServicePrincipalId;
  readonly name: string;
  readonly state: "Active" | "Disabled";
  readonly revision: number;
};
```

One `Service` OAuth client owns exactly one service principal. One service principal is bound to exactly one OAuth client. The binding is immutable.

A service principal has no password, email, Better Auth user, browser session, consent, refresh token, membership, tag assignment, or implied capability.

The existing `AuthzRuleSubject = Person | Tag` schema and persistence remain unchanged. This amendment does not persist a `ServicePrincipal` grant.

`ServicePrincipal` is a real 0055.1 principal, but authentication does not imply authorization. The 0082 implementation proves this mapping only at `OAuthCredentialAuthority`.

No external `AccessSpec` accepts `OAuthServiceBearer` until specification 0056.3 freezes and implements the complete authorization cutover. A service bearer sent to a person-only endpoint is a wrong mechanism and produces 401. It is not a domain 403 decision.

Specification 0056.3 must cover the rule subject, SQL constraints, decoders, evaluators, migrations, grants, scopes, requirements, tests, and operation assignments in one change.

No implementation can use a person, tag, role, client kind, OAuth scope, client metadata, or hard-coded client ID as an interim service grant.

Disabling a service principal is an operator action. The transaction sets the service state to `Disabled`, disables the bound client, revokes tracked access-token state, and appends one audit event.

Deletion is forbidden while any client, audit, or token-state row refers to the principal. Normal lifecycle uses disablement, not deletion.

## 14. Persistence and migration contract

### 14.1 Sequential migration

Implementation adds one sequential migration after revision 26:

```text
0027-native-oauth-provider.sql
```

`databaseSchemaRevision` becomes `27_native_oauth_provider`.

The checked-in migration contains the exact schema generated from Better Auth 1.7.1 plus the owned additions below. Runtime auto-migration is disabled. Boot never mutates schema.

### 14.2 Provider relations

The `auth` schema contains the exact plugin relations:

- `auth."oauthClient"`
- `auth."oauthResource"`
- `auth."oauthClientResource"`
- `auth."oauthRefreshToken"`
- `auth."oauthAccessToken"`
- `auth."oauthConsent"`
- `auth."oauthClientAssertion"`
- `auth.jwks`

Authorization codes use the existing `auth.verification` relation. The implementation does not add a second authorization-code table.

The migration preserves the provider's required unique keys, foreign keys, resource-link composite uniqueness, token indexes, and client indexes.

### 14.3 Owned relations

#### `public.service_principals`

| Column                     | Contract                                 |
| -------------------------- | ---------------------------------------- |
| `service_principal_id`     | Primary key; strict `ServicePrincipalId` |
| `name`                     | Trimmed nonempty display name            |
| `state`                    | `Active \| Disabled` check               |
| `revision`                 | Nonnegative integer                      |
| `created_at`, `updated_at` | `timestamptz`, ordered                   |

#### `auth.oauth_client_bindings`

| Column                     | Contract                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `client_id`                | Primary key and FK to `auth."oauthClient"."clientId"`, delete restricted             |
| `client_kind`              | Closed `DelegatedPublic \| DelegatedConfidential \| Service \| ResourceServer` check |
| `service_principal_id`     | Nullable unique FK to `public.service_principals`, delete restricted                 |
| `secret_expires_at`        | Null only for public clients; required for confidential clients                      |
| `revision`                 | Nonnegative integer advanced by operator mutations                                   |
| `created_at`, `updated_at` | `timestamptz`, ordered                                                               |

A check requires `service_principal_id` exactly for `Service`. No other kind can carry it.

#### `auth.oauth_refresh_families`

| Column                       | Contract                                                            |
| ---------------------------- | ------------------------------------------------------------------- |
| `family_id`                  | Random primary key; safe audit reference                            |
| `authorization_code_id`      | Unique provider code digest; private linkage, never emitted         |
| `client_id`                  | FK to binding, delete restricted                                    |
| `person_id`                  | FK to `auth.user.id`, delete restricted                             |
| `session_id`                 | FK to `auth.session.id`, delete restricted while active             |
| `created_at`, `last_used_at` | Ordered `timestamptz`                                               |
| `inactivity_expires_at`      | At most seven days after `last_used_at` and at most absolute expiry |
| `absolute_expires_at`        | Exactly 30 days after `created_at`                                  |
| `revoked_at`                 | Nullable monotonic timestamp                                        |
| `revocation_reason`          | Closed reason, required exactly when revoked                        |

#### `auth.oauth_access_token_state`

| Column                    | Contract                                     |
| ------------------------- | -------------------------------------------- |
| `jti`                     | Primary key; no raw token                    |
| `family_id`               | Nullable FK for delegated refresh families   |
| `client_id`               | FK to binding                                |
| `principal_kind`          | `Person \| ServicePrincipal`                 |
| `person_id`               | Present exactly for `Person`                 |
| `service_principal_id`    | Present exactly for `ServicePrincipal`       |
| `session_id`              | Present exactly for delegated tokens         |
| `issued_at`, `expires_at` | Exact JWT times                              |
| `revoked_at`              | Nullable monotonic timestamp                 |
| `revocation_reason`       | Closed reason, required exactly when revoked |

The row values must equal the signed claims and immutable client binding. A missing row makes the bearer invalid.

#### `auth.oauth_security_audit`

This append-only relation uses the contract in section 17.

### 14.4 Rule persistence stays unchanged

Migration 0027 does not alter `public.authz_rules`, `public.authz_tags`, or their subject constraints.

It does not add `subject_service_principal_id`, a service-grant table, a compatibility subject, or a hard-coded client-to-capability mapping.

Specification 0056.3 owns the future service-principal grant migration. Until that amendment lands, every authenticated service principal has no persisted domain grant.

## 15. Signing keys and JWKS

ES256 is the only access-token signing algorithm. The provider stores encrypted private JWK material in `auth.jwks`. Public keys are available at `/api/auth/jwks`.

The key lifecycle is:

1. The first operator bootstrap creates a key before the provider accepts traffic.
2. A key becomes active for new signatures for seven days.
3. Rotation creates a new active key with a new random `kid`.
4. The previous public key remains in JWKS for 15 minutes.
5. The previous private key is not used for new signatures after rotation.
6. After grace, the retired key is removed by the owned key-maintenance command.

The 15-minute grace exceeds the longest 10-minute access-token lifetime and the required five-minute remote JWKS cache maximum.

A resource server refreshes JWKS when it sees an unknown `kid`, subject to bounded request coalescing. It never falls back to another algorithm or key.

Boot fails when there is no usable ES256 key, multiple active keys, a duplicate `kid`, an unencrypted private key, or a grace interval shorter than 15 minutes.

The JWKS response contains public material only. It uses `Cache-Control: public, max-age=300, must-revalidate` and a strong ETag. OAuth token and consent responses use `Cache-Control: no-store` and `Pragma: no-cache`.

## 16. Transport and abuse controls

### 16.1 TLS, CORS, and CSRF

Production and preview accept OAuth only over HTTPS. Local HTTP is limited to the explicit `127.0.0.1` composition.

The token, revoke, and introspection endpoints accept `application/x-www-form-urlencoded` only. They reject cookies and do not enable browser CORS.

Authorization is a top-level GET navigation. It requires `state` and S256 PKCE. The consent and consent-management endpoints require the 0054.1 first-party cookie, trusted origin, and CSRF protection.

No OAuth response uses `Access-Control-Allow-Origin: *`. No credentialed response uses a reflected client origin.

Authorization and consent pages set `Referrer-Policy: no-referrer`, `Content-Security-Policy: frame-ancestors 'none'`, and `Cache-Control: no-store`.

### 16.2 Client authentication

Confidential endpoints accept `client_secret_basic` only. `client_secret_post`, query credentials, bearer client credentials, and cookies are rejected.

Public clients use `token_endpoint_auth_method=none` and mandatory S256 PKCE. A public client cannot use client credentials.

Client authentication uses constant-time hash verification. All client-authentication failures use the same external `invalid_client` shape for that endpoint.

### 16.3 Rate and size limits

The provider limits in section 4 are mandatory. The ingress also applies these compound keys:

| Surface                             | Compound key                       |              Limit |
| ----------------------------------- | ---------------------------------- | -----------------: |
| Authorization                       | source IP and client ID            |  30 per 60 seconds |
| Token                               | source IP and client ID            |  20 per 60 seconds |
| Invalid confidential authentication | source IP and client ID            |  10 per 60 seconds |
| Consent mutation                    | session ID                         |  20 per 60 seconds |
| Introspection                       | source network and client ID       | 100 per 60 seconds |
| Revocation                          | source IP or network and client ID |  30 per 60 seconds |

Limits fail closed without disabling a client globally. They do not disclose whether a client, code, refresh token, or bearer exists.

OAuth request headers are limited to 16 KiB. Form bodies are limited to 16 KiB. Authorization query strings are limited to 8 KiB. A limit failure occurs before body logging or provider dispatch.

### 16.4 Issuance restrictions

The provider supports no implicit grant, password grant, device grant, token exchange, JWT bearer grant, CIBA grant, or custom extension grant.

A service client can mint only a five-minute native API token. It cannot mint for a person, another service principal, a second audience, or an added scope.

An operator can disable a client immediately. Static registration, secret rotation, service disablement, key maintenance, and network allowlists are not public HTTP operations.

## 17. Security audit and redaction

### 17.1 Closed event kinds

`auth.oauth_security_audit.event_kind` is one of:

- `oauth-client-provisioned`
- `oauth-client-secret-rotated`
- `oauth-client-disabled`
- `oauth-service-principal-disabled`
- `oauth-consent-accepted`
- `oauth-consent-denied`
- `oauth-consent-withdrawn`
- `oauth-authorization-code-issued`
- `oauth-authorization-code-rejected`
- `oauth-authorization-code-replay`
- `oauth-token-issued`
- `oauth-refresh-rotated`
- `oauth-refresh-replay`
- `oauth-access-token-revoked`
- `oauth-refresh-family-revoked`
- `oauth-client-authentication-rejected`
- `oauth-bearer-rejected`
- `oauth-introspection-rejected`
- `oauth-signing-key-rotated`

Successful native resource access uses the 0055.1 access trace and domain audit. It does not add one OAuth security row per successful request.

### 17.2 Audit row

Each row has:

- random `event_id` primary key;
- `occurred_at`;
- closed `event_kind`;
- optional `client_id`;
- optional `family_id`;
- optional `jti`;
- optional `subject_person_id`;
- optional `subject_service_principal_id`;
- bounded `actor_principal`;
- required request correlation;
- bounded source IP and user-agent fields consistent with 0054.1;
- strict JSON `details` with event-specific allowed keys.

The relation denies update and delete to the application role. Its trigger rejects an unknown event kind, forbidden detail key, or missing correlation.

### 17.3 Forbidden evidence

No log, metric, trace, audit row, exception, assertion message, or test artifact can contain:

- an access token or refresh token;
- a client secret or its stored hash;
- an authorization code or its stored digest;
- a PKCE verifier or challenge;
- raw `Authorization`, `Cookie`, or `Set-Cookie` data;
- a raw OAuth request body or query;
- `state`, pending authorization query, or consent cookie;
- private JWK material;
- an arbitrary client-provided string.

Safe evidence can contain a registered client ID, service-principal ID, person ID, family ID, JWT `jti`, registered scope IDs, registered resource ID, denial category, and timestamps.

Redaction occurs before structured logging. Error handling cannot depend on later log scrubbing.

## 18. Dynamic authorization composition

A bearer proves a principal and bounded token facts. It never carries the current authorization verdict.

For each person-bearing native API request, the order is:

```text
route match
  -> endpoint AccessSpec
  -> OAuthCredentialAuthority
  -> Person
  -> canonical resource resolver
  -> current direct grants and role/rule macros
  -> current interval, scope, ownership, state, and requirements
  -> SnapshotRead or Transaction decision
  -> domain operation
```

The evaluator reloads current authority for every request. It does not cache grants in a JWT, token-state row, client binding, or introspection response.

Service-principal domain grants and operation assignments are unavailable in this amendment. Service bearer resolution is tested directly. Native HTTP projection remains disabled until 0056.3.

OAuth token scope never satisfies a 0055.1 `Scope`, `CapabilityExpression`, or `TypedRequirement`. Client registration never grants a domain capability.

An inactive credential fails before principal resolution and returns 401. A valid person accepted by an endpoint but denied by current domain authority returns 403, subject to explicit endpoint concealment.

## 19. Errors and protocol responses

OAuth endpoint errors use the provider's OAuth error taxonomy. This narrow protocol representation is part of OAuth and does not define general native Problem Details.

| Condition                                                              | OAuth endpoint result                            |
| ---------------------------------------------------------------------- | ------------------------------------------------ |
| Missing or malformed parameter                                         | `invalid_request`                                |
| Failed confidential authentication                                     | `invalid_client`; Basic challenge where required |
| Unknown, expired, consumed, replayed, or mismatched code/refresh token | `invalid_grant`                                  |
| Unknown scope                                                          | `invalid_scope`                                  |
| Wrong or unlinked resource                                             | `invalid_target`                                 |
| Unsupported grant                                                      | `unsupported_grant_type`                         |
| Denied consent                                                         | `access_denied` through validated redirect       |
| Introspection of inactive or unauthorized token                        | `200 { "active": false }`                        |

An authorization error redirects only when the requested redirect URI passed exact registration validation. Otherwise, it renders a local no-store error.

For a native resource request, missing or invalid OAuth credentials map through section 12 to the frozen 0055.1 401 behavior. Dynamic authorization denial remains 403.

## 20. Implementation cutover

The matching implementation is one clean cutover:

1. Add the exact package at version `1.7.1` and keep Better Auth at `1.7.1`.
2. Compose one JWT plugin and one OAuth provider plugin into the existing engine.
3. Add the canonical issuer, dashboard-origin, and internal-ingress configuration decoders.
4. Add migration 0027 with generated provider schema and owned relations.
5. Add the strict static client, service-principal, and resource authorities.
6. Add the thin route, redirect, lock, release-barrier, `jti`, credential, and audit adapters.
7. Add the owned dashboard `/dashboard/oauth/consent` page and route. Its pending-request loader and action preserve the exact query, enforce 0054.1 CSRF and origin rules, and submit it for Better Auth signed-query validation. This is owned implementation-cutover work, not an external deliverable.
8. Keep the existing `Person | Tag` rule subject and persistence unchanged.
9. Split external OAuth protocol routing from internal introspection routing.
10. Add the OAuth credential resolver to the 0055.1 evaluator binding.
11. After 0077.2 is frozen, implement only its named person endpoint, `AccessSpec`, and fixtures.
12. Update the 0077.2 OAuth security schemes from these frozen URLs and scopes.
13. Remove any temporary bearer parser, token map, fake service person, or old route in the same change.

There is no dual issuer, dual audience, compatibility token format, legacy refresh path, temporary plaintext secret, optional `jti` state, or second authorization registry.

## 21. Operator authority

Only an authorized operator can perform these effects:

- provision, rotate, disable, or replace a confidential client;
- create or disable a service principal;
- change the resource-server network allowlist;
- run schema migration 0027;
- bootstrap or retire signing keys;
- set the production canonical origin and secrets;
- deploy the provider;
- inspect production OAuth security audit data.

The implementation provides bounded commands for these operations. It does not expose the provider's client or resource administration endpoints.

A command supports dry-run validation. A mutating run requires explicit target and authority. It prints no secret except the one-time newly generated client secret on the operator-controlled output channel.

## 22. Focused evidence journeys

The delegated journey is implementation-blocked until 0077.2 names the endpoint, colocated `AccessSpec`, domain fixture constructor, and static client fixture required by section 2.5. Tests cannot substitute a synthetic route or local access registry.

### 22.1 Delegated browser journey

Use disposable PostgreSQL and exactly the 0077.2 person, domain, endpoint, `AccessSpec`, and public-client fixtures.

1. Start the real auth engine with an explicit loopback issuer, dashboard origin, and exact registered redirect.
2. Sign in through `/dashboard/login` with the original signed `oauth_query`.
3. Verify the cookie and provider continuation response pass through the dashboard guard.
4. Start authorization with `native-api offline_access`, exact resource, state, and S256 challenge.
5. Observe `/dashboard/oauth/consent`, accept, and exchange the 60-second code.
6. Verify ES256, `at+jwt`, issuer, singleton audience, person subject, live `sid`, scopes, lifetime, and tracked `jti`.
7. Call the exact 0077.2 endpoint and observe `OAuthUserBearer -> Person` plus current authorization.
8. Remove the exact fixture grant. The same bearer now gets 403, not 401.
9. Rotate the refresh token. Reuse the parent and observe family plus access-token revocation.
10. Retry the resource request and observe 401.
11. Inspect only redacted bounded evidence.

The browser journey also denies an unregistered redirect, missing state, plain PKCE, wrong verifier, missing resource, changed pending query, expanded scope without consent, untrusted consent origin, and unapproved continuation URL.

### 22.2 Service journey

Use one synthetic service principal and one confidential service client.

1. Provision both through the fail-closed operator sequence and capture the secret only in memory.
2. Request exactly `native-api` for the native resource with `client_secret_basic`.
3. Verify a five-minute token with `sub = client_id`, no `sid`, and a tracked `jti`.
4. Call `OAuthCredentialAuthority` directly and observe `OAuthServiceBearer -> ServicePrincipal`.
5. Confirm that no production `AccessSpec` accepts this mechanism before 0056.3.
6. Confirm that no person, tag, OAuth scope, client metadata, or hard-coded client rule supplies authority.
7. Disable the service principal and observe credential rejection on the next direct resolution.
8. Confirm no `auth.user`, person membership, tag, consent, or refresh token was created.

### 22.3 PostgreSQL concurrency journey

Use two independent connections and controlled time.

1. Exchange one code concurrently. Exactly one response succeeds.
2. Let the second exchange acquire the lock and revoke the complete grant.
3. Rotate one refresh token concurrently. Exactly one compare-and-swap succeeds.
4. Confirm the loser revokes the family after the winner commits.
5. Advance past seven days of inactivity and reject rotation.
6. Keep rotating within seven days, then advance past the original 30-day absolute expiry and reject rotation.
7. Inject an audit or token-state write failure. Confirm no token response leaves the process.
8. Revoke one access-token `jti` and confirm immediate rejection through a different connection.

### 22.4 JWKS and introspection journey

1. Verify a token with the active key.
2. Rotate keys and verify old and new tokens during the 15-minute grace.
3. Advance beyond old-token expiry and grace. Confirm the old key leaves JWKS.
4. Call introspection through external ingress and observe route-not-found.
5. Call through internal ingress from a wrong network or wrong client and observe no token signal.
6. Call from the linked resource-server client and observe the bounded active result.
7. Revoke the `jti` and observe `active: false` immediately.

No journey uses a production hostname, credential, database, provider account, remote service, or shared state.

## 23. Exact falsifiers

This amendment is not implemented if any condition below occurs:

1. Better Auth or the OAuth provider is not exactly version `1.7.1`.
2. The provider source or license decision differs without a new frozen amendment.
3. A second Better Auth engine, identity store, issuer, audience, or runtime client registry exists.
4. The issuer comes from a request header, trusted-origin order, redirect URI, or forwarded host.
5. An issuer alias or trailing-slash variant is accepted.
6. A native token has a missing, multiple, or different audience.
7. An authorization or token request can omit the exact resource.
8. An OAuth scope grants or stores a role, capability, membership, department, ownership fact, or verdict.
9. An unknown scope is accepted.
10. Authorization code flow works without S256 PKCE, state, exact redirect, live session, or explicit first consent.
11. A loopback redirect can change its registered port.
12. An unvalidated redirect receives an OAuth response.
13. A code lives longer than 60 seconds or succeeds twice.
14. A service client gets a refresh token or person subject.
15. A service principal is represented by `auth.user`, `Person`, membership, role, or tag.
16. A service principal gains domain authority before the complete 0056.3 grant-persistence cutover.
17. A bearer contains current roles, capabilities, departments, requirements, or authorization verdicts.
18. A valid bearer bypasses canonical resource, ownership, state, interval, requirement, or transaction evaluation.
19. A valid person bearer accepted by the endpoint gets 401 for a current domain denial instead of 403.
20. A credential failure or wrong endpoint mechanism returns 403 rather than 401.
21. A user token resolves without a live matching `sid`.
22. A service token resolves without a live one-to-one client binding.
23. A signed JWT resolves without a matching live `jti` row.
24. JWT access-token revocation calls the provider's unsupported self-contained-token branch instead of the owned adapter.
25. Access-token revocation is not effective on the next request.
26. Refresh rotation reuses a parent, allows a replay interval, or lacks the distributed lock.
27. A refresh family exceeds seven days of inactivity or 30 days absolute lifetime.
28. A family replay leaves a tracked family access token active.
29. A token response leaves before required owned token-state and audit writes commit.
30. The provider refresh-family race remains reachable through supported ingress despite the advisory lock.
31. Dynamic, unauthenticated, discovered, or HTTP-admin client registration is reachable.
32. `client_secret_post`, a query secret, a cookie client credential, or a plaintext stored secret is accepted.
33. A confidential secret has less than 32 random bytes, lives longer than 90 days, or remains valid after rotation.
34. An external request can reach introspection by path knowledge or fallback.
35. Introspection isolation depends only on OpenAPI omission.
36. An unlinked or wrong-network introspection client learns token existence.
37. An OAuth provider route outside the frozen allowlist is reachable.
38. OAuth routes become native API operations or acquire a second `AccessSpec` registry.
39. A production or preview OAuth request uses cleartext HTTP or wildcard credentialed CORS.
40. Consent mutation bypasses the 0054.1 origin and CSRF boundary.
41. A private key is unencrypted, an unknown algorithm is accepted, or an old public key disappears before 15 minutes.
42. A log, trace, audit, error, test name, or artifact contains forbidden credential material.
43. The audit relation allows update/delete or accepts an unknown event/detail key.
44. Migration 0027 runs at startup, contains a secret, alters the existing person/tag rule relation, or adds interim service-grant persistence.
45. DPoP, PAR, JAR, RAR, mTLS sender constraint, federation, device flow, or dynamic registration is partially implemented here.
46. A provider and owned write are described as one ACID transaction under Better Auth 1.7.1.
47. A provider credential response is released after release-barrier verification or owned persistence fails.
48. `loginPage` or `consentPage` is API-relative or is not mounted below `/dashboard/`.
49. OAuth login omits or changes `oauth_query`, or a dashboard action bypasses the origin and continuation guards.
50. The section 4 `OAuthOptions` literal does not type-check against the exact 1.7.1 declarations.

## 24. Definition of done

1. This frozen amendment exists as one design-spec file and precedes implementation.
2. Better Auth and the provider are pinned to 1.7.1 with the recorded npm integrity, source commit, and MIT license.
3. One existing Better Auth engine composes the JWT and OAuth provider plugins without changing 0054.1 sessions.
4. Issuer, audience, scopes, grants, methods, prefixes, algorithms, lifetimes, rate limits, resource metadata, and page URLs match this amendment exactly.
5. The section 4 options literal type-checks against the pinned package declarations.
6. The external OAuth allowlist and separate internal introspection ingress contain only the frozen routes.
7. Static clients use the closed kind table, exact redirects, exact resource link, closed scopes, and operator-only lifecycle.
8. Dashboard login and consent use the exact mounted routes, signed query forwarding, cookie/origin forwarding, and continuation guard.
9. Delegated clients use authorization code, S256 PKCE, exact redirect, explicit consent, and optional rotating refresh tokens.
10. Service clients use client credentials, no refresh, and immutable one-to-one service-principal ownership.
11. `OAuthCredentialAuthority` returns the exact 0055.1 principal, mechanism, evidence, and rejection reason.
12. Every bearer requires a live client, exact claims, live `jti`, and, when delegated, a live Better Auth session.
13. Dynamic authorization remains current and token-independent for delegated people.
14. Service bearers resolve to `ServicePrincipal`, receive no persisted domain grant, and have no protected-operation assignment until 0056.3.
15. Migration 0027 installs the exact generated provider schema, owned state, constraints, indexes, and append-only audit.
16. Code and refresh locks, provider one-use/CAS behavior, response buffering, owned state commits, and response release match section 10.
17. No implementation claims cross-provider/owned ACID atomicity.
18. Authorization codes, access tokens, refresh families, client secrets, and signing keys obey the exact lifetimes and rotation rules.
19. Access-token and family revocation affect the next request and introspection result.
20. JWKS exposes only ES256 public keys and preserves the 15-minute retirement grace.
21. Dynamic registration, provider admin routes, unsupported grants, extra scopes, extra audiences, and unsafe client authentication stay unreachable.
22. After 0077.2 freezes its concrete names, focused browser, service, concurrency, revocation, JWKS, introspection, migration, and redaction evidence passes against disposable state.
23. No production credential, hostname decision, remote database, provider effect, deployment, or shared-state mutation occurs during implementation proof.

## 25. Explicit deferrals

This amendment explicitly defers:

- DPoP and every other sender-constrained token mechanism;
- Pushed Authorization Requests (PAR);
- JWT-Secured Authorization Requests (JAR);
- Rich Authorization Requests (RAR);
- mTLS client authentication or certificate-bound access tokens;
- private-key JWT client authentication;
- dynamic client registration and Client ID Metadata Documents;
- device authorization, CIBA, token exchange, impersonation, and personal access tokens;
- OIDC ID tokens, UserInfo, logout, pairwise subjects, and external identity federation;
- service-principal domain-grant persistence, the `ServicePrincipal` rule subject, capability assignments, and protected operation enablement, all owned by specification 0056.3;
- additional protected resources, audiences, or OAuth scopes;
- browser-SPA cross-origin token exchange;
- general HTTP Problem Details, cache, CORS, idempotency, ETag, and conditional-request policy owned by 0080.1;
- stronger all-or-nothing atomicity across Better Auth provider writes and Vektor-owned rows, until a supported handler transaction hook or separately proven adapter amendment exists;
- provider deployment, production hostname selection, production credentials, remote database state, and release authority.

Each deferred protocol changes the credential threat model or public surface. It requires a separately frozen amendment before implementation.
