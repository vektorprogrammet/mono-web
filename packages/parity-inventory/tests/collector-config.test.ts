import { Effect } from "effect";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  buildCollectorSandboxArguments,
  collectorExecutableProvenance,
  collectApiOperations,
  resolveCollectorExecutables,
  validateCollectorExecutablePath,
} from "../src/api.js";
import { scanRootEffect } from "../src/runtime.js";
import { createManifestContextFromSnapshots } from "../src/source-manifest.js";

test("missing collector configuration is a runtime_unavailable observation", async () => {
  const directory = mkdtempSync("/tmp/parity-collector-missing-");
  const legacyRoot = join(directory, "legacy");
  const monoRoot = join(directory, "mono");
  mkdirSync(legacyRoot);
  mkdirSync(monoRoot);
  try {
    const legacy = await Effect.runPromise(scanRootEffect(legacyRoot, "legacy"));
    const mono = await Effect.runPromise(scanRootEffect(monoRoot, "mono"));
    const context = createManifestContextFromSnapshots(legacy, mono);
    const result = collectApiOperations(
      context,
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(result.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "runtime_unavailable" })]),
    );
    expect(context.runtimeObservations[0]).toMatchObject({
      logical_command_id: "api-platform-metadata",
      executable_digests: { php: null, bwrap: null },
      executable_provenance: { php: null, bwrap: null },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("collector executable validation rejects arbitrary, symlinked, and writable paths", () => {
  const directory = mkdtempSync("/tmp/parity-collector-validation-");
  const regular = join(directory, "php");
  const link = join(directory, "php-link");
  writeFileSync(regular, "#!/bin/sh\n");
  chmodSync(regular, 0o755);
  symlinkSync(regular, link);
  try {
    expect(
      resolveCollectorExecutables({ phpExecutable: regular, bwrapExecutable: regular }),
    ).toBeNull();
    expect(validateCollectorExecutablePath("php", link)).toBeNull();
    chmodSync(regular, 0o775);
    expect(validateCollectorExecutablePath("php", regular)).toBeNull();
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Nix executable shapes are recognized without PATH lookup", () => {
  const php = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-php-8.3.21/bin/php";
  const bwrap = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-bubblewrap-0.11.2/bin/bwrap";
  expect(collectorExecutableProvenance("php", php)).toBe("nix-store");
  expect(collectorExecutableProvenance("bwrap", bwrap)).toBe("nix-store");
  expect(collectorExecutableProvenance("php", "php")).toBeNull();
});

test("sandbox invocation binds selected binaries and isolates arguments", () => {
  const php = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-php-8.3.21/bin/php";
  const bwrap = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-bubblewrap-0.11.2/bin/bwrap";
  const invocation = buildCollectorSandboxArguments(
    { phpExecutable: php, bwrapExecutable: bwrap },
    ["-r", "echo 'ok';", "--", "$(touch /tmp/injected)"],
    "/tmp/staged-source",
  );
  expect(invocation.executable).toBe(bwrap);
  expect(invocation.arguments).toEqual(
    expect.arrayContaining([
      "--clearenv",
      "--unshare-net",
      "--unshare-pid",
      "--unshare-uts",
      "--unshare-ipc",
      "--ro-bind",
      php,
      "/usr/bin/php",
      "--ro-bind",
      "/nix/store",
      "/nix/store",
    ]),
  );
  const separator = invocation.arguments.indexOf("--");
  expect(separator).toBeGreaterThan(-1);
  expect(invocation.arguments[separator + 1]).toBe("/usr/bin/php");
  expect(invocation.arguments.at(-1)).toBe("$(touch /tmp/injected)");
});

test("production collection does not consume runtime fixtures", async () => {
  const directory = mkdtempSync("/tmp/parity-collector-production-");
  const legacyRoot = join(directory, "legacy");
  const monoRoot = join(directory, "mono");
  mkdirSync(join(monoRoot, "apps/server/var/parity"), { recursive: true });
  mkdirSync(legacyRoot);
  writeFileSync(join(monoRoot, "apps/server/var/parity/api-operations.json"), "[]");
  try {
    const legacy = await Effect.runPromise(scanRootEffect(legacyRoot, "legacy"));
    const mono = await Effect.runPromise(scanRootEffect(monoRoot, "mono"));
    const context = createManifestContextFromSnapshots(legacy, mono);
    const result = collectApiOperations(
      context,
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      [],
      false,
    );
    expect(result.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "runtime_unavailable" })]),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
