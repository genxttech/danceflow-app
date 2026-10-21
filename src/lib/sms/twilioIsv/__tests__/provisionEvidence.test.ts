import { describe, expect, it, vi } from "vitest";
import { RunnerStoreError } from "../store";
import { FakeProvisioningAdapter } from "../fakeProvisioning";
import { ProvisionEvidenceStore, checkCampaignAbsence, listingDigest, type ListingFacts, type ListingResult } from "../provisionEvidence";

const ACC = `AC${"1".repeat(32)}`;
const MS = `MG${"2".repeat(32)}`;
const OP_CAMPAIGN = "c0000000-0000-4000-8000-000000000001";
const OP_OLD = "c0000000-0000-4000-8000-000000000002";
const OP_FREE = "c0000000-0000-4000-8000-000000000003";

type Op = { id: string; kind: string; status: string; fee_bearing: boolean; superseded: boolean; provider_sid: string | null };
const op = (over: Partial<Op>): Op => ({ id: OP_CAMPAIGN, kind: "campaign", status: "unknown_outcome", fee_bearing: true, superseded: false, provider_sid: null, ...over });

function setup(opts: { ops?: Op[]; account?: Partial<{ accountSid: string | null; status: string | null }>; claimError?: string; recordError?: string } = {}) {
  const calls: string[] = [];
  const store = {
    claim: vi.fn(async () => {
      calls.push("claim");
      if (opts.claimError) throw new RunnerStoreError(opts.claimError);
      return { onboarding_id: "o1", studio_id: "s1", state: "campaign_pending", submission_seq: 1 };
    }),
    getAccount: vi.fn(async () => ({ legalEntityId: "e1", accountSid: ACC, status: "active", ...(opts.account ?? {}) })),
    context: vi.fn(async () => ({ operations: opts.ops ?? [op({}), op({ id: "m", kind: "messaging_service", status: "succeeded", fee_bearing: false, provider_sid: MS })] })),
    release: vi.fn(async () => { calls.push("release"); }),
  };
  const recorded: { operationId: string; facts: ListingFacts; source: string; digest: string; leaseOwner: string }[] = [];
  const evidence = {
    recordListing: vi.fn(async (a: { operationId: string; facts: ListingFacts; source: "provider_read" | "fake"; digest: string; leaseOwner: string }): Promise<ListingResult> => {
      if (opts.recordError) throw new RunnerStoreError(opts.recordError);
      recorded.push(a);
      return { listing_id: "l1", verdict: a.facts.listed.length ? "present" : "absent", replayed: false, orphans: 0 };
    }),
  };
  const adapter = new FakeProvisioningAdapter(ACC);
  return { store, evidence, adapter, recorded, calls };
}
const run = (s: ReturnType<typeof setup>, now?: () => Date) =>
  checkCampaignAbsence({ store: s.store as never, evidence: s.evidence as unknown as ProvisionEvidenceStore, adapter: s.adapter, studioId: "s1", actorId: "a1", now });

describe("listingDigest", () => {
  const base: ListingFacts = { account_sid: ACC, scope_sid: MS, read_id: "r1", read_started_at: "2026-10-21T12:00:00.000Z", complete: true, listed: [`QE${"a".repeat(32)}`, `QE${"b".repeat(32)}`] };
  it("is stable, order-insensitive for the listing, and changes with any fact", () => {
    expect(listingDigest(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(listingDigest(base)).toBe(listingDigest({ ...base, listed: [...base.listed].reverse() }));
    for (const change of [{ account_sid: `AC${"9".repeat(32)}` }, { scope_sid: `MG${"9".repeat(32)}` }, { read_id: "r2" }, { read_started_at: "2026-10-21T12:00:01.000Z" }, { complete: false }, { listed: [] }]) {
      expect(listingDigest({ ...base, ...change })).not.toBe(listingDigest(base));
    }
  });
});

describe("checkCampaignAbsence: GET-only, lease-bound, and it never decides", () => {
  it("records exactly what one fresh complete listing says, once per fee-bearing campaign operation, then releases the lease", async () => {
    const s = setup();
    const out = await run(s);
    expect(out).toEqual({ outcome: "recorded", results: [{ operationId: OP_CAMPAIGN, verdict: "absent", orphans: 0 }] });
    expect(s.recorded).toHaveLength(1);
    expect(s.recorded[0].source).toBe("fake");
    expect(s.recorded[0].facts).toMatchObject({ account_sid: ACC, scope_sid: MS, complete: true, listed: [] });
    expect(s.recorded[0].digest).toBe(listingDigest(s.recorded[0].facts));
    expect(s.recorded[0].leaseOwner).toMatch(/^prov-evidence-/);
    expect(s.adapter.calls.map((c) => c.method)).toEqual(["findCampaigns"]); // no create, no cancel, nothing paid
    expect(s.calls).toEqual(["claim", "release"]);
  });

  it("reports a provider-listed campaign as listed (the database turns it into a verdict and, if unknown to the ledger, an orphan)", async () => {
    const s = setup();
    s.adapter.campaigns.set(`QE${"c".repeat(32)}`, { sid: `QE${"c".repeat(32)}`, account_sid: ACC, messaging_service_sid: MS } as never);
    const out = await run(s);
    expect(out).toMatchObject({ outcome: "recorded", results: [{ verdict: "present" }] });
    expect(s.recorded[0].facts.listed).toEqual([`QE${"c".repeat(32)}`]);
  });

  it("takes each read freshly: two operations are two reads with distinct read ids", async () => {
    const s = setup({ ops: [op({}), op({ id: OP_OLD, status: "abandoned" }), op({ id: "m", kind: "messaging_service", status: "succeeded", fee_bearing: false, provider_sid: MS })] });
    await run(s);
    expect(s.adapter.count("findCampaigns")).toBe(2);
    expect(new Set(s.recorded.map((r) => r.facts.read_id)).size).toBe(2);
  });

  it("a closed (abandoned or failed) fee operation is still checked: a late-found resource must not be missed; succeeded and free operations are not", async () => {
    const s = setup({ ops: [op({ status: "abandoned" }), op({ id: OP_OLD, status: "failed" }), op({ id: "x1", status: "succeeded" }), op({ id: OP_FREE, kind: "messaging_service", fee_bearing: false, status: "unknown_outcome" }), op({ id: "m", kind: "messaging_service", status: "succeeded", fee_bearing: false, provider_sid: MS })] });
    const out = await run(s);
    expect(out).toMatchObject({ outcome: "recorded" });
    expect(s.recorded.map((r) => r.operationId).sort()).toEqual([OP_CAMPAIGN, OP_OLD].sort());
  });

  it("refuses an adapter that is not the studio's own active subaccount BEFORE any provider call", async () => {
    for (const account of [{ accountSid: `AC${"9".repeat(32)}` }, { status: "suspended" }, { accountSid: null }]) {
      const s = setup({ account });
      expect(await run(s)).toEqual({ outcome: "account_mismatch" });
      expect(s.adapter.calls).toHaveLength(0);
      expect(s.recorded).toHaveLength(0);
      expect(s.calls).toEqual(["claim", "release"]);
    }
  });

  it("nothing to check without a live Messaging Service or a fee-bearing campaign operation", async () => {
    expect(await run(setup({ ops: [op({})] }))).toEqual({ outcome: "nothing_to_check" });
    expect(await run(setup({ ops: [op({ id: "m", kind: "messaging_service", status: "succeeded", fee_bearing: false, provider_sid: MS })] }))).toEqual({ outcome: "nothing_to_check" });
  });

  it("a failed provider read is NOT evidence either way: nothing is recorded and the caller retries", async () => {
    const s = setup();
    s.adapter.failNext("findCampaigns", { kind: "transient" });
    expect(await run(s)).toEqual({ outcome: "retry_later", detail: "listing_failed" });
    expect(s.recorded).toHaveLength(0);
    expect(s.calls).toEqual(["claim", "release"]);
  });

  it("lease problems and database refusals are reported with the SQLSTATE only", async () => {
    expect(await run(setup({ claimError: "55P03" }))).toEqual({ outcome: "lease_busy", detail: "55P03" });
    expect(await run(setup({ claimError: "TW030" }))).toEqual({ outcome: "not_runnable", detail: "TW030" });
    const refused = setup({ recordError: "TW046" });
    expect(await run(refused)).toEqual({ outcome: "record_failed", detail: "TW046" });
    expect(refused.calls).toEqual(["claim", "release"]);
  });

  it("uses the injected clock for the read start (the database still decides what counts)", async () => {
    const s = setup();
    await run(s, () => new Date("2026-10-21T10:00:00.000Z"));
    expect(s.recorded[0].facts.read_started_at).toBe("2026-10-21T10:00:00.000Z");
  });
});
