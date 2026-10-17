import { afterAll, describe, expect, it } from "vitest";

const originalFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("validation network fence (scripts/tw4-validation/fence.ts)", () => {
  it("allows loopback always, Twilio registration hosts only for the real adapter, and nothing else", async () => {
    const { fenceAllows } = await import("../../../../../scripts/tw4-validation/fence");
    for (const url of ["http://127.0.0.1:55321/rest/v1/x", "http://localhost:1/", "http://[::1]:3/"]) {
      expect(fenceAllows(url, "fake")).toBe(true);
      expect(fenceAllows(url, "real")).toBe(true);
    }
    const twilio = ["https://trusthub.twilio.com/v1/Policies", "https://messaging.twilio.com/v1/a2p/BrandRegistrations", "https://api.twilio.com/2010-04-01/Accounts/AC.json"];
    for (const url of twilio) {
      expect(fenceAllows(url, "fake")).toBe(false);
      expect(fenceAllows(url, "real")).toBe(true);
    }
    for (const url of ["http://trusthub.twilio.com/v1/Policies", "https://trusthub.twilio.com.evil.example/", "https://evil.example/", "https://epdrtzcydvnoidwrepqz.supabase.co/rest/v1/x", "https://hvsujyfbftfffxpfmlpb.supabase.co/", "nope", "http://localhost.evil.com/"]) {
      expect(fenceAllows(url, "real")).toBe(false);
      expect(fenceAllows(url, "fake")).toBe(false);
    }
  });
  it("importing the fence replaces global fetch with a guard that throws for blocked hosts (fake mode) before any request is made", async () => {
    await import("../../../../../scripts/tw4-validation/fence");
    await expect(fetch("https://api.twilio.com/2010-04-01/Accounts/AC.json")).rejects.toThrow("network fence");
    await expect(fetch("https://example.com/")).rejects.toThrow("network fence");
  });
});

describe("stage-aware request fence (review P2-1: the S10 boundary is also enforced at the network layer)", () => {
  const P = "https://trusthub.twilio.com/v1";
  const BU = `BU${"a".repeat(32)}`;
  const AC = `AC${"1".repeat(32)}`;
  const post = (url: string, body = "") => ({ method: "POST", body });
  it("stage B: GETs and the draft-creating POSTs only", async () => {
    const { requestAllowed } = await import("../../../../../scripts/tw4-validation/fence");
    expect(requestAllowed(`${P}/Policies`, { method: "GET" }, "real", "B")).toBe(true);
    for (const url of [`${P}/CustomerProfiles`, `${P}/EndUsers`, `${P}/SupportingDocuments`, `${P}/CustomerProfiles/${BU}/EntityAssignments`, `${P}/CustomerProfiles/${BU}/Evaluations`, `https://api.twilio.com/2010-04-01/Accounts/${AC}/Addresses.json`]) {
      expect(requestAllowed(url, post(url, "FriendlyName=x"), "real", "B")).toBe(true);
    }
  });
  it("stage B can NEVER submit, create trust products or brands, or send a Status field - exactly the S11/T/B1 operations", async () => {
    const { requestAllowed } = await import("../../../../../scripts/tw4-validation/fence");
    const blocked: [string, string][] = [
      [`${P}/CustomerProfiles/${BU}`, "Status=pending-review"],
      [`${P}/CustomerProfiles/${BU}`, ""],
      [`${P}/TrustProducts`, "FriendlyName=x"],
      [`${P}/TrustProducts/${BU}`, "Status=pending-review"],
      [`${P}/TrustProducts/${BU}/EntityAssignments`, "ObjectSid=x"],
      ["https://messaging.twilio.com/v1/a2p/BrandRegistrations", "Mock=true"],
      [`${P}/CustomerProfiles`, "FriendlyName=x&Status=pending-review"],
      [`${P}/CustomerProfiles/${BU}/Evaluations`, "Status=pending-review"],
      [`${P}/CustomerProfiles/${BU}/EntityAssignments/extra`, "ObjectSid=x"],
      [`https://api.twilio.com/2010-04-01/Accounts/${AC}/Messages.json`, "Body=hi"],
    ];
    for (const [url, body] of blocked) expect(requestAllowed(url, post(url, body), "real", "B"), url).toBe(false);
    for (const method of ["PUT", "DELETE", "PATCH"]) expect(requestAllowed(`${P}/CustomerProfiles/${BU}`, { method }, "real", "B")).toBe(false);
  });
  it("stage C adds submission and the brand, but only pending-review as a Status value and only on the profile / trust product roots", async () => {
    const { requestAllowed } = await import("../../../../../scripts/tw4-validation/fence");
    expect(requestAllowed(`${P}/CustomerProfiles/${BU}`, post("", "Status=pending-review"), "real", "C")).toBe(true);
    expect(requestAllowed(`${P}/TrustProducts`, post("", "FriendlyName=x"), "real", "C")).toBe(true);
    expect(requestAllowed("https://messaging.twilio.com/v1/a2p/BrandRegistrations", post("", "Mock=true"), "real", "C")).toBe(true);
    expect(requestAllowed(`${P}/CustomerProfiles/${BU}`, post("", "Status=approved"), "real", "C")).toBe(false);
    for (const method of ["PUT", "DELETE", "PATCH"]) expect(requestAllowed(`${P}/CustomerProfiles/${BU}`, { method, body: "Status=pending-review" }, "real", "C")).toBe(false);
    expect(requestAllowed(`${P}/CustomerProfiles/${BU}/Evaluations`, post("", "Status=pending-review"), "real", "C")).toBe(false);
    expect(requestAllowed("https://api.twilio.com/2010-04-01/Accounts/AC/Messages.json", post("", "Body=x"), "real", "C")).toBe(false);
  });
  it("outside stages B and C (stage A, authorize-*, evidence, cleanup) there is no POST at all; the fake adapter reaches no Twilio host; loopback is untouched", async () => {
    const { requestAllowed } = await import("../../../../../scripts/tw4-validation/fence");
    for (const stage of ["", "A", "X"]) expect(requestAllowed(`${P}/CustomerProfiles`, post("", "FriendlyName=x"), "real", stage)).toBe(false);
    expect(requestAllowed(`${P}/Policies`, { method: "GET" }, "fake", "B")).toBe(false);
    expect(requestAllowed("http://127.0.0.1:55321/rest/v1/rpc/x", { method: "POST", body: "{}" }, "real", "")).toBe(true);
  });
  it("in real mode the ambient TWILIO_AUTH_TOKEN is removed from the environment when the fence loads (the harness never uses it)", async () => {
    const { vi } = await import("vitest");
    const savedArgv = process.argv;
    const savedFetch = globalThis.fetch;
    process.env.TWILIO_AUTH_TOKEN = "ambient-token-for-test";
    process.argv = [...savedArgv, "--adapter", "real", "--stages", "B"];
    vi.resetModules();
    try {
      const fence = await import("../../../../../scripts/tw4-validation/fence");
      expect(fence.ADAPTER_KIND).toBe("real");
      expect(fence.STAGE_ARG).toBe("B");
      expect(process.env.TWILIO_AUTH_TOKEN).toBeUndefined();
    } finally {
      process.argv = savedArgv;
      globalThis.fetch = savedFetch;
      delete process.env.TWILIO_AUTH_TOKEN;
      vi.resetModules();
    }
  });
});
