import react from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fumadocsMdx } from "fumadocs-mdx/vite";
import { nitro } from "nitro/vite";

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
      spa: {
        enabled: true,
        prerender: {
          enabled: true,
          crawlLinks: true,
        },
      },

      pages: [
        {
          path: "/docs",
        },
        {
          path: "/api/search",
        },
        {
          path: "llms-full.txt",
        },
        {
          path: "llms.txt",
        },
      ],
    }),
    react(),
    // please see https://tanstack.com/start/latest/docs/framework/react/guide/hosting#nitro for guides on hosting
    nitro(),
  ],
  resolve: {
    tsconfigPaths: true,
    alias: {
      tslib: "tslib/tslib.es6.js",
    },
  },
});
