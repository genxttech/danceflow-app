import { describe, expect, it, afterEach } from "vitest";
import { E2ESafetyError, assertE2EBaseUrlIsSafe } from "@/lib/e2e/guards";

describe("assertE2EBaseUrlIsSafe", () => {
  afterEach(() => {
    delete process.env.E2E_ALLOW_HOSTS;
  });

  it("accepts localhost", () => {
    expect(() => assertE2EBaseUrlIsSafe("http://localhost:3000")).not.toThrow();
  });

  it("accepts 127.0.0.1", () => {
    expect(() => assertE2EBaseUrlIsSafe("http://127.0.0.1:3000")).not.toThrow();
  });

  it("rejects a production-shaped *.vercel.app URL by default -- production deployments get one too", () => {
    // This is the real address a "Production - danceflow-app-qfem" deployment
    // has actually had in this project's own deployment history -- Vercel
    // assigns every deployment a *.vercel.app address, preview and
    // production alike, so this must never be built-in-safe by hostname
    // shape alone.
    expect(() =>
      assertE2EBaseUrlIsSafe("https://danceflow-app-qfem-nmulhlxcm-dance-flow.vercel.app"),
    ).toThrow(E2ESafetyError);
  });

  it("rejects an arbitrary *.vercel.app host by default (no blanket trust for the whole suffix)", () => {
    expect(() =>
      assertE2EBaseUrlIsSafe("https://danceflow-app-abc123-dance-flow.vercel.app"),
    ).toThrow(E2ESafetyError);
  });

  it("accepts a specific non-production *.vercel.app host only when explicitly listed in E2E_ALLOW_HOSTS", () => {
    const previewHost = "danceflow-app-abc123-dance-flow.vercel.app";

    expect(() => assertE2EBaseUrlIsSafe(`https://${previewHost}`)).toThrow(E2ESafetyError);

    process.env.E2E_ALLOW_HOSTS = previewHost;
    expect(() => assertE2EBaseUrlIsSafe(`https://${previewHost}`)).not.toThrow();

    // Allowing this one exact preview host does not implicitly allow a
    // different *.vercel.app host -- the allowlist is per-hostname, not
    // per-suffix.
    expect(() =>
      assertE2EBaseUrlIsSafe("https://some-other-deployment-xyz789.vercel.app"),
    ).toThrow(E2ESafetyError);
  });

  it("rejects an arbitrary unrecognized host by default (fails closed)", () => {
    expect(() => assertE2EBaseUrlIsSafe("https://some-other-host.example.com")).toThrow(
      E2ESafetyError,
    );
  });

  it("rejects a malformed URL", () => {
    expect(() => assertE2EBaseUrlIsSafe("not-a-url")).toThrow(E2ESafetyError);
  });

  it("rejects the known production domain idanceflow.com", () => {
    expect(() => assertE2EBaseUrlIsSafe("https://idanceflow.com")).toThrow(E2ESafetyError);
  });

  it("rejects the known production domain www.idanceflow.com", () => {
    expect(() => assertE2EBaseUrlIsSafe("https://www.idanceflow.com/events/foo")).toThrow(
      E2ESafetyError,
    );
  });

  it("still rejects idanceflow.com even if it is explicitly listed in E2E_ALLOW_HOSTS", () => {
    process.env.E2E_ALLOW_HOSTS = "idanceflow.com";
    expect(() => assertE2EBaseUrlIsSafe("https://idanceflow.com")).toThrow(E2ESafetyError);
  });

  it("accepts an otherwise-unrecognized host when explicitly listed in E2E_ALLOW_HOSTS", () => {
    process.env.E2E_ALLOW_HOSTS = "danceflow-staging.internal";
    expect(() =>
      assertE2EBaseUrlIsSafe("https://danceflow-staging.internal"),
    ).not.toThrow();
  });

  it("E2E_ALLOW_HOSTS matching is case-insensitive and trims whitespace", () => {
    process.env.E2E_ALLOW_HOSTS = " Danceflow-Staging.Internal , other.example ";
    expect(() =>
      assertE2EBaseUrlIsSafe("https://danceflow-staging.internal"),
    ).not.toThrow();
  });
});
