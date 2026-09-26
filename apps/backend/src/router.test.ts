import { backendDatabase } from "../test/database.js";
import {
  IdentitySnapshot,
  OAuthCredentialAuthority,
  type OAuthExpectedMechanism,
} from "@vektorprogrammet/database";
import {
  Identity,
  IdentityEngineError,
  IdentityActor,
  IdentitySession,
  IdentitySessionExpired,
  IdentityOwnedSessionNotFound,
  IdentitySessionNotFound,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";
import { Database } from "@vektorprogrammet/database";
import {
  MembershipId,
  TeamId,
  DepartmentId,
  Organization,
  PersonId,
  type OrganizationAuthorityInstant,
  type OrganizationOperations,
} from "@vektorprogrammet/domain/organization";
import {
  PersonContactProfile,
  PersonProfile,
  Profile,
  type ProfileOperations,
} from "@vektorprogrammet/domain/profile";
import { Schools } from "@vektorprogrammet/domain/schools";
import { SocialEvents } from "@vektorprogrammet/domain/social-events";
import {
  CredentialEvidenceRef,
  CredentialMechanismSchema,
  CredentialOutcomeSchema,
  PrincipalSchema,
} from "@vektorprogrammet/domain/authz";
import { Economy } from "@vektorprogrammet/domain/receipt";
import { NativeProblem, SocialEventsReadScopeProblem } from "@vektorprogrammet/http-api";
import { DateTime, Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decodeBackendConfig } from "./config.js";
import { contactConfig } from "./contact/config.js";
import {
  externalNativePreflightAttachmentGaps,
  externalNativePreflightMethodsForPath,
} from "./native-api-preflight.js";
import { makeBackendTestHttp as backendHttpHandler } from "./test/native-http.js";

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
  PASSWORD_RESET_DELIVERY_MODE: "disabled",
  RECEIPT_DELIVERY_MODE: "disabled",
  ADMISSION_FIXED_NOW: "2031-09-15T12:00:00.000Z",
} as const;

const config = decodeBackendConfig(environment);

const database = backendDatabase(
  Database.use((sql) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO person_profiles VALUES ('member-1','Member','One',0)`;
      yield* sql`INSERT INTO person_contact_profiles VALUES ('member-1','member@example.invalid','90000000',0)`;
    }),
  ),
);

const profile: ProfileOperations = {
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
      personId: PersonId.make(input.actorPersonId),
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
  resolvePersonAuthority: (
    _personId: PersonId,
    _authorizationInstant: OrganizationAuthorityInstant,
  ) =>
    Effect.succeed({
      personId: PersonId.make("member-1"),
      evaluatedAt: "2031-09-15T12:00:00.000Z",
      globalAdministrator: "Absent",
      memberships: [
        {
          membershipId: MembershipId.make("membership-1"),
          teamId: TeamId.make("team-1"),
          departmentId: DepartmentId.make("department-1"),
          active: true,
          unitLeader: false,
          unitKind: "Team",
          teamScope: "HomeDepartment",
          departmentIndependent: false,
        },
      ],
      nationalBoardSeats: [],
      delegations: [],
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
          membershipId: MembershipId.make("membership-1"),
          teamId: TeamId.make("team-1"),
          departmentId: DepartmentId.make("department-1"),
          active: true,
          unitLeader: false,
          unitKind: "Team",
          teamScope: "HomeDepartment",
          departmentIndependent: false,
        },
      ],
      nationalBoardSeats: [],
      delegations: [],
    }),
} satisfies Partial<OrganizationOperations>;

const schools = Schools.of({
  readManagement: () => Effect.die("unexpected school management read"),
  authorizeCommand: () => Effect.die("unexpected school command authorization"),
  executeCommand: () => Effect.die("unexpected school command"),
  listDirectory: () => Effect.succeed({ activeSchools: [], inactiveSchools: [] }),
});

const socialEvents = SocialEvents.of({
  readSnapshotInstant: Effect.die("unexpected social-event read"),
  readScope: () => Effect.die("unexpected social-event read"),
  readList: () => Effect.die("unexpected social-event read"),
  validateScope: () => Effect.die("unexpected social-event validation"),
  create: () => Effect.die("unexpected social-event create"),
});

const oauthCredentialAuthority = OAuthCredentialAuthority.of({
  resolve: () => Effect.die("unexpected OAuth credential resolution"),
  resolveInTransaction: () => Effect.die("unexpected OAuth credential resolution"),
});

const makeBackendServices = (
  identity: IdentityOperations,
  organizationService: Partial<OrganizationOperations> = organization,
) =>
  Layer.mergeAll(
    database.layer,
    Layer.succeed(Profile, profile),
    Layer.mock(Organization, organizationService),
    Layer.succeed(Schools, schools),
    Layer.succeed(Identity, identity),
    Layer.succeed(SocialEvents, socialEvents),
    Layer.succeed(
      IdentitySnapshot,
      IdentitySnapshot.of({
        resolveSession: (cookieHeader) =>
          identity.resolveSession(cookieHeader).pipe(
            Effect.catchTag("IdentitySessionExpired", () =>
              Effect.fail(
                new IdentityEngineError({
                  operation: "resolveSnapshotSession",
                  message: "test identity failure",
                }),
              ),
            ),
          ),
        revokeCurrentSession: () => Effect.succeed({ setCookies: [] }),
        revokeSession: (_actor, sessionId, request) =>
          identity.revokeSession(undefined, sessionId, request).pipe(
            Effect.catchTag(
              ["IdentitySessionNotFound", "IdentitySessionExpired", "IdentityEngineError"],
              () =>
                Effect.fail(
                  new IdentityEngineError({
                    operation: "revokeSession",
                    message: "Session revocation failed",
                  }),
                ),
            ),
          ),
        revokeOtherSessions: () => Effect.succeed({ setCookies: [] }),
        revokeAllSessions: () => Effect.succeed({ setCookies: [] }),
      }),
    ),
    Layer.succeed(OAuthCredentialAuthority, oauthCredentialAuthority),
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
  signIn: () => Effect.die("unexpected sign-in"),
  resolveSession: (cookieHeader: string | undefined) =>
    cookieHeader !== undefined && cookieHeader.includes(`${token}=`)
      ? Effect.succeed(
          new IdentityActor({
            personId: PersonId.make("member-1"),
            sessionId: "session-1",
            expiresAt: currentSession.expiresAt,
          }),
        )
      : Effect.fail(new IdentitySessionNotFound()),
  readCurrentSession: () => Effect.succeed(currentSession),
  listSessions: () => Effect.succeed([currentSession]),
  revokeCurrentSession: () => Effect.succeed({ setCookies: [] }),
  revokeSession: () => Effect.succeed({ setCookies: [] }),
  revokeOtherSessions: () => Effect.succeed({ setCookies: [] }),
  revokeAllSessions: () => Effect.succeed({ setCookies: [] }),
  recordSecurityEvent: () => Effect.void,
  signOut: () => Effect.succeed({ setCookies: [] }),
} satisfies IdentityOperations);

const unavailableAuthHandler = {
  handler: () => Effect.succeed(new Response(null, { status: 404 })),
  recordTrustedOriginRejection: () => Effect.void,
};

const successfulServices = makeBackendServices(successfulIdentity);

const backend = backendHttpHandler(config, successfulServices, unavailableAuthHandler);

const request = (pathname: string, init?: RequestInit): Promise<Response> =>
  backend.fetch(new Request(`http://backend.test${pathname}`, init));

const expectedProblem = (code: string, title: string, status: number, detail: string) => ({
  type: `urn:vektorprogrammet:problem:v0.2:${code}`,
  title,
  status,
  detail,
  code,
});

describe("unified backend router", () => {
  it("derives preflight methods with every generated operation attached", () => {
    expect(externalNativePreflightMethodsForPath("/api/session")).toEqual(["GET", "DELETE"]);
    expect(externalNativePreflightAttachmentGaps).toEqual([]);
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
      request("/api/profile", { headers: { cookie: `${token}=value` } }),
      request("/api/departments"),
      request("/api/schools", { headers: { cookie: `${token}=value` } }),
      request("/api/admission-periods"),
      request("/api/receipts"),
      request("/api/recruitment/application-assignments?status=new"),
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
        personId: PersonId.make("member-1"),
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

    for (const response of [admission, receipt, recruitment]) {
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 401,
        body: expectedProblem(
          "credential.missing",
          "Credential required",
          401,
          "A credential is required for this operation.",
        ),
      });
    }

    expect({
      status: publicRecruitment.status,
      body: await publicRecruitment.json(),
    }).toEqual({
      status: 404,
      body: expectedProblem(
        "resource.not-found",
        "Resource not found",
        404,
        "The requested resource was not found.",
      ),
    });

    for (const response of [missing, internalEvidence]) {
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 404,
        body: expectedProblem(
          "resource.not-found",
          "Resource not found",
          404,
          "The requested resource was not found.",
        ),
      });
    }
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
        body: expectedProblem(
          "resource.not-found",
          "Resource not found",
          404,
          "The requested resource was not found.",
        ),
      });
    }
  });

  it("dispatches team-interest and mailing-list reads through Organization", async () => {
    const [teamInterest, mailingLists] = await Promise.all([
      request("/api/team-interest-registrations"),
      request("/api/mailing-lists"),
    ]);

    for (const response of [teamInterest, mailingLists]) {
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 401,
        body: expectedProblem(
          "credential.missing",
          "Credential required",
          401,
          "A credential is required for this operation.",
        ),
      });
    }
  });

  it("exposes exactly the six safe native session resources and removes the old path", async () => {
    const cookieHeaders = { cookie: `${token}=value; other=1` };

    const mutationHeaders = {
      ...cookieHeaders,
      origin: "http://127.0.0.1:5174",
      "idempotency-key": "session-mutation-key-0001",
    };

    const current = await request("/api/session", { headers: cookieHeaders });
    expect(current.headers.get("cache-control")).toBe("private, no-store");
    expect({ status: current.status, body: await current.json() }).toEqual({
      status: 200,
      body: {
        sessionId: "session-1",
        personId: PersonId.make("member-1"),
        createdAt: "2031-09-15T12:00:00.000Z",
        updatedAt: "2031-09-15T12:00:00.000Z",
        expiresAt: "2031-09-16T12:00:00.000Z",
        ipAddress: "127.0.0.1",
        userAgent: "router-test",
        current: true,
      },
    });
    const listed = await request("/api/sessions", { headers: cookieHeaders });
    expect(listed.headers.get("cache-control")).toBe("private, no-store");
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
          personId: PersonId.make("member-1"),
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

    const guardedBackend = backendHttpHandler(
      config,
      makeBackendServices({
        ...successfulIdentity,
        readCurrentSession: () =>
          Effect.sync(() => {
            currentReads += 1;

            return currentSession;
          }),
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

  describe("classifies absent and rejected credentials at ingress", () => {
    const personChallenge = 'VektorSession realm="native-api", Bearer realm="native-api"';

    const decodeProblemCode = Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }));

    const classifyingBackend = backendHttpHandler(
      config,
      Layer.mergeAll(
        makeBackendServices({
          ...successfulIdentity,
          resolveSession: (cookieHeader: string | undefined) =>
            cookieHeader?.split(/;\s*/u).includes(`${token}=valid-session`)
              ? Effect.succeed(
                  new IdentityActor({
                    personId: PersonId.make("member-1"),
                    sessionId: "session-1",
                    expiresAt: currentSession.expiresAt,
                  }),
                )
              : Effect.fail(new IdentitySessionNotFound()),
        }),
        Layer.succeed(
          OAuthCredentialAuthority,
          OAuthCredentialAuthority.of({
            resolve: () =>
              Effect.succeed(CredentialOutcomeSchema.cases.Rejected.make({ reason: "Invalid" })),
            resolveInTransaction: () =>
              Effect.succeed(CredentialOutcomeSchema.cases.Rejected.make({ reason: "Invalid" })),
          }),
        ),
        Layer.mock(Economy, {
          listReceiptsForApproval: () => Effect.succeed({ items: [] }),
        }),
      ),
      unavailableAuthHandler,
    );

    it.each([
      ["Session", "/api/session", 'VektorSession realm="native-api"'],
      ["Person", "/api/profile", personChallenge],
      ["PersonOrService", "/api/receipt-approval-queue", personChallenge],
    ] as const)("for a %s-secured operation", async (_security, path, challenge) => {
      const fetchWith = (headers: Record<string, string>) =>
        classifyingBackend.fetch(new Request(`http://backend.test${path}`, { headers }));

      for (const [headers, code] of [
        [{}, "credential.missing"],
        [{ cookie: "theme=dark; vp.session_token=opaque" }, "credential.missing"],
        [{ cookie: `theme=dark; ${token}=unknown-session` }, "credential.invalid"],
        [{ authorization: "Bearer unknown-token" }, "credential.invalid"],
      ] as const) {
        const response = await fetchWith(headers);

        expect({
          status: response.status,
          code: decodeProblemCode(await response.json()).code,
          challenge: response.headers.get("www-authenticate"),
        }).toEqual({ status: 401, code, challenge });
      }

      expect((await fetchWith({ cookie: `theme=dark; ${token}=valid-session` })).status).toBe(200);
    });

    it("for the contact server credential", async () => {
      const contactBackend = backendHttpHandler(
        {
          ...config,
          contact: contactConfig({
            CONTACT_BACKEND_TOKEN: "router-contact-credential-00000000000000",
            CONTACT_DELIVERY_TOKEN: "router-contact-delivery",
            CONTACT_SENDER: "contact@example.org",
            CONTACT_DELIVERY_URL: "http://127.0.0.1:9",
            CONTACT_DELIVERY_TIMEOUT_MS: "100",
          }),
        },
        successfulServices,
        unavailableAuthHandler,
      );

      for (const [headers, code] of [
        [{}, "credential.missing"],
        [{ "x-vektor-contact-backend": "wrong" }, "credential.invalid"],
      ] as const) {
        const response = await contactBackend.fetch(
          new Request("http://backend.test/api/contact-messages", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "http://127.0.0.1:5174",
              "x-vektor-contact-ip": "127.0.0.1",
              ...headers,
            },
            body: JSON.stringify({
              departmentId: "one",
              name: "Ola",
              email: "ola@example.org",
              subject: "Hei",
              message: "Hei",
            }),
          }),
        );

        expect({
          status: response.status,
          code: Schema.decodeUnknownSync(NativeProblem)(await response.json()).code,
          challenge: response.headers.get("www-authenticate"),
        }).toEqual({ status: 401, code, challenge: 'ContactSSR realm="native-contact"' });
      }
    });
  });

  describe("accepts exactly one credential per request", () => {
    const personChallenge = 'VektorSession realm="native-api", Bearer realm="native-api"';

    // The session cookie names member-1; each bearer names the Person beside it.
    const sessionCookie = `${token}=member-1-session`;

    const bearers = [
      ["Bearer member-1-bearer", "member-1"],
      ["Bearer member-2-bearer", "member-2"],
    ] as const;

    const bearerOutcome = (request: Request, expected: OAuthExpectedMechanism) => {
      const personId = bearers.find(
        ([bearer]) => bearer === request.headers.get("authorization"),
      )?.[1];

      return personId === undefined || expected === "OAuthServiceBearer"
        ? CredentialOutcomeSchema.cases.Rejected.make({ reason: "Invalid" })
        : CredentialOutcomeSchema.cases.Accepted.make({
            mechanism: CredentialMechanismSchema.cases.OAuthUserBearer.make({}),
            principal: PrincipalSchema.cases.Person.make({ personId: PersonId.make(personId) }),
            evidenceRef: CredentialEvidenceRef.make(`oauth:Person:${personId}`),
          });
    };

    // The projection names whichever Person the resolved credential names.
    const actingOrganization: Partial<OrganizationOperations> = {
      ...organization,
      resolvePersonAuthority: (personId, authorizationInstant) =>
        Effect.map(
          organization.resolvePersonAuthority(personId, authorizationInstant),
          (authority) => ({ ...authority, personId }),
        ),
    };

    const oneCredentialBackend = backendHttpHandler(
      config,
      Layer.mergeAll(
        makeBackendServices(
          {
            ...successfulIdentity,
            resolveSession: (cookieHeader: string | undefined) =>
              cookieHeader?.split(/;\s*/u).includes(sessionCookie) === true
                ? Effect.succeed(
                    new IdentityActor({
                      personId: PersonId.make("member-1"),
                      sessionId: "session-1",
                      expiresAt: currentSession.expiresAt,
                    }),
                  )
                : Effect.fail(new IdentitySessionNotFound()),
          },
          actingOrganization,
        ),
        Layer.succeed(
          OAuthCredentialAuthority,
          OAuthCredentialAuthority.of({
            resolve: (request, expected) => Effect.succeed(bearerOutcome(request, expected)),
            resolveInTransaction: (request, expected) =>
              Effect.succeed(bearerOutcome(request, expected)),
          }),
        ),
        Layer.mock(Economy, {
          listReceiptsForApproval: () => Effect.succeed({ items: [] }),
        }),
      ),
      unavailableAuthHandler,
    );

    // A problem names its code; a profile names the Person who acted.
    const answer = async (path: string, headers: Record<string, string>) => {
      const response = await oneCredentialBackend.fetch(
        new Request(`http://backend.test${path}`, { headers }),
      );

      return {
        status: response.status,
        challenge: response.headers.get("www-authenticate"),
        ...Schema.decodeUnknownSync(
          Schema.Struct({
            code: Schema.optional(Schema.String),
            personId: Schema.optional(Schema.String),
          }),
        )(await response.json()),
      };
    };

    // Each test case gets a fresh database, so both cases seed the bearer's Person.
    const seedBearerPerson = () =>
      database.run(
        Database.use((sql) =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO person_profiles VALUES ('member-2','Member','Two',0)`;
            yield* sql`INSERT INTO person_contact_profiles VALUES ('member-2','member-2@example.invalid','90000001',0)`;
          }),
        ),
      );

    it.each([
      ["Session", "/api/session", 'VektorSession realm="native-api"'],
      ["Person", "/api/profile", personChallenge],
      ["PersonOrService", "/api/receipt-approval-queue", personChallenge],
    ] as const)(
      "rejects a session cookie with a bearer at a %s-secured operation",
      async (_security, path, challenge) => {
        await seedBearerPerson();

        // The first bearer names another Person than the session; the second names the same one.
        for (const bearer of ["Bearer member-2-bearer", "Bearer member-1-bearer"]) {
          expect({
            bearer,
            ...(await answer(path, {
              cookie: `theme=dark; ${sessionCookie}`,
              authorization: bearer,
            })),
          }).toEqual({ bearer, status: 401, code: "credential.invalid", challenge });
        }
      },
    );

    it("lets either person credential alone name the acting Person", async () => {
      await seedBearerPerson();

      expect(await answer("/api/profile", { cookie: sessionCookie })).toEqual({
        status: 200,
        challenge: null,
        personId: "member-1",
      });
      expect(await answer("/api/profile", { authorization: "Bearer member-2-bearer" })).toEqual({
        status: 200,
        challenge: null,
        personId: "member-2",
      });
    });
  });

  it("answers a handler defect with the frozen internal.error problem", async () => {
    // The router's SocialEvents service dies on every call.
    const response = await request("/api/social-events/scope", {
      headers: { cookie: `${token}=value` },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(
      Schema.decodeUnknownSync(SocialEventsReadScopeProblem)(await response.json(), {
        onExcessProperty: "error",
      }).code,
    ).toBe("internal.error");
  });

  it("conceals missing, non-owned, and already-revoked session ids identically", async () => {
    const owned = new Set(["owned-session"]);
    let revokeCalls = 0;

    const ownerBackend = backendHttpHandler(
      config,
      makeBackendServices({
        ...successfulIdentity,
        revokeSession: (_cookie, sessionId) =>
          Effect.suspend(() => {
            revokeCalls += 1;

            return owned.delete(sessionId)
              ? Effect.succeed({ setCookies: [] })
              : Effect.fail(new IdentityOwnedSessionNotFound({ sessionId }));
          }),
      }),
      unavailableAuthHandler,
    );

    const headers = {
      cookie: `${token}=value`,
      origin: "http://127.0.0.1:5174",
      "idempotency-key": "owned-session-delete-key-01",
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

    const replay = await ownerBackend.fetch(
      new Request("http://backend.test/api/sessions/owned-session", { method: "DELETE", headers }),
    );

    expect(replay.status).toBe(204);
    expect(revokeCalls).toBe(1);

    for (const sessionId of ["owned-session", "missing-session", "another-person-session"]) {
      const response = await ownerBackend.fetch(
        new Request(`http://backend.test/api/sessions/${sessionId}`, {
          method: "DELETE",
          headers: { ...headers, "idempotency-key": `conceal-session-${sessionId}-key` },
        }),
      );

      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 404,
        body: expectedProblem(
          "resource.not-found",
          "Resource not found",
          404,
          "The requested resource was not found.",
        ),
      });
    }

    expect(revokeCalls).toBe(4);
  });

  it("centralizes trusted-origin, CSRF rejection, audit, and credentialed CORS", async () => {
    const handled: string[] = [];
    const rejectedCorrelations: string[] = [];

    const originBackend = backendHttpHandler(config, successfulServices, {
      handler: (request) =>
        Effect.sync(() => {
          handled.push(new URL(request.url).pathname);

          return new Response(null, { status: 204 });
        }),
      recordTrustedOriginRejection: (context) =>
        Effect.sync(() => {
          rejectedCorrelations.push(context.requestCorrelation);
        }),
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

    const oauthBackend = backendHttpHandler(config, successfulServices, {
      handler: () => Effect.succeed(new Response(null, { status: 404 })),
      oauthHandler: (request) =>
        Effect.sync(() => {
          oauthCalls.push(`${request.method} ${new URL(request.url).pathname}`);

          return Response.json(
            { error: "invalid_request" },
            {
              status: 400,
              headers: {
                "cache-control": "no-store",
                "content-type": "application/json",
              },
            },
          );
        }),
      recordTrustedOriginRejection: (context) =>
        Effect.sync(() => {
          rejectedCorrelations.push(context.requestCorrelation);
        }),
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

    const backend = backendHttpHandler(config, successfulServices, {
      handler: (request) =>
        Effect.sync(() => {
          dispatched.push(new URL(request.url).pathname);

          return new Response(null, { status: 204 });
        }),
      recordTrustedOriginRejection: (context) =>
        Effect.sync(() => {
          rejectedCorrelations.push(context.requestCorrelation);
        }),
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
          "access-control-request-method": "DELETE",
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

  it("composes local and production cookie policy without invented origins", () => {
    expect(config.sessionBoundary).toEqual({
      deployment: "local",
      trustedOrigins: ["http://127.0.0.1:5174"],
      secureCookies: false,
    });
    expect(
      decodeBackendConfig({
        ...environment,
        NATIVE_IDENTITY_DEPLOYMENT: "production",
        NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify(["https://dashboard.example.invalid"]),
        OAUTH_CANONICAL_ORIGIN: "https://dashboard.example.invalid",
        OAUTH_DASHBOARD_ORIGIN: "https://dashboard.example.invalid",
      }).sessionBoundary,
    ).toEqual({
      deployment: "production",
      trustedOrigins: ["https://dashboard.example.invalid"],
      secureCookies: true,
    });
    expect(() =>
      decodeBackendConfig({
        ...environment,
        NATIVE_IDENTITY_DEPLOYMENT: "production",
        NATIVE_IDENTITY_TRUSTED_ORIGINS: undefined,
      }),
    ).toThrow();
  });

  it.each([
    ["BETTER_AUTH_URL", "http://127.0.0.1:5174"],
    ["BETTER_AUTH_URL", ""],
    ["BETTER_AUTH_TRUSTED_ORIGINS", "http://127.0.0.1:5174"],
    ["BETTER_AUTH_TRUSTED_ORIGINS", ""],
  ] as const)("rejects unsupported %s even when its value is %j", (name, value) => {
    expect(() => decodeBackendConfig({ ...environment, [name]: value })).toThrow("unsupported");
  });

  it("forwards an evidence-only clock to protected authority resolution", async () => {
    const authorizationInstants: string[] = [];
    const pinnedInstant = "2037-01-15T12:00:00.000Z";

    const observedOrganization: Partial<OrganizationOperations> = {
      ...organization,
      resolvePersonAuthority: (personId, authorizationInstant) => {
        authorizationInstants.push(authorizationInstant);

        return organization.resolvePersonAuthority(personId, authorizationInstant);
      },
    };

    const pinnedBackend = backendHttpHandler(
      config,
      makeBackendServices(successfulIdentity, observedOrganization),
      unavailableAuthHandler,
      { now: () => pinnedInstant },
    );

    const response = await pinnedBackend.fetch(
      new Request("http://backend.test/api/profile", {
        headers: { cookie: `${token}=value` },
      }),
    );

    expect(response.status).toBe(200);
    expect(authorizationInstants).toEqual([pinnedInstant]);
  });

  it.each([
    [
      "expired session",
      new IdentitySessionExpired(),
      401,
      "credential.invalid",
      "Invalid credential",
      "The supplied credential is invalid.",
    ],
    [
      "typed provider failure",
      new IdentityEngineError({
        operation: "getSession",
        message: "authentication provider unavailable",
      }),
      503,
      "identity.unavailable",
      "Identity unavailable",
      "The identity service is temporarily unavailable.",
    ],
  ] as const)(
    "maps %s at the session HTTP boundary",
    async (_name, failure, status, code, title, detail) => {
      const failingBackend = backendHttpHandler(
        config,
        makeBackendServices({
          ...successfulIdentity,
          readCurrentSession: () => Effect.fail(failure),
        }),
        unavailableAuthHandler,
      );

      const response = await failingBackend.fetch(
        new Request("http://backend.test/api/session", {
          headers: { cookie: "better-auth.session_token=session-value" },
        }),
      );

      expect({ status: response.status, body: await response.json() }).toEqual({
        status,
        body: expectedProblem(code, title, status, detail),
      });
    },
  );

  it("mounts the auth engine handler over the /api/auth/* surface", async () => {
    const probingBackend = backendHttpHandler(config, successfulServices, {
      handler: (request) =>
        Effect.sync(() => new Response(`auth-saw:${new URL(request.url).pathname}`)),
      recordTrustedOriginRejection: () => Effect.void,
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
      decodeBackendConfig({
        ...environment,
        PUBLIC_APPLICATION_EFFECT_MODE: "http",
        PUBLIC_APPLICATION_EFFECT_ENDPOINT: "http://provider.example.invalid/effects",
        PUBLIC_APPLICATION_EFFECT_TOKEN: "provider-token",
      }),
    ).toThrow("must use HTTPS unless it targets loopback");

    expect(
      decodeBackendConfig({
        ...environment,
        PUBLIC_APPLICATION_EFFECT_MODE: "http",
        PUBLIC_APPLICATION_EFFECT_ENDPOINT: "http://127.0.0.1:8898/effects",
        PUBLIC_APPLICATION_EFFECT_TOKEN: "provider-token",
      }).publicApplicationEffects?.endpoint.href,
    ).toBe("http://127.0.0.1:8898/effects");
  });

  it("requires an explicit application effect mode", () => {
    const { PUBLIC_APPLICATION_EFFECT_MODE: _, ...implicitEnvironment } = environment;
    expect(() => decodeBackendConfig(implicitEnvironment)).toThrow(
      "PUBLIC_APPLICATION_EFFECT_MODE must be disabled or http",
    );
    expect(() =>
      decodeBackendConfig({
        ...environment,
        PUBLIC_APPLICATION_EFFECT_ENDPOINT: "https://provider.example.invalid/effects",
        PUBLIC_APPLICATION_EFFECT_TOKEN: "provider-token",
      }),
    ).toThrow("require PUBLIC_APPLICATION_EFFECT_MODE=http");
  });
});

it("classifies only exact password recovery method/path origin rejections", async () => {
  const observed: Array<string | undefined> = [];

  const backend = backendHttpHandler(config, successfulServices, {
    handler: () => Effect.die(new Error("Rejected origin must not reach engine")),
    recordTrustedOriginRejection: (_context, flow) =>
      Effect.sync(() => {
        observed.push(flow);
      }),
  });

  const cases = [
    ["POST", "/api/auth/request-password-reset", "PasswordRecovery"],
    ["POST", "/api/auth/reset-password", "PasswordRecovery"],
    ["GET", "/api/auth/reset-password/opaque", "PasswordRecovery"],
    ["GET", "/api/auth/request-password-reset", undefined],
    ["POST", "/api/auth/reset-password/opaque", undefined],
    ["GET", "/api/auth/reset-password/opaque/extra", undefined],
    ["POST", "/api/auth/sign-in/email", undefined],
  ] as const;

  for (const [method, path, flow] of cases) {
    expect(
      (
        await backend.fetch(
          new Request(`http://backend.test${path}`, {
            method,
            headers: { origin: "https://untrusted.example.invalid" },
          }),
        )
      ).status,
    ).toBe(403);
    expect(observed.at(-1)).toBe(flow);
  }
});
