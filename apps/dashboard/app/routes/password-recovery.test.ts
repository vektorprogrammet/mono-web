import { beforeEach, describe, expect, it, vi } from "vitest";

const legacyPasswordRecovery = vi.hoisted(() => ({
  requestLegacySymfonyPasswordReset: vi.fn(),
  setLegacySymfonyPassword: vi.fn(),
}));

vi.mock("../server/legacy-symfony-password-recovery.server", () => legacyPasswordRecovery);

import { action as requestPasswordReset } from "./glemt-passord";
import { action as setPassword } from "./tilbakestill-passord.$code";

const formRequest = (path: string, fields: Readonly<Record<string, string>>): Request =>
  new Request(`http://dashboard.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });

describe("interim legacy password-recovery routes", () => {
  beforeEach(() => {
    legacyPasswordRecovery.requestLegacySymfonyPasswordReset.mockReset();
    legacyPasswordRecovery.setLegacySymfonyPassword.mockReset();
  });

  it("moves the forgot-password action to the narrow server adapter", async () => {
    legacyPasswordRecovery.requestLegacySymfonyPasswordReset.mockResolvedValue(undefined);

    const result = await requestPasswordReset({
      request: formRequest("/glemt-passord", { email: "ada@example.invalid" }),
      params: {},
    } as never);

    expect(legacyPasswordRecovery.requestLegacySymfonyPasswordReset).toHaveBeenCalledOnce();
    expect(legacyPasswordRecovery.requestLegacySymfonyPasswordReset).toHaveBeenCalledWith(
      "ada@example.invalid",
    );
    expect(result).toEqual({ success: true, error: null });
  });

  it("preserves the forgot-password failure result", async () => {
    legacyPasswordRecovery.requestLegacySymfonyPasswordReset.mockRejectedValue(
      new Error("legacy unavailable"),
    );

    const result = await requestPasswordReset({
      request: formRequest("/glemt-passord", { email: "ada@example.invalid" }),
      params: {},
    } as never);

    expect(result).toEqual({
      error: "Noe gikk galt. Vennligst prøv igjen.",
      success: false,
    });
  });

  it("keeps the dynamic code route and legacy password body behavior", async () => {
    legacyPasswordRecovery.setLegacySymfonyPassword.mockResolvedValue(undefined);

    const result = await setPassword({
      request: formRequest("/tilbakestill-passord/code-123", {
        password: "eight-or-more",
        confirmPassword: "eight-or-more",
      }),
      params: { code: "code-123" },
    } as never).catch((error: unknown) => error);

    expect(legacyPasswordRecovery.setLegacySymfonyPassword).toHaveBeenCalledOnce();
    expect(legacyPasswordRecovery.setLegacySymfonyPassword).toHaveBeenCalledWith(
      "code-123",
      "eight-or-more",
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);
    expect((result as Response).headers.get("Location")).toBe("/login?reset=true");
  });

  it("preserves the reset failure result", async () => {
    legacyPasswordRecovery.setLegacySymfonyPassword.mockRejectedValue(new Error("legacy rejected"));

    const result = await setPassword({
      request: formRequest("/tilbakestill-passord/code-123", {
        password: "eight-or-more",
        confirmPassword: "eight-or-more",
      }),
      params: { code: "code-123" },
    } as never);

    expect(result).toEqual({
      error: "Kunne ikke tilbakestille passordet. Lenken kan være ugyldig eller utløpt.",
    });
  });
});
