import { createReadStream, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { reactRouter } from "@react-router/dev/vite";
import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const defaultProfileImagePath = fileURLToPath(
  new URL("../server/assets/images/defaultProfile.png", import.meta.url),
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

export default defineConfig({
  base: "/dashboard/",
  plugins: [reactRouter(), foldkit(), tailwindcss(), defaultProfileImage()],
  resolve: {
    alias: {
      "@/components": "/app/components",
      "@/hooks": "/app/hooks",
      "@/lib": "/app/lib",
      "@/ui": "/app/components/ui",
    },
  },
});
