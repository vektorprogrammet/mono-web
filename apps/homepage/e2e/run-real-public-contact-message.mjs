import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const homepageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const serverRoot = join(repositoryRoot, "apps/server");
const homepageOrigin = "http://127.0.0.1:8787";
const symfonyOrigin = "http://127.0.0.1:8794";
const proxyOrigin = "http://127.0.0.1:8793";
const databasePath = join(tmpdir(), `contact-e2e-${process.pid}.sqlite`);
const evidencePath =
  process.env.PUBLIC_CONTACT_E2E_EVIDENCE_PATH ??
  join(tmpdir(), "public-contact-message-0043.json");
const databaseUrl = `sqlite:///${databasePath}`;
const commandTimeout = 300_000;

const children = [];
const contactRequests = [];
let proxy;

const command = (
  application,
  args,
  { cwd = repositoryRoot, env = process.env, label = application } = {},
) =>
  new Promise((resolve, reject) => {
    const child = spawn(application, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${label} timed out\n${output}`));
    }, commandTimeout);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`${label} exited with ${code}\n${output}`));
    });
  });

const start = (application, args, { cwd, env, label }) => {
  const child = spawn(application, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = { child, label, output: "" };
  child.stdout.on("data", (chunk) => {
    record.output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    record.output += chunk.toString();
  });
  children.push(record);
  return record;
};

const waitForHttp = async (url, label) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // The process has not opened its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const logs = children
    .map((record) => `${record.label}:\n${record.output.slice(-4000)}`)
    .join("\n");
  throw new Error(`${label} did not become ready\n${logs}`);
};

const stopChildren = async () => {
  await Promise.all(
    children.map(
      ({ child }) =>
        new Promise((resolve) => {
          if (child.exitCode !== null) {
            resolve();
            return;
          }
          const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          child.kill("SIGTERM");
        }),
    ),
  );
};

const readBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("error", reject);
  });

const startRecordingProxy = async () => {
  proxy = createServer(async (request, response) => {
    try {
      const body = await readBody(request);
      const headers = { ...request.headers };
      delete headers.host;
      delete headers["content-length"];
      const upstream = await fetch(`${symfonyOrigin}${request.url}`, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
        redirect: "manual",
      });
      const responseBody = Buffer.from(await upstream.arrayBuffer());
      if (
        request.method === "POST" &&
        new URL(request.url, proxyOrigin).pathname === "/api/contact_messages"
      ) {
        const payload = JSON.parse(body.toString("utf8"));
        contactRequests.push({
          departmentId: payload.departmentId,
          keys: Object.keys(payload).sort(),
          status: upstream.status,
        });
      }
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      response.end(responseBody);
    } catch (error) {
      response.writeHead(502, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : "proxy failure");
    }
  });
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(8793, "127.0.0.1", resolve);
  });
};

const closeProxy = async () => {
  if (proxy === undefined) return;
  await new Promise((resolve, reject) => {
    proxy.close((error) => (error ? reject(error) : resolve()));
  });
};

const main = async () => {
  const serverEnvironment = {
    ...process.env,
    APP_ENV: "test",
    APP_DEBUG: "0",
    DATABASE_URL: databaseUrl,
  };
  await rm(databasePath, { force: true });
  await command(
    "php",
    ["bin/console", "doctrine:schema:create", "--no-interaction"],
    { cwd: serverRoot, env: serverEnvironment, label: "Symfony schema" },
  );
  await command(
    "php",
    ["bin/console", "doctrine:fixtures:load", "--no-interaction"],
    { cwd: serverRoot, env: serverEnvironment, label: "Symfony fixtures" },
  );

  start(
    "php",
    ["-S", "127.0.0.1:8794", "-t", "public", "public/index.php"],
    { cwd: serverRoot, env: serverEnvironment, label: "Symfony API" },
  );
  await waitForHttp(`${symfonyOrigin}/api/departments`, "Symfony API");
  await startRecordingProxy();

  const homepageEnvironment = { ...process.env, API_URL: proxyOrigin };
  await command("bun", ["run", "worker:build"], {
    cwd: homepageRoot,
    env: homepageEnvironment,
    label: "Homepage build",
  });
  start("bun", ["run", "worker:dev"], {
    cwd: homepageRoot,
    env: homepageEnvironment,
    label: "Homepage preview",
  });
  await waitForHttp(`${homepageOrigin}/kontakt`, "Homepage preview");

  await command(
    "bun",
    [
      "run",
      "e2e:test",
      "--",
      "e2e/public-contact-message.spec.ts",
      "--project=chromium",
      "--retries=0",
    ],
    {
      cwd: homepageRoot,
      env: {
        ...process.env,
        REAL_PUBLIC_APPLICATION_E2E: "1",
        REAL_PUBLIC_CONTACT_E2E: "1",
        PUBLIC_CONTACT_E2E_BACKEND_ORIGIN: symfonyOrigin,
      },
      label: "Contact browser journey",
    },
  );

  const departmentsResponse = await fetch(`${symfonyOrigin}/api/departments`);
  const departmentsBody = await departmentsResponse.json();
  const selectedDepartment = departmentsBody["hydra:member"].find(
    (department) => department.active,
  );
  if (contactRequests.length !== 1) {
    throw new Error(`Expected one contact API request, received ${contactRequests.length}`);
  }
  if (contactRequests[0].departmentId !== selectedDepartment.id) {
    throw new Error("The contact request used a different department identifier");
  }
  if (contactRequests[0].status !== 201) {
    throw new Error(`The contact API returned ${contactRequests[0].status}`);
  }

  const revision = (
    await command("git", ["rev-parse", "HEAD"], { label: "Git revision" })
  ).trim();
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(
    evidencePath,
    `${JSON.stringify(
      {
        schema: "public-contact-message-evidence/v1",
        revision,
        selectedDepartmentId: selectedDepartment.id,
        apiRequests: contactRequests,
        browser: {
          acceptedResult: "Meldingen er sendt.",
          rejectedResult: "Fyll ut alle feltene med gyldig informasjon.",
        },
        legacyRecaptchaDisposition: "open",
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`${evidencePath}\n`);
};

try {
  await main();
} finally {
  await closeProxy();
  await stopChildren();
  await rm(databasePath, { force: true });
}
