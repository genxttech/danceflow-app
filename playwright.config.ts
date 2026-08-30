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
  // Slice 3: raised from Playwright's 30s default. Under full default
  // parallel execution, registration-failure-document-setup.spec.ts's real
  // (deliberately oversized) PDF render+upload is genuinely CPU/IO heavy
  // enough to visibly slow down every other concurrently-running test
  // against the same single local dev server process -- this is real
  // resource contention, not flakiness, and 30s isn't enough headroom for
  // it. That spec's own test additionally sets an even higher timeout for
  // itself, since its own work is slower still.
  timeout: 90_000,
  use: {
    baseURL: baseUrl,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      // Slice 3: registration-failure-document-setup.spec.ts's real (~20MB+)
      // PDF render+upload is heavy enough, CPU/IO-wise, to genuinely starve
      // the single local dev server process shared by every worker --
      // observed directly as real timeouts and a transient query failure in
      // *other*, unrelated, concurrently-running tests, not merely slowness
      // in that one test itself. Excluded here and run instead by the
      // dependent project below, which Playwright guarantees starts only
      // after every "chromium" test has finished -- so this suite's default
      // parallel execution stays genuinely parallel for everything else,
      // and this one heavy test never runs concurrently with anything.
      testIgnore: /registration-failure-document-setup\.spec\.ts/,
    },
    {
      // Note (independent pre-commit review, non-blocking recommendation):
      // Playwright's `dependencies` mechanism runs the entire dependency
      // project's test set as a prerequisite, not just tests related to
      // whatever file you asked for -- so even a targeted
      // `npx playwright test e2e/tests/registration-failure-document-setup.spec.ts`
      // still runs the full "chromium" project first. This is correct and
      // safe (no bypass, no accidental concurrency), but it means iterating
      // on this one heavy spec alone still costs the fast suite's runtime
      // too. There is no Playwright option to opt out of that per-invocation.
      name: "chromium-heavy-serial",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /registration-failure-document-setup\.spec\.ts/,
      dependencies: ["chromium"],
      fullyParallel: false,
    },
  ],
});
