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

type Target = { operation_id: string; status: string; twilio_account_sid: string; scope_sid: string | null; ok: boolean; reason: string | null };
const OLD_MS = `MG${"3".repeat(32)}`;
const targetOf = (o: Op, over: Partial<Target> = {}): Target => ({ operation_id: o.id, status: o.status, twilio_account_sid: ACC, scope_sid: MS, ok: true, reason: null, ...over });

function setup(opts: { ops?: Op[]; targets?: Target[]; targetsError?: string; account?: Partial<{ accountSid: string | null; status: string | null }>; claimError?: string; recordError?: string } = {}) {
  const calls: string[] = [];
  const store = {
    getAccount: vi.fn(async () => ({ legalEntityId: "e1", accountSid: ACC, status: "active", ...(opts.account ?? {}) })),
    context: vi.fn(async () => ({ operations: opts.ops ?? [op({}), op({ id: "m", kind: "messaging_service", status: "succeeded", fee_bearing: false, provider_sid: MS })] })),
    release: vi.fn(async () => { calls.push("release"); }),
  };
  const recorded: { operationId: string; facts: ListingFacts; source: string; digest: string; leaseOwner: string }[] = [];
  const ops = opts.ops ?? [op({}), op({ id: "m", kind: "messaging_service", status: "succeeded", fee_bearing: false, provider_sid: MS })];
  const evidence = {
    // the database answers per operation from its OWN recorded account and Messaging Service (never the studio's current service)
    targets: vi.fn(async () => {
      if (opts.targetsError) throw new RunnerStoreError(opts.targetsError);
      return opts.targets ?? ops.filter((o) => o.kind === "campaign" && o.fee_bearing && ["unknown_outcome", "in_flight", "abandoned", "failed"].includes(o.status)).map((o) => targetOf(o));
    }),
    // the evidence-only lease works in any non-cancelled state, including `exception` (where an unknown fee outcome parks the onboarding)
    claim: vi.fn(async () => {
      calls.push("claim");
      if (opts.claimError) throw new RunnerStoreError(opts.claimError);
      return { onboarding_id: "o1", studio_id: "s1", state: "exception", submission_seq: 1 };
    }),
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

  it("nothing to check without a fee-bearing campaign operation that still matters", async () => {
    expect(await run(setup({ ops: [op({ id: "m", kind: "messaging_service", status: "succeeded", fee_bearing: false, provider_sid: MS })] }))).toEqual({ outcome: "nothing_to_check" });
    expect(await run(setup({ ops: [op({ status: "succeeded" })] }))).toEqual({ outcome: "nothing_to_check" });
  });

  describe("the operation's OWN account and Messaging Service decide what is read and recorded (never the studio's current service)", () => {
    it("after a Messaging Service replacement the read and the record use the service the operation was registered under", async () => {
      // the studio's CURRENT service is MS (store context), the operation was registered under OLD_MS
      const s = setup({ targets: [targetOf(op({}), { scope_sid: OLD_MS })] });
      s.adapter.campaigns.set(`QE${"c".repeat(32)}`, { sid: `QE${"c".repeat(32)}`, account_sid: ACC, messaging_service_sid: OLD_MS } as never);
      s.adapter.campaigns.set(`QE${"d".repeat(32)}`, { sid: `QE${"d".repeat(32)}`, account_sid: ACC, messaging_service_sid: MS } as never);
      const out = await run(s);
      expect(out).toMatchObject({ outcome: "recorded", results: [{ operationId: OP_CAMPAIGN, verdict: "present" }] });
      expect(s.recorded[0].facts.scope_sid).toBe(OLD_MS);
      expect(s.recorded[0].facts.listed).toEqual([`QE${"c".repeat(32)}`]); // only the original service's campaign; the new service's is not read
      expect(s.adapter.calls.filter((c) => c.method === "findCampaigns").map((c) => JSON.stringify(c.input))).toEqual([JSON.stringify({ messagingServiceSid: OLD_MS })]);
    });

    it("fails closed per operation: missing, unknown, ambiguous or malformed scope and a mismatching account read NOTHING and record NOTHING for that operation", async () => {
      const cases: Partial<Target>[] = [
        { ok: false, scope_sid: null, reason: "scope_missing" },
        { ok: false, scope_sid: null, reason: "scope_unknown" },
        { ok: false, scope_sid: null, reason: "scope_ambiguous" },
        { ok: false, scope_sid: null, reason: "account_mismatch" },
        { ok: true, scope_sid: null, reason: null }, // inconsistent answer
        { ok: true, scope_sid: "not-a-service", reason: null }, // malformed
        { ok: true, twilio_account_sid: `AC${"9".repeat(32)}` }, // the operation belongs to another subaccount than the adapter
      ];
      for (const over of cases) {
        const s = setup({ targets: [targetOf(op({}), over)] });
        const out = await run(s);
        expect(out).toMatchObject({ outcome: "scope_unavailable", skipped: [{ operationId: OP_CAMPAIGN }] });
        expect(s.adapter.calls).toHaveLength(0);
        expect(s.recorded).toHaveLength(0);
        expect(s.calls).toEqual(["claim", "release"]);
      }
    });

    it("one operation without a usable scope is skipped while the others are still recorded, and the skip is reported", async () => {
      const bad = op({ id: OP_OLD, status: "abandoned" });
      const s = setup({ targets: [targetOf(op({})), targetOf(bad, { ok: false, scope_sid: null, reason: "scope_missing" })] });
      const out = await run(s);
      expect(out).toMatchObject({ outcome: "recorded", results: [{ operationId: OP_CAMPAIGN }], skipped: [{ operationId: OP_OLD, reason: "scope_missing" }] });
      expect(s.recorded.map((r) => r.operationId)).toEqual([OP_CAMPAIGN]);
    });

    it("a refused or failed target query is reported (no provider call) and the lease is released", async () => {
      const s = setup({ targetsError: "TW030" });
      expect(await run(s)).toEqual({ outcome: "not_runnable", detail: "TW030" });
      expect(s.adapter.calls).toHaveLength(0);
      expect(s.calls).toEqual(["claim", "release"]);
    });

    it("the recorded facts name the OPERATION's account, not whatever the adapter reports", async () => {
      const s = setup();
      await run(s);
      expect(s.recorded[0].facts.account_sid).toBe(ACC);
    });
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
