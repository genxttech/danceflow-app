import { describe, expect, it } from "vitest";
import { generateSyntheticRunId, isValidSyntheticRunId, syntheticTag } from "@/lib/synthetic/runId";

describe("generateSyntheticRunId", () => {
  it("produces ids prefixed with syn_", () => {
    expect(generateSyntheticRunId()).toMatch(/^syn_/);
  });

  it("produces ids that pass isValidSyntheticRunId", () => {
    expect(isValidSyntheticRunId(generateSyntheticRunId())).toBe(true);
  });

  it("produces distinct ids across calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateSyntheticRunId()));
    expect(ids.size).toBe(50);
  });
});

describe("isValidSyntheticRunId", () => {
  it("rejects a bare uuid without the syn_ prefix", () => {
    expect(isValidSyntheticRunId("11111111-1111-4111-8111-111111111111")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidSyntheticRunId("")).toBe(false);
  });

  it("rejects a run id with the prefix but a malformed uuid", () => {
    expect(isValidSyntheticRunId("syn_not-a-uuid")).toBe(false);
  });
});

describe("syntheticTag", () => {
  it("embeds the run id in a recognizable bracketed tag", () => {
    const runId = "syn_11111111-1111-4111-8111-111111111111";
    expect(syntheticTag(runId)).toBe(`[synthetic-test:${runId}]`);
  });
});
