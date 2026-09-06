import { serverApiEndpoint } from "../lib/api.server";
export class PasswordRecoveryError extends Error {
  constructor(readonly outcome: "InvalidOrExpired" | "OutcomeUnknown" | "Rejected") {
    super(outcome);
  }
}
/** Credential-only client; never part of the native generated operation registry. */
export const createPasswordRecoveryClient = (request: Request) => {
  const origin = request.headers.get("origin") ?? new URL(request.url).origin;
  const dashboardOrigin = process.env.OAUTH_DASHBOARD_ORIGIN;
  if (!dashboardOrigin) throw new Error("Recovery dashboard origin is not configured");
  const post = async (path: string, body: unknown) => {
    let response: Response;
    try {
      response = await fetch(serverApiEndpoint(`/api/auth/${path}`), {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new PasswordRecoveryError("OutcomeUnknown");
    }
    const decoded: unknown = await response.json().catch(() => null);
    if (
      response.ok &&
      decoded !== null &&
      typeof decoded === "object" &&
      "status" in decoded &&
      decoded.status === true
    )
      return;
    if (response.status >= 500) throw new PasswordRecoveryError("OutcomeUnknown");
    throw new PasswordRecoveryError(
      decoded !== null &&
        typeof decoded === "object" &&
        "code" in decoded &&
        decoded.code === "INVALID_TOKEN"
        ? "InvalidOrExpired"
        : "Rejected",
    );
  };
  return {
    requestPasswordReset: (email: string) =>
      post("request-password-reset", {
        email,
        redirectTo: `${dashboardOrigin}/tilbakestill-passord`,
      }),
    resetPassword: (token: string, newPassword: string) =>
      post("reset-password", { token, newPassword }),
  };
};
/** Explicit ownership; native dashboard sign-in cannot be paired with legacy reset. */
export const requireNativePasswordRecovery = () => {
  if (process.env.PASSWORD_RECOVERY_ENGINE !== "native")
    throw new Error("Native recovery cohort has not been enabled");
};
