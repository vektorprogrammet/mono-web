import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { dashboardMount } from "../dashboard/dashboard-base.ts";
import { DEV_CONTENT, DEV_ROUTE_CENSUS } from "./src/lib/dev-content.ts";
import {
  buildHomepageDigestInputs,
  computeContentDigest,
  computeRouteDigest,
} from "./vite-digests.ts";

const projectRoot = fileURLToPath(new URL("./", import.meta.url));

function buildCommit() {
  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  if (status.trim()) {
    throw new Error("Homepage build requires a clean git worktree");
  }

  const commit = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();

  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("Homepage build requires a full verified git commit SHA");
  }

  return commit;
}

export default defineConfig(({ command, isPreview }) => {
  const localDevelopment = command === "serve" && !isPreview;
  const commit = localDevelopment ? "working-tree" : buildCommit();

  const cloudflarePlugins =
    localDevelopment || process.env.ALCHEMY_CLOUDFLARE_VITE_INJECTED === "1"
      ? []
      : cloudflare({ viteEnvironment: { name: "ssr" } });

  const inputs = buildHomepageDigestInputs(projectRoot);
  const dashboardOrigin = localDevelopment ? process.env.OAUTH_DASHBOARD_ORIGIN : undefined;
  let dashboardLoginUrl = "/login?redirectTo=%2Fdashboard";

  if (dashboardOrigin) {
    const mount = dashboardMount(process.env);
    const loginUrl = new URL(`${mount}login`, dashboardOrigin);
    loginUrl.searchParams.set("redirectTo", "/");
    dashboardLoginUrl = loginUrl.href;
  }

  return {
    define: {
      "import.meta.env.HOMEPAGE_LOCAL_DEV": JSON.stringify(String(localDevelopment)),
      "import.meta.env.HOMEPAGE_DASHBOARD_LOGIN_URL": JSON.stringify(dashboardLoginUrl),
      __BUILD_COMMIT__: JSON.stringify(commit),
      __BUILD_CONTENT_DIGEST__: JSON.stringify(
        computeContentDigest(DEV_CONTENT, inputs.assetManifest),
      ),
      __BUILD_ROUTE_DIGEST__: JSON.stringify(computeRouteDigest(DEV_ROUTE_CENSUS, inputs)),
    },
    plugins: [...cloudflarePlugins, ...reactRouter(), tailwindcss()],
    build: {
      outDir: "./build",
    },
    server: {
      host: "127.0.0.1",
      port: Number(process.env.LOCAL_HOMEPAGE_PORT ?? "8787"),
      allowedHosts: ["p000.vektor.phibkro.org"],
      strictPort: true,
    },
    preview: {
      allowedHosts: ["p000.vektor.phibkro.org"],
    },
    resolve: {
      alias: {
        "~": "/src",
        "@/components": "/src/components",
        "@/hooks": "/src/hooks",
        "@/lib": "/src/lib",
        "@/ui": "/src/components/ui",
        "@/api": "/src/api",
      },
    },
  };
});
