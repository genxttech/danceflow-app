import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { assertE2EBaseUrlIsSafe, E2ESafetyError } from "../src/lib/e2e/guards";
import { assertRunDirOutsideRepo } from "../src/lib/e2e/runDirGuard";

/**
 * P1 restricted-pilot browser run (production build, local stack only). Two projects, each against its OWN build:
 *   --project=walkthrough   app built with the three Competition flags on
 *   --project=flag-off      app built with none of them
 * Runbook: docs/competition/p1-browser-walkthrough.md. One worker, no retries (a retry would hide a flaky step).
 */
const rawBaseUrl = process.env.E2E_BASE_URL;
if (!rawBaseUrl) throw new E2ESafetyError("E2E_BASE_URL is required (see docs/competition/p1-browser-walkthrough.md).");
const baseUrl = assertE2EBaseUrlIsSafe(rawBaseUrl).origin;
// This run seeds accounts and events with a service key: this machine only, whatever the shared allow-lists say.
for (const [name, value] of [["E2E_BASE_URL", rawBaseUrl], ["E2E_SUPABASE_URL", process.env.E2E_SUPABASE_URL]] as const) {
  if (value && !["127.0.0.1", "localhost"].includes(new URL(value).hostname)) throw new E2ESafetyError(`${name} must be a loopback address for the P1 run.`);
}

const runDir = process.env.E2E_RUN_DIR;
if (!runDir) throw new E2ESafetyError("E2E_RUN_DIR is required: an artifact directory outside the repository.");
assertRunDirOutsideRepo(runDir, path.resolve(__dirname, ".."));

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 900_000,
  outputDir: `${runDir}/artifacts`,
  reporter: [
    ["list"],
    ["json", { outputFile: `${runDir}/results.json` }],
    ["html", { outputFolder: `${runDir}/html`, open: "never" }],
  ],
  // E2E_BROWSER_CHANNEL (for example "chrome") drives a browser already installed on this machine instead of Playwright's own download.
  use: { baseURL: baseUrl, trace: "on", screenshot: "on", video: "off", ...(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {}) },
  projects: [
    { name: "walkthrough", testMatch: /competition-p1-pilot-walkthrough\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "flag-off", testMatch: /competition-p1-flag-off-smoke\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
  ],
});
