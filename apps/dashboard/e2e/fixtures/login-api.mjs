import http from "node:http";

const HOST = "127.0.0.1";
const PORT = 8788;
const MAX_BODY_BYTES = 8192;
const SEED = "dashboard-cutover-0010";
const READY_LINE = `w0-login-fixture ready seed=${SEED}`;
const SHUTDOWN_LINE = "w0-login-fixture shutdown signal=SIGTERM";

const requiredEnvironment = {
  API_URL: "http://127.0.0.1:8788",
  VITE_API_URL: "http://127.0.0.1:8788",
  API_MODE: "fixture",
  VITE_API_MODE: "fixture",
  DASHBOARD_CUTOVER_FIXTURE_SEED: SEED,
};

for (const [name, expected] of Object.entries(requiredEnvironment)) {
  if (process.env[name] !== expected) {
    process.stderr.write("w0-login-fixture configuration error\n");
    process.exit(1);
  }
}

let events = [];
let shutdownStarted = false;
let shutdownReported = false;

function writeJson(response, status, value) {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function writeEmpty(response, status) {
  response.statusCode = status;
  response.setHeader("Content-Length", "0");
  response.end();
}

function writeBadRequest(response, status = 400) {
  writeJson(response, status, { error: "invalid request" });
}

function readBody(request) {
  return new Promise((resolve) => {
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const chunks = [];

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    request.on("data", (chunk) => {
      if (tooLarge) return;
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        request.resume();
        finish({ tooLarge: true, body: null });
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) return;
      finish({ tooLarge: false, body: Buffer.concat(chunks, size) });
    });
    request.on("error", () => {
      finish({ tooLarge: false, body: null, failed: true });
    });
  });
}

function isEmptyBody(body) {
  return body !== null && body.length === 0;
}

function parseLoginBody(body) {
  if (body === null) return null;
  let text = body.toString("utf8");
  let payload;
  try {
    payload = JSON.parse(text);
    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Object.keys(payload).length !== 2 ||
      !Object.hasOwn(payload, "username") ||
      !Object.hasOwn(payload, "password") ||
      payload.username !== "invalid@test.com" ||
      payload.password !== "wrongpassword"
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  } finally {
    text = "";
  }
}

async function handleRequest(request, response) {
  const bodyResult = await readBody(request);
  if (bodyResult.tooLarge) {
    writeBadRequest(response, 413);
    return;
  }
  if (bodyResult.failed || bodyResult.body === null) {
    writeBadRequest(response);
    return;
  }

  const body = bodyResult.body;
  try {
    let parsedUrl;
    try {
      parsedUrl = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
    } catch {
      writeBadRequest(response);
      return;
    }

    if (parsedUrl.search || parsedUrl.hash) {
      writeBadRequest(response, 404);
      return;
    }

    const method = request.method ?? "";
    const path = parsedUrl.pathname;

    if (path === "/health") {
      if (method !== "GET" || !isEmptyBody(body)) {
        writeBadRequest(response, 405);
        return;
      }
      writeJson(response, 200, { ok: true, seed: SEED });
      return;
    }

    if (path === "/reset") {
      if (method !== "POST" || !isEmptyBody(body)) {
        writeBadRequest(response, 405);
        return;
      }
      events = [];
      writeEmpty(response, 204);
      return;
    }

    if (path === "/events") {
      if (method !== "GET" || !isEmptyBody(body)) {
        writeBadRequest(response, 405);
        return;
      }
      writeJson(response, 200, { events });
      return;
    }

    if (path === "/api/login") {
      if (method !== "POST") {
        writeBadRequest(response, 405);
        return;
      }
      const payload = parseLoginBody(body);
      if (payload === null) {
        writeBadRequest(response);
        return;
      }
      events.push({
        method: "POST",
        path: "/api/login",
        username: "invalid@test.com",
      });
      payload.password = "";
      writeJson(response, 401, { error: "invalid credentials" });
      return;
    }

    writeBadRequest(response, 404);
  } finally {
    body.fill(0);
  }
}

const server = http.createServer((request, response) => {
  void handleRequest(request, response).catch(() => {
    if (!response.headersSent) {
      writeBadRequest(response, 500);
    } else {
      response.destroy();
    }
  });
});

function reportShutdown(exitCode = 0) {
  if (shutdownReported) return;
  shutdownReported = true;
  process.stdout.write(`${SHUTDOWN_LINE}\n`);
  process.exit(exitCode);
}

function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const forceTimer = setTimeout(() => {
    server.closeAllConnections?.();
    reportShutdown(0);
  }, 4_500);
  forceTimer.unref();
  server.close(() => {
    clearTimeout(forceTimer);
    reportShutdown(0);
  });
}

process.on("SIGTERM", shutdown);

server.once("error", () => {
  process.stderr.write("w0-login-fixture listen error\n");
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`${READY_LINE}\n`);
});
