export const LOCAL_ONLY_STAGE = "p000" as const;
export const DASHBOARD_ZONE = "vektor.phibkro.org" as const;

export type CloudDashboardStage = `p${number}`;
export type DashboardStage = typeof LOCAL_ONLY_STAGE | CloudDashboardStage;

export type DashboardRequest = {
  readonly stage: DashboardStage;
  readonly host: string;
};

function normalizeHost(rawHost: string): string {
  return rawHost.toLowerCase().replace(/:[0-9]+$/, "");
}

export function dashboardDomain(stage: string): string {
  if (stage === LOCAL_ONLY_STAGE) {
    throw new Error("p000 is reserved for local-only proof");
  }
  if (/^p[0-9]{3}$/.test(stage)) {
    return `${stage}-dashboard.${DASHBOARD_ZONE}`;
  }
  throw new Error(`Unsupported dashboard stage: ${stage}`);
}

export function stageFromHost(rawHost: string): DashboardStage {
  const host = normalizeHost(rawHost);
  const match = /^p([0-9]{3})-dashboard\.vektor\.phibkro\.org$/.exec(host);
  if (match?.[1] === "000") return LOCAL_ONLY_STAGE;
  if (match) return `p${match[1]}` as CloudDashboardStage;
  throw new Error(`Unsupported dashboard host: ${rawHost}`);
}

export function resolveDashboardRequest(rawHost: string): DashboardRequest {
  const host = normalizeHost(rawHost);
  const stage = stageFromHost(host);
  return { stage, host };
}
