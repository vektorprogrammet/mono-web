import { describe, expect, it } from "vitest";
import { isNativeOperation, isNativeRequest } from "../e2e/native-operations.ts";
import { addressesRoute } from "../e2e/request-routes.ts";

/** Better Auth session identifier from hosted run 36224459581; its "jwT" is random. */
const hostedRunSessionId = "wm97nHEWTDO8UArCXrVpni919bgIjwTB";

describe("journey request route classification", () => {
  it("keeps a native request native whatever random value fills its path parameter", () => {
    expect(isNativeRequest("DELETE", `/api/sessions/${hostedRunSessionId}`)).toBe(true);
    expect(isNativeRequest("DELETE", "/api/sessions/reset-token-jwt-verification")).toBe(true);
  });

  it("matches the method, the literal text beside a parameter, and one whole segment", () => {
    expect(isNativeOperation("POST", "/api/receipts/receipt_1:approve")).toBe(true);
    expect(isNativeOperation("GET", `/api/sessions/${hostedRunSessionId}`)).toBe(false);
    expect(isNativeOperation("POST", "/api/receipts/receipt_1:approved")).toBe(false);
    expect(isNativeOperation("DELETE", `/api/sessions/${hostedRunSessionId}/extra`)).toBe(false);
  });

  it("keeps the email sign-in and leaves the native surface for every other identity route", () => {
    expect(isNativeRequest("POST", "/api/auth/sign-in/email")).toBe(true);

    for (const [method, pathname] of [
      ["POST", "/api/auth/sign-in/social"],
      ["GET", "/api/auth/callback/google"],
      ["POST", "/api/auth/request-password-reset"],
      ["POST", "/api/auth/oauth2/token"],
      ["POST", "/api/login"],
    ] as const) {
      expect(isNativeRequest(method, pathname)).toBe(false);
    }
  });

  it("addresses a route by whole consecutive segments at any depth", () => {
    expect(addressesRoute("/app/mock/api/data-brukere.ts", "/mock/api")).toBe(true);
    expect(addressesRoute("/mock/apis", "/mock/api")).toBe(false);
    expect(addressesRoute("/api/mock", "/mock/api")).toBe(false);
  });

  it("never reads an opaque segment as a route", () => {
    expect(addressesRoute("/interview-response/Xsymfony9Qa", "/symfony")).toBe(false);
    expect(addressesRoute("/assets/glemt-passord-C-r9YSzX.js", "/glemt-passord")).toBe(false);
  });

  it("addresses the route of a React Router single-fetch request", () => {
    expect(addressesRoute("/glemt-passord.data", "/glemt-passord")).toBe(true);
  });
});
