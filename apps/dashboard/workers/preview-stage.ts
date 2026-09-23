export type DashboardPreviewStage = "p20" | "dev-main" | "worker-preview";

const WORKERS_DEV_HOST_SUFFIX = ".workers.dev";

const HOST_BY_STAGE: Readonly<Record<"p20" | "dev-main", string>> = {
  p20: "p20.vektor.phibkro.org",
  "dev-main": "vektor.phibkro.org",
};

export function validateDashboardPreviewStage(
  stage: string,
  configuredHost?: string,
  configuredHostSuffix?: string,
): DashboardPreviewStage {
  if (stage === "worker-preview") {
    if (configuredHost !== undefined || configuredHostSuffix !== WORKERS_DEV_HOST_SUFFIX) {
      throw new Error("Invalid Worker Preview host configuration");
    }
    return stage;
  }
  if (stage !== "p20" && stage !== "dev-main") {
    throw new Error("Unsupported dashboard preview stage");
  }
  if (
    configuredHostSuffix !== undefined ||
    configuredHost === undefined ||
    HOST_BY_STAGE[stage] !== configuredHost.toLowerCase()
  ) {
    throw new Error("Dashboard preview stage and host do not match");
  }
  return stage;
}

export function isDashboardPreviewHost(
  stage: DashboardPreviewStage,
  requestHost: string,
  configuredHost?: string,
  configuredHostSuffix?: string,
): boolean {
  if (stage === "worker-preview") {
    return (
      configuredHostSuffix === WORKERS_DEV_HOST_SUFFIX &&
      requestHost.length > WORKERS_DEV_HOST_SUFFIX.length &&
      requestHost.endsWith(WORKERS_DEV_HOST_SUFFIX)
    );
  }
  return configuredHost !== undefined && requestHost === configuredHost.toLowerCase();
}
