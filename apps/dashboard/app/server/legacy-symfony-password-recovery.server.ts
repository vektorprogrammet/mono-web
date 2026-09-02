const LegacySymfonyPasswordRecoveryUrl = "LEGACY_SYMFONY_PASSWORD_RECOVERY_URL";

const legacySymfonyOrigin = (): string => {
  const value = process.env[LegacySymfonyPasswordRecoveryUrl];
  if (value === undefined || value.length === 0) {
    throw new Error(`${LegacySymfonyPasswordRecoveryUrl} is not configured`);
  }
  if (value.trim() !== value) {
    throw new Error(`${LegacySymfonyPasswordRecoveryUrl} must be an exact origin`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${LegacySymfonyPasswordRecoveryUrl} must be an exact origin`);
  }

  const localLoopback =
    url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port.length > 0;
  if (
    url.origin !== value ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.protocol !== "https:" && !localLoopback)
  ) {
    throw new Error(
      `${LegacySymfonyPasswordRecoveryUrl} must be an exact HTTPS origin or fixed-port http://127.0.0.1 origin`,
    );
  }

  return value;
};

const legacySymfonyEndpoint = (path: string): string =>
  new URL(path, `${legacySymfonyOrigin()}/`).toString();

const postLegacyPasswordRecovery = async (
  path: string,
  body: Readonly<Record<string, string>>,
  failureMessage: string,
): Promise<void> => {
  const endpoint = legacySymfonyEndpoint(path);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
    });
  } catch {
    throw new Error("Legacy Symfony password recovery is unavailable");
  }

  if (response.status !== 204) throw new Error(failureMessage);
};

export const requestLegacySymfonyPasswordReset = (email: string): Promise<void> =>
  postLegacyPasswordRecovery(
    "/api/password_resets",
    { email },
    "Legacy Symfony password reset request failed",
  );

export const setLegacySymfonyPassword = (code: string, password: string): Promise<void> =>
  postLegacyPasswordRecovery(
    `/api/password_resets/${encodeURIComponent(code)}`,
    { password },
    "Legacy Symfony password update failed",
  );
