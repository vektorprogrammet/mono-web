import type { Admissions } from "@vektorprogrammet/domain/admissions";
import {
  Auth,
  AuthenticatedActor,
  AuthSessionNotFound,
  type AuthShape,
} from "@vektorprogrammet/domain/auth";
import { Database, type DatabaseShape } from "@vektorprogrammet/domain/database";
import { Organization, type OrganizationShape } from "@vektorprogrammet/domain/organization";
import {
  PersonContactProfile,
  PersonProfile,
  Profile,
  type ProfileShape,
} from "@vektorprogrammet/domain/profile";
import type { Economy } from "@vektorprogrammet/domain/receipt";
import type { Recruitment } from "@vektorprogrammet/domain/recruitment";
import { DateTime, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeBackendConfig } from "./config.js";
import { makeBackendHttp, type BackendRun } from "./router.js";
import { runTestPromise } from "../test/runtime.js";

const token = "shared-token";
const environment = {
  BACKEND_PG_URL: "postgres://test.invalid/vektorprogrammet",
  BETTER_AUTH_SECRET: "router-test-secret-with-at-least-32-characters!",
  PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
  ADMISSION_AUTH_TOKENS: JSON.stringify({
    [token]: {
      _tag: "Member",
      personId: "member-1",
      departmentId: "department-1",
      active: true,
    },
  }),
  ADMISSION_FIXED_NOW: "2031-09-15T12:00:00.000Z",
  RECEIPT_AUTH_TOKENS: JSON.stringify({
    [token]: {
      personId: "member-1",
      departmentId: "department-1",
      active: true,
      paymentAccountCiphertext: "ciphertext",
      approvalScope: { _tag: "None" },
    },
  }),
  ORGANIZATION_AUTH_TOKENS: JSON.stringify({
    [token]: {
      _tag: "OrganizationMember",
      personId: "member-1",
    },
  }),
} as const;
const config = makeBackendConfig(environment);

const database = { health: Effect.void } as unknown as DatabaseShape;
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
} as unknown as OrganizationShape;

const successfulRun: BackendRun = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    Database | Admissions | Economy | Organization | Profile | Recruitment | Auth
  >,
): Promise<A> =>
  runTestPromise(
    effect.pipe(
      Effect.provideService(Database, database),
      Effect.provideService(Profile, profile),
      Effect.provideService(Organization, organization),
      Effect.provideService(Auth, {
        signIn: () => Promise.reject(new Error("unexpected sign-in")),
        resolveSession: async (cookieHeader: string | undefined) => {
          if (cookieHeader !== undefined && cookieHeader.includes(`${token}=`)) {
            return new AuthenticatedActor({
              personId: "member-1" as never,
              sessionId: "session-1",
              expiresAt: DateTime.makeUnsafe(new Date("2031-09-16T12:00:00.000Z")),
            });
          }
          throw new AuthSessionNotFound({ sessionToken: "" });
        },
        signOut: async () => undefined,
      } as unknown as AuthShape),
    ) as Effect.Effect<A, E>,
  );
const backend = makeBackendHttp(config, successfulRun, {
  handle: async () => new Response(null, { status: 404 }),
});

const request = (pathname: string, init?: RequestInit): Promise<Response> =>
  backend.fetch(new Request(`http://backend.test${pathname}`, init));

describe("unified backend router", () => {
  it("owns health, Profile, Organization, Admission, Receipt, and Recruitment routes", async () => {
    const [
      health,
      profile,
      organizationResponse,
      admission,
      receipt,
      recruitment,
      publicRecruitment,
      missing,
    ] = await Promise.all([
      request("/health"),
      request("/api/me", { headers: { cookie: `${token}=value` } }),
      request("/api/departments"),
      request("/api/admin/admission-periods"),
      request("/api/receipts"),
      request("/api/admin/recruitment/assignment-board?status=new"),
      request("/api/recruitment/invitation-response"),
      request("/api/not-a-capability"),
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

  it("serves GET /api/me/session from the session cookie and fails closed without one", async () => {
    const ok = await request("/api/me/session", { headers: { cookie: `${token}=value; other=1` } });
    expect({ status: ok.status, body: await ok.json() }).toEqual({
      status: 200,
      body: {
        personId: "member-1",
        expiresAt: "2031-09-16T12:00:00.000Z",
      },
    });

    const anonymous = await request("/api/me/session");
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: { tag: "UnauthenticatedActor" } });
  });

  it("mounts the auth engine handler over the /api/auth/* surface", async () => {
    const calls: Array<string> = [];
    const probingBackend = makeBackendHttp(config, successfulRun, {
      handle: async (request) => new Response(`auth-saw:${new URL(request.url).pathname}`),
    });
    void calls;
    for (const path of ["/api/auth/get-session", "/api/auth/sign-in/email", "/api/auth/"]) {
      const response = await probingBackend.fetch(
        new Request(`http://backend.test${path}`, { method: "POST" }),
      );
      expect(await response.text()).toBe(`auth-saw:${path}`);
    }
  });

  it("rejects conflicting identity facts at the process boundary", () => {
    expect(() =>
      makeBackendConfig({
        ...environment,
        RECEIPT_AUTH_TOKENS: JSON.stringify({
          [token]: {
            personId: "member-1",
            departmentId: "different-department",
            active: true,
            paymentAccountCiphertext: "ciphertext",
            approvalScope: { _tag: "None" },
          },
        }),
      }),
    ).toThrow("conflicting actor facts for shared token");
  });

  it("boots with the legacy auth token env maps absent", () => {
    const {
      ADMISSION_AUTH_TOKENS: _admissionTokens,
      RECEIPT_AUTH_TOKENS: _receiptTokens,
      ORGANIZATION_AUTH_TOKENS: _organizationTokens,
      ...legacyFreeEnvironment
    } = environment;
    const legacyFreeConfig = makeBackendConfig(legacyFreeEnvironment);
    expect(legacyFreeConfig.admission.tokens.size).toBe(0);
    expect(legacyFreeConfig.receipt.tokens.size).toBe(0);
    expect(legacyFreeConfig.organization.actorsByToken.size).toBe(0);
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
