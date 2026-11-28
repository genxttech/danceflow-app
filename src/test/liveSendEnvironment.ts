import { afterEach, beforeEach, vi } from "vitest";

/**
 * The older SMS sender calls the provider, and the dispatcher takes queued texts, only in the live production build. A test that asserts a send
 * (always against a mocked provider) declares that environment with this. Call it once, at the end of the test file.
 */
export function declareLiveSendEnvironment() {
  beforeEach(() => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NODE_ENV", "production");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
}
