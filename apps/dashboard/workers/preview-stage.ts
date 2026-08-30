export type DashboardPreviewStage = "p20" | "dev-main";

const HOST_BY_STAGE: Readonly<Record<DashboardPreviewStage, string>> = {
  p20: "p20.vektor.phibkro.org",
  "dev-main": "vektor.phibkro.org",
};

export function validateDashboardPreviewStage(
  stage: string,
  configuredHost: string,
): DashboardPreviewStage {
  if (stage !== "p20" && stage !== "dev-main") {
    throw new Error("Unsupported dashboard preview stage");
  }
  if (HOST_BY_STAGE[stage] !== configuredHost.toLowerCase()) {
    throw new Error("Dashboard preview stage and host do not match");
  }
  return stage;
}
