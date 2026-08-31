// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

/**
 * Preview devtools gating predicate tests (design spec 0074).
 *
 * Contract: `previewDevtoolsEnabled` is true ONLY for
 * - local-dev, or
 * - the validated dev/preview stage-host pairs (dev-main/p20),
 * - everything else (production, unknown stages, mismatched pairs) is false.
 */
import {
  PREVIEW_DEVTOOLS_BUILD,
  previewDevtoolsEnabled,
  serverPreviewDevtoolsEnabled,
} from "./preview-devtools";

describe("previewDevtoolsEnabled", () => {
  it("returns true for local-dev regardless of stage", () => {
    expect(previewDevtoolsEnabled("local-dev")).toBe(true);
    expect(previewDevtoolsEnabled("local-dev", "production")).toBe(true);
  });

  it("returns true for the two validated preview stage-host pairs", () => {
    expect(previewDevtoolsEnabled("preview-stage", "dev-main", "vektor.phibkro.org")).toBe(true);
    expect(previewDevtoolsEnabled("preview-stage", "p20", "p20.vektor.phibkro.org")).toBe(true);
  });

  it("returns true for preview-stage host with different letter case", () => {
    expect(previewDevtoolsEnabled("preview-stage", "dev-main", "VEKTOR.PHIBKRO.ORG")).toBe(true);
  });

  it("returns false for production and unknown stage names", () => {
    expect(previewDevtoolsEnabled("preview-stage", "production", "vektor.phibkro.org")).toBe(false);
    expect(previewDevtoolsEnabled("preview-stage", "p999", "p999.vektor.phibkro.org")).toBe(false);
    expect(previewDevtoolsEnabled("preview-stage", "", "")).toBe(false);
  });

  it("returns false when stage/host pair is mismatched (falsifier F3)", () => {
    expect(previewDevtoolsEnabled("preview-stage", "dev-main", "p20.vektor.phibkro.org")).toBe(
      false,
    );
    expect(previewDevtoolsEnabled("preview-stage", "p20", "vektor.phibkro.org")).toBe(false);
    expect(previewDevtoolsEnabled("preview-stage", "dev-main", "evil.example.com")).toBe(false);
  });

  it("returns false when stage or host is missing", () => {
    expect(previewDevtoolsEnabled("preview-stage")).toBe(false);
    expect(previewDevtoolsEnabled("preview-stage", "dev-main")).toBe(false);
    expect(previewDevtoolsEnabled("preview-stage", undefined, "vektor.phibkro.org")).toBe(false);
  });

  it("returns true for server-stage with validated preview stages", () => {
    expect(serverPreviewDevtoolsEnabled("dev-main")).toBe(true);
    expect(serverPreviewDevtoolsEnabled("p20")).toBe(true);
  });

  it("returns false for server-stage with null or production stages", () => {
    expect(serverPreviewDevtoolsEnabled(null)).toBe(false);
    expect(serverPreviewDevtoolsEnabled("production" as never)).toBe(false);
    expect(serverPreviewDevtoolsEnabled("p999" as never)).toBe(false);
  });

  it("build-time constant mirrors import.meta.env.VITE_PREVIEW_DEVTOOLS (F1)", () => {
    // In a production build (no VITE_PREVIEW_DEVTOOLS) this must be false so
    // the bundler tree-shakes the whole devtools module.
    const expected = import.meta.env.VITE_PREVIEW_DEVTOOLS === "true";
    expect(PREVIEW_DEVTOOLS_BUILD).toBe(expected);
  });
});
