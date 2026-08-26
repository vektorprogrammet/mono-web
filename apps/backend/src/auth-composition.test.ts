import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const mainSource = await readFile(new URL("./main.ts", import.meta.url), "utf8");

describe("backend auth composition", () => {
  it("uses AuthLive as the sole auth authority and lifecycle owner", () => {
    expect(mainSource).toContain("const authLayers = AuthLive(config.auth);");
    expect(mainSource.match(/\bAuthLive\(config\.auth\)/g)).toHaveLength(1);
    expect(mainSource).not.toContain("AuthEngineLive");
    expect(mainSource).not.toMatch(/Layer\.merge\(AuthLive\(config\.auth\)/);
  });
});
