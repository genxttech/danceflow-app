import path from "node:path";
import { defineConfig } from "vitest/config";

// PV-1: runs the F1 engine suites with the capture setup (see capture.setup.ts). Usage:
//   PV1_CAPTURE=<out.jsonl> node node_modules/vitest/vitest.mjs run --config scripts/qa/pv1/capture.vitest.mts
const root = path.resolve(import.meta.dirname, "../../..");

export default defineConfig({
  test: {
    root,
    environment: "node",
    include: ["src/lib/competition/results/engines/__tests__/**/*.test.ts", "src/lib/competition/results/__tests__/**/*.test.ts"],
    setupFiles: [path.resolve(import.meta.dirname, "capture.setup.ts")],
    fileParallelism: false,
    // The capture writes every engine call synchronously; property and determinism loops need far more than the default 5 s.
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(root, "src"),
      "server-only": path.resolve(root, "src/test/serverOnlyStub.ts"),
    },
  },
});
