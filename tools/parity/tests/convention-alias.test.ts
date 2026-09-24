import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { NodeRuntimeLayer } from "../node-runtime.js";
import { scanRootEffect } from "../src/runtime.js";
import { sha256 } from "../src/canonical.js";

const fixture = async (setup: (root: string) => void, check: (root: string) => Promise<void>) => {
  const root = mkdtempSync("/tmp/parity-convention-alias-");

  try {
    execFileSync("git", ["init", "--quiet", root]);
    setup(root);
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", [
      "-C",
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    await check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const scan = (root: string) =>
  Effect.runPromise(scanRootEffect(root, "mono").pipe(Effect.provide(NodeRuntimeLayer)));

test("tracked convention pointer and canonical authority retain separate source digests", async () => {
  await fixture(
    (root) => {
      writeFileSync(join(root, "AGENTS.md"), "Canonical instructions\n");
      symlinkSync("AGENTS.md", join(root, "CLAUDE.md"));
    },
    async (root) => {
      const result = await scan(root);
      expect(result.files.find((file) => file.path === "CLAUDE.md")?.digest).toBe(
        sha256("AGENTS.md"),
      );
      expect(result.files.find((file) => file.path === "AGENTS.md")?.digest).toBe(
        sha256("Canonical instructions\n"),
      );
    },
  );
});

for (const target of ["other.md", "/etc/hosts", "missing.md", "CLAUDE.md", "./AGENTS.md"]) {
  test(`rejects noncanonical convention target ${target}`, async () => {
    await fixture(
      (root) => {
        writeFileSync(join(root, "AGENTS.md"), "Canonical instructions\n");
        writeFileSync(join(root, "other.md"), "Other\n");
        symlinkSync(target, join(root, "CLAUDE.md"));
      },
      async (root) => {
        await expect(scan(root)).rejects.toThrow("invalid convention alias");
      },
    );
  });
}

test("rejects canonical pointer with dangling target", async () => {
  await fixture(
    (root) => symlinkSync("AGENTS.md", join(root, "CLAUDE.md")),
    async (root) => {
      await expect(scan(root)).rejects.toThrow("tracked AGENTS.md");
    },
  );
});

test("rejects cyclic canonical target and arbitrary aliases", async () => {
  for (const cyclic of [true, false]) {
    await fixture(
      (root) => {
        if (cyclic) {
          symlinkSync("CLAUDE.md", join(root, "AGENTS.md"));
          symlinkSync("AGENTS.md", join(root, "CLAUDE.md"));
        } else {
          writeFileSync(join(root, "AGENTS.md"), "Canonical instructions\n");
          symlinkSync("AGENTS.md", join(root, "OTHER.md"));
        }
      },
      async (root) => {
        await expect(scan(root)).rejects.toThrow("symbolic link");
      },
    );
  }
});
