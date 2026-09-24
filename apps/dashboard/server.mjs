/** Production server: credentials never enter access logs; browser assets and SSR share one entrypoint. */
import { nativeDashboardRecoveryMode } from "./app/server/native-account-mode.server.ts";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequestHandler } from "react-router";
import * as build from "./build/server/index.js";

nativeDashboardRecoveryMode(process.env);

const configuredApiUrl = process.env.API_URL;

if (configuredApiUrl === undefined || configuredApiUrl.trim() === "")
  throw new Error("API_URL is required");

const apiOrigin = new URL(configuredApiUrl);

if (
  apiOrigin.username !== "" ||
  apiOrigin.password !== "" ||
  apiOrigin.pathname !== "/" ||
  apiOrigin.search !== "" ||
  apiOrigin.hash !== ""
)
  throw new Error("API_URL must be an origin without credentials, path, query, or fragment");

const handler = createRequestHandler(build, "production");

const clientRoot = fileURLToPath(new URL("./build/client/", import.meta.url));

const mount = build.basename;

if (process.env.DASHBOARD_MOUNT !== undefined && process.env.DASHBOARD_MOUNT !== mount)
  throw new Error("Dashboard mount does not match built artifact");

if (mount !== "/" && mount !== "/dashboard/") throw new Error("Invalid dashboard mount");

const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? "3000"),
  fetch: async (request) => {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      try {
        const upstreamUrl = new URL(`${pathname}${url.search}`, apiOrigin);

        return await fetch(new Request(upstreamUrl, request), { redirect: "manual" });
      } catch (cause) {
        process.stderr.write(
          `Dashboard API proxy failed: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`,
        );

        return new Response("Tjenesten er midlertidig utilgjengelig.", {
          status: 503,
          headers: { "cache-control": "no-store" },
        });
      }
    }

    const assetPath =
      mount !== "/" && pathname.startsWith(mount) ? pathname.slice(mount.length - 1) : pathname;

    let filePath;

    try {
      filePath = resolve(clientRoot, `.${decodeURIComponent(assetPath)}`);
    } catch {
      return new Response(null, { status: 400 });
    }

    if (
      (request.method === "GET" || request.method === "HEAD") &&
      filePath.startsWith(clientRoot) &&
      (await stat(filePath).catch(() => null))?.isFile()
    ) {
      const file = Bun.file(filePath);

      return new Response(request.method === "HEAD" ? null : file, {
        headers: {
          "content-type": file.type,
          "cache-control": assetPath.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        },
      });
    }

    try {
      return await handler(request);
    } catch (cause) {
      process.stderr.write(
        `Dashboard request failed: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`,
      );

      return new Response("Tjenesten er midlertidig utilgjengelig.", {
        status: 503,
        headers: { "cache-control": "no-store" },
      });
    }
  },
});

process.stdout.write(`Dashboard listening on ${server.hostname}:${server.port}\n`);
