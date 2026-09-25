import { createReadStream, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { reactRouter } from "@react-router/dev/vite";
import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin, AliasOptions, ServerOptions } from "vite";
import { dashboardMount } from "./dashboard-base.ts";

const defaultProfileImagePath = fileURLToPath(
  new URL("./assets/images/defaultProfile.png", import.meta.url),
);

const defaultProfileImage = (): Plugin => ({
  name: "default-profile-image",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url?.split("?")[0] !== "/images/defaultProfile.png") return next();
      response.setHeader("Content-Type", "image/png");
      createReadStream(defaultProfileImagePath).on("error", next).pipe(response);
    });
  },
  generateBundle() {
    this.emitFile({
      type: "asset",
      fileName: "images/defaultProfile.png",
      source: readFileSync(defaultProfileImagePath),
    });
  },
});

export const previewDevtoolsBuildEnabled = (
  command: "build" | "serve",
  environment: NodeJS.ProcessEnv,
): boolean => command === "serve" || environment.VITE_PREVIEW_DEVTOOLS === "true";

export default defineConfig(({ command }) => {
  const alias: AliasOptions = {
    "@/components": "/app/components",
    "@/hooks": "/app/hooks",
    "@/lib": "/app/lib",
    "@/ui": "/app/components/ui",
  };

  const rehearsalSdk = process.env.ORGANIZATION_IMPORT_REHEARSAL_SDK_EFFECT_PATH;

  if (rehearsalSdk !== undefined) alias["@vektorprogrammet/sdk/effect"] = rehearsalSdk;

  const server: ServerOptions = {
    host: "127.0.0.1",
    port: Number(process.env.LOCAL_DASHBOARD_PORT ?? 5173),
    strictPort: true,
  };

  if (process.env.API_URL) server.proxy = { "/api": { target: process.env.API_URL } };

  return {
    base: dashboardMount(process.env),
    // Local serve enables devtools; builds require the explicit preview flag.
    define: {
      "import.meta.env.VITE_PREVIEW_DEVTOOLS": JSON.stringify(
        previewDevtoolsBuildEnabled(command, process.env) ? "true" : "false",
      ),
    },
    plugins: [reactRouter(), foldkit(), tailwindcss(), defaultProfileImage()],
    // Workspace packages such as the SDK resolve to source; the plugins append Vite's default conditions.
    resolve: { alias, conditions: ["@vektorprogrammet/source"] },
    ssr: { resolve: { conditions: ["@vektorprogrammet/source"] } },
    server,
  };
});
