import { defineConfig } from "vitest/config";

// Harness self-tests only (never part of the application's test run: the default config includes src/**/*.test.ts only).
export default defineConfig({ test: { environment: "node", include: ["scripts/qa/selftest/*.test.ts"] } });
