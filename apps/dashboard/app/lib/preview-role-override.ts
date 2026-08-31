import { Schema as S } from "effect";
import { Option } from "effect";

/**
 * Client-side role override for preview/devtools ONLY.
 *
 * SECURITY CONTRACT (design spec 0074):
 * - This module is imported ONLY by the preview devtools panel and the
 *   client-side render paths it patches (routes/dashboard.tsx,
 *   foldkit/dashboard/main.ts).
 * - NO `.server` module, loader, or action may import anything from this
 *   file. Server authorization is always derived from the real session
 *   (see shell.server.ts); this override changes presentation only.
 * - Falsifier F4 in design-specs/0074 asserts no `.server` file references
 *   PREVIEW_ROLE_STORAGE_KEY.
 */

export const PREVIEW_ROLE_STORAGE_KEY = "vektor-preview-role-override";

export const PREVIEW_ROLES = ["ROLE_TEAM_MEMBER", "ROLE_TEAM_LEADER", "ROLE_ADMIN"] as const;

const RoleOverrideSchema = S.NullOr(S.Literals(PREVIEW_ROLES));

export type PreviewRole = (typeof PREVIEW_ROLES)[number];

/** Read the stored override; returns null when absent or invalid. */
export const readRoleOverride = (): PreviewRole | null => {
  try {
    const raw = window.localStorage.getItem(PREVIEW_ROLE_STORAGE_KEY);
    if (raw === null) return null;
    const decoded = S.decodeUnknownOption(RoleOverrideSchema)(JSON.parse(raw));
    return Option.getOrNull(decoded) as PreviewRole | null;
  } catch {
    return null;
  }
};

/** Persist an override (call from the panel only). */
export const writeRoleOverride = (role: PreviewRole): void => {
  window.localStorage.setItem(PREVIEW_ROLE_STORAGE_KEY, JSON.stringify(role));
};

/** Clear the override (panel "reset" button). */
export const clearRoleOverride = (): void => {
  window.localStorage.removeItem(PREVIEW_ROLE_STORAGE_KEY);
};

/**
 * Apply the override to a Foldkit dashboard input before embed.
 * Returns the input unchanged when no override is active or parsing fails —
 * the embedded program then runs on the server-provided identity.
 */
export const applyRoleOverrideToInput = (
  inputJson: string | null,
  override: PreviewRole | null,
): string | null => {
  if (override === null || inputJson === null) return inputJson;
  try {
    const input = JSON.parse(inputJson) as Record<string, unknown>;
    input["role"] = override;
    return JSON.stringify(input);
  } catch {
    return inputJson;
  }
};

/**
 * Rendering-only flags for the React shell: maps an overridden role to the
 * same flag shape the loader computes, so the override changes which nav
 * groups are DRAWN without touching any server-authorized value.
 */
export const roleToRenderFlags = (role: PreviewRole | null): { isAdmin: boolean } => ({
  isAdmin: role === "ROLE_ADMIN" || role === "ROLE_TEAM_LEADER",
});
