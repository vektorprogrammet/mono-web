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
import { join, resolve } from "node:path";
import {
  API_METADATA_SCRIPT,
  API_OPENAPI_SCRIPT,
  buildCollectorSandboxArguments,
  collectorExecutableProvenance,
  collectApiOperations,
  resolveCollectorExecutables,
  routePayloadContainsUnsafe,
  validateCollectorExecutablePath,
} from "../src/api.js";
import { sha256 } from "../src/canonical.js";
import {
  createManifestContextFromSnapshots,
  unsafeSourceTextReason,
} from "../src/source-manifest.js";
import { scanRootEffect } from "../src/runtime.js";
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
    const mono = await Effect.runPromise(scanRootEffect(directory, "mono"));
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
    const legacy = await Effect.runPromise(scanRootEffect(legacyRoot, "legacy"));
    const mono = await Effect.runPromise(scanRootEffect(monoRoot, "mono"));
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
      const result = collectApiOperations(
        context,
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        [],
        true,
        undefined,
        { path: fixture.path, bytes: fixture.bytes },
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
  const phpWithExtensions =
    "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-php-with-extensions-8.4.23/bin/php";
  const bwrap = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-bubblewrap-0.11.2/bin/bwrap";
  expect(collectorExecutableProvenance("php", php)).toBe("nix-store");
  expect(collectorExecutableProvenance("php", phpWithExtensions)).toBe("nix-store");
  expect(collectorExecutableProvenance("bwrap", bwrap)).toBe("nix-store");
  expect(collectorExecutableProvenance("php", "php")).toBeNull();
});

test("sandbox invocation binds selected binaries, isolates arguments, and narrows runtime writes", () => {
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
