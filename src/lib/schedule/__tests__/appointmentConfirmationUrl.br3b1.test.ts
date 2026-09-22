import { afterEach, describe, expect, it, vi } from "vitest";
import { appointmentConfirmationSiteUrl } from "@/lib/schedule/appointmentConfirmation";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("appointmentConfirmationSiteUrl", () => {
  it("returns the canonical www origin in production, ignoring any site/app URL env vars", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://staging.example.com");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://also-not-canonical.example.com");
    expect(appointmentConfirmationSiteUrl()).toBe("https://www.idanceflow.com");
  });

  it("never returns the old apex-only fallback", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(appointmentConfirmationSiteUrl()).not.toBe("https://idanceflow.com");
  });
});
