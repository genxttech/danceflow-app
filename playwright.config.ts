import { defineConfig, devices } from "@playwright/test";
import { assertE2EBaseUrlIsSafe, E2ESafetyError } from "./src/lib/e2e/guards";

/**
 * Public Event Registration E2E Harness -- Slice 1.
 *
 * Isolated from the app's own dev/build config: this file lives at the
 * repo root only because that's where Playwright looks for it by default,
 * but testDir is scoped to ./e2e (outside src/), which vitest.config.mts's
 * `include: ["src/**\/*.test.ts"]` already can't reach -- the two suites
 * can never cross-run each other's files.
 *
 * Fails closed at config-load time, before any browser/test starts: no
 * E2E_BASE_URL, or one that isn't a recognized safe host, throws
 * immediately (see src/lib/e2e/guards.ts for the allowlist/blocklist
 * policy). There is no fallback to NEXT_PUBLIC_APP_URL/NEXT_PUBLIC_SITE_URL
 * or any other app runtime var -- this must be set explicitly every time.
 */
const rawBaseUrl = process.env.E2E_BASE_URL;
if (!rawBaseUrl) {
  throw new E2ESafetyError(
    "E2E_BASE_URL is required to run the Playwright E2E suite (see .env.e2e.example). Refusing to default to any URL, including production-shaped ones.",
  );
}
const baseUrl = assertE2EBaseUrlIsSafe(rawBaseUrl).origin;

export default defineConfig({
  testDir: "./e2e/tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: baseUrl,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
