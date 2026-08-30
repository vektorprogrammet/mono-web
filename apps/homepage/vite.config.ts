import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import { DEV_CONTENT, DEV_ROUTE_CENSUS } from "./src/lib/dev-content.ts";
import {
  buildHomepageDigestInputs,
  computeContentDigest,
  computeRouteDigest,
} from "./vite-digests.ts";

const projectRoot = fileURLToPath(new URL("./", import.meta.url));
const cloudflarePlugins =
  process.env.ALCHEMY_CLOUDFLARE_VITE_INJECTED === "1"
    ? []
    : cloudflare({ viteEnvironment: { name: "ssr" } });

function buildIdentity(): { commit: string; digest: string; routeDigest: string } {
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

  const inputs = buildHomepageDigestInputs(projectRoot);
  return {
    commit,
    digest: computeContentDigest(DEV_CONTENT, inputs.assetManifest),
    routeDigest: computeRouteDigest(DEV_ROUTE_CENSUS, inputs),
  };
}

const identity = buildIdentity();

export default defineConfig({
  define: {
    __BUILD_COMMIT__: JSON.stringify(identity.commit),
    __BUILD_CONTENT_DIGEST__: JSON.stringify(identity.digest),
    __BUILD_ROUTE_DIGEST__: JSON.stringify(identity.routeDigest),
  },
  plugins: [...cloudflarePlugins, ...reactRouter()],
  build: {
    outDir: "./build",
  },
  server: {
    allowedHosts: ["p000.vektor.phibkro.org"],
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
});
