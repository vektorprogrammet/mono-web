import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __BUILD_COMMIT__: JSON.stringify("0000000000000000000000000000000000000000"),
    __BUILD_CONTENT_DIGEST__: JSON.stringify(
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    ),
    __BUILD_ROUTE_DIGEST__: JSON.stringify(
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    ),
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
