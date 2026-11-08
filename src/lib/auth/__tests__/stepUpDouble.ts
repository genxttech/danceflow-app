/**
 * Test double for `@/lib/auth/platform-assurance` in suites that exercise a platform-admin server action but not session assurance itself.
 * It keeps the ROLE check real for that suite (whatever the suite mocked `requirePlatformAdmin` to do still applies) and skips only the MFA claims read.
 * Assurance behaviour is covered by platformAssurance.test.ts and the action coverage suite.
 *
 * Use: vi.mock("@/lib/auth/platform-assurance", async () => (await import("@/lib/auth/__tests__/stepUpDouble")).stepUpDouble());
 */
export async function stepUpDouble() {
  const { requirePlatformAdmin } = await import("@/lib/auth/platform");
  return { requirePlatformStepUp: async () => requirePlatformAdmin() };
}
