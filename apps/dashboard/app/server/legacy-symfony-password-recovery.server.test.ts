import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as passwordRecovery from "./legacy-symfony-password-recovery.server";

const ConfigurationName = "LEGACY_SYMFONY_PASSWORD_RECOVERY_URL";
const appDirectory = fileURLToPath(new URL("..", import.meta.url));

const collectSourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    return /\.[cm]?[jt]sx?$/u.test(entry.name) ? [path] : [];
  });

describe("legacy Symfony password recovery server adapter", () => {
  beforeEach(() => {
    vi.stubEnv(ConfigurationName, "https://legacy.example");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("exports only the two frozen password-recovery operations", () => {
    expect(Object.keys(passwordRecovery).sort()).toEqual([
      "requestLegacySymfonyPasswordReset",
      "setLegacySymfonyPassword",
    ]);
  });

  it("posts the exact reset-request route, body, and status contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await passwordRecovery.requestLegacySymfonyPasswordReset("ada@example.invalid");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("https://legacy.example/api/password_resets", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "ada@example.invalid" }),
      redirect: "error",
    });
  });

  it("encodes the reset code as one path segment and preserves the legacy body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await passwordRecovery.setLegacySymfonyPassword("code/with ?#%", "eight-or-more");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://legacy.example/api/password_resets/code%2Fwith%20%3F%23%25",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password: "eight-or-more" }),
        redirect: "error",
      },
    );
  });

  it.each([
    [
      "request",
      () => passwordRecovery.requestLegacySymfonyPasswordReset("ada@example.invalid"),
      "Legacy Symfony password reset request failed",
    ],
    [
      "update",
      () => passwordRecovery.setLegacySymfonyPassword("code", "eight-or-more"),
      "Legacy Symfony password update failed",
    ],
  ] as const)("rejects an unexpected %s response status", async (_operation, run, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("opaque", { status: 200 })));

    await expect(run()).rejects.toThrow(message);
  });

  it("maps transport errors to one bounded unavailable error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret provider detail")));

    await expect(
      passwordRecovery.requestLegacySymfonyPasswordReset("ada@example.invalid"),
    ).rejects.toThrow("Legacy Symfony password recovery is unavailable");
  });

  it.each([
    [undefined, `${ConfigurationName} is not configured`],
    [
      "https://legacy.example/",
      `${ConfigurationName} must be an exact HTTPS origin or fixed-port http://127.0.0.1 origin`,
    ],
    [
      "https://legacy.example/api",
      `${ConfigurationName} must be an exact HTTPS origin or fixed-port http://127.0.0.1 origin`,
    ],
    [
      "http://legacy.example:8000",
      `${ConfigurationName} must be an exact HTTPS origin or fixed-port http://127.0.0.1 origin`,
    ],
  ] as const)("rejects an invalid legacy origin", async (value, message) => {
    if (value === undefined) vi.stubEnv(ConfigurationName, "");
    else vi.stubEnv(ConfigurationName, value);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      passwordRecovery.requestLegacySymfonyPasswordReset("ada@example.invalid"),
    ).rejects.toThrow(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts only the fixed-port loopback HTTP exception", async () => {
    vi.stubEnv(ConfigurationName, "http://127.0.0.1:8000");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await passwordRecovery.requestLegacySymfonyPasswordReset("ada@example.invalid");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/api/password_resets",
      expect.any(Object),
    );
  });

  it("keeps the adapter behind the route-action server boundary", () => {
    const adapterName = "legacy-symfony-password-recovery.server";
    const allowedImporters: Readonly<Record<string, true>> = {
      [join(appDirectory, "routes", "glemt-passord.tsx")]: true,
      [join(appDirectory, "routes", "tilbakestill-passord.$code.tsx")]: true,
    };
    const violations = collectSourceFiles(appDirectory).filter((path) => {
      if (path.endsWith(".test.ts") || allowedImporters[path] === true) return false;
      return readFileSync(path, "utf8").includes(adapterName);
    });

    expect(
      fileURLToPath(new URL("./legacy-symfony-password-recovery.server.ts", import.meta.url)),
    ).toMatch(/\.server\.ts$/u);
    expect(violations).toEqual([]);
  });
});
