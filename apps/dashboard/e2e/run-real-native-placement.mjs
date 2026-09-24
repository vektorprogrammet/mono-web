import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { sanitizePlaywrightArtifact } from "./runtime-evidence-receipt.mjs";

// The parent owns PostgreSQL, fixture, backend and credentials; this child owns dashboard and browser.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));
const manifestPath = process.env.PLACEMENT_JOURNEY_MANIFEST;
assert.ok(manifestPath, "PLACEMENT_JOURNEY_MANIFEST is required");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
for (const origin of [manifest.backendOrigin, manifest.dashboardOrigin]) {
  const url = new URL(origin);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.protocol, "http:");
}
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
assert.equal(revision.status, 0);
assert.equal(revision.stdout.trim(), manifest.revision, "browser must build manifest's exact revision");
const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
assert.equal(status.status, 0);
assert.equal(status.stdout.trim(), "", "browser requires a clean source tree");
const environment = {
  ...Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", "PLAYWRIGHT_NODE_EXECUTABLE", "PLAYWRIGHT_BROWSERS_PATH"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  PLACEMENT_JOURNEY_MANIFEST: manifestPath,
  API_URL: manifest.backendOrigin,
  VITE_API_URL: manifest.dashboardOrigin,
  DASHBOARD_ORIGIN: manifest.dashboardOrigin,
  DASHBOARD_MOUNT: "/dashboard/",
  HOST: "127.0.0.1",
  PORT: new URL(manifest.dashboardOrigin).port,
  NODE_ENV: "production",
  REAL_NATIVE_IDENTITY_E2E: "1",
  GOLDEN_SCHOOL_SERVICE_REQUIRED: manifest.golden ? "1" : "0",
};
const secrets = Object.values(manifest.persons).map(person => person.password);
const sanitize = value => secrets.reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), String(value))
  .replace(/(authorization|cookie|set-cookie)([\s"':=]+)[^\r\n,}]+/gi, "$1$2[REDACTED]");
const children = new Set();
let commandSequence = 0;
let output = "";
let failure;
let cleanupPromise;
const start = (command, args, cwd) => {
  const child = spawn(command, args, { cwd, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  return child;
};
const stop = async child => {
  if (!child?.pid) return;
  const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once("exit", resolve));
  const signal = name => { try { process.kill(-child.pid, name); } catch (error) { if (error.code !== "ESRCH") throw error; } };
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), 3000);
  try { await exited; } finally { clearTimeout(timer); }
  signal("SIGKILL");
  assert.ok(child.exitCode !== null || child.signalCode !== null, "owned child must have exited");
};
const run = (command, args, cwd) => new Promise((resolve, reject) => {
  const logPath = join(manifest.artifacts, `dashboard-command-${++commandSequence}.log`);
  const child = start(command, args, cwd);
  let text = "";
  child.stdout.on("data", value => { text += value; });
  child.stderr.on("data", value => { text += value; });
  child.once("error", reject);
  child.once("close", code => {
    writeFile(logPath, sanitize(text), { mode: 0o600 }).then(() => code === 0 ? resolve(text) : reject(new Error(`${command} exited ${code}; ${logPath}\n${sanitize(text).slice(-6000)}`)), reject);
  });
});
const cleanup = () => cleanupPromise ??= (async () => {
  await Promise.all([...children].map(stop));
  const traces = [];
  for (const name of await readdir(manifest.artifacts)) {
    if (!/^private-trace-\d+\.zip$/.test(name)) continue;
    const path = join(manifest.artifacts, name);
    try {
      const extracted = spawnSync("unzip", ["-p", path, "*.trace", "*.network"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
      assert.equal(extracted.status, 0, "failed to extract private diagnostic trace");
      for (const line of extracted.stdout.split("\n")) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        const request = event.snapshot?.request;
        const response = event.snapshot?.response;
        traces.push({ context: name, type: event.type, apiName: event.apiName, method: event.method ?? request?.method,
          path: request?.url ? new URL(request.url).pathname : undefined, status: response?.status,
          error: event.error ? sanitize(event.error.message ?? event.error.name ?? "browser action failed") : undefined });
      }
    } finally { await rm(path, { force: true }); }
  }
  if (traces.length) await writeFile(join(manifest.artifacts, "browser-trace-sanitized.json"), JSON.stringify(traces, null, 2), { mode: 0o600 });
  await rm(join(manifest.artifacts, "playwright-private"), { recursive: true, force: true });
  await writeFile(join(manifest.artifacts, "dashboard-runtime.log"), sanitize(output), { mode: 0o600 });
  await writeFile(join(manifest.artifacts, "browser-cleanup.json"), JSON.stringify({ processesExited: [...children].every(child => child.exitCode !== null || child.signalCode !== null), privateTracesRemoved: true, privateResultsRemoved: true, failure: failure ? sanitize(failure) : null }), { mode: 0o600 });
})();
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
  failure = `Interrupted by ${signal}`;
  void cleanup().then(() => process.exit(signal === "SIGTERM" ? 143 : 130), () => process.exit(1));
});
try {
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(Number(environment.PORT), "127.0.0.1", resolve); });
  await new Promise(resolve => reservation.close(resolve));
  await run("bun", ["--no-env-file", "run", "build"], join(root, "packages/sdk"));
  await run("bun", ["--no-env-file", "run", "build"], dashboardRoot);
  const dashboard = start("bun", ["--no-env-file", "server.mjs"], dashboardRoot);
  dashboard.stdout.on("data", value => { output += value; });
  dashboard.stderr.on("data", value => { output += value; });
  const deadline = Date.now() + 30000;
  while (true) {
    if (dashboard.exitCode !== null) throw new Error(`Dashboard exited: ${sanitize(output)}`);
    try { if ((await fetch(`${manifest.dashboardOrigin}/dashboard/login`)).ok) break; } catch {}
    assert.ok(Date.now() < deadline, `Dashboard startup timed out: ${sanitize(output)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const report = await run(environment.PLAYWRIGHT_NODE_EXECUTABLE ?? "node", [
    "node_modules/@playwright/test/cli.js", "test", "e2e/native-placement.spec.ts", "--project=chromium", "--workers=1", "--retries=0", "--reporter=json",
    "--grep", manifest.golden ? "^golden school-service continuous functional journey$" : "^0096 placement,",
    "--output", join(manifest.artifacts, "playwright-private"),
  ], dashboardRoot);
  const sanitized = sanitizePlaywrightArtifact(Buffer.from(report));
  assert.equal(JSON.parse(Buffer.from(sanitized).toString()).tests.length, 1, "exactly one required browser scenario must pass");
  await writeFile(join(manifest.artifacts, "playwright-evidence.json"), sanitized, { mode: 0o600 });
  const evidencePath = join(manifest.artifacts, "browser-evidence.json");
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(evidence.passed, true, "browser evidence is required even after API success");
  assert.equal(evidence.revision, manifest.revision);
} catch (cause) {
  failure = cause;
} finally {
  await cleanup();
}
if (failure) throw new Error(sanitize(failure));
process.stdout.write(`${JSON.stringify({ passed: true, revision: manifest.revision, evidencePath: join(manifest.artifacts, "browser-evidence.json") })}\n`);
