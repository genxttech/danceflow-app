import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/qa/d24-m3d-proof/__tests__/**/*.test.ts", "scripts/qa/d24-test-provision/__tests__/**/*.test.ts", "scripts/qa/d24-test-runner/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "server-only": path.resolve(import.meta.dirname, "./src/test/serverOnlyStub.ts"),
    },
  },
});
