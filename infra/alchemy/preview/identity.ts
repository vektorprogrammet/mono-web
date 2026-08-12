export const PREVIEW_IDENTITY = {
  repository: "p20/vektor-p20",
  app: "vektor",
  stage: "p20",
  target: "p20",
  pullRequest: 21,
  hostname: "p20.vektor.phibkro.org",
  resourcePrefix: "vektor-p20",
  containerInstance: "vektor-p20-container",
  remoteStateKey: "vektor/p20",
  concurrencyKey: "preview-vektor-p20",
  databaseNamespace: "vektor-p20",
  forbiddenHost: "vektorprogrammet.no",
} as const;

export const PREVIEW_TAGS = {
  app: PREVIEW_IDENTITY.app,
  stage: PREVIEW_IDENTITY.stage,
  pr: String(PREVIEW_IDENTITY.pullRequest),
  target: PREVIEW_IDENTITY.target,
} as const;

export const PREVIEW_RESOURCE_ALLOW_LIST = [
  "worker",
  "container-backed-durable-object",
  "container",
  "homepage",
  "dashboard",
  "route",
  "dns-tls",
  "synthetic-seed-artifact",
] as const;

export type PreviewResourceKind = (typeof PREVIEW_RESOURCE_ALLOW_LIST)[number];

export function assertPreviewIdentity(value: {
  readonly app: string;
  readonly stage: string;
  readonly target: string;
  readonly hostname: string;
  readonly containerInstance: string;
}): void {
  if (
    value.app !== PREVIEW_IDENTITY.app ||
    value.stage !== PREVIEW_IDENTITY.stage ||
    value.target !== PREVIEW_IDENTITY.target ||
    value.hostname !== PREVIEW_IDENTITY.hostname ||
    value.containerInstance !== PREVIEW_IDENTITY.containerInstance
  ) {
    throw new Error("Preview identity does not match the frozen p20 contract");
  }
  if (value.hostname.includes(PREVIEW_IDENTITY.forbiddenHost)) {
    throw new Error("Preview identity contains the forbidden production host");
  }
}

export function resourceName(kind: PreviewResourceKind): string {
  const suffix = kind === "container" ? "container" : kind;
  return `${PREVIEW_IDENTITY.resourcePrefix}-${suffix}`;
}
