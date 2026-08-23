import { describe, expect, it } from "vitest";
import { makeBackendConfig } from "./config.js";
import { makeBackendHttp, type BackendRun } from "./router.js";

const token = "shared-token";
const environment = {
  BACKEND_PG_URL: "postgres://test.invalid/vektorprogrammet",
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

const successfulRun: BackendRun = async <A>(): Promise<A> => undefined as A;
const backend = makeBackendHttp(config, successfulRun);

const request = (pathname: string, init?: RequestInit): Promise<Response> =>
  backend.fetch(new Request(`http://backend.test${pathname}`, init));

describe("unified backend router", () => {
  it("owns health, profile, Admission, and Receipt routes on one listener", async () => {
    const [health, profile, admission, receipt, missing] = await Promise.all([
      request("/health"),
      request("/api/me/profile", { headers: { authorization: `Bearer ${token}` } }),
      request("/api/admin/admission-periods"),
      request("/api/receipts"),
      request("/api/not-a-capability"),
    ]);

    expect({ status: health.status, body: await health.json() }).toEqual({
      status: 200,
      body: { status: "ok" },
    });
    expect({ status: profile.status, body: await profile.json() }).toEqual({
      status: 200,
      body: expect.objectContaining({ userName: "member-1", role: "assistant" }),
    });
    expect({ status: admission.status, body: await admission.json() }).toEqual({
      status: 401,
      body: { error: { tag: "UnauthenticatedActor" } },
    });
    expect({ status: receipt.status, body: await receipt.json() }).toEqual({
      status: 401,
      body: { error: { tag: "UnauthenticatedActor" } },
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
        PUBLIC_APPLICATION_EFFECT_ENDPOINT: "http://provider.example.invalid/effects",
        PUBLIC_APPLICATION_EFFECT_TOKEN: "provider-token",
      }),
    ).toThrow("must use HTTPS unless it targets loopback");

    expect(
      makeBackendConfig({
        ...environment,
        PUBLIC_APPLICATION_EFFECT_ENDPOINT: "http://127.0.0.1:8898/effects",
        PUBLIC_APPLICATION_EFFECT_TOKEN: "provider-token",
      }).publicApplicationEffects?.endpoint.href,
    ).toBe("http://127.0.0.1:8898/effects");
  });
});
