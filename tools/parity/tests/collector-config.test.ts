import { Effect } from "effect";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { NodeRuntimeLayer } from "../node-runtime.js";
import {
  API_METADATA_SCRIPT,
  API_OPENAPI_SCRIPT,
  buildCollectorSandboxArguments,
  collectorExecutableProvenance,
  discoverCollectorExecutables,
  collectApiOperations,
  resolveCollectorExecutables,
  routePayloadContainsUnsafe,
  validateCollectorExecutablePath,
  runTrustedPhpCollectorWithServices,
} from "../src/api.js";
import { sha256 } from "../src/canonical.js";
import {
  createManifestContextFromSnapshots,
  unsafeSourceTextReason,
} from "../src/source-manifest.js";
import { scanRootEffect } from "../src/runtime.js";
import {
  ParityFileSystem,
  type ParityCommandExecutorShape,
  type ParityFileSystemShape,
} from "../src/services.js";

// Raw node-backed filesystem shape for service-level tests; resolved lazily so the
// module registers its tests without top-level await.
const realFileSystemPromise: Promise<ParityFileSystemShape> = Effect.runPromise(
  Effect.gen(function* () {
    return yield* ParityFileSystem;
  }).pipe(Effect.provide(NodeRuntimeLayer)),
);
// Command executor stub whose sandbox invocations always fail closed: enough for
// reaching the execution seam while never spawning real processes.
const noopCommands: ParityCommandExecutorShape = {
  executeBytes: () => {
    throw new Error("collector sandbox execution is unavailable in tests");
  },
  executeText: () => {
    throw new Error("collector command execution is unavailable in tests");
  },
  spawnText: () => ({ signal: null, status: 1, stderr: "", stdout: "" }),
};
test("route payload safety validates values without treating structural keys as secrets", () => {
  const safe = {
    reset_password: {
      path: "/resetpassord/{resetCode}",
      defaults: { _controller: "App\\Identity\\Controller\\PasswordResetController::showAction" },
      methods: ["GET"],
    },
  };
  expect(unsafeSourceTextReason(JSON.stringify(safe))).toBe("UNSAFE_SOURCE");
  expect(routePayloadContainsUnsafe(safe)).toBe(false);
  expect(routePayloadContainsUnsafe({ ...safe, secret_route: { token: "concrete-secret" } })).toBe(
    true,
  );
});

test("missing collector configuration is a runtime_unavailable observation", async () => {
  const directory = mkdtempSync("/tmp/parity-collector-missing-");
  const legacyRoot = join(directory, "legacy");
  const monoRoot = join(directory, "mono");
  mkdirSync(legacyRoot);
  mkdirSync(monoRoot);
  try {
    const legacy = await Effect.runPromise(
      scanRootEffect(legacyRoot, "legacy").pipe(Effect.provide(NodeRuntimeLayer)),
    );
    const mono = await Effect.runPromise(
      scanRootEffect(monoRoot, "mono").pipe(Effect.provide(NodeRuntimeLayer)),
    );
    const context = createManifestContextFromSnapshots(legacy, mono);
    const result = await Effect.runPromise(
      collectApiOperations(
        context,
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ).pipe(Effect.provide(NodeRuntimeLayer)),
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
const APPROVED_TEST_ENV = `# define your env variables for the test env here
APP_ENV=test
APP_DEBUG=1
CORS_ALLOW_ORIGIN='*'
DATABASE_URL=sqlite:///:memory:
APP_SECRET=test_app_secret_for_testing_only
JWT_PASSPHRASE=
TEST_JWT_PRIVATE_PATH=/dev/null
TEST_JWT_PUBLIC_PATH=/dev/null
TEST_JWT_PASSPHRASE=

LOG_CHANNEL='#test-log'
SLACK_DISABLED=1
SLACK_ENDPOINT='https://example.invalid/slack'
GATEWAY_API_TOKEN=
SMS_DISABLE=1
DEFAULT_SURVEY_EMAIL=
IPINFO_TOKEN=
GEO_IGNORED_ASNS='[]'
DEFAULT_FROM_EMAIL=
ECONOMY_EMAIL=
GOOGLE_API_CLIENT_ID=test
GOOGLE_API_CLIENT_SECRET=
GOOGLE_API_REFRESH_TOKEN=`;
test("metadata collector loads only the staged test dotenv before fixed kernel boot", () => {
  const autoload = API_METADATA_SCRIPT.indexOf("require $root . '/vendor/autoload.php';");
  const dotenv = API_METADATA_SCRIPT.indexOf(
    "(new \\Symfony\\Component\\Dotenv\\Dotenv())->usePutenv()->load($root . '/.env.test');",
  );
  const kernel = API_METADATA_SCRIPT.indexOf("$kernel = new \\Kernel('test', false);");
  const testContainer = API_METADATA_SCRIPT.indexOf(
    "$container = $kernel->getContainer()->get('test.service_container');",
  );
  const factory = API_METADATA_SCRIPT.indexOf(
    "$factory = $container->get('api_platform.metadata.resource.metadata_collection_factory');",
  );
  expect(testContainer).toBeGreaterThan(kernel);
  expect(factory).toBeGreaterThan(testContainer);
  expect(autoload).toBeGreaterThanOrEqual(0);
  expect(dotenv).toBeGreaterThan(autoload);
  expect(kernel).toBeGreaterThan(dotenv);
  expect(API_METADATA_SCRIPT).not.toContain("bootEnv");
  expect(API_METADATA_SCRIPT).not.toContain("loadEnv");
  expect(API_METADATA_SCRIPT).not.toContain("$root . '/.env';");
  expect(API_METADATA_SCRIPT).not.toContain("$root . '/.env.local';");
  expect(API_METADATA_SCRIPT).not.toMatch(/\$root \. '\/\.env\.(?:dev|prod|local)'/);
});

test("OpenAPI collector uses the API Platform command serializer seam", () => {
  expect(API_OPENAPI_SCRIPT).toContain("$serializer = $container->get('api_platform.serializer');");
  expect(API_OPENAPI_SCRIPT).not.toContain("$container->get('serializer')");
});

test("tracked collector environment contains only the approved test bytes", async () => {
  const directory = mkdtempSync("/tmp/parity-collector-env-scan-");
  const expectedBytes = execFileSync("git", ["show", "HEAD:apps/server/.env.test"], {
    cwd: resolve(import.meta.dir, "../../.."),
    maxBuffer: 4096,
  });
  mkdirSync(join(directory, "apps/server"), { recursive: true });
  writeFileSync(join(directory, "apps/server/.env.test"), expectedBytes);
  try {
    const mono = await Effect.runPromise(
      scanRootEffect(directory, "mono").pipe(Effect.provide(NodeRuntimeLayer)),
    );
    const envFiles = mono.files.filter((file) => /(?:^|\/)\.env(?:$|[.-])/iu.test(file.path));
    expect(envFiles.map((file) => file.path)).toEqual(["apps/server/.env.test"]);
    const envFile = envFiles[0];
    expect(envFile).toMatchObject({ availability: "available", unsafe: false });
    expect(Buffer.from(envFile?.bytes ?? new Uint8Array())).toEqual(expectedBytes);
    expect(new TextDecoder().decode(envFile?.bytes ?? new Uint8Array())).toBe(APPROVED_TEST_ENV);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed fixture collector bytes become fixed reason-only observations", async () => {
  const directory = mkdtempSync("/tmp/parity-collector-failure-bytes-");
  const legacyRoot = join(directory, "legacy");
  const monoRoot = join(directory, "mono");
  mkdirSync(legacyRoot);
  mkdirSync(monoRoot);
  try {
    const legacy = await Effect.runPromise(
      scanRootEffect(legacyRoot, "legacy").pipe(Effect.provide(NodeRuntimeLayer)),
    );
    const mono = await Effect.runPromise(
      scanRootEffect(monoRoot, "mono").pipe(Effect.provide(NodeRuntimeLayer)),
    );
    const context = createManifestContextFromSnapshots(legacy, mono);
    const cases = [
      { path: "non-utf8", bytes: new Uint8Array([0xff, 0xfe, 0xfd]), reason: "NON_UTF8_OUTPUT" },
      {
        path: "malformed",
        bytes: new TextEncoder().encode('{"outer":{"password":"correct-horse-battery-staple"}'),
        reason: "SOURCE_PARSE_ERROR",
      },
      {
        path: "nested",
        bytes: new TextEncoder().encode('{"outer":{"password":"correct-horse-battery-staple"}}'),
        reason: "UNSAFE_SOURCE",
      },
      {
        path: "nested-result",
        bytes: new TextEncoder().encode(
          '{"operations":[{"resource_class_ref":"App\\\\Fixture\\\\Api\\\\Resource","operation_name":"Get","method":"GET","uri_template":"/fixture","metadata":{"newPassword":{"example":"correct-horse-battery-staple"}}}]}',
        ),
        reason: "UNSAFE_SOURCE",
      },
    ] as const;
    for (const fixture of cases) {
      const result = await Effect.runPromise(
        collectApiOperations(
          context,
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          [],
          true,
          undefined,
          { path: fixture.path, bytes: fixture.bytes },
        ).pipe(Effect.provide(NodeRuntimeLayer)),
      );
      const observation = context.runtimeObservations.at(-1);
      const fixtureSource = context.sources.find(
        (source) => source.path === `fixture://runtime/${fixture.path}`,
      );
      expect(fixtureSource).toMatchObject({
        byte_length: null,
        sha256: null,
        capture_mode: "runtime",
        availability: "unavailable",
      });
      expect(fixtureSource?.out_of_band).toBeUndefined();
      expect(result.failures[0]?.reasonCode).toBe(fixture.reason);
      expect(result.failures[0]?.sourceRefIds).toContain(fixtureSource?.source_id);
      expect(observation?.stdout_sha256).toBe(sha256(fixture.reason));
      expect(observation?.stderr_sha256).toBe(sha256(fixture.reason));
      expect(JSON.stringify({ result, observation })).not.toContain("correct-horse-battery-staple");
      expect(JSON.stringify({ result, observation })).not.toContain("255,254,253");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("collector executable validation rejects arbitrary, symlinked, and writable paths", async () => {
  const directory = mkdtempSync("/tmp/parity-collector-validation-");
  const regular = join(directory, "php");
  const link = join(directory, "php-link");
  writeFileSync(regular, "#!/bin/sh\n");
  chmodSync(regular, 0o755);
  symlinkSync(regular, link);
  try {
    expect(
      await Effect.runPromise(
        resolveCollectorExecutables({
          phpExecutable: regular,
          bwrapExecutable: regular,
        }).pipe(Effect.provide(NodeRuntimeLayer)),
      ),
    ).toBeNull();
    expect(
      await Effect.runPromise(
        validateCollectorExecutablePath("php", link).pipe(Effect.provide(NodeRuntimeLayer)),
      ),
    ).toBeNull();
    chmodSync(regular, 0o775);
    expect(
      await Effect.runPromise(
        validateCollectorExecutablePath("php", regular).pipe(Effect.provide(NodeRuntimeLayer)),
      ),
    ).toBeNull();
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Nix executable shapes are recognized without PATH lookup", () => {
  const php = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-php-8.3.21/bin/php";
  const phpWithExtensions =
    "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-php-with-extensions-8.4.23/bin/php";
  const bwrap = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-bubblewrap-0.11.2/bin/bwrap";
  expect(collectorExecutableProvenance("php", php)).toBe("nix-store");
  expect(collectorExecutableProvenance("php", phpWithExtensions)).toBe("nix-store");
  expect(collectorExecutableProvenance("bwrap", bwrap)).toBe("nix-store");
  expect(collectorExecutableProvenance("php", "php")).toBeNull();
});

test("sandbox invocation binds selected binaries, isolates arguments, and narrows runtime writes", async () => {
  const php = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-php-8.3.21/bin/php";
  const bwrap = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-bubblewrap-0.11.2/bin/bwrap";
  const invocation = await Effect.runPromise(
    buildCollectorSandboxArguments(
      { phpExecutable: php, bwrapExecutable: bwrap },
      ["-r", "echo 'ok';", "--", "$(touch /tmp/injected)"],
      "/tmp/staged-source",
    ).pipe(Effect.provide(NodeRuntimeLayer)),
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
  const workspaceBindIndex = invocation.arguments.findIndex(
    (value, index) => value === "--ro-bind" && invocation.arguments[index + 2] === "/workspace",
  );
  const varOverlayIndex = invocation.arguments.findIndex(
    (value, index) =>
      value === "--tmpfs" && invocation.arguments[index + 1] === "/workspace/apps/server/var",
  );
  expect(workspaceBindIndex).toBeGreaterThan(-1);
  expect(varOverlayIndex).toBe(workspaceBindIndex + 3);
  const tmpfsDestinations = invocation.arguments.flatMap((value, index) =>
    value === "--tmpfs" ? [invocation.arguments[index + 1]] : [],
  );
  expect(tmpfsDestinations).toEqual(
    expect.arrayContaining(["/", "/tmp", "/workspace/apps/server/var"]),
  );
  expect(tmpfsDestinations).not.toContain("/workspace");
  expect(tmpfsDestinations).not.toContain("/workspace/apps/server");
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
    const legacy = await Effect.runPromise(
      scanRootEffect(legacyRoot, "legacy").pipe(Effect.provide(NodeRuntimeLayer)),
    );
    const mono = await Effect.runPromise(
      scanRootEffect(monoRoot, "mono").pipe(Effect.provide(NodeRuntimeLayer)),
    );
    const context = createManifestContextFromSnapshots(legacy, mono);
    const result = await Effect.runPromise(
      collectApiOperations(
        context,
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        [],
        false,
      ).pipe(Effect.provide(NodeRuntimeLayer)),
    );
    expect(result.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "runtime_unavailable" })]),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("PATH discovery accepts provenanced executables and rejects every other shape", async () => {
  const realFileSystem = await realFileSystemPromise;
  // discoverPathExecutableWithServices only trusts PATH entries under /usr/bin and
  // /nix/store/<hash>-*/, so the positive case cannot use a /tmp fixture directory.
  // Instead a fake filesystem maps a handful of /nix/store-shaped virtual paths
  // onto real fixture files, exercising every lstat/realpath/mode/provenance check;
  // the remaining cases pin each negative branch against the real filesystem:
  // trusted-looking directory with wrong basename, untrusted PATH root, missing
  // PATH, symlinked candidate, group/other-writable mode.
  const directory = mkdtempSync("/tmp/parity-collector-discovery-");
  const phpStore = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-php-8.3.21/bin";
  const bwrapStore = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-bubblewrap-0.11.2/bin";
  const phpReal = join(directory, "php");
  const bwrapReal = join(directory, "bwrap");
  mkdirSync(directory, { recursive: true });
  writeFileSync(phpReal, "#!/bin/sh\n");
  writeFileSync(bwrapReal, "#!/bin/sh\n");
  chmodSync(phpReal, 0o755);
  chmodSync(bwrapReal, 0o500);
  const virtualMap: Record<string, string> = {
    [`${phpStore}/php`]: phpReal,
    [`${bwrapStore}/bwrap`]: bwrapReal,
  };
  const fakeFileSystem: ParityFileSystemShape = {
    ...realFileSystem,
    exists: (path) => realFileSystem.exists(virtualMap[path] ?? path),
    lstat: (path) => realFileSystem.lstat(virtualMap[path] ?? path),
    // Virtual paths are canonical inside the emulated world: realpath returns
    // the virtual path itself for mapped candidates, real behavior otherwise.
    realpath: (path) => (virtualMap[path] !== undefined ? path : realFileSystem.realpath(path)),
    readBytes: (path) => realFileSystem.readBytes(virtualMap[path] ?? path),
    stat: (path) => realFileSystem.stat(virtualMap[path] ?? path),
  };
  try {
    expect(
      await Effect.runPromise(
        Effect.sync(() =>
          discoverCollectorExecutables(fakeFileSystem, { PATH: `${phpStore}:${bwrapStore}` }),
        ),
      ),
    ).toEqual({ phpExecutable: `${phpStore}/php`, bwrapExecutable: `${bwrapStore}/bwrap` });
    // PATH entry outside /usr/bin and /nix/store/* is skipped entirely.
    expect(
      await Effect.runPromise(
        Effect.sync(() => discoverCollectorExecutables(realFileSystem, { PATH: "/opt/bin" })),
      ),
    ).toBeUndefined();
    // Missing or empty PATH yields no discovery.
    expect(
      await Effect.runPromise(Effect.sync(() => discoverCollectorExecutables(realFileSystem, {}))),
    ).toBeUndefined();
    // Bare /nix/store is not a trusted PATH entry; trust requires /usr/bin or
    // /nix/store/<hash>-*/ directories with a provenance-valid candidate name.
    expect(
      await Effect.runPromise(
        Effect.sync(() => discoverCollectorExecutables(realFileSystem, { PATH: "/nix/store" })),
      ),
    ).toBeUndefined();
    // A trusted-shaped nix-store PATH entry without a php candidate leaves
    // discovery incomplete and rejected.
    expect(
      await Effect.runPromise(
        Effect.sync(() => discoverCollectorExecutables(realFileSystem, { PATH: bwrapStore })),
      ),
    ).toBeUndefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("plain git-ignored vendor tree stages collector inputs; absent or symlinked vendor fails closed", async () => {
  const realFileSystem = await realFileSystemPromise;
  const APPROVED_TEST_ENV_BYTES = execFileSync("git", ["show", "HEAD:apps/server/.env.test"], {
    cwd: resolve(import.meta.dir, "../../.."),
    maxBuffer: 8192,
  }).toString("utf8");
  const buildMonoTree = (vendor: "present" | "symlink" | "absent"): string => {
    const monoRoot = mkdtempSync("/tmp/parity-collector-vendor-");
    execFileSync("git", ["-C", monoRoot, "init", "-q"]);
    execFileSync("git", ["-C", monoRoot, "config", "user.email", "parity@example.invalid"]);
    execFileSync("git", ["-C", monoRoot, "config", "user.name", "parity-test"]);
    const put = (path: string, bytes: string): void => {
      mkdirSync(dirname(join(monoRoot, path)), { recursive: true });
      writeFileSync(join(monoRoot, path), bytes, "utf8");
    };
    put("apps/server/.gitignore", "/vendor\n/var\n");
    put("apps/server/bin/console", "#!/usr/bin/env php\n<?php echo '[]';\n");
    put("apps/server/composer.json", "{}\n");
    put("apps/server/composer.lock", "{}\n");
    put("apps/server/config/bundles.php", "<?php\nreturn [];\n");
    put("apps/server/src/Controller/HomeController.php", "<?php\nfinal class Home {}\n");
    put("apps/server/.env.test", APPROVED_TEST_ENV_BYTES);
    execFileSync("git", ["-C", monoRoot, "add", "-A"]);
    execFileSync("git", ["-C", monoRoot, "commit", "-qm", "fixture"]);
    // Vendor variants are created AFTER the commit so they stay untracked and
    // git-ignored: the scanner never walks them (a committed symlink would make
    // scanRoot fail on symlinked path components), while staging sees them.
    if (vendor === "present") {
      mkdirSync(join(monoRoot, "apps/server/vendor"), { recursive: true });
      writeFileSync(join(monoRoot, "apps/server/vendor/autoload.php"), "<?php\n");
    }
    if (vendor === "symlink")
      symlinkSync("/nonexistent-vendor-target", join(monoRoot, "apps/server/vendor"));
    return monoRoot;
  };
  const legacyRoot = mkdtempSync("/tmp/parity-collector-legacy-");
  // Nix-store-shaped stand-in paths satisfy collectorExecutableProvenance while
  // the actual bytes are ordinary mode-0500 files in the writable fixture tree,
  // so resolution passes without depending on a host-installed php or bwrap.
  const phpStandIn = "/nix/store/cccccccccccccccccccccccccccccccc-php-8.3.21/bin/php";
  const bwrapStandIn = "/nix/store/dddddddddddddddddddddddddddddddd-bubblewrap-0.11.2/bin/bwrap";
  writeFileSync(join(legacyRoot, "standin-php"), "#!/bin/sh\n");
  chmodSync(join(legacyRoot, "standin-php"), 0o500);
  writeFileSync(join(legacyRoot, "standin-bwrap"), "#!/bin/sh\n");
  chmodSync(join(legacyRoot, "standin-bwrap"), 0o500);
  const standInMap: Record<string, string> = {
    [phpStandIn]: join(legacyRoot, "standin-php"),
    [bwrapStandIn]: join(legacyRoot, "standin-bwrap"),
  };
  const standInFileSystem: ParityFileSystemShape = {
    ...realFileSystem,
    exists: (path) => realFileSystem.exists(standInMap[path] ?? path),
    lstat: (path) => realFileSystem.lstat(standInMap[path] ?? path),
    stat: (path) => realFileSystem.stat(standInMap[path] ?? path),
    readBytes: (path) => realFileSystem.readBytes(standInMap[path] ?? path),
    // Stand-in paths are canonical inside the emulated world: realpath returns
    // the stand-in path itself for mapped candidates, real behavior otherwise.
    realpath: (path) => (standInMap[path] !== undefined ? path : realFileSystem.realpath(path)),
  };
  const runCollector = async (monoRoot: string): Promise<string> => {
    const legacy = await Effect.runPromise(
      scanRootEffect(legacyRoot, "legacy").pipe(Effect.provide(NodeRuntimeLayer)),
    );
    const mono = await Effect.runPromise(
      scanRootEffect(monoRoot, "mono").pipe(Effect.provide(NodeRuntimeLayer)),
    );
    const context = createManifestContextFromSnapshots(legacy, mono);
    // The public collectApiOperations wrapper cannot inject configuration, so
    // this drives runTrustedPhpCollectorWithServices directly with explicit
    // nix-store-shaped stand-in executables that pass validation on any host;
    // staging behavior is what differs between the fixtures below.
    const standInExecutables = {
      phpExecutable: phpStandIn,
      bwrapExecutable: bwrapStandIn,
    };
    const result = await Effect.runPromise(
      Effect.sync(() =>
        runTrustedPhpCollectorWithServices(
          standInFileSystem,
          noopCommands,
          context,
          ["-r", "echo '[]';"],
          standInExecutables,
          "generic",
          {},
        ),
      ),
    );
    expect(result.availability).toBe("unavailable");
    return result.reason ?? "";
  };
  const present = buildMonoTree("present");
  const absent = buildMonoTree("absent");
  const symlinked = buildMonoTree("symlink");
  try {
    // Plain vendor tree passes staging and reaches sandbox execution; the noop
    // executor then throws, surfacing as COLLECTOR_EXECUTION_FAILED.
    expect(await runCollector(present)).toBe("COLLECTOR_EXECUTION_FAILED");
    // Absent vendor or symlinked vendor never reach execution.
    expect(await runCollector(absent)).toBe("COLLECTOR_INPUTS_UNAVAILABLE");
    expect(await runCollector(symlinked)).toBe("COLLECTOR_INPUTS_UNAVAILABLE");
  } finally {
    rmSync(present, { recursive: true, force: true });
    rmSync(absent, { recursive: true, force: true });
    rmSync(symlinked, { recursive: true, force: true });
    rmSync(legacyRoot, { recursive: true, force: true });
  }
});

test("restricted PATH without valid collectors fails before staging", async () => {
  const realFileSystem = await realFileSystemPromise;
  const directory = mkdtempSync("/tmp/parity-collector-nopath-");
  const legacyRoot = join(directory, "legacy");
  const monoRoot = join(directory, "mono");
  mkdirSync(legacyRoot);
  mkdirSync(monoRoot);
  try {
    const legacy = await Effect.runPromise(
      scanRootEffect(legacyRoot, "legacy").pipe(Effect.provide(NodeRuntimeLayer)),
    );
    const mono = await Effect.runPromise(
      scanRootEffect(monoRoot, "mono").pipe(Effect.provide(NodeRuntimeLayer)),
    );
    const context = createManifestContextFromSnapshots(legacy, mono);
    const result = await Effect.runPromise(
      Effect.sync(() =>
        runTrustedPhpCollectorWithServices(
          realFileSystem,
          noopCommands,
          context,
          ["-r", "echo '[]';"],
          undefined,
          "generic",
          {},
        ),
      ),
    );
    expect(result.reason).toBe("COLLECTOR_EXECUTABLE_CONFIG_MISSING");
    expect(result.executableDigests).toEqual({ php: null, bwrap: null });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
