import { createContext, type RouterContextProvider } from "react-router";

export const LOCAL_ONLY_STAGE = "p000" as const;

/** Synthetic local-proof host. Runners map it to 127.0.0.1; no deployment serves it. */
const LOCAL_ONLY_HOST = "p000.vektor.phibkro.org";

export const WORKER_PREVIEW_STAGE = "worker-preview" as const;

export const WORKERS_DEV_HOST_SUFFIX = ".workers.dev" as const;

export type HomepageStage = typeof LOCAL_ONLY_STAGE | typeof WORKER_PREVIEW_STAGE;

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
    host === LOCAL_ONLY_HOST ||
    (import.meta.env?.HOMEPAGE_LOCAL_DEV === "true" &&
      (host === "localhost" || host === "127.0.0.1" || host === "[::1]"))
  ) {
    return { stage: LOCAL_ONLY_STAGE, host };
  }

  throw new Error(`Unsupported homepage host: ${rawHost}`);
}
