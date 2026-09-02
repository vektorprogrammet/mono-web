import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@/components": fileURLToPath(new URL("./app/components", import.meta.url)),
      "@/hooks": fileURLToPath(new URL("./app/hooks", import.meta.url)),
      "@/lib": fileURLToPath(new URL("./app/lib", import.meta.url)),
      "@/ui": fileURLToPath(new URL("./app/components/ui", import.meta.url)),
    },
  },
  test: {
    include: ["app/**/*.test.ts"],
  },
});
