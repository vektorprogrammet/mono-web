import type { DashboardPreviewStage } from "../../workers/preview-stage";

/**
 * Stages for which the preview devtools capability is compiled in.
 *
 * This is the same stage/host contract that
 * `validateDashboardPreviewStage` enforces server-side in the deployed
 * preview Workers: `dev-main` (apex preview) and `p20` (container preview).
 * Production has no stage in this set, so the capability is structurally
 * absent there — it is a build-time constant, not a runtime flag.
 */
const DEVTOOLS_STAGES: Record<string, string> = {
  "dev-main": "vektor.phibkro.org",
  p20: "p20.vektor.phibkro.org",
};

export type PreviewDevtoolsSource = "local-dev" | "preview-stage" | "server-stage";

/**
 * The single gating predicate for the preview devtools capability.
 *
 * `true` only when the capability source is one of:
 * - `local-dev`: the Vite dev server (`import.meta.env.DEV`), or
 * - `preview-stage`: the build/deploy ran against a validated dev/preview
 *   stage-host pair (the same pairs `validateDashboardPreviewStage` accepts), or
 * - `server-stage`: the server-side validated stage is a dev/preview stage.
 *
 * Everything else — production, unknown stages, mismatched pairs — is `false`
 * with no fallback. Callers must not widen this.
 */
export const previewDevtoolsEnabled = (
  source: PreviewDevtoolsSource,
  stage?: string,
  host?: string,
): boolean => {
  if (source === "local-dev") return true;
  if (source === "server-stage") return stage !== undefined && stage in DEVTOOLS_STAGES;
  if (source === "preview-stage") {
    if (stage === undefined || host === undefined) return false;
    return DEVTOOLS_STAGES[stage] === host?.toLowerCase();
  }
  return false;
};

/**
 * Build-time capability constant. In dev/preview builds the Vite config
 * defines this as `true`; in production builds it stays `false` so the
 * bundler tree-shakes the entire devtools module out of the client bundle.
 *
 * This mirrors the shape of `import.meta.env.DEV`/`PROD` — a static constant
 * the bundler can fold — so the production bundle structurally excludes the
 * devtools entry rather than hiding it behind a runtime check.
 */
export const PREVIEW_DEVTOOLS_BUILD = import.meta.env.VITE_PREVIEW_DEVTOOLS === "true";

/**
 * Server-side capability. The dashboard Worker derives this from the
 * validated preview stage; production servers never validate a stage, so this
 * stays `false` there. Kept in a separate export so client code never imports
 * server-only types.
 */
export const serverPreviewDevtoolsEnabled = (stage: DashboardPreviewStage | null): boolean =>
  stage !== null && previewDevtoolsEnabled("server-stage", stage);
