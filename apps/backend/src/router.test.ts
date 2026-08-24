import type { Admissions } from "@vektorprogrammet/domain/admissions";
import { Database, type DatabaseShape } from "@vektorprogrammet/domain/database";
import type { Organization } from "@vektorprogrammet/domain/organization";
import {
  PersonContactProfile,
  PersonProfile,
  Profile,
  type ProfileShape,
} from "@vektorprogrammet/domain/profile";
import type { Economy } from "@vektorprogrammet/domain/receipt";
import type { Recruitment } from "@vektorprogrammet/domain/recruitment";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeBackendConfig } from "./config.js";
import { makeBackendHttp, type BackendRun } from "./router.js";

const token = "shared-token";
const environment = {
  BACKEND_PG_URL: "postgres://test.invalid/vektorprogrammet",
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
};
const successfulRun: BackendRun = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    Database | Admissions | Economy | Organization | Profile | Recruitment
  >,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(Database, database),
      Effect.provideService(Profile, profile),
    ) as Effect.Effect<A, E>,
  );
const backend = makeBackendHttp(config, successfulRun);

const request = (pathname: string, init?: RequestInit): Promise<Response> =>
  backend.fetch(new Request(`http://backend.test${pathname}`, init));

describe("unified backend router", () => {
  it("owns health, Profile, Admission, Receipt, and Recruitment routes on one listener", async () => {
    const [
      health,
      profile,
      admission,
      receipt,
      recruitment,
      publicRecruitment,
      missing,
    ] = await Promise.all([
      request("/health"),
      request("/api/me/profile", { headers: { authorization: `Bearer ${token}` } }),
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
      body: expect.objectContaining({
        firstName: "Member",
        lastName: "One",
        userName: null,
        email: "",
        role: "ROLE_TEAM_MEMBER",
      }),
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
