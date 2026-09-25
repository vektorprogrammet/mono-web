export type DashboardPreviewStage = "worker-preview";

const WORKERS_DEV_HOST_SUFFIX = ".workers.dev";

export function validateDashboardPreviewStage(
  stage: string,
  configuredHost?: string,
  configuredHostSuffix?: string,
): DashboardPreviewStage {
  if (stage !== "worker-preview") {
    throw new Error("Unsupported dashboard preview stage");
  }

  if (configuredHost !== undefined || configuredHostSuffix !== WORKERS_DEV_HOST_SUFFIX) {
    throw new Error("Invalid Worker Preview host configuration");
  }

  return stage;
}

export function isDashboardPreviewHost(
  _stage: DashboardPreviewStage,
  requestHost: string,
  configuredHost?: string,
  configuredHostSuffix?: string,
): boolean {
  return (
    configuredHost === undefined &&
    configuredHostSuffix === WORKERS_DEV_HOST_SUFFIX &&
    requestHost.length > WORKERS_DEV_HOST_SUFFIX.length &&
    requestHost.endsWith(WORKERS_DEV_HOST_SUFFIX)
  );
}
