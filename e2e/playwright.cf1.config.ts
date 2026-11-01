import { defineConfig, devices } from "@playwright/test";
import { assertE2EBaseUrlIsSafe, E2ESafetyError } from "../src/lib/e2e/guards";

/**
 * CF1-C acceptance run configuration (stack cf1c-qa). Use with:
 *   npx playwright test -c e2e/playwright.cf1.config.ts
 *
 * Same fail-closed base-URL guard as the repo config. Evidence-first settings: trace and screenshots on for every
 * test, one worker (the suite is a serial walkthrough), no retries (a retry would hide a flaky step), and the JSON and
 * HTML reporters write into E2E_RUN_DIR, which must live OUTSIDE the repository (e.g. <scratchpad>/runs/<timestamp>/).
 */
const rawBaseUrl = process.env.E2E_BASE_URL;
if (!rawBaseUrl) throw new E2ESafetyError("E2E_BASE_URL is required (see docs/qa/competition-acceptance-harness.md). Refusing to default to any URL.");
const baseUrl = assertE2EBaseUrlIsSafe(rawBaseUrl).origin;

const runDir = process.env.E2E_RUN_DIR;
if (!runDir) throw new E2ESafetyError("E2E_RUN_DIR is required: an artifact directory outside the repository.");
if (/[\/]studioapp[\/]?$|[\/]studioapp-qa[\/]?$/.test(runDir.replace(/[\/]+$/, ""))) throw new E2ESafetyError("E2E_RUN_DIR must not be a repository root.");

export default defineConfig({
  testDir: "./tests",
  testMatch: /competition-cf1-(advancement|regression)-acceptance.spec.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 2_400_000,
  expect: { timeout: 60_000 },
  outputDir: `${runDir}/artifacts`,
  reporter: [
    ["list"],
    ["json", { outputFile: `${runDir}/results.json` }],
    ["html", { outputFolder: `${runDir}/html`, open: "never" }],
  ],
  use: {
    baseURL: baseUrl,
    actionTimeout: 90_000,
    trace: "on",
    screenshot: "on",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
