import { createContext, type RouterContextProvider } from "react-router";

export const LOCAL_ONLY_STAGE = "p000" as const;

export const DEV_MAIN_STAGE = "dev-main" as const;

export const WORKER_PREVIEW_STAGE = "worker-preview" as const;

export const WORKERS_DEV_HOST_SUFFIX = ".workers.dev" as const;

export const HOMEPAGE_ZONE = "vektor.phibkro.org" as const;

export type CloudHomepageStage =
  | `p${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}${number}`
  | `p${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}${number}${number}`;

export type HomepageStage =
  | typeof LOCAL_ONLY_STAGE
  | typeof DEV_MAIN_STAGE
  | typeof WORKER_PREVIEW_STAGE
  | CloudHomepageStage;

export type HomepageRequest = {
  readonly stage: HomepageStage;
  readonly host: string;
};

export const homepageRequestContext = createContext<HomepageRequest | null>(null);

export function loadHomepageRequest({ request, context }: {
  request: Request;
  context: Readonly<RouterContextProvider>;
}): HomepageRequest {
  const resolved = context.get(homepageRequestContext);
  if (resolved !== null) return resolved;
  const host = request.headers.get("host");
  if (!host) throw new Response("Missing Host", { status: 421 });
  return resolveHomepageRequest(host);
}

export type HomepagePreviewHost = {
  readonly stage?: string;
  readonly hostSuffix?: string;
};

function normalizeHost(rawHost: string): string {
  return rawHost.toLowerCase().replace(/:[0-9]+$/, "");
}

export function homepageDomain(stage: string): string {
  if (stage === LOCAL_ONLY_STAGE) {
    throw new Error("p000 is reserved for local-only proof");
  }

  if (stage === DEV_MAIN_STAGE) return HOMEPAGE_ZONE;

  if (isCloudHomepageStage(stage)) {
    return `${stage}.${HOMEPAGE_ZONE}`;
  }

  throw new Error(`Unsupported homepage stage: ${stage}`);
}

function isCloudHomepageStage(stage: string): stage is CloudHomepageStage {
  return /^p(?:[1-9][0-9]|[0-9]{3})$/.test(stage) && stage !== LOCAL_ONLY_STAGE;
}

export function stageFromHost(rawHost: string): HomepageStage {
  const host = normalizeHost(rawHost);

  if (host === HOMEPAGE_ZONE) return DEV_MAIN_STAGE;

  const suffix = `.${HOMEPAGE_ZONE}`;

  if (host.endsWith(suffix)) {
    const stage = host.slice(0, -suffix.length);

    if (stage === LOCAL_ONLY_STAGE || isCloudHomepageStage(stage)) return stage;
  }


  throw new Error(`Unsupported homepage host: ${rawHost}`);
}

export function resolveHomepageRequest(
  rawHost: string,
  preview: HomepagePreviewHost = {},
): HomepageRequest {
  const host = normalizeHost(rawHost);

  if (preview.stage !== undefined || preview.hostSuffix !== undefined) {
    if (
      preview.stage !== WORKER_PREVIEW_STAGE ||
      preview.hostSuffix !== WORKERS_DEV_HOST_SUFFIX ||
      host.length <= WORKERS_DEV_HOST_SUFFIX.length ||
      !host.endsWith(WORKERS_DEV_HOST_SUFFIX)
    ) {
      throw new Error("Invalid Worker Preview host configuration");
    }

    return { stage: WORKER_PREVIEW_STAGE, host };
  }

  if (
    import.meta.env?.HOMEPAGE_LOCAL_DEV === "true" &&
    (host === "localhost" || host === "127.0.0.1" || host === "[::1]")
  ) {
    return { stage: LOCAL_ONLY_STAGE, host };
  }

  const stage = stageFromHost(host);

  return { stage, host };
}
