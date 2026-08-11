import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetSyntheticConfigCacheForTests, loadSyntheticConfig } from "@/lib/synthetic/config";
import { SyntheticSafetyError } from "@/lib/synthetic/types";

/**
 * FlowOps quality/PRODUCTION-SYNTHETIC-TESTING.md safety requirement #1:
 * "Runner must fail closed if the target tenant is not the configured
 * synthetic tenant." Config loading is the first line of that guarantee --
 * an unconfigured or partially-configured harness must never start.
 */

const REQUIRED_BASE_ENV = {
  SYNTHETIC_STUDIO_ID: "11111111-1111-4111-8111-111111111111",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  SYNTHETIC_OWNER_EMAIL: "owner@synthetic.invalid",
  SYNTHETIC_OWNER_PASSWORD: "correct horse battery staple",
};

const SYNTHETIC_ENV_KEYS = [
  "SYNTHETIC_STUDIO_ID",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SYNTHETIC_OWNER_EMAIL",
  "SYNTHETIC_OWNER_PASSWORD",
  "SYNTHETIC_ORGANIZER_EMAIL",
  "SYNTHETIC_ORGANIZER_PASSWORD",
  "SYNTHETIC_STUDENT_EMAIL",
  "SYNTHETIC_STUDENT_PASSWORD",
  "SYNTHETIC_STUDENT_CLIENT_ID",
  "SYNTHETIC_EVENT_ID",
  "SYNTHETIC_EVENT_TICKET_TYPE_ID",
];

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of SYNTHETIC_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  __resetSyntheticConfigCacheForTests();
});

afterEach(() => {
  for (const key of SYNTHETIC_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  __resetSyntheticConfigCacheForTests();
});

function setEnv(overrides: Record<string, string> = {}) {
  Object.assign(process.env, REQUIRED_BASE_ENV, overrides);
}

describe("loadSyntheticConfig", () => {
  it("throws (fails closed) when SYNTHETIC_STUDIO_ID is missing", () => {
    setEnv();
    delete process.env.SYNTHETIC_STUDIO_ID;
    expect(() => loadSyntheticConfig()).toThrow(SyntheticSafetyError);
    try {
      loadSyntheticConfig();
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SyntheticSafetyError);
      expect((error as SyntheticSafetyError).code).toBe("CONFIG_MISSING");
    }
  });

  it("throws when Supabase connection details are missing", () => {
    setEnv();
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(() => loadSyntheticConfig()).toThrow(SyntheticSafetyError);
  });

  it("throws when no synthetic identity is configured at all", () => {
    setEnv();
    delete process.env.SYNTHETIC_OWNER_EMAIL;
    delete process.env.SYNTHETIC_OWNER_PASSWORD;
    expect(() => loadSyntheticConfig()).toThrow(/No synthetic identities configured/);
  });

  it("throws when an identity has an email but no password (partial config)", () => {
    setEnv({ SYNTHETIC_ORGANIZER_EMAIL: "organizer@synthetic.invalid" });
    expect(() => loadSyntheticConfig()).toThrow(SyntheticSafetyError);
    try {
      loadSyntheticConfig();
    } catch (error) {
      expect((error as SyntheticSafetyError).code).toBe("CONFIG_INCOMPLETE");
    }
  });

  it("throws when the student identity is missing SYNTHETIC_STUDENT_CLIENT_ID", () => {
    setEnv({
      SYNTHETIC_STUDENT_EMAIL: "student@synthetic.invalid",
      SYNTHETIC_STUDENT_PASSWORD: "hunter2-but-fake",
    });
    expect(() => loadSyntheticConfig()).toThrow(/SYNTHETIC_STUDENT_CLIENT_ID/);
  });

  it("throws when only one of SYNTHETIC_EVENT_ID / SYNTHETIC_EVENT_TICKET_TYPE_ID is set", () => {
    setEnv({ SYNTHETIC_EVENT_ID: "22222222-2222-4222-8222-222222222222" });
    expect(() => loadSyntheticConfig()).toThrow(SyntheticSafetyError);
  });

  it("loads a fully valid minimal config (owner identity only, no event fixture)", () => {
    setEnv();
    const config = loadSyntheticConfig();
    expect(config.studioId).toBe(REQUIRED_BASE_ENV.SYNTHETIC_STUDIO_ID);
    expect(config.identities.owner).toEqual({
      email: REQUIRED_BASE_ENV.SYNTHETIC_OWNER_EMAIL,
      password: REQUIRED_BASE_ENV.SYNTHETIC_OWNER_PASSWORD,
    });
    expect(config.identities.student).toBeUndefined();
    expect(config.eventFixture).toBeNull();
  });

  it("loads a fully configured config with all identities and the event fixture", () => {
    setEnv({
      SYNTHETIC_ORGANIZER_EMAIL: "organizer@synthetic.invalid",
      SYNTHETIC_ORGANIZER_PASSWORD: "organizer-pass",
      SYNTHETIC_STUDENT_EMAIL: "student@synthetic.invalid",
      SYNTHETIC_STUDENT_PASSWORD: "student-pass",
      SYNTHETIC_STUDENT_CLIENT_ID: "33333333-3333-4333-8333-333333333333",
      SYNTHETIC_EVENT_ID: "44444444-4444-4444-8444-444444444444",
      SYNTHETIC_EVENT_TICKET_TYPE_ID: "55555555-5555-4555-8555-555555555555",
    });
    const config = loadSyntheticConfig();
    expect(config.identities.owner).toBeDefined();
    expect(config.identities.organizer).toBeDefined();
    expect(config.identities.student).toEqual({
      email: "student@synthetic.invalid",
      password: "student-pass",
      clientId: "33333333-3333-4333-8333-333333333333",
    });
    expect(config.eventFixture).toEqual({
      eventId: "44444444-4444-4444-8444-444444444444",
      ticketTypeId: "55555555-5555-4555-8555-555555555555",
    });
  });

  it("caches the loaded config across calls until explicitly reset", () => {
    setEnv();
    const first = loadSyntheticConfig();
    process.env.SYNTHETIC_STUDIO_ID = "should-not-be-picked-up";
    const second = loadSyntheticConfig();
    expect(second).toBe(first);
    expect(second.studioId).toBe(REQUIRED_BASE_ENV.SYNTHETIC_STUDIO_ID);
  });
});
