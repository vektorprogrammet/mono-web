import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

    const manifest = JSON.parse(readFileSync(resolve(import.meta.dir, "../../../package.json"), "utf8")) as {
      scripts: { "parity:verify": string };
    };
    expect(manifest.scripts["parity:verify"]).toBe(
      "bun run packages/parity-inventory/verify-cli.ts",
    );
  });
});
