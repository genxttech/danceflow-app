import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  ACTIVATION_FLASH_COOKIE, ACTIVATION_ITEM_LABELS, ACTIVATION_STATES, activate, activationCheck, activationDetailReason, activationErrorMessage, activationItemLabel,
  activationProviderReads, activationSenderReadProvider, checklistUnmetMessage, complianceReadRuntime, ki1Blocking, loadActivationOverview, parseUnmetItems, runComplianceValidation,
} from "../activation";

/** TW-4F J4: the console helpers in activation.ts. No database: the Supabase client is a scripted `rpc` stub. */

const STUDIO = "f0000001-0000-4000-8000-000000000001";
const ADMIN = "a6000000-0000-4000-8000-000000000004";
const AC = `AC${"1".repeat(32)}`;
const MG = `MG${"2".repeat(32)}`;
const QE = `QE${"3".repeat(32)}`;

type Reply = { data?: unknown; error?: { code?: string; message?: string } };
type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: Reply["error"] | null }>;
/** The scripted client, typed as the module's `rpc`-only client. */
const asClient = (rpc: Rpc) => ({ rpc }) as unknown as Parameters<typeof activationCheck>[0];
function client(replies: Record<string, Reply | (() => Reply)>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db = asClient(async (fn, args) => {
    calls.push({ fn, args });
    const r = replies[fn];
    const reply = typeof r === "function" ? r() : r;
    if (!reply) return { data: null, error: { code: "42883" } };
    return { data: reply.data ?? null, error: reply.error ?? null };
  });
  return Object.assign(db, { calls });
}

const KNOWN = [
  "subaccount_active", "service_ready", "campaign_verified", "number_owned", "number_attached", "sender_ready", "opt_out_attested", "compliance_passed",
  "rfl_ready", "inventory_reconciled", "inbound_route_pinned", "usage_reconciler_ready", "funding_continuity", "pilot_ki1_redecided",
];
const checkReply = (items = KNOWN.map((id) => ({ id, ok: true, detail: "ok" })), ready = true) => ({
  data: { state: "campaign_pending", items, ready, ledger: { account_sid: AC, messaging_service_sid: MG, campaign_sid: QE, phone_number_sid: null, e164: null, sender_id: null } },
});

describe("labels and reasons", () => {
  it("every known checklist id has its own label; an unknown id still gets a label that names it", () => {
    for (const id of KNOWN) expect(ACTIVATION_ITEM_LABELS[id]).toBeTruthy();
    expect(activationItemLabel("brand_new_item")).toContain("brand_new_item");
    expect(activationItemLabel("")).toContain("?");
  });

  it("maps every funding, pilot, reconciler and KI-1 detail; an unknown detail falls back by ok", () => {
    const details = [
      "pilot_current_period_unapproved", "pilot_number_not_registered", "pilot_campaign_not_registered", "pilot_resources_unconfirmed", "pilot_ceiling_exceeded",
      "pilot_standing_authorization_present", "credit_on_hold", "campaign_authorization_short_or_missing", "number_authorization_short_or_missing",
      "campaign_rent_unfunded", "number_rent_unfunded", "no_registration_path", "no_legal_entity",
      "reconciler_gate_not_installed", "reconciler_error", "reconciler_not_ready", "no_completed_run", "no_evidence_reads", "evidence_failing", "stale", "stuck_lease",
      "ki1_owner_redecision_pending:lifted_only_by_migration", "not_pilot",
    ];
    for (const d of details) expect(activationDetailReason(d, false)).not.toMatch(/^Not met \(see the code\)/);
    expect(activationDetailReason("ki1_owner_redecision_pending:lifted_only_by_migration", false)).toMatch(/No flag, switch or admin action/);
    expect(activationDetailReason("ki1_owner_redecision_pending:something_else", false)).toMatch(/later migration/);
    expect(activationDetailReason('rfl_blockers:["a","b"]', false)).toMatch(/blockers/);
    expect(activationDetailReason("mystery", false)).toBe("Not met (see the code).");
    expect(activationDetailReason("mystery", true)).toBe("Met.");
    expect(activationDetailReason("constructor", false)).toBe("Not met (see the code).");
  });

  it("KI-1 blocks only when the item is present and not ok", () => {
    expect(ki1Blocking([{ id: "pilot_ki1_redecided", ok: false, detail: "ki1_owner_redecision_pending:lifted_only_by_migration" }])).toBe(true);
    expect(ki1Blocking([{ id: "pilot_ki1_redecided", ok: true, detail: "not_pilot" }])).toBe(false);
    expect(ki1Blocking([])).toBe(false);
  });

  it("console constants", () => {
    expect(ACTIVATION_FLASH_COOKIE).toBe("tw4_activation_flash");
    expect([...ACTIVATION_STATES]).toEqual(["campaign_pending", "ready_for_activation", "active", "suspended"]);
  });
});

describe("TW042 parsing and error messages", () => {
  it("parses the unmet list, keeping commas inside a detail with the previous item", () => {
    const items = parseUnmetItems('activation checklist unmet: sender_ready:sender_not_verified_or_stale,rfl_ready:rfl_blockers:["x","y"],pilot_ki1_redecided:ki1_owner_redecision_pending:lifted_only_by_migration');
    expect(items).toEqual([
      { id: "sender_ready", detail: "sender_not_verified_or_stale" },
      { id: "rfl_ready", detail: 'rfl_blockers:["x","y"]' },
      { id: "pilot_ki1_redecided", detail: "ki1_owner_redecision_pending:lifted_only_by_migration" },
    ]);
  });

  it("anything without the prefix, or not a string, gives nothing; output is bounded and printable", () => {
    expect(parseUnmetItems("something else: a:b")).toEqual([]);
    expect(parseUnmetItems(undefined)).toEqual([]);
    const many = `activation checklist unmet: ${Array.from({ length: 50 }, (_, i) => `item_${i}:d\u0007${"x".repeat(300)}`).join(",")}`;
    const parsed = parseUnmetItems(many);
    expect(parsed.length).toBeLessThanOrEqual(30);
    for (const p of parsed) {
      expect(p.detail.length).toBeLessThanOrEqual(120);
      expect(p.detail).not.toMatch(/[\u0000-\u001f]/);
    }
  });

  it("maps each database code to a plain message and lists the unmet items for TW042", () => {
    expect(activationErrorMessage("42501")).toMatch(/Not authorized/);
    expect(activationErrorMessage("TW030")).toMatch(/onboarding state/);
    expect(activationErrorMessage("55P03")).toMatch(/lease/);
    expect(activationErrorMessage("TW041")).toMatch(/attestation/);
    expect(activationErrorMessage("TW044")).toMatch(/inbound route/);
    expect(activationErrorMessage("TW032")).toMatch(/not confirmed/);
    expect(activationErrorMessage("TW021")).toMatch(/sender row/);
    expect(activationErrorMessage("22023")).toMatch(/refused the input/);
    expect(activationErrorMessage("XX000")).toMatch(/Nothing changed/);
    const tw042 = activationErrorMessage("TW042", "activation checklist unmet: opt_out_attested:attestation_missing_or_stale");
    expect(tw042).toMatch(/^The activation checklist is not met\./);
    expect(tw042).toContain("Advanced Opt-Out is attested");
    expect(tw042).toContain("attestation_missing_or_stale");
    expect(activationErrorMessage("TW042", "garbage")).toBe("The activation checklist is not met. Nothing changed.");
    expect(tw042).toBe("The activation checklist is not met. 1 item unmet: Advanced Opt-Out is attested (within 30 days) (attestation_missing_or_stale). Nothing changed.");
  });

  it("TW042 summary: KI-1 first, at most 400 characters, 'Nothing changed.' always last, even with 30 maximal items", () => {
    const items = [
      ...Array.from({ length: 29 }, (_, i) => ({ id: `item_${i}_${"z".repeat(50)}`, detail: "d".repeat(120) })),
      { id: "pilot_ki1_redecided", detail: "ki1_owner_redecision_pending:lifted_only_by_migration" },
    ];
    const msg = checklistUnmetMessage(items);
    expect(msg.length).toBeLessThanOrEqual(400);
    expect(msg).toMatch(/^The activation checklist is not met\. KI-1 \(pilot ceiling double capture\) must be re-decided by the owner/);
    expect(msg).toContain("30 items unmet: Pilot ceiling issue KI-1");
    expect(msg.endsWith(" … Nothing changed.")).toBe(true);
    // without KI-1 there is no KI-1 line
    expect(checklistUnmetMessage([{ id: "sender_ready", detail: "sender_not_verified_or_stale" }])).not.toContain("KI-1");
  });
});

describe("database round trips", () => {
  it("a refusal keeps the database message for parsing; the actor and note are passed through", async () => {
    const db = client({ tw4_act_activate: { error: { code: "TW042", message: "activation checklist unmet: sender_ready:sender_not_verified_or_stale" } } });
    const res = await activate(db, STUDIO, ADMIN, "a note of enough length");
    expect(res).toEqual({ ok: false, code: "TW042", message: "activation checklist unmet: sender_ready:sender_not_verified_or_stale" });
    expect(db.calls).toEqual([{ fn: "tw4_act_activate", args: { p_studio_id: STUDIO, p_actor: ADMIN, p_note: "a note of enough length" } }]);
    // without a message the old shape is unchanged
    expect(await activate(client({ tw4_act_activate: { error: { code: "TW030" } } }), STUDIO, ADMIN, "x".repeat(10))).toEqual({ ok: false, code: "TW030" });
  });

  it("the overview degrades per studio to unavailable, never to ready", async () => {
    const other = "f0000002-0000-4000-8000-000000000001";
    const db = asClient(async (_fn, args) => (args.p_studio_id === STUDIO ? { data: checkReply().data, error: null } : { data: null, error: { code: "XX000" } }));
    const overview = await loadActivationOverview(db, ADMIN, [STUDIO, other]);
    expect(overview[other]).toBe("unavailable");
    expect(overview[STUDIO]).not.toBe("unavailable");
    expect((await activationCheck(client({ tw4_act_check: { data: "nonsense" } }), STUDIO, ADMIN)).ok).toBe(false);
  });

  it("compliance validation refuses an adapter of another account before any provider read or record", async () => {
    const db = client({ tw4_act_check: checkReply() });
    const adapter = { accountSid: `AC${"9".repeat(32)}`, evidenceSource: "fake", getCampaignCompliance: vi.fn(), getServiceRoute: vi.fn() };
    const res = await runComplianceValidation(db, adapter as never, { studioId: STUDIO, actorId: ADMIN, inboundUrl: "https://app.example/api/sms/twilio/inbound" });
    expect(res).toEqual({ ok: false, code: "account_mismatch" });
    expect(adapter.getCampaignCompliance).not.toHaveBeenCalled();
    expect(db.calls.map((c) => c.fn)).toEqual(["tw4_act_check"]);
  });
});

describe("provider reads are env-gated and off by default", () => {
  it("with no gates set, nothing is constructed: compliance and sender reads refuse", () => {
    const env = { NODE_ENV: "test" };
    const runtime = complianceReadRuntime(env);
    expect(runtime.ok).toBe(false);
    expect(activationSenderReadProvider(env)).toBeNull();
    const reads = activationProviderReads(env);
    expect(reads.compliance.enabled).toBe(false);
    expect(reads.sender.enabled).toBe(false);
    expect(reads.compliance.reason).toBeTruthy();
  });

  it("the local fake is used only where the existing fake gate allows it (non-production, TW4_ISV_FAKE=on, loopback database)", async () => {
    const remote = { NODE_ENV: "development", TW4_ISV_FAKE: "on", NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co" };
    expect(complianceReadRuntime(remote).ok).toBe(false);
    const local = { NODE_ENV: "development", TW4_ISV_FAKE: "on", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" };
    const runtime = complianceReadRuntime(local);
    expect(runtime.ok && runtime.mode).toBe("fake");
    if (runtime.ok) {
      const adapter = await runtime.adapterFor(AC);
      expect(adapter.accountSid).toBe(AC);
      expect(adapter.evidenceSource).toBe("fake");
      // narrowed at run time too: only the two GET reads and the identity are reachable, never search / purchase / attach / release
      expect(Object.keys(adapter).sort()).toEqual(["accountSid", "evidenceSource", "getCampaignCompliance", "getServiceRoute"]);
      expect("searchAvailableNumbers" in adapter || "listIncomingNumbers" in adapter).toBe(false);
      expect(Object.isFrozen(adapter)).toBe(true);
    }
    expect(activationProviderReads(local)).toEqual({ compliance: { enabled: true, reason: null }, sender: { enabled: true, reason: null } });
    expect(activationSenderReadProvider(local)?.isFake).toBe(true);
  });
});
