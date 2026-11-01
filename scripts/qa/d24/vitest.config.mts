import path from "node:path";
import { defineConfig } from "vitest/config";

// D24 acceptance suite: real route + real signatures + real Postgres (disposable container). Run via scripts/qa/d24-acceptance.sh.
const root = path.resolve(import.meta.dirname, "../../..");
export default defineConfig({
  root,
  test: {
    environment: "node",
    include: ["scripts/qa/d24/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(root, "./src"),
      "server-only": path.resolve(root, "./src/test/serverOnlyStub.ts"),
    },
  },
});
