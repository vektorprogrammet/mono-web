import { APEX_IDENTITY, PREVIEW_IDENTITY } from "./identity.ts";

export const APEX_LOCAL_STATE_CONTRACT = "vektor-dev-main-local-v1" as const;
export const APEX_LOCAL_STATE_LOGICAL_IDS = [
  "vektor-apex-dashboard",
  "vektor-apex-homepage",
  "vektor-apex-worker",
] as const;

export type DeploymentStateBackend = "local" | "cloudflare";

export function stateBackendForStage(stage: string): DeploymentStateBackend {
  if (stage === APEX_IDENTITY.stage) return "local";
  if (stage === PREVIEW_IDENTITY.stage) return "cloudflare";
  throw new Error(
    `Only ${PREVIEW_IDENTITY.stage} or ${APEX_IDENTITY.stage} is allowed by this delivery stack`,
  );
}
