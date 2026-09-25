import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Workspace packages such as the SDK resolve to source; Vitest appends its default conditions.
  resolve: {
    alias: {
      "@/components": fileURLToPath(new URL("./app/components", import.meta.url)),
      "@/hooks": fileURLToPath(new URL("./app/hooks", import.meta.url)),
      "@/lib": fileURLToPath(new URL("./app/lib", import.meta.url)),
      "@/ui": fileURLToPath(new URL("./app/components/ui", import.meta.url)),
    },
    conditions: ["@vektorprogrammet/source"],
  },
  ssr: { resolve: { conditions: ["@vektorprogrammet/source"] } },
  test: {
    include: ["app/**/*.test.ts", "test/**/*.test.ts", "workers/**/*.test.ts"],
  },
});
