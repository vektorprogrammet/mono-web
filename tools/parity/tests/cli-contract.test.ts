 
import { describe, expect, test } from "bun:test";
import { parityVerifyArguments } from "../verify-config.ts";

describe("root parity verification command", () => {
  test("pins repository-relative external authorities and diff mode", () => {
    const root = "/workspace/mono-web";
    expect(parityVerifyArguments(root)).toEqual([
      "--root",
      root,
      "--legacy-root",
      "/workspace/vektorprogrammet",
      "--intent-register",
      "/workspace/functional-parity-intent-authority/accepted-intent.json",
      "--evidence-register",
      "/workspace/functional-parity-runtime-evidence/runtime-evidence.json",
      "--mode",
      "diff",
    ]);
 
  });
});
