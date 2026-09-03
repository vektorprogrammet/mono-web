import { describe, expect, it } from "vitest";
import { APEX_VITE_RESOURCE_MEMOS } from "./apex.ts";

describe("apex Vite deployment inputs", () => {
  it("pins the same exact workspace roots for both Website.Vite resources without a digest", () => {
    const expectedMemo = {
      workspaces: [
        { cwd: "../../packages/domain" },
        { cwd: "../../packages/http-api" },
        { cwd: "../../packages/sdk" },
      ],
    };

    expect(APEX_VITE_RESOURCE_MEMOS.homepage).toBe(APEX_VITE_RESOURCE_MEMOS.dashboard);
    expect(APEX_VITE_RESOURCE_MEMOS.homepage).toEqual(expectedMemo);
    expect(APEX_VITE_RESOURCE_MEMOS.dashboard).toEqual(expectedMemo);
    expect(Object.isFrozen(APEX_VITE_RESOURCE_MEMOS)).toBe(true);
    expect(Object.isFrozen(APEX_VITE_RESOURCE_MEMOS.homepage)).toBe(true);
    expect(Object.isFrozen(APEX_VITE_RESOURCE_MEMOS.homepage.workspaces)).toBe(true);
    expect(JSON.stringify(APEX_VITE_RESOURCE_MEMOS)).not.toMatch(/\b[\da-f]{64}\b/iu);
  });
});
