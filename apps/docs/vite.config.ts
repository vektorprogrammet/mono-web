import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fumadocsMdx } from "fumadocs-mdx/vite";
import { nitro } from "nitro/vite";

const routes = readFileSync(resolve(process.cwd(), "generated/routes.txt"), "utf8")
  .trimEnd()
  .split("\n");

export default defineConfig({
  // GitHub Pages serves the site at https://vektorprogrammet.github.io/mono-web/.
  base: "/mono-web/",
  server: {
    port: 3000,
  },
  plugins: [
    fumadocsMdx(),
    tailwindcss(),
    tanstackStart({
      router: {
        // The committed route tree skips Oxlint and Oxfmt by their configurations, so it needs no
        // blanket `eslint-disable`, which `just exceptions` rejects.
        routeTreeFileHeader: ["// @ts-nocheck", "// noinspection JSUnusedGlobalSymbols"],
      },
      // GitHub Pages has no rewrites, so every page is prerendered and no SPA shell is served.
      // The routes come from the same content scan and OpenAPI contract as the site.
      prerender: { enabled: true, crawlLinks: false, concurrency: 4, failOnError: true },
      pages: routes.map((path) => ({ path })),
    }),
    react(),
    // Shiki provides an inline WASM wrapper; Nitro's unwasm condition selects raw onig.wasm,
    // whose env import Rolldown cannot link. Use Shiki's default wrapper instead.
    nitro({ wasm: false }),
  ],
  resolve: {
    tsconfigPaths: true,
    alias: {
      tslib: "tslib/tslib.es6.js",
    },
  },
});
