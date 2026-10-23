import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const redirects: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirects.push(url);
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const cookieWrites: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ set: (name: string, value: string) => cookieWrites.push({ name, value }), get: () => undefined }) }));

const ADMIN = "a6000000-0000-4000-8000-000000000f41";
let platformAdmin = true;
vi.mock("@/lib/auth/platform", () => ({
  requirePlatformAdmin: async () => {
    if (!platformAdmin) throw new Error("NOT_PLATFORM_ADMIN");
    return { id: ADMIN };
  },
}));

const rpc: { fn: string; args: Record<string, unknown> }[] = [];
let replies: Record<string, { data?: unknown; error?: { code?: string } }> = {};
let clientsBuilt = 0;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    clientsBuilt += 1;
    return {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpc.push({ fn, args });
        const r = replies[fn];
        if (!r) return { data: null, error: { code: "42883" } };
        return { data: r.data ?? null, error: r.error ?? null };
      },
    };
  },
}));
const runtime = { value: { ok: false, reason: "Twilio provisioning calls are switched off." } as unknown };
vi.mock("@/lib/sms/provisioning/evidenceRuntime", () => ({ buildEvidenceRuntime: () => runtime.value }));
const absence = vi.fn();
vi.mock("@/lib/sms/twilioIsv/provisionEvidence", async (orig) => ({ ...(await orig<typeof import("@/lib/sms/twilioIsv/provisionEvidence")>()), checkCampaignAbsence: (...a: unknown[]) => absence(...a) }));

import { parseDeferred, parseExposure, parseGaps, parseNumberLedger, type RecoveryOverview } from "@/lib/sms/provisioning/recoveryStore";
import { FEE_RELEASE_ENABLED, parseEvidence, parseLedger } from "@/lib/sms/provisioning/provisionLedger";
import { retireDeferredAction, retryRegistrationAction } from "../recoveryActions";
import { recordProviderListingAction } from "../provisioningActions";
import Recovery from "../Recovery";
import ExposureConsolidated from "../ExposureConsolidated";
import NumberLedger from "../NumberLedger";
import ProvisioningLedger from "../ProvisioningLedger";

const U = (n: number) => `f${String(n).padStart(7, "0")}-0000-4000-8000-000000000001`;
const STUDIO = U(1);
const OTHER_STUDIO = U(2);
const OP = U(3);
const PN = `PN${"a".repeat(32)}`;
const QE = `QE${"b".repeat(32)}`;
const NOTE = "Checked the provider console before retrying";

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
async function run(action: (f: FormData) => Promise<void>, fields: Record<string, string>) {
  await expect(action(form(fields))).rejects.toThrow("NEXT_REDIRECT");
  const flash = JSON.parse(cookieWrites[cookieWrites.length - 1].value) as { ok: boolean; message: string };
  return { url: redirects[redirects.length - 1], ...flash };
}
const writes = () => rpc.filter((c) => ["tw4_admin_registration_retry", "tw4_admin_deferred_retire", "tw4_prov_evidence_claim", "tw4_prov_listing_record"].includes(c.fn));

const gapsReply = { data: [{ kind: "campaign", studio_id: STUDIO, legal_entity_id: U(9), operation_id: OP, provider_sid: QE, e164: null, observed_at: "2026-10-22T10:00:00Z", last_failure_at: "2026-10-22T10:00:00Z", last_retry: null }] };
const deferredRow = (over: Record<string, unknown> = {}) => ({
  studio_id: STUDIO, legal_entity_id: U(9), resource_id: U(8), phone_number_sid: PN, e164: "+12025550100", cancelled_at: "2026-10-22T09:00:00Z", operations: [{ id: OP, kind: "number_purchase" }],
  sender_status: "released", deferral_alerted: true, blockers: { lease_held: false, operation_unresolved: false, sender_release_required: false }, ready: true, ...over,
});

beforeEach(() => {
  rpc.length = 0;
  redirects.length = 0;
  cookieWrites.length = 0;
  replies = {};
  clientsBuilt = 0;
  platformAdmin = true;
  absence.mockReset();
  runtime.value = { ok: false, reason: "Twilio provisioning calls are switched off." };
});

describe("recovery actions (platform admin only, session actor, re-verified ids)", () => {
  it("a non-administrator is refused before any database client is built", async () => {
    platformAdmin = false;
    await expect(retryRegistrationAction(form({ studioId: STUDIO, kind: "campaign", note: NOTE, confirm: "on" }))).rejects.toThrow("NOT_PLATFORM_ADMIN");
    await expect(retireDeferredAction(form({ studioId: STUDIO, phoneNumberSid: PN, note: NOTE, confirm: "on" }))).rejects.toThrow("NOT_PLATFORM_ADMIN");
    await expect(recordProviderListingAction(form({ studioId: STUDIO, operationId: OP, confirm: "on" }))).rejects.toThrow("NOT_PLATFORM_ADMIN");
    expect(clientsBuilt).toBe(0);
    expect(rpc).toHaveLength(0);
  });

  it("retry: the actor is the session administrator (never a form field), the reason is passed for audit, and success says no charge was taken", async () => {
    replies = { tw4_admin_registration_gaps: gapsReply, tw4_admin_registration_retry: { data: { outcome: "registered", resource_id: U(7), operation_id: OP } } };
    const out = await run(retryRegistrationAction, { studioId: STUDIO, kind: "campaign", note: NOTE, confirm: "on", actor: U(66), p_actor: U(66) });
    expect(out.ok).toBe(true);
    expect(out.url).toBe("/platform/sms?recovery=1#sms-recovery");
    expect(out.message).toMatch(/No charge was taken/);
    expect(writes()).toEqual([{ fn: "tw4_admin_registration_retry", args: { p_studio_id: STUDIO, p_actor: ADMIN, p_kind: "campaign", p_note: NOTE } }]);
    expect(cookieWrites[0].name).toBe("tw4_recovery_flash");
  });

  it("retry: a forged or stale studio id (not in the database's gap list) is refused without a write", async () => {
    replies = { tw4_admin_registration_gaps: gapsReply };
    for (const fields of [{ studioId: OTHER_STUDIO, kind: "campaign" }, { studioId: STUDIO, kind: "number" }, { studioId: "not-a-uuid", kind: "campaign" }, { studioId: STUDIO, kind: "brand" }]) {
      const out = await run(retryRegistrationAction, { ...fields, note: NOTE, confirm: "on" });
      expect(out.ok).toBe(false);
    }
    expect(writes()).toHaveLength(0);
  });

  it("retry: an unreadable gap list fails closed; a missing reason or confirmation is refused before any call", async () => {
    replies = { tw4_admin_registration_gaps: { error: { code: "XX000" } } };
    expect((await run(retryRegistrationAction, { studioId: STUDIO, kind: "campaign", note: NOTE, confirm: "on" })).ok).toBe(false);
    rpc.length = 0;
    expect((await run(retryRegistrationAction, { studioId: STUDIO, kind: "campaign", note: "short", confirm: "on" })).ok).toBe(false);
    expect((await run(retryRegistrationAction, { studioId: STUDIO, kind: "campaign", note: NOTE })).ok).toBe(false);
    expect(rpc).toHaveLength(0);
  });

  it("retry: a recorded refusal is shown as a failure that says the attempt was recorded (never as success)", async () => {
    replies = { tw4_admin_registration_gaps: gapsReply, tw4_admin_registration_retry: { data: { outcome: "refused", code: "TW040" } } };
    const out = await run(retryRegistrationAction, { studioId: STUDIO, kind: "campaign", note: NOTE, confirm: "on" });
    expect(out.ok).toBe(false);
    expect(out.url).toContain("recovery_error=1");
    expect(out.message).toMatch(/recorded/);
  });

  it("deferred retire: only a listed, ready entry is attempted; a required sender release is refused before the call", async () => {
    replies = { tw4_admin_deferred_retirements: { data: [deferredRow({ sender_status: "revoked", ready: false, blockers: { lease_held: false, operation_unresolved: false, sender_release_required: true } })] } };
    let out = await run(retireDeferredAction, { studioId: STUDIO, phoneNumberSid: PN, note: NOTE, confirm: "on" });
    expect(out.message).toMatch(/Release the studio's sender row/);
    out = await run(retireDeferredAction, { studioId: OTHER_STUDIO, phoneNumberSid: PN, note: NOTE, confirm: "on" });
    expect(out.ok).toBe(false);
    expect(writes()).toHaveLength(0);
    replies = { tw4_admin_deferred_retirements: { data: [deferredRow()] }, tw4_admin_deferred_retire: { data: { retired: true, replayed: false } } };
    out = await run(retireDeferredAction, { studioId: STUDIO, phoneNumberSid: PN, note: NOTE, confirm: "on" });
    expect(out.ok).toBe(true);
    expect(writes()).toEqual([{ fn: "tw4_admin_deferred_retire", args: { p_studio_id: STUDIO, p_phone_number_sid: PN, p_actor: ADMIN, p_note: NOTE } }]);
  });

  it("evidence console: provider reads switched off -> nothing recorded, no lease taken; never resolves or releases", async () => {
    replies = { tw4_prov_status: { data: { onboarding_id: U(5), state: "exception", operations: [{ id: OP, kind: "campaign", status: "unknown_outcome", fee_bearing: true, fee_kinds: ["campaign_vetting"] }] } } };
    const out = await run(recordProviderListingAction, { studioId: STUDIO, operationId: OP, confirm: "on" });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/not available here/);
    expect(writes()).toHaveLength(0);
    expect(rpc.some((c) => c.fn === "tw4_prov_resolve" || c.fn === "tw4_prov_settle_admin")).toBe(false);
    expect(absence).not.toHaveBeenCalled();
  });

  it("evidence console: an operation outside the studio's ledger, or not an unresolved fee-bearing campaign, is refused", async () => {
    replies = { tw4_prov_status: { data: { onboarding_id: U(5), state: "exception", operations: [{ id: OP, kind: "messaging_service", status: "unknown_outcome", fee_bearing: false }] } } };
    expect((await run(recordProviderListingAction, { studioId: STUDIO, operationId: OP, confirm: "on" })).ok).toBe(false);
    expect((await run(recordProviderListingAction, { studioId: STUDIO, operationId: U(77), confirm: "on" })).ok).toBe(false);
    expect(writes()).toHaveLength(0);
  });

  it("evidence console: with the local fake, ONE listing is recorded through the shared absence check and the result says nothing was released", async () => {
    const adapter = { accountSid: `AC${"1".repeat(32)}`, evidenceSource: "fake" };
    runtime.value = { ok: true, mode: "fake", adapterFor: async () => adapter };
    replies = {
      tw4_prov_status: { data: { onboarding_id: U(5), state: "exception", operations: [{ id: OP, kind: "campaign", status: "unknown_outcome", fee_bearing: true, fee_kinds: ["campaign_vetting"] }] } },
      tw4_prov_evidence_claim: { data: { onboarding_id: U(5), studio_id: STUDIO, state: "exception", submission_seq: 1 } },
      tw4_runner_account: { data: { legal_entity_id: U(9), account_sid: adapter.accountSid, status: "active" } },
      tw4_runner_release: { data: null },
    };
    absence.mockResolvedValue({ outcome: "recorded", results: [{ operationId: OP, verdict: "premature", orphans: 0 }] });
    const out = await run(recordProviderListingAction, { studioId: STUDIO, operationId: OP, confirm: "on" });
    expect(out.ok).toBe(true);
    expect(out.message).toMatch(/this attempt: premature/);
    expect(out.message).toMatch(/no held fee was released/);
    expect(absence).toHaveBeenCalledTimes(1);
    expect((absence.mock.calls[0][0] as { actorId: string; studioId: string; adapter: unknown }).actorId).toBe(ADMIN);
    expect((absence.mock.calls[0][0] as { studioId: string }).studioId).toBe(STUDIO);
    expect(rpc.find((c) => c.fn === "tw4_prov_evidence_claim")?.args.p_actor).toBe(ADMIN);
    // #269: an attempt whose original scope cannot be established is skipped by the check; the console says so and never claims a listing
    absence.mockResolvedValue({ outcome: "recorded", results: [], skipped: [{ operationId: OP, reason: "scope_unknown" }] });
    const skipped = await run(recordProviderListingAction, { studioId: STUDIO, operationId: OP, confirm: "on" });
    expect(skipped.ok).toBe(false);
    expect(skipped.message).toMatch(/could not be established/);
    absence.mockResolvedValue({ outcome: "scope_unavailable", skipped: [{ operationId: OP, reason: "scope_unknown" }] });
    expect((await run(recordProviderListingAction, { studioId: STUDIO, operationId: OP, confirm: "on" })).message).toMatch(/could not be established/);
  });
});

describe("parsers (fail closed, unknown cost stays null)", () => {
  it("exposure: an unknown cost is null even if a number is present; a malformed answer throws", () => {
    const e = parseExposure({
      resources: [{ provider_sid: PN, resource_kind: "number", findings: [{ finding: "number_unknown" }], cost: { basis: "unknown", known: false, provider_billed_cents: 0 } }],
      aggregate: { resources: 1, numbers: 1, cost_unknown: 1, provider_billed_cents: null },
    });
    expect(e.resources[0].cost.providerBilledCents).toBeNull();
    expect(e.aggregate.providerBilledCents).toBeNull();
    expect(() => parseExposure({ resources: "x", aggregate: {} })).toThrow();
    expect(() => parseExposure({ resources: [{ provider_sid: PN }], aggregate: {} })).toThrow();
  });

  it("deferred: an unreadable blocker counts as present and the entry is not ready", () => {
    const [d] = parseDeferred([deferredRow({ blockers: {}, ready: true })]);
    expect(d.ready).toBe(false);
    expect(d.blockers.senderReleaseRequired).toBe(true);
  });

  it("gaps and number ledger reject malformed rows", () => {
    expect(() => parseGaps([{ kind: "brand", studio_id: STUDIO, operation_id: OP }])).toThrow();
    expect(parseNumberLedger(null)).toBeNull();
    expect(() => parseNumberLedger({ onboarding_id: U(5), state: "active", operations: [{ id: OP }] })).toThrow();
  });

  it("evidence: a pilot or unproven attempt is never reported as releasable", () => {
    const ev = parseEvidence([
      { operation_id: OP, listings: 2, proof: { ok: true, reason: "verified_absence" }, pilot: true, release_permitted_by_evidence: true },
      { operation_id: U(4), listings: 1, proof: { ok: false, reason: "need_two_independent_listings" }, pilot: false, release_permitted_by_evidence: true },
      { operation_id: U(6), listings: 2, proof: { ok: true, reason: "verified_absence" } },
    ]);
    expect(ev[OP].releasePermittedByEvidence).toBe(false);
    expect(ev[U(4)].releasePermittedByEvidence).toBe(false);
    expect(ev[U(6)].pilot).toBe(true);   // a missing pilot flag is treated as pilot
    expect(ev[U(6)].releasePermittedByEvidence).toBe(false);
  });
});

describe("rendering", () => {
  const overview = (over: Partial<RecoveryOverview> = {}): RecoveryOverview => ({
    exposure: parseExposure({
      resources: [
        { provider_sid: QE, resource_kind: "campaign", findings: [{ finding: "campaign_orphan" }], cost: { basis: "recorded", known: true, provider_billed_cents: 250, expected_provider_cents_estimate: 2000, in_rfl_exposure_report: true } },
        { provider_sid: PN, resource_kind: "number", findings: [{ finding: "number_unknown" }, { finding: "unregistered_ledger_resource" }], cost: { basis: "unknown", known: false } },
      ],
      aggregate: { resources: 2, campaigns: 1, numbers: 1, cost_unknown: 1, cost_recorded: 1, in_rfl_exposure_report: 1, provider_billed_cents: 250, expected_provider_cents_estimate: 2000 },
    }),
    gaps: parseGaps(gapsReply.data),
    deferred: parseDeferred([deferredRow({ ready: false, sender_status: "revoked", blockers: { lease_held: true, operation_unresolved: false, sender_release_required: true } })]),
    numberLedgers: { [STUDIO]: parseNumberLedger({ onboarding_id: U(5), state: "active", operations: [{ id: OP, kind: "number_purchase", status: "unknown_outcome", fee_bearing: true, attempt: 1 }] })! },
    ...over,
  });

  it("exposure shows each resource once, an unknown cost as unknown (never $0.00) and the overlap with the recurring-fee report", () => {
    const html = renderToStaticMarkup(createElement(ExposureConsolidated, { exposure: overview().exposure }));
    expect(html.match(/data-testid="exposure-row"/g)).toHaveLength(2);
    expect(html).toContain("unknown (no provider cost recorded)");
    expect(html).not.toContain("$0.00");
    expect(html).toContain("Do not add the two");
    expect(html).toMatch(/owners are never asked to authorize or pay/);
    expect(renderToStaticMarkup(createElement(ExposureConsolidated, { exposure: "unavailable" }))).toContain("Do not assume there is none");
  });

  it("the panel never asks an owner to authorize or pay; a blocked deferred retirement has no retire form", () => {
    const html = renderToStaticMarkup(createElement(Recovery, { overview: overview(), studioNames: { [STUDIO]: "Studio One" }, notice: null, error: null }));
    expect(html).toContain("Platform administrators only");
    expect(html).toContain("Retry registration");
    expect(html).not.toContain("Retire from the number ledger");
    expect(html).toContain("sender row for this number must be released first");
    expect(html).not.toMatch(/authorize (this|the) (payment|charge)|pay (now|for this)|approve (the|this) (charge|payment)/i);
    expect(html).not.toMatch(/name="(actor|p_actor|actorId)"/);
  });

  it("unreadable lists are shown as unreadable, never as empty", () => {
    const html = renderToStaticMarkup(createElement(Recovery, { overview: overview({ gaps: "unavailable", deferred: "unavailable", exposure: "unavailable" }), studioNames: {}, notice: null, error: null }));
    expect(html.match(/data-testid="recovery-unavailable"/g)).toHaveLength(2);
    expect(html).toContain("exposure-unavailable");
    expect(html).not.toContain(">None.<");
  });

  it("the number ledger shows an unknown outcome as unknown and its fee as held", () => {
    const html = renderToStaticMarkup(createElement(NumberLedger, { studioId: STUDIO, studioName: "Studio One", ledger: overview().numberLedgers[STUDIO] as never }));
    expect(html).toContain("Outcome unknown");
    expect(html).toContain("number-held");
    expect(renderToStaticMarkup(createElement(NumberLedger, { studioId: STUDIO, studioName: "S", ledger: "unreadable" }))).toContain("do not assume nothing is in flight");
  });

  it("evidence console: shows the proof status, keeps release off (U-1) even when the evidence would permit it, and offers no 'not created' choice", () => {
    expect(FEE_RELEASE_ENABLED).toBe(false);
    const ledger = parseLedger({ onboarding_id: U(5), state: "exception", operations: [{ id: OP, kind: "campaign", status: "unknown_outcome", fee_bearing: true, fee_kinds: ["campaign_vetting"], attempt: 1 }] })!;
    ledger.evidence = parseEvidence([{ operation_id: OP, listings: 2, latest: { verdict: "absent", observed_at: "2026-10-22T10:00:00Z", source: "provider_read" }, proof: { ok: true, reason: "verified_absence" }, pilot: false, release_permitted_by_evidence: true }]);
    const html = renderToStaticMarkup(createElement(ProvisioningLedger, { studioId: STUDIO, ledger }));
    expect(html).toContain("Proof of non-creation: complete");
    expect(html).toContain("release stays switched off until the owner decides (U-1)");
    expect(html).toContain("Record provider listing");
    expect(html).not.toContain('value="not_created"');
    ledger.evidence = "unavailable";
    expect(renderToStaticMarkup(createElement(ProvisioningLedger, { studioId: STUDIO, ledger }))).toContain("Do not assume none was recorded");
  });
});
