import { isIP } from "node:net";

/** Validate selections before either database connection is opened. */
export const selectLegacyTargetTransport = (targetUrl: string, targetDatabase: string) => {
  const targetSelection = (() => {
    try {
      return new URL(targetUrl);
    } catch {
      throw new Error("Target connection selection is invalid");
    }
  })();

  if (
    !/^[A-Za-z0-9_]+$/.test(targetDatabase) ||
    !["postgres:", "postgresql:"].includes(targetSelection.protocol) ||
    decodeURIComponent(targetSelection.pathname.slice(1)) !== targetDatabase
  )
    throw new Error("Target database selection differs from connection URL");

  const socketPath = targetSelection.searchParams.get("host");
  const caEnv = targetSelection.searchParams.get("sslCaEnv");

  if (
    [...targetSelection.searchParams.keys()].some(
      (key) => !["host", "port", "sslCaEnv"].includes(key),
    )
  )
    throw new Error("Target transport options are not permitted");

  if (socketPath !== null) {
    if (!socketPath.startsWith("/") || caEnv !== null || targetSelection.hostname !== "localhost")
      throw new Error("Local target socket selection is invalid");
  } else if (
    !caEnv ||
    !/^[A-Z][A-Z0-9_]*$/.test(caEnv) ||
    !process.env[caEnv] ||
    !targetSelection.hostname ||
    isIP(targetSelection.hostname) !== 0
  )
    throw new Error("Remote target requires a verified TLS CA and DNS identity");
  targetSelection.searchParams.delete("sslCaEnv");

  return { targetSelection, socketPath, caEnv };
};
