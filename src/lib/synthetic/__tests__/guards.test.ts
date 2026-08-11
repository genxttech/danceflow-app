import { describe, expect, it } from "vitest";
import {
  assertIsConfiguredFixture,
  assertRecordWasCreatedByThisRun,
  assertSyntheticStudio,
} from "@/lib/synthetic/guards";
import { SyntheticSafetyError } from "@/lib/synthetic/types";
import type { SyntheticConfig } from "@/lib/synthetic/types";

const CONFIG: SyntheticConfig = {
  studioId: "11111111-1111-4111-8111-111111111111",
  supabaseUrl: "https://example.supabase.co",
  supabaseAnonKey: "anon-key",
  identities: {},
  eventFixture: null,
};

describe("assertSyntheticStudio", () => {
  it("passes when the resolved studio matches the configured synthetic tenant", () => {
    expect(() => assertSyntheticStudio(CONFIG, CONFIG.studioId, "test")).not.toThrow();
  });

  it("fails closed when the resolved studio does not match", () => {
    expect(() => assertSyntheticStudio(CONFIG, "22222222-2222-4222-8222-222222222222", "test")).toThrow(
      SyntheticSafetyError,
    );
  });

  it("fails closed when the resolved studio is null", () => {
    expect(() => assertSyntheticStudio(CONFIG, null, "test")).toThrow(SyntheticSafetyError);
  });

  it("fails closed when the resolved studio is undefined", () => {
    expect(() => assertSyntheticStudio(CONFIG, undefined, "test")).toThrow(SyntheticSafetyError);
  });

  it("uses the TENANT_MISMATCH error code", () => {
    try {
      assertSyntheticStudio(CONFIG, "wrong-studio", "test");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as SyntheticSafetyError).code).toBe("TENANT_MISMATCH");
    }
  });
});

describe("assertRecordWasCreatedByThisRun", () => {
  it("passes when the record id is present under the given table", () => {
    const refs = { clients: ["client-1", "client-2"] };
    expect(() => assertRecordWasCreatedByThisRun(refs, "clients", "client-1")).not.toThrow();
  });

  it("fails closed for a record id not present in created_record_refs", () => {
    const refs = { clients: ["client-1"] };
    expect(() => assertRecordWasCreatedByThisRun(refs, "clients", "some-other-client")).toThrow(
      SyntheticSafetyError,
    );
  });

  it("fails closed for a record id present under a DIFFERENT table than claimed", () => {
    const refs = { clients: ["record-1"], appointments: [] };
    expect(() => assertRecordWasCreatedByThisRun(refs, "appointments", "record-1")).toThrow(
      SyntheticSafetyError,
    );
  });

  it("fails closed when the table key is entirely absent from refs", () => {
    const refs = {};
    expect(() => assertRecordWasCreatedByThisRun(refs, "clients", "client-1")).toThrow(SyntheticSafetyError);
  });
});

describe("assertIsConfiguredFixture", () => {
  it("passes when the candidate id matches the configured fixture id", () => {
    expect(() => assertIsConfiguredFixture("event-1", "event-1", "test")).not.toThrow();
  });

  it("fails closed when the candidate id does not match", () => {
    expect(() => assertIsConfiguredFixture("event-1", "event-2", "test")).toThrow(SyntheticSafetyError);
  });
});
