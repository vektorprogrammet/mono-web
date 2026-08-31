// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";

/**
 * Role override unit tests (design spec 0074).
 *
 * Contract:
 * - Override read/write/clear round-trips through localStorage.
 * - Invalid stored values are rejected (schema validation) -> null.
 * - applyRoleOverrideToInput only patches the `role` field and preserves the
 *   rest of the dashboard input (F2: presentation only).
 */
import { DashboardInputJson } from "../foldkit/dashboard/model";
import { Schema as S } from "effect";
import {
  PREVIEW_ROLE_STORAGE_KEY,
  applyRoleOverrideToInput,
  clearRoleOverride,
  readRoleOverride,
  roleToRenderFlags,
  writeRoleOverride,
} from "./preview-role-override";

const decodeInput = (json: string | null) => {
  if (json === null) return null;
  return S.decodeUnknownSync(DashboardInputJson)(json, { onExcessProperty: "error" });
};

const serverInput = JSON.stringify({
  user: { name: "Real User", avatar: null },
  role: "ROLE_TEAM_MEMBER",
  activePath: "/dashboard",
  summary: { _tag: "Unavailable" },
  recruitment: null,
  scheduling: null,
});

afterEach(() => {
  window.localStorage.clear();
});

describe("role override storage", () => {
  it("round-trips a valid role", () => {
    writeRoleOverride("ROLE_TEAM_LEADER");
    expect(readRoleOverride()).toBe("ROLE_TEAM_LEADER");
  });

  it("returns null when nothing stored", () => {
    expect(readRoleOverride()).toBeNull();
  });

  it("returns null for an invalid stored role (no client-side trust)", () => {
    window.localStorage.setItem(PREVIEW_ROLE_STORAGE_KEY, JSON.stringify("ROLE_SUPER_ADMIN"));
    expect(readRoleOverride()).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    window.localStorage.setItem(PREVIEW_ROLE_STORAGE_KEY, "{not json");
    expect(readRoleOverride()).toBeNull();
  });

  it("clear removes the override", () => {
    writeRoleOverride("ROLE_ADMIN");
    clearRoleOverride();
    expect(readRoleOverride()).toBeNull();
  });
});

describe("applyRoleOverrideToInput", () => {
  it("patches only the role field and preserves everything else (F2)", () => {
    const patched = applyRoleOverrideToInput(serverInput, "ROLE_ADMIN");
    const decoded = decodeInput(patched);
    expect(decoded).not.toBeNull();
    expect(decoded!.role).toBe("ROLE_ADMIN");
    // Identity stays the REAL server-provided user — only presentation changes.
    expect(decoded!.user).toEqual({ name: "Real User", avatar: null });
    expect(decoded!.activePath).toBe("/dashboard");
    expect(decoded!.summary).toEqual({ _tag: "Unavailable" });
  });

  it("returns input unchanged when override is null", () => {
    expect(applyRoleOverrideToInput(serverInput, null)).toBe(serverInput);
  });

  it("returns null input unchanged", () => {
    expect(applyRoleOverrideToInput(null, "ROLE_ADMIN")).toBeNull();
  });

  it("patched input still passes the real DashboardInput schema validation", () => {
    const patched = applyRoleOverrideToInput(serverInput, "ROLE_TEAM_LEADER");
    expect(() => decodeInput(patched)).not.toThrow();
  });

  it("returns original input when the input JSON is malformed", () => {
    expect(applyRoleOverrideToInput("{broken", "ROLE_ADMIN")).toBe("{broken");
  });
});

describe("roleToRenderFlags", () => {
  it("maps leader and admin to isAdmin=true (rendering only)", () => {
    expect(roleToRenderFlags("ROLE_ADMIN").isAdmin).toBe(true);
    expect(roleToRenderFlags("ROLE_TEAM_LEADER").isAdmin).toBe(true);
  });

  it("maps member and null to isAdmin=false", () => {
    expect(roleToRenderFlags("ROLE_TEAM_MEMBER").isAdmin).toBe(false);
    expect(roleToRenderFlags(null).isAdmin).toBe(false);
  });
});
