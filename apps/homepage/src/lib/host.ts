export const LOCAL_ONLY_STAGE = "p000" as const;
export const DEV_MAIN_STAGE = "dev-main" as const;
export const HOMEPAGE_ZONE = "vektor.phibkro.org" as const;

export type CloudHomepageStage = `p${number}`;
export type HomepageStage =
  | typeof LOCAL_ONLY_STAGE
  | typeof DEV_MAIN_STAGE
  | CloudHomepageStage;

export type HomepageRequest = {
  readonly stage: HomepageStage;
  readonly host: string;
};

function normalizeHost(rawHost: string): string {
  return rawHost.toLowerCase().replace(/:[0-9]+$/, "");
}

export function homepageDomain(stage: string): string {
  if (stage === LOCAL_ONLY_STAGE) {
    throw new Error("p000 is reserved for local-only proof");
  }
  if (stage === DEV_MAIN_STAGE) return HOMEPAGE_ZONE;
  if (/^p[0-9]{3}$/.test(stage) && stage !== LOCAL_ONLY_STAGE) {
    return `${stage}.${HOMEPAGE_ZONE}`;
  }
  throw new Error(`Unsupported homepage stage: ${stage}`);
}

export function stageFromHost(rawHost: string): HomepageStage {
  const host = normalizeHost(rawHost);
  if (host === HOMEPAGE_ZONE) return DEV_MAIN_STAGE;

  const match = /^p([0-9]{3})\.vektor\.phibkro\.org$/.exec(host);
  if (match?.[1] === "000") return LOCAL_ONLY_STAGE;
  if (match) return `p${match[1]}` as CloudHomepageStage;

  throw new Error(`Unsupported homepage host: ${rawHost}`);
}

export function resolveHomepageRequest(rawHost: string): HomepageRequest {
  const host = normalizeHost(rawHost);
  const stage = stageFromHost(host);
  return { stage, host };
}
