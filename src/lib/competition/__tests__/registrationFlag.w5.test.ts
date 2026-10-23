import { afterEach, describe, expect, it, vi } from "vitest";
import { isCompetitionRegistrationEnabled } from "../registrationFlag";

/**
 * W-5: the public event page and the register route share this helper, so the event page only links to
 * /competition/register when the route itself would render (source guards live in workspace.phase10b and
 * registrationIsolation.phase10c5).
 */

const FLAG = "NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isCompetitionRegistrationEnabled", () => {
  it("is true only for the exact string 'true'", () => {
    vi.stubEnv(FLAG, "true");
    expect(isCompetitionRegistrationEnabled()).toBe(true);
    for (const value of ["false", "TRUE", "1", ""]) {
      vi.stubEnv(FLAG, value);
      expect(isCompetitionRegistrationEnabled()).toBe(false);
    }
  });
});
