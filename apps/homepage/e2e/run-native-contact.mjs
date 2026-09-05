// Spec 0043.1: isolated real Worker, native HTTP, PostgreSQL and acknowledged loopback delivery.
// Reuses repository real-journey runners' PostgreSQL lifecycle and installed Cloudflare runtime.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, writeFile, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const homepage = join(root, "apps/homepage");
const require = createRequire(import.meta.url);
const domainRequire = createRequire(join(root, "packages/domain/package.json"));
const databaseRequire = createRequire(join(root, "packages/database/package.json"));
const { Address4, Address6 } = domainRequire("ip-address");
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const { Pool } = databaseRequire("pg");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
assert.equal(
  execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
  "",
  "run committed clean content",
);
const artifacts = await mkdtemp(join(tmpdir(), "vektor-contact-0043-"));
const children = [];
const servers = [];
let mf;
let pool;
let browser;
let evidence;
const tokens = {
  ingress: randomBytes(32).toString("hex"),
  backend: randomBytes(32).toString("hex"),
  delivery: randomBytes(32).toString("hex"),
};
const secretValues = Object.values(tokens);
const safe = (text) =>
  secretValues.reduce((value, secret) => value.replaceAll(secret, "[redacted]"), String(text));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: root, encoding: "utf8", timeout: 60_000, ...opts });
const start = (cmd, args, env) => {
  const child = spawn(cmd, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output = (output + safe(chunk)).slice(-20_000);
  });
  child.stderr.on("data", (chunk) => {
    output = (output + safe(chunk)).slice(-20_000);
  });
  children.push({ child, output: () => output });
  return child;
};
const listen = (server, desiredPort = 0) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(desiredPort, "127.0.0.1", () => {
      servers.push(server);
      resolve(server.address().port);
    });
  });
const port = async () => {
  const s = createServer();
  const p = await listen(s);
  await new Promise((r) => s.close(r));
  return p;
};
const ready = async (url) => {
  for (let n = 0; n < 150; n++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await delay(200);
  }
  throw new Error(`Startup failed ${url}\n${children.map((c) => c.output()).join("\n")}`);
};
const canonical = (ip) => {
  if (Address4.isValid(ip)) return new Address4(ip).correctForm();
  const v6 = new Address6(ip);
  return v6.isMapped4() ? v6.to4().correctForm() : v6.correctForm();
};
const records = [];
const workerOutbound = [];
let mode = "accept";
const message = {
  departmentId: "contact-aas",
  name: "Ola Kontakt",
  email: "ola@example.org",
  subject: "Kontaktprøve",
  message: "Når starter opptaket?",
};
const gates = [];
const checkpoint = (message) => {
  gates.push(message);
  console.log(JSON.stringify({ phase: message }));
};
const bounded = (promise, milliseconds, label) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
try {
  const pgPort = await port();
  const backendPort = await port();
  const workerPort = await port();
  const ingressPort = await port();
  const browserOrigin = `http://p000.vektor.phibkro.org:${ingressPort}`;
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const pgDir = join(artifacts, "postgres");
  run("initdb", ["-D", pgDir, "-A", "trust", "-U", "postgres", "--no-locale", "--encoding=UTF8"]);
  start(
    "postgres",
    ["-D", pgDir, "-p", String(pgPort), "-h", "127.0.0.1", "-k", artifacts],
    process.env,
  );
  const pgUrl = `postgres://postgres@127.0.0.1:${pgPort}/postgres`;
  pool = new Pool({ connectionString: pgUrl });
  for (let n = 0; ; n++) {
    try {
      await pool.query("SELECT 1");
      break;
    } catch (e) {
      if (n >= 100) throw e;
      await delay(100);
    }
  }
  const sink = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${tokens.delivery}`) {
      res.writeHead(401).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    if (mode === "reject") {
      res.writeHead(503).end();
      return;
    }
    records.push(JSON.parse(body));
    if (mode === "timeout") {
      await delay(1500);
      if (!res.destroyed) res.writeHead(201).end();
      return;
    }
    if (mode === "pending") await delay(400);
    res.writeHead(201).end();
  });
  const sinkPort = await listen(sink);
  const deliveryUrl = `http://127.0.0.1:${sinkPort}/deliver`;
  assert.equal(new URL(deliveryUrl).hostname, "127.0.0.1");
  const baseEnv = {
    ...process.env,
    BACKEND_HOST: "127.0.0.1",
    BACKEND_PORT: String(backendPort),
    BACKEND_PG_URL: pgUrl,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    NATIVE_IDENTITY_DEPLOYMENT: "local",
    NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify(["http://127.0.0.1:5174"]),
    OAUTH_CANONICAL_ORIGIN: backendOrigin,
    OAUTH_DASHBOARD_ORIGIN: "http://127.0.0.1:5174",
    OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
    PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
    ADMISSION_AUTH_TOKENS: "{}",
    RECEIPT_AUTH_TOKENS: "{}",
    ORGANIZATION_AUTH_TOKENS: "{}",
    CONTACT_BACKEND_TOKEN: tokens.backend,
    CONTACT_DELIVERY_TOKEN: tokens.delivery,
    CONTACT_SENDER: "contact@example.org",
    CONTACT_DELIVERY_URL: deliveryUrl,
    CONTACT_DELIVERY_TIMEOUT_MS: "800",
  };
  // No inherited application transport destination can turn this run into external delivery.
  delete baseEnv.PUBLIC_APPLICATION_EFFECT_ENDPOINT;
  delete baseEnv.PUBLIC_APPLICATION_EFFECT_TOKEN;
  start("bun", ["run", "apps/backend/src/main.ts"], baseEnv);
  await ready(`${backendOrigin}/health`);
  console.log(JSON.stringify({ phase: "native backend ready" }));
  await pool.query(`INSERT INTO public.organization_departments(department_id,name,short_name,email,city,active) VALUES
    ('contact-aas','Vektorprogrammet Ås','Ås','aas@example.org','Ås',true),
    ('contact-bergen','Vektorprogrammet Bergen','Bergen','bergen@example.org','Bergen',true),
    ('contact-inactive','Inaktiv','Inaktiv','inactive@example.org','Ås',false),
    ('contact-invalid-email','Uten e-post','Uten e-post','invalid-address','Ås',true)`);
  mf = new Miniflare(
    convertV4MiniflareOptions({
      host: "127.0.0.1",
      port: workerPort,
      upstream: browserOrigin,
      modulesRoot: join(homepage, "build/server"),
      modules: [
        "index.js",
        ...(await readdir(join(homepage, "build/server"), { recursive: true })).filter(
          (path) => path.endsWith(".js") && path !== "index.js",
        ),
      ].map((path) => ({ type: "ESModule", path: join(homepage, "build/server", path) })),
      compatibilityDate: "2026-08-08",
      compatibilityFlags: ["nodejs_compat"],
      cf: false,
      outboundService: async (request) => {
        const url = new URL(request.url);
        if (url.origin !== backendOrigin) throw new Error("Local Worker outbound origin rejected");
        const response = await fetch(url, {
          method: request.method,
          headers: request.headers,
          redirect: "manual",
          ...(["GET", "HEAD"].includes(request.method)
            ? {}
            : { body: await request.arrayBuffer() }),
        });
        workerOutbound.push({
          method: request.method,
          path: url.pathname,
          status: response.status,
        });
        return response;
      },
      assets: {
        directory: join(homepage, "build/client"),
        binding: "ASSETS",
        routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
      },
      bindings: {
        API_URL: backendOrigin,
        CONTACT_INGRESS_TOKEN: tokens.ingress,
        CONTACT_BACKEND_TOKEN: tokens.backend,
      },
    }),
  );
  await bounded(mf.ready, 30_000, "built Worker startup");
  const workerHealth = await mf.dispatchFetch("http://p000.vektor.phibkro.org/health", {
    headers: { host: "p000.vektor.phibkro.org" },
  });
  if (workerHealth.status !== 200)
    throw new Error(
      `Built Worker health returned ${workerHealth.status}: ${safe(await workerHealth.text())}`,
    );
  const provenance = await workerHealth.json();
  assert.equal(provenance.commit, revision, "built Worker must match selected committed revision");
  assert.match(provenance.routeDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(provenance.contentDigest, /^sha256:[a-f0-9]{64}$/);
  checkpoint("built Worker commit and route/content digests observed");
  let backendCommands = 0;
  const ingress = createServer(async (req, res) => {
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers))
        if (
          value !== undefined &&
          !key.startsWith("x-vektor-contact-") &&
          ![
            "host",
            "connection",
            "content-length",
            "transfer-encoding",
            "x-forwarded-for",
            "forwarded",
            "cf-connecting-ip",
          ].includes(key)
        )
          headers.set(key, Array.isArray(value) ? value.join(",") : value);
      headers.set("host", "p000.vektor.phibkro.org");
      headers.set("x-vektor-contact-ingress", tokens.ingress);
      headers.set("x-vektor-contact-ip", canonical(req.socket.remoteAddress));
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65_536) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      if (req.method === "POST") backendCommands++;
      const response = await mf.dispatchFetch(`http://p000.vektor.phibkro.org${req.url}`, {
        method: req.method,
        headers,
        ...(["GET", "HEAD"].includes(req.method) ? {} : { body: Buffer.concat(chunks) }),
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(502).end("Local ingress failed");
    }
  });
  await listen(ingress, ingressPort);
  const origin = `http://127.0.0.1:${ingressPort}`;
  const headers = (ip, token = tokens.backend) => ({
    "content-type": "application/json",
    "x-vektor-contact-ip": ip,
    "x-vektor-contact-backend": token,
  });
  const post = (payload = message, ip = "192.0.2.1", token = tokens.backend) =>
    fetch(`${backendOrigin}/api/contact-messages`, {
      method: "POST",
      headers: headers(ip, token),
      body: JSON.stringify(payload),
      redirect: "error",
    });
  const count = async () =>
    Number(
      (await pool.query("SELECT coalesce(sum(attempts),0) AS n FROM public.contact_rate_windows"))
        .rows[0].n,
    );
  const clear = async () => pool.query("TRUNCATE public.contact_rate_windows");
  for (const token of ["", tokens.ingress, "wrong"]) {
    assert.equal((await post(message, "192.0.2.1", token)).status, 401);
  }
  for (const ip of ["192.0.2.1/32", "::ffff:192.0.2.1", "192.0.2.1,192.0.2.2"]) {
    assert.equal((await post(message, ip)).status, 400);
  }
  assert.equal(await count(), 0);
  assert.equal(records.length, 0);
  checkpoint(
    "wrong/missing/wrong-hop credential and noncanonical identity reject before quota/delivery",
  );
  assert.equal((await post({ ...message, email: "invalid" })).status, 422);
  assert.equal((await post({ ...message, to: "attacker@example.org" })).status, 422);
  assert.equal((await post({ ...message, message: "x".repeat(70_000) })).status, 413);
  assert.equal(await count(), 0);
  for (const departmentId of ["unknown", "contact-inactive", "contact-invalid-email"]) {
    assert.equal((await post({ ...message, departmentId })).status, 422);
  }
  assert.equal(await count(), 3);
  assert.equal(records.length, 0);
  await clear();
  checkpoint("invalid input rejects; recipient rejection consumes decoded attempts");
  await post();
  const initialExpiry = (await pool.query("SELECT expires_at FROM public.contact_rate_windows"))
    .rows[0].expires_at;
  await post();
  assert.equal(
    (
      await pool.query("SELECT expires_at FROM public.contact_rate_windows")
    ).rows[0].expires_at.getTime(),
    initialExpiry.getTime(),
  );
  await pool.query(
    "UPDATE public.contact_rate_windows SET expires_at=statement_timestamp()-interval '1 second'",
  );
  await post();
  assert.equal(await count(), 1);
  await clear();
  records.length = 0;
  checkpoint("fixed expiry does not slide and expired window resets");
  const concurrent = await Promise.all(Array.from({ length: 12 }, () => post()));
  assert.equal(concurrent.filter((r) => r.status === 201).length, 5);
  assert.equal(concurrent.filter((r) => r.status === 429).length, 7);
  assert.equal(records.length, 5);
  assert.equal((await post(message, "192.0.2.2")).status, 201);
  await clear();
  checkpoint("atomic concurrency admits5/rejects7; separate visitor has quota");
  mode = "reject";
  const beforeReject = records.length;
  assert.equal((await post()).status, 503);
  assert.equal(records.length, beforeReject);
  assert.equal(await count(), 1);
  mode = "timeout";
  const beforeTimeout = records.length;
  assert.equal((await post()).status, 503);
  await delay(1000);
  assert.equal(records.length, beforeTimeout + 1);
  assert.equal(await count(), 2);
  await clear();
  checkpoint("rejection/ambiguous timeout fail without retry and consume quota");
  mode = "accept";
  browser = await chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "/etc/profiles/per-user/nori/bin/chromium",
    args: [
      "--disable-background-networking",
      "--no-proxy-server",
      "--host-resolver-rules=MAP p000.vektor.phibkro.org 127.0.0.1",
    ],
  });
  const context = await browser.newContext({ locale: "nb-NO" });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "p000.vektor.phibkro.org"].includes(url.hostname)
      ? route.continue()
      : route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) =>
    console.log(JSON.stringify({ browserError: safe(error.message) })),
  );
  page.on("requestfailed", (request) =>
    console.log(
      JSON.stringify({ failedRequest: request.url(), reason: request.failure()?.errorText }),
    ),
  );
  page.on("response", (response) => {
    if (response.url().includes(".data") && response.request().method() === "POST")
      console.log(JSON.stringify({ actionStatus: response.status() }));
  });
  const pageResponse = await page.goto(`${browserOrigin}/kontakt`);
  assert.equal(pageResponse.status(), 200);
  await page
    .getByRole("navigation", { name: "Velg avdeling" })
    .getByRole("link", { name: "Bergen", exact: true })
    .click();
  await expect(page.getByRole("link", { name: "bergen@example.org", exact: true })).toBeVisible();
  const fill = async () => {
    await page.getByLabel("Ditt navn").fill(message.name);
    await page.getByLabel("Din e-post").fill(message.email);
    await page.getByLabel("Emne", { exact: true }).fill(message.subject);
    await page.getByLabel("Melding", { exact: true }).fill(message.message);
  };
  const axe = async (label) => {
    const result = await new AxeBuilder({ page })
      .include('nav[aria-label="Velg avdeling"]')
      .include("main")
      .analyze();
    assert.deepEqual(result.violations, [], `axe ${label}`);
  };
  await axe("initial");
  await fill();
  mode = "pending";
  const beforeBrowser = records.length;
  const beforeCommands = backendCommands;
  await page.getByRole("button", { name: "Send melding", exact: true }).click();
  try {
    await expect(
      page.getByRole("button", { name: "Sender melding...", exact: true }),
    ).toBeDisabled();
  } catch (error) {
    console.log(
      JSON.stringify({
        browserUrl: page.url(),
        alerts: await page.getByRole("alert").allTextContents(),
        statuses: await page.getByRole("status").allTextContents(),
        buttons: await page.getByRole("button").allTextContents(),
        backendCommands,
        acceptances: records.length,
        quotaAttempts: await count(),
        workerOutbound,
      }),
    );
    throw error;
  }
  await page.locator('button[type="submit"]').evaluate((button) => button.click());
  await expect(page.getByRole("status")).toHaveText("Meldingen er sendt.");
  assert.equal(records.length, beforeBrowser + 1);
  assert.equal(backendCommands, beforeCommands + 1);
  assert.deepEqual(records.at(-1), {
    subject: `[Kontaktskjema] ${message.subject}`,
    text: `Navn: ${message.name}\nE-post: ${message.email}\n\n${message.message}`,
    to: "bergen@example.org",
    replyTo: message.email,
    from: "contact@example.org",
  });
  await expect(page.getByLabel("Melding", { exact: true })).toHaveValue("");
  await axe("accepted");
  mode = "reject";
  await fill();
  const beforeDraft = records.length;
  await page.getByRole("button", { name: "Send melding", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Meldingen kunne ikke sendes. Prøv igjen senere.",
  );
  await expect(page.getByLabel("Melding", { exact: true })).toHaveValue(message.message);
  assert.equal(records.length, beforeDraft);
  await axe("rejected");
  await page.screenshot({ path: join(artifacts, "contact-rejected.png"), fullPage: true });
  checkpoint(
    "built Worker browser department select/send/pending/clear/draft retention and axe states",
  );
  mode = "accept";
  await clear();
  const rawForm = (localAddress) =>
    new Promise((resolve, reject) => {
      const body = new URLSearchParams({
        name: message.name,
        email: message.email,
        subject: message.subject,
        message: message.message,
        departmentId: "contact-aas",
      }).toString();
      const req = httpRequest(
        `${origin}/kontakt/bergen`,
        {
          method: "POST",
          localAddress,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "content-length": Buffer.byteLength(body),
            "x-forwarded-for": randomBytes(4).join("."),
            "x-vektor-contact-ip": "198.51.100.55",
            "x-vektor-contact-ingress": "forged",
          },
        },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode, text }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  for (let n = 0; n < 5; n++) assert.match((await rawForm("127.0.0.1")).text, /Meldingen er sendt/);
  assert.match((await rawForm("127.0.0.1")).text, /for mange meldinger/);
  assert.match((await rawForm("127.0.0.2")).text, /Meldingen er sendt/);
  checkpoint("socket-derived ingress ignores spoofed headers and preserves distinct visitors");
  const direct = await mf.dispatchFetch("http://p000.vektor.phibkro.org/kontakt/bergen", {
    method: "POST",
    headers: {
      host: "p000.vektor.phibkro.org",
      "content-type": "application/x-www-form-urlencoded",
      "x-vektor-contact-ingress": tokens.backend,
      "x-vektor-contact-ip": "192.0.2.77",
    },
    body: new URLSearchParams(message).toString(),
  });
  assert.doesNotMatch(await direct.text(), /Meldingen er sendt/);
  checkpoint("wrong-hop Worker credential rejected");
  await clear();
  await new Promise((resolve) => sink.close(resolve));
  const beforeUnavailable = records.length;
  assert.equal((await post()).status, 503);
  assert.equal(records.length, beforeUnavailable);
  assert.equal(await count(), 1);
  checkpoint("unavailable real transport fails and consumes quota");
  await pool.query(
    "UPDATE public.organization_departments SET short_name='Ås' WHERE department_id='contact-bergen'",
  );
  assert.equal((await fetch(`${origin}/kontakt`)).status, 503);
  checkpoint("duplicate live fixture slugs fail503 without fabricated fallback");
  evidence = {
    revision,
    passed: true,
    gates,
    provenance,
    deliveryAcceptances: records.length,
    endpointOrigins: { ingress: origin, backend: backendOrigin, delivery: deliveryUrl },
    scope:
      "isolated synthetic PostgreSQL fixtures; actual built Worker/browser/native HTTP/loopback delivery; no production or inbox claim",
    antiAbuseParity: "reCAPTCHA and default geolocation gaps remain open",
  };
} catch (error) {
  await writeFile(join(artifacts, "failure.txt"), safe(error.stack));
  throw new Error(safe(error.stack));
} finally {
  await browser?.close();
  await mf?.dispose();
  await pool?.end();
  for (const server of servers) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
  for (const { child } of children.reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve, reject) => {
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
        const deadline = setTimeout(
          () => reject(new Error("Owned child exit not confirmed; preserving database")),
          15_000,
        );
        child.once("exit", () => {
          clearTimeout(killTimer);
          clearTimeout(deadline);
          resolve();
        });
        child.kill("SIGTERM");
      });
    }
  }
  await rm(join(artifacts, "postgres"), { recursive: true, force: true });
}

assert.ok(evidence, "success requires completed observations");
await writeFile(
  join(artifacts, "evidence.json"),
  JSON.stringify(
    {
      ...evidence,
      cleanup: "owned processes confirmed exited; disposable database removed; evidence retained",
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({ passed: true, revision, gates, evidence: join(artifacts, "evidence.json") }),
);
