import { IdentitySnapshot, type OAuthCredentialAuthority } from "@vektorprogrammet/database";
import { Content, ContentManagement } from "@vektorprogrammet/domain/content";
import type { Admissions } from "@vektorprogrammet/domain/admissions";
import type { ServicePrincipalGrantAuthority } from "@vektorprogrammet/domain/authz";
import {
  Identity,
  IdentityEngineError,
  IdentityActor,
  IdentitySession,
  IdentitySessionExpired,
  IdentityOwnedSessionNotFound,
  IdentitySessionNotFound,
  type IdentityShape,
} from "@vektorprogrammet/domain/identity";
import { Database, type DatabaseShape } from "@vektorprogrammet/domain/database";
import {
  Organization,
  PersonId,
  type OrganizationAuthorityInstant,
  type OrganizationShape,
} from "@vektorprogrammet/domain/organization";
import {
  PersonContactProfile,
  PersonProfile,
  Profile,
  type ProfileShape,
} from "@vektorprogrammet/domain/profile";
import type { Economy } from "@vektorprogrammet/domain/receipt";
import type { Recruitment } from "@vektorprogrammet/domain/recruitment";
import { Schools } from "@vektorprogrammet/domain/schools";
import { DateTime, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeBackendConfig } from "./config.js";
import {
  externalNativePreflightAttachmentGaps,
  externalNativePreflightMethodsForPath,
} from "./native-api-preflight.js";
import type { BackendRun } from "./router.js";
import { makeBackendTestHttp as makeBackendHttp } from "./test/native-http.js";
import { runTestPromise } from "../test/runtime.js";

const token = "better-auth.session_token";
const environment = {
  BACKEND_PG_URL: "postgres://test.invalid/vektorprogrammet",
  BETTER_AUTH_SECRET: "router-test-secret-with-at-least-32-characters!",
  NATIVE_IDENTITY_DEPLOYMENT: "local",
  NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify(["http://127.0.0.1:5174"]),
  OAUTH_CANONICAL_ORIGIN: "http://127.0.0.1:5174",
  OAUTH_DASHBOARD_ORIGIN: "http://127.0.0.1:5174",
  OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
  PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
  ADMISSION_FIXED_NOW: "2031-09-15T12:00:00.000Z",
} as const;
const config = makeBackendConfig(environment);

const database = Object.assign((() => Effect.succeed([])) as unknown as DatabaseShape, {
  health: Effect.void,
  withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
});
const profile: ProfileShape = {
  readProfiles: (personIds) =>
    Effect.succeed(
      personIds.map(
        (personId) =>
          new PersonProfile({ personId, firstName: "Member", lastName: "One", revision: 0 }),
      ),
    ),
  readContacts: (personIds) =>
    Effect.succeed(
      personIds.map(
        (personId) =>
          new PersonContactProfile({
            personId,
            email: "member@example.invalid",
            phone: "90000000",
            revision: 0,
          }),
      ),
    ),
  readOwnProfile: (personId) =>
    Effect.succeed({
      personId,
      firstName: "Member",
      lastName: "One",
      email: "member@example.invalid",
      phone: "90000000",
      nameRevision: 0,
      contactRevision: 0,
    }),
  updateOwnProfile: (input) =>
    Effect.as(profile.readOwnProfile(input.actorPersonId), {
      personId: input.actorPersonId,
      firstName: input.command.firstName,
      lastName: input.command.lastName,
      email: input.command.email,
      phone: input.command.phone,
      nameRevision: input.command.expectedNameRevision + 1,
      contactRevision: input.command.expectedContactRevision + 1,
    }),
  readDirectoryPage: () => Effect.succeed({ entries: [], nextCursor: undefined }),
};
const organization = {
  listDepartments: Effect.succeed([]),
  listTeams: () => Effect.succeed([]),
  listFieldOfStudies: Effect.succeed([]),
  resolvePersonAuthority: () =>
    Effect.succeed({
      personId: "member-1",
      evaluatedAt: "2031-09-15T12:00:00.000Z",
      globalAdministrator: "Absent",
      memberships: [
        {
          membershipId: "membership-1",
          teamId: "team-1",
          departmentId: "department-1",
          active: true,
          teamLeader: false,
        },
      ],
    }),
  resolvePersonAuthorityForRead: (
    personId: PersonId,
    authorizationInstant: OrganizationAuthorityInstant,
  ) =>
    Effect.succeed({
      personId,
      evaluatedAt: authorizationInstant,
      globalAdministrator: "Absent",
      memberships: [
        {
          membershipId: "membership-1",
          teamId: "team-1",
          departmentId: "department-1",
          active: true,
          teamLeader: false,
        },
      ],
    }),
} as unknown as OrganizationShape;
const schools = Schools.of({
  listDirectory: () => Effect.succeed({ activeSchools: [], inactiveSchools: [] }),
});

const makeRun =
  (identity: IdentityShape, organizationService: OrganizationShape = organization): BackendRun =>
  <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | Database
      | Admissions
      | Economy
      | Organization
      | Profile
      | Recruitment
      | Schools
      | Identity
      | IdentitySnapshot
      | OAuthCredentialAuthority
      | ServicePrincipalGrantAuthority
      | ContentManagement
      | Content
    >,
  ): Promise<A> =>
    runTestPromise(
      effect.pipe(
        Effect.provideService(Database, database),
        Effect.provideService(Profile, profile),
        Effect.provideService(Organization, organizationService),
        Effect.provideService(Schools, schools),
        Effect.provideService(Identity, identity),
        Effect.provideService(
          IdentitySnapshot,
          IdentitySnapshot.of({
            resolveSession: (cookieHeader) =>
              Effect.tryPromise({
                try: () => identity.resolveSession(cookieHeader),
                catch: (cause) =>
                  cause instanceof IdentitySessionNotFound || cause instanceof IdentityEngineError
                    ? cause
                    : new IdentityEngineError({
                        operation: "resolveSnapshotSession",
                        message: "test identity failure",
                      }),
              }),
            revokeCurrentSession: () => Effect.succeed({ setCookies: [] }),
            revokeSession: () => Effect.succeed({ setCookies: [] }),
            revokeOtherSessions: () => Effect.succeed({ setCookies: [] }),
            revokeAllSessions: () => Effect.succeed({ setCookies: [] }),
          }),
        ),
      ) as Effect.Effect<A, E>,
    );

const currentSession = new IdentitySession({
  sessionId: "session-1",
  createdAt: DateTime.makeUnsafe(new Date("2031-09-15T12:00:00.000Z")),
  updatedAt: DateTime.makeUnsafe(new Date("2031-09-15T12:00:00.000Z")),
  expiresAt: DateTime.makeUnsafe(new Date("2031-09-16T12:00:00.000Z")),
  ipAddress: "127.0.0.1",
  userAgent: "router-test",
  current: true,
});
const successfulIdentity = Identity.of({
  signIn: () => Promise.reject(new Error("unexpected sign-in")),
  resolveSession: async (cookieHeader: string | undefined) => {
    if (cookieHeader !== undefined && cookieHeader.includes(`${token}=`)) {
      return new IdentityActor({
        personId: PersonId.make("member-1"),
        sessionId: "session-1",
        expiresAt: currentSession.expiresAt,
      });
    }
    throw new IdentitySessionNotFound();
  },
  readCurrentSession: async () => currentSession,
  listSessions: async () => [currentSession],
  revokeCurrentSession: async () => ({ setCookies: [] }),
  revokeSession: async () => ({ setCookies: [] }),
  revokeOtherSessions: async () => ({ setCookies: [] }),
  revokeAllSessions: async () => ({ setCookies: [] }),
  recordSecurityEvent: async () => undefined,
  signOut: async () => ({ setCookies: [] }),
} satisfies IdentityShape);

const unavailableAuthHandler = {
  handle: async () => new Response(null, { status: 404 }),
  recordTrustedOriginRejection: async () => undefined,
};

const successfulRun = makeRun(successfulIdentity);
const backend = makeBackendHttp(config, successfulRun, unavailableAuthHandler);

const request = (pathname: string, init?: RequestInit): Promise<Response> =>
  backend.fetch(new Request(`http://backend.test${pathname}`, init));

describe("unified backend router", () => {
  it("derives current preflight methods while exposing the 0077.2 attachment gap", () => {
    expect(externalNativePreflightMethodsForPath("/api/session")).toEqual(["GET", "DELETE"]);
    expect(externalNativePreflightAttachmentGaps).toContainEqual({
      identifier: "readSession",
      method: "GET",
      path: "/api/session",
    });
  });
  it("owns health, Profile, Organization, Schools, Admission, Receipt, and Recruitment routes", async () => {
    const [
      health,
      profile,
      organizationResponse,
      schoolsResponse,
      admission,
      receipt,
      recruitment,
      publicRecruitment,
      missing,
      internalEvidence,
    ] = await Promise.all([
      request("/health"),
      request("/api/me", { headers: { cookie: `${token}=value` } }),
      request("/api/departments"),
      request("/api/admin/schools", { headers: { cookie: `${token}=value` } }),
      request("/api/admin/admission-periods"),
      request("/api/receipts"),
      request("/api/admin/recruitment/assignment-board?status=new"),
      request("/api/recruitment/invitation-response"),
      request("/api/not-a-capability"),
      request("/api/e2e/receipts/receipt-one/evidence", {
        headers: { cookie: `${token}=value` },
      }),
    ]);

    expect({ status: health.status, body: await health.json() }).toEqual({
      status: 200,
      body: { status: "ok" },
    });
    expect({ status: profile.status, body: await profile.json() }).toEqual({
      status: 200,
      body: {
        personId: "member-1",
        firstName: "Member",
        lastName: "One",
        email: "member@example.invalid",
        phone: "90000000",
        role: "ROLE_TEAM_MEMBER",
        nameRevision: 0,
        contactRevision: 0,
      },
    });
    expect({
      status: organizationResponse.status,
      body: await organizationResponse.json(),
    }).toEqual({
      status: 200,
      body: [],
    });
    expect({ status: schoolsResponse.status, body: await schoolsResponse.json() }).toEqual({
      status: 200,
      body: { activeSchools: [], inactiveSchools: [] },
    });
    expect({ status: admission.status, body: await admission.json() }).toEqual({
      status: 401,
      body: { error: { tag: "UnauthenticatedActor" } },
    });
    expect({ status: receipt.status, body: await receipt.json() }).toEqual({
      status: 401,
      body: { error: { tag: "UnauthenticatedActor" } },
    });
    expect({ status: recruitment.status, body: await recruitment.json() }).toEqual({
      status: 401,
      body: { error: { tag: "UnauthenticatedActor" } },
    });
    expect({
      status: publicRecruitment.status,
      body: await publicRecruitment.json(),
    }).toEqual({
      status: 404,
      body: { error: { tag: "RecruitmentInvitationNotFound" } },
    });
    expect({ status: missing.status, body: await missing.json() }).toEqual({
      status: 404,
      body: { error: { tag: "RouteNotFound" } },
    });
    expect({ status: internalEvidence.status, body: await internalEvidence.json() }).toEqual({
      status: 404,
      body: { error: { tag: "RouteNotFound" } },
    });
  });

  it("leaves every off-spec content alias at the unified 404 boundary", async () => {
    const responses = await Promise.all([
      request("/api/admin/content/drafts", { method: "POST" }),
      request("/api/admin/content/drafts/7", { method: "PUT" }),
      request("/api/admin/content", { method: "POST" }),
      request("/api/articles", { method: "GET" }),
      request("/articles/7", { method: "GET" }),
    ]);

    for (const response of responses) {
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 404,
        body: { error: { tag: "RouteNotFound" } },
      });
    }
  });

  it("dispatches team-interest and mailing-list reads through Organization", async () => {
    const [teamInterest, mailingLists] = await Promise.all([
      request("/api/admin/team-interest"),
      request("/api/admin/mailing-lists"),
    ]);

    for (const response of [teamInterest, mailingLists]) {
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 401,
        body: { error: { tag: "UnauthenticatedActor" } },
      });
    }
  });

  it("exposes exactly the six safe native session resources and removes the old path", async () => {
    const cookieHeaders = { cookie: `${token}=value; other=1` };
    const mutationHeaders = {
      ...cookieHeaders,
      origin: "http://127.0.0.1:5174",
    };
    const current = await request("/api/session", { headers: cookieHeaders });
    expect({ status: current.status, body: await current.json() }).toEqual({
      status: 200,
      body: {
        sessionId: "session-1",
        createdAt: "2031-09-15T12:00:00.000Z",
        updatedAt: "2031-09-15T12:00:00.000Z",
        expiresAt: "2031-09-16T12:00:00.000Z",
        ipAddress: "127.0.0.1",
        userAgent: "router-test",
        current: true,
      },
    });
    const listed = await request("/api/sessions", { headers: cookieHeaders });
    expect({ status: listed.status, body: await listed.json() }).toEqual({
      status: 200,
      body: [
        {
          sessionId: "session-1",
          createdAt: "2031-09-15T12:00:00.000Z",
          updatedAt: "2031-09-15T12:00:00.000Z",
          expiresAt: "2031-09-16T12:00:00.000Z",
          ipAddress: "127.0.0.1",
          userAgent: "router-test",
          current: true,
        },
      ],
    });
    for (const [path, method] of [
      ["/api/session", "DELETE"],
      ["/api/sessions/session-1", "DELETE"],
      ["/api/sessions:revoke-others", "POST"],
      ["/api/sessions:revoke-all", "POST"],
    ] as const) {
      const response = await request(path, { method, headers: mutationHeaders });
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
      expect(response.headers.getSetCookie()).toHaveLength(0);
    }
    expect((await request("/api/session")).status).toBe(401);
    expect((await request("/api/me/session", { headers: cookieHeaders })).status).toBe(404);
  });

  it("requires a recognized Better Auth session cookie before authoritative handlers run", async () => {
    let currentReads = 0;
    const guardedBackend = makeBackendHttp(
      config,
      makeRun({
        ...successfulIdentity,
        readCurrentSession: async () => {
          currentReads += 1;
          return currentSession;
        },
      }),
      unavailableAuthHandler,
    );
    for (const cookie of [undefined, "", "theme=dark", "vp.session_token=opaque"]) {
      const response = await guardedBackend.fetch(
        new Request("http://backend.test/api/session", {
          headers: cookie === undefined ? undefined : { cookie },
        }),
      );
      expect(response.status).toBe(401);
    }
    expect(currentReads).toBe(0);

    for (const cookie of [
      "better-auth.session_token=opaque",
      "__Secure-better-auth.session_token=opaque",
    ]) {
      const response = await guardedBackend.fetch(
        new Request("http://backend.test/api/session", { headers: { cookie } }),
      );
      expect(response.status).toBe(200);
    }
    expect(currentReads).toBe(2);
  });

  it("conceals missing, non-owned, and already-revoked session ids identically", async () => {
    const owned = new Set(["owned-session"]);
    let revokeCalls = 0;
    const ownerBackend = makeBackendHttp(
      config,
      makeRun({
        ...successfulIdentity,
        revokeSession: async (_cookie, sessionId) => {
          revokeCalls += 1;
          if (!owned.delete(sessionId)) {
            throw new IdentityOwnedSessionNotFound({ sessionId });
          }
          return { setCookies: [] };
        },
      }),
      unavailableAuthHandler,
    );
    const headers = {
      cookie: `${token}=value`,
      origin: "http://127.0.0.1:5174",
    };
    expect(
      (
        await ownerBackend.fetch(
          new Request("http://backend.test/api/sessions/owned-session", {
            method: "DELETE",
            headers,
          }),
        )
      ).status,
    ).toBe(204);
    for (const sessionId of ["owned-session", "missing-session", "another-person-session"]) {
      const response = await ownerBackend.fetch(
        new Request(`http://backend.test/api/sessions/${sessionId}`, {
          method: "DELETE",
          headers,
        }),
      );
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 404,
        body: { error: { tag: "SessionNotFound" } },
      });
    }
    expect(revokeCalls).toBe(4);
  });

  it("centralizes trusted-origin, CSRF rejection, audit, and credentialed CORS", async () => {
    const handled: string[] = [];
    const rejectedCorrelations: string[] = [];
    const originBackend = makeBackendHttp(config, successfulRun, {
      handle: async (request) => {
        handled.push(new URL(request.url).pathname);
        return new Response(null, { status: 204 });
      },
      recordTrustedOriginRejection: async (context) => {
        rejectedCorrelations.push(context.requestCorrelation);
      },
    });
    const trustedOrigin = "http://127.0.0.1:5174";
    const trusted = await originBackend.fetch(
      new Request("http://backend.test/api/auth/sign-in/email", {
        method: "POST",
        headers: { origin: trustedOrigin },
      }),
    );
    expect(trusted.status).toBe(204);
    expect(trusted.headers.get("access-control-allow-origin")).toBe(trustedOrigin);
    expect(trusted.headers.get("access-control-allow-credentials")).toBe("true");
    expect(trusted.headers.get("access-control-allow-origin")).not.toBe("*");

    for (const headers of [
      new Headers({ origin: "https://untrusted.example.invalid" }),
      new Headers(),
    ]) {
      const rejected = await originBackend.fetch(
        new Request("http://backend.test/api/auth/sign-in/email", {
          method: "POST",
          headers,
        }),
      );
      expect({ status: rejected.status, body: await rejected.json() }).toEqual({
        status: 403,
        body: {
          type: "urn:vektorprogrammet:problem:v0.2:origin.denied",
          title: "Origin denied",
          status: 403,
          code: "origin.denied",
          detail: "The browser origin is not trusted for this operation.",
        },
      });
      expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
    }

    const protectedCrossOrigin = await originBackend.fetch(
      new Request("http://backend.test/api/session", {
        headers: {
          cookie: `${token}=value`,
          origin: "https://untrusted.example.invalid",
        },
      }),
    );
    expect(protectedCrossOrigin.status).toBe(403);

    const preflight = await originBackend.fetch(
      new Request("http://backend.test/api/session", {
        method: "OPTIONS",
        headers: { origin: trustedOrigin, "access-control-request-method": "GET" },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(trustedOrigin);
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");
    expect(handled).toEqual(["/api/auth/sign-in/email"]);
    expect(rejectedCorrelations).toHaveLength(3);
    expect(new Set(rejectedCorrelations).size).toBe(3);
  });
  it("keeps OAuth protocol errors outside the native origin problem boundary", async () => {
    const oauthCalls: string[] = [];
    const rejectedCorrelations: string[] = [];
    const oauthBackend = makeBackendHttp(config, successfulRun, {
      handle: async () => new Response(null, { status: 404 }),
      handleOAuth: async (request) => {
        oauthCalls.push(`${request.method} ${new URL(request.url).pathname}`);
        return new Response(JSON.stringify({ error: "invalid_request" }), {
          status: 400,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json",
          },
        });
      },
      recordTrustedOriginRejection: async (context) => {
        rejectedCorrelations.push(context.requestCorrelation);
      },
    });

    const response = await oauthBackend.fetch(
      new Request("http://backend.test/api/auth/oauth2/consent", {
        method: "POST",
        headers: { origin: "https://untrusted.example.invalid" },
      }),
    );
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 400,
      body: { error: "invalid_request" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(oauthCalls).toEqual(["POST /api/auth/oauth2/consent"]);
    expect(rejectedCorrelations).toEqual([]);
  });

  it("allows only the centralized native browser request headers before dispatch", async () => {
    const dispatched: string[] = [];
    const rejectedCorrelations: string[] = [];
    const origin = "http://127.0.0.1:5174";
    const backend = makeBackendHttp(config, successfulRun, {
      handle: async (request) => {
        dispatched.push(new URL(request.url).pathname);
        return new Response(null, { status: 204 });
      },
      recordTrustedOriginRejection: async (context) => {
        rejectedCorrelations.push(context.requestCorrelation);
      },
    });

    const allowed = await backend.fetch(
      new Request("http://backend.test/api/session", {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "DELETE",
          "access-control-request-headers":
            "CONTENT-type, idempotency-KEY, IF-match, If-None-Match, x-Recruitment-Invitation-Capability",
        },
      }),
    );
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-headers")).toBe(
      "Authorization, Content-Type, Idempotency-Key, If-Match, If-None-Match, X-Recruitment-Invitation-Capability",
    );
    expect(allowed.headers.get("access-control-allow-methods")).toBe("GET, HEAD, DELETE, OPTIONS");
    expect(allowed.headers.get("vary")).toBe(
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    );

    const unknown = await backend.fetch(
      new Request("http://backend.test/api/session", {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "Content-Type, X-Unknown-Native-Header",
        },
      }),
    );
    expect({ status: unknown.status, body: await unknown.json() }).toEqual({
      status: 400,
      body: {
        type: "urn:vektorprogrammet:problem:v0.2:header.malformed",
        title: "Malformed header",
        status: 400,
        code: "header.malformed",
        detail: "A request header is malformed.",
      },
    });

    const wrongMethod = await backend.fetch(
      new Request("http://backend.test/api/session", {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "POST",
        },
      }),
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET, HEAD, DELETE, OPTIONS");
    expect(dispatched).toEqual([]);
    expect(rejectedCorrelations).toHaveLength(0);
  });

  it("composes local, preview, and production cookie policy without invented origins", () => {
    expect(config.sessionBoundary).toEqual({
      deployment: "local",
      trustedOrigins: ["http://127.0.0.1:5174"],
      secureCookies: false,
    });
    expect(
      makeBackendConfig({
        ...environment,
        NATIVE_IDENTITY_DEPLOYMENT: "preview",
        NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify(["https://vektor.phibkro.org"]),
        OAUTH_CANONICAL_ORIGIN: "https://vektor.phibkro.org",
        OAUTH_DASHBOARD_ORIGIN: "https://vektor.phibkro.org",
      }).sessionBoundary,
    ).toEqual({
      deployment: "preview",
      trustedOrigins: ["https://vektor.phibkro.org"],
      secureCookies: true,
    });
    expect(() =>
      makeBackendConfig({
        ...environment,
        NATIVE_IDENTITY_DEPLOYMENT: "production",
        NATIVE_IDENTITY_TRUSTED_ORIGINS: undefined,
      }),
    ).toThrow();
    expect(() =>
      makeBackendConfig({
        ...environment,
        NATIVE_IDENTITY_DEPLOYMENT: "preview",
        NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify(["https://p999.vektor.phibkro.org"]),
      }),
    ).toThrow("frozen dev-main or p20 origin");
    expect(() =>
      makeBackendConfig({
        ...environment,
        BETTER_AUTH_URL: "http://127.0.0.1:5174",
      }),
    ).toThrow("unsupported");
  });

  it("forwards an evidence-only clock to protected authority resolution", async () => {
    const authorizationInstants: string[] = [];
    const pinnedInstant = "2037-01-15T12:00:00.000Z";
    const observedOrganization: OrganizationShape = {
      ...organization,
      resolvePersonAuthority: (personId, authorizationInstant) => {
        authorizationInstants.push(authorizationInstant);
        return organization.resolvePersonAuthority(personId, authorizationInstant);
      },
    };
    const pinnedBackend = makeBackendHttp(
      config,
      makeRun(successfulIdentity, observedOrganization),
      unavailableAuthHandler,
      { now: () => pinnedInstant },
    );

    const response = await pinnedBackend.fetch(
      new Request("http://backend.test/api/me", {
        headers: { cookie: `${token}=value` },
      }),
    );

    expect(response.status).toBe(200);
    expect(authorizationInstants).toEqual([pinnedInstant]);
  });

  it.each([
    ["expired session", new IdentitySessionExpired(), 401, "UnauthenticatedActor"],
    [
      "typed provider failure",
      new IdentityEngineError({
        operation: "getSession",
        message: "authentication provider unavailable",
      }),
      503,
      "IdentityEngineError",
    ],
    ["unknown provider failure", new Error("connection refused"), 503, "IdentityEngineError"],
  ] as const)(
    "maps %s at the session HTTP boundary",
    async (_name, failure, expectedStatus, expectedTag) => {
      const failingBackend = makeBackendHttp(
        config,
        makeRun({
          ...successfulIdentity,
          readCurrentSession: () => Promise.reject(failure),
        }),
        unavailableAuthHandler,
      );

      const response = await failingBackend.fetch(
        new Request("http://backend.test/api/session", {
          headers: { cookie: "better-auth.session_token=session-value" },
        }),
      );

      expect({ status: response.status, body: await response.json() }).toEqual({
        status: expectedStatus,
        body: { error: { tag: expectedTag } },
      });
    },
  );

  it("mounts the auth engine handler over the /api/auth/* surface", async () => {
    const probingBackend = makeBackendHttp(config, successfulRun, {
      handle: async (request) => new Response(`auth-saw:${new URL(request.url).pathname}`),
      recordTrustedOriginRejection: async () => undefined,
    });
    for (const path of ["/api/auth/get-session", "/api/auth/sign-in/email", "/api/auth/"]) {
      const response = await probingBackend.fetch(
        new Request(`http://backend.test${path}`, {
          method: "POST",
          headers: { origin: "http://127.0.0.1:5174" },
        }),
      );
      expect(await response.text()).toBe(`auth-saw:${path}`);
    }
  });

  it("requires TLS for non-loopback application effect providers", () => {
    expect(() =>
      makeBackendConfig({
        ...environment,
        PUBLIC_APPLICATION_EFFECT_MODE: "http",
        PUBLIC_APPLICATION_EFFECT_ENDPOINT: "http://provider.example.invalid/effects",
        PUBLIC_APPLICATION_EFFECT_TOKEN: "provider-token",
      }),
    ).toThrow("must use HTTPS unless it targets loopback");

    expect(
      makeBackendConfig({
        ...environment,
        PUBLIC_APPLICATION_EFFECT_MODE: "http",
        PUBLIC_APPLICATION_EFFECT_ENDPOINT: "http://127.0.0.1:8898/effects",
        PUBLIC_APPLICATION_EFFECT_TOKEN: "provider-token",
      }).publicApplicationEffects?.endpoint.href,
    ).toBe("http://127.0.0.1:8898/effects");
  });

  it("requires an explicit application effect mode", () => {
    const { PUBLIC_APPLICATION_EFFECT_MODE: _, ...implicitEnvironment } = environment;
    expect(() => makeBackendConfig(implicitEnvironment)).toThrow(
      "PUBLIC_APPLICATION_EFFECT_MODE must be disabled or http",
    );
    expect(() =>
      makeBackendConfig({
        ...environment,
        PUBLIC_APPLICATION_EFFECT_ENDPOINT: "https://provider.example.invalid/effects",
        PUBLIC_APPLICATION_EFFECT_TOKEN: "provider-token",
      }),
    ).toThrow("require PUBLIC_APPLICATION_EFFECT_MODE=http");
  });
});
