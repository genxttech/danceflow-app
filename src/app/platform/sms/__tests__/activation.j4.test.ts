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

const ADMIN = "a6000000-0000-4000-8000-000000000a04";
let platformAdmin = true;
vi.mock("@/lib/auth/platform", () => ({
  requirePlatformAdmin: async () => {
    if (!platformAdmin) throw new Error("NOT_PLATFORM_ADMIN");
    return { id: ADMIN };
  },
}));

let rateAllowed = true;
const rateLimitCalls: string[] = [];
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimitKey: (...p: unknown[]) => p.join(":"),
  checkRateLimit: (key: string) => {
    rateLimitCalls.push(key);
    return { allowed: rateAllowed };
  },
}));

const rpc: { fn: string; args: Record<string, unknown> }[] = [];
let replies: Record<string, { data?: unknown; error?: { code?: string; message?: string } }> = {};
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

// the provider reads: the real module decides with the real (all-off) env unless a test scripts a runtime / provider
const runtimeOverride: { value: unknown } = { value: null };
const providerOverride: { value: unknown } = { value: undefined };
vi.mock("@/lib/sms/activation", async (orig) => {
  const real = await orig<typeof import("@/lib/sms/activation")>();
  return {
    ...real,
    complianceReadRuntime: (env: Record<string, string | undefined>) => (runtimeOverride.value ?? real.complianceReadRuntime(env)),
    activationSenderReadProvider: (env: Record<string, string | undefined>) => (providerOverride.value === undefined ? real.activationSenderReadProvider(env) : providerOverride.value),
  };
});

import { parseActivationCheck, type ActivationCheck } from "@/lib/sms/activation";
import {
  activateAction, attestOptOutAction, markReadyAction, recordActivationSenderAction, runComplianceAction, suspendAction, verifyActivationSenderAction,
} from "../activationActions";
import Activation, { KI1_BLOCKING_NOTE } from "../Activation";
import { selectActivationRows } from "../ActivationPanel";

const STUDIO = "f0000001-0000-4000-8000-000000000001";
const FORGED = "f0000009-0000-4000-8000-000000000009";
const AC = `AC${"1".repeat(32)}`;
const MG = `MG${"2".repeat(32)}`;
const QE = `QE${"3".repeat(32)}`;
const PN = `PN${"4".repeat(32)}`;
const SENDER = "f0000005-0000-4000-8000-000000000005";
const NOTE = "Reviewed the checklist with the owner today";
const OPT_OUT = { advanced_opt_out_enabled: "on", stop_keyword_confirmed: "on", start_keyword_confirmed: "on", help_keyword_confirmed: "on", confirmation_replies_confirmed: "on" };
const KNOWN = [
  "subaccount_active", "service_ready", "campaign_verified", "number_owned", "number_attached", "sender_ready", "opt_out_attested", "compliance_passed",
  "rfl_ready", "inventory_reconciled", "inbound_route_pinned", "usage_reconciler_ready", "funding_continuity", "pilot_ki1_redecided",
];

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
async function run(action: (f: FormData) => Promise<void>, fields: Record<string, string>) {
  await expect(action(form(fields))).rejects.toThrow("NEXT_REDIRECT");
  const flash = JSON.parse(cookieWrites[cookieWrites.length - 1].value) as { ok: boolean; message: string };
  return { url: redirects[redirects.length - 1], cookie: cookieWrites[cookieWrites.length - 1].name, ...flash };
}
const checkData = (over: Record<string, unknown> = {}) => ({
  state: "campaign_pending", ready: true, items: KNOWN.map((id) => ({ id, ok: true, detail: id === "pilot_ki1_redecided" ? "not_pilot" : "ok" })),
  ledger: { account_sid: AC, messaging_service_sid: MG, campaign_sid: QE, phone_number_sid: PN, e164: "+12025550100", sender_id: SENDER },
  ...over,
});
const mutations = () => rpc.filter((c) => c.fn !== "tw4_act_check");

beforeEach(() => {
  rpc.length = 0;
  redirects.length = 0;
  cookieWrites.length = 0;
  replies = {};
  clientsBuilt = 0;
  platformAdmin = true;
  rateAllowed = true;
  runtimeOverride.value = null;
  providerOverride.value = undefined;
});

describe("activation actions: platform admin only, session actor, studio id the only identifier", () => {
  const all: [string, (f: FormData) => Promise<void>, Record<string, string>][] = [
    ["record", recordActivationSenderAction, { confirm: "on" }],
    ["attest", attestOptOutAction, { ...OPT_OUT, evidenceRef: "Console screenshot in ticket 123" }],
    ["compliance", runComplianceAction, {}],
    ["verify", verifyActivationSenderAction, {}],
    ["ready", markReadyAction, { note: NOTE, confirm: "on" }],
    ["activate", activateAction, { note: NOTE, confirm: "on" }],
    ["suspend", suspendAction, { reason: NOTE }],
  ];

  it("a non-administrator is refused before any database client is built", async () => {
    platformAdmin = false;
    for (const [, action, fields] of all) await expect(action(form({ studioId: STUDIO, ...fields }))).rejects.toThrow("NOT_PLATFORM_ADMIN");
    expect(clientsBuilt).toBe(0);
    expect(rpc).toHaveLength(0);
  });

  it("a malformed studio id, or the rate limit, is refused before any call", async () => {
    for (const [, action, fields] of all) {
      const out = await run(action, { studioId: "not-a-uuid", ...fields });
      expect(out.ok).toBe(false);
      expect(out.url).toBe("/platform/sms?activation_error=1#sms-activation");
      expect(out.cookie).toBe("tw4_activation_flash");
    }
    rateAllowed = false;
    for (const [, action, fields] of all) expect((await run(action, { studioId: STUDIO, ...fields })).message).toMatch(/Too many attempts/);
    expect(rpc).toHaveLength(0);
  });

  it("record sender: the actor is the session administrator and no identifier is taken from the form", async () => {
    replies = { tw4_num_record_sender: { data: { sender_id: SENDER, status: "pending" } } };
    const out = await run(recordActivationSenderAction, { studioId: STUDIO, confirm: "on", actor: FORGED, p_actor: FORGED, messagingServiceSid: `MG${"9".repeat(32)}`, phoneNumberSid: `PN${"9".repeat(32)}` });
    expect(out.ok).toBe(true);
    expect(out.url).toBe("/platform/sms?activation=1#sms-activation");
    expect(rpc).toEqual([{ fn: "tw4_num_record_sender", args: { p_studio_id: STUDIO, p_actor: ADMIN } }]);
  });

  it("attest: every one of the five items and a 10-300 character evidence reference are required", async () => {
    for (const key of Object.keys(OPT_OUT)) {
      const fields: Record<string, string> = { studioId: STUDIO, ...OPT_OUT, evidenceRef: "Console screenshot in ticket 123" };
      delete fields[key];
      expect((await run(attestOptOutAction, fields)).ok).toBe(false);
    }
    expect((await run(attestOptOutAction, { studioId: STUDIO, ...OPT_OUT, evidenceRef: "short" })).ok).toBe(false);
    expect((await run(attestOptOutAction, { studioId: STUDIO, ...OPT_OUT, evidenceRef: "x".repeat(301) })).ok).toBe(false);
    expect(rpc).toHaveLength(0);
    replies = { tw4_act_attest: { data: { attestation_id: SENDER } } };
    const out = await run(attestOptOutAction, { studioId: STUDIO, ...OPT_OUT, evidenceRef: "Console screenshot in ticket 123" });
    expect(out.ok).toBe(true);
    expect(rpc).toEqual([{ fn: "tw4_act_attest", args: {
      p_studio_id: STUDIO, p_actor: ADMIN, p_evidence_ref: "Console screenshot in ticket 123",
      p_checklist: { advanced_opt_out_enabled: true, stop_keyword_confirmed: true, start_keyword_confirmed: true, help_keyword_confirmed: true, confirmation_replies_confirmed: true },
    } }]);
  });

  it("compliance and verify: with every gate off (the default) they refuse cleanly; nothing is read or recorded", async () => {
    replies = { tw4_act_check: { data: checkData() } };
    for (const action of [runComplianceAction, verifyActivationSenderAction]) {
      const out = await run(action, { studioId: STUDIO });
      expect(out.ok).toBe(false);
      expect(out.message).toMatch(/Provider reads are not enabled in this environment/);
    }
    expect(rpc).toHaveLength(0);
  });

  it("compliance with the local fake: the adapter is built for the LEDGER's subaccount and the database judges the facts", async () => {
    const adapter = {
      accountSid: AC, evidenceSource: "fake",
      getCampaignCompliance: vi.fn(async () => ({ sid: QE, opt_out_keywords: ["STOP"] })), getServiceRoute: vi.fn(async () => ({ sid: MG })),
    };
    const adapterFor = vi.fn(async () => adapter);
    runtimeOverride.value = { ok: true, mode: "fake", adapterFor };
    const prev = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example";
    try {
      replies = { tw4_act_check: { data: checkData() }, tw4_act_compliance_record: { data: { outcome: "passed", codes: [] } } };
      const out = await run(runComplianceAction, { studioId: STUDIO, accountSid: `AC${"9".repeat(32)}` });
      expect(out.ok).toBe(true);
      expect(out.message).toMatch(/local fake provider/);
      expect(adapterFor).toHaveBeenCalledWith(AC);
      const record = rpc.find((c) => c.fn === "tw4_act_compliance_record")!;
      expect(record.args.p_actor).toBe(ADMIN);
      expect(record.args.p_source).toBe("fake");
      expect(record.args.p_expected_inbound).toBe("https://app.example/api/sms/twilio/inbound");
      replies.tw4_act_compliance_record = { data: { outcome: "failed", codes: ["opt_out_keywords_missing", "<script>"] } };
      const failed = await run(runComplianceAction, { studioId: STUDIO });
      expect(failed.ok).toBe(false);
      expect(failed.message).toContain("opt_out_keywords_missing");
      expect(failed.message).not.toContain("<script>");
    } finally {
      process.env.NEXT_PUBLIC_APP_URL = prev;
    }
  });

  it("verify with the local fake: TW041 (no attestation / compliance) is explained in plain words", async () => {
    providerOverride.value = { isFake: true };
    const prev = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example";
    try {
      replies = { tw4_act_check: { data: checkData() }, tw4_act_verify_sender: { error: { code: "TW041", message: "raw database text" } } };
      const out = await run(verifyActivationSenderAction, { studioId: STUDIO });
      expect(out.ok).toBe(false);
      expect(out.message).toMatch(/attestation or a passed compliance validation/);
      expect(out.message).not.toContain("raw database text");
    } finally {
      process.env.NEXT_PUBLIC_APP_URL = prev;
    }
  });

  it("mark ready / activate: a note and a confirmation are required; the database is called even when the console would disable the button", async () => {
    expect((await run(markReadyAction, { studioId: STUDIO, note: "short", confirm: "on" })).ok).toBe(false);
    expect((await run(activateAction, { studioId: STUDIO, note: NOTE })).ok).toBe(false);
    expect(rpc).toHaveLength(0);
    replies = { tw4_act_activate: { error: { code: "TW042", message: "activation checklist unmet: pilot_ki1_redecided:ki1_owner_redecision_pending:lifted_only_by_migration,sender_ready:sender_not_verified_or_stale" } } };
    const out = await run(activateAction, { studioId: STUDIO, note: NOTE, confirm: "on", ready: "true" });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/^The activation checklist is not met\./);
    expect(out.message).toContain("KI-1");
    expect(out.message).toContain("sender_not_verified_or_stale");
    expect(mutations()).toEqual([{ fn: "tw4_act_activate", args: { p_studio_id: STUDIO, p_actor: ADMIN, p_note: NOTE } }]);
    replies = { tw4_act_mark_ready: { data: { state: "ready_for_activation" } } };
    expect((await run(markReadyAction, { studioId: STUDIO, note: NOTE, confirm: "on" })).ok).toBe(true);
  });

  it("maps each database code to its plain message", async () => {
    const cases: [string, RegExp][] = [
      ["42501", /Not authorized/], ["TW030", /onboarding state/], ["55P03", /lease/], ["TW044", /inbound route/], ["TW032", /not confirmed/], ["TW021", /sender row/],
      ["22023", /refused the input/], ["XX000", /Nothing changed/],
    ];
    for (const [code, re] of cases) {
      replies = { tw4_act_mark_ready: { error: { code, message: "do not show me" } } };
      const out = await run(markReadyAction, { studioId: STUDIO, note: NOTE, confirm: "on" });
      expect(out.message).toMatch(re);
      expect(out.message).not.toContain("do not show me");
    }
  });

  it("suspend: only a well-formed submit counts against the rate limit", async () => {
    rateLimitCalls.length = 0;
    expect((await run(suspendAction, { studioId: "not-a-uuid", reason: NOTE })).ok).toBe(false);
    expect((await run(suspendAction, { studioId: STUDIO, reason: "short" })).ok).toBe(false);
    expect((await run(suspendAction, { studioId: STUDIO, reason: "‮​⁦short⁩" })).ok).toBe(false);
    expect(rateLimitCalls).toHaveLength(0);
    replies = { tw4_act_suspend: { data: { state: "suspended" } } };
    await run(suspendAction, { studioId: STUDIO, reason: NOTE });
    expect(rateLimitCalls).toHaveLength(1);
  });

  it("notes, reasons and evidence references lose Unicode format characters (bidi overrides, zero-width) before the database sees them", async () => {
    replies = { tw4_act_suspend: { data: { state: "suspended" } }, tw4_act_attest: { data: { attestation_id: SENDER } } };
    await run(suspendAction, { studioId: STUDIO, reason: `‮${NOTE}​⁦` });
    expect(rpc[0].args.p_reason).toBe(NOTE);
    await run(attestOptOutAction, { studioId: STUDIO, ...OPT_OUT, evidenceRef: "Ticket‮ 123 screenshot‍" });
    expect(rpc[1].args.p_evidence_ref).toBe("Ticket 123 screenshot");
  });

  it("TW042 with many unmet items stays within the flash cap, KI-1 first, 'Nothing changed.' last", async () => {
    const many = Array.from({ length: 14 }, (_, i) => `item_${i}:some_long_detail_code_${"x".repeat(40)}`).join(",");
    replies = { tw4_act_activate: { error: { code: "TW042", message: `activation checklist unmet: ${many},pilot_ki1_redecided:ki1_owner_redecision_pending:lifted_only_by_migration` } } };
    const out = await run(activateAction, { studioId: STUDIO, note: NOTE, confirm: "on" });
    expect(out.message.length).toBeLessThanOrEqual(400);
    expect(out.message).toMatch(/^The activation checklist is not met\. KI-1 \(pilot ceiling double capture\)/);
    expect(out.message).toContain("15 items unmet: Pilot ceiling issue KI-1");
    expect(out.message).toContain("…");
    expect(out.message.endsWith(" Nothing changed.")).toBe(true);
  });

  it("suspend: a reason is required; the session actor and reason reach the database", async () => {
    expect((await run(suspendAction, { studioId: STUDIO, reason: "short" })).ok).toBe(false);
    replies = { tw4_act_suspend: { data: { state: "suspended" } } };
    const out = await run(suspendAction, { studioId: STUDIO, reason: NOTE, actor: FORGED });
    expect(out.ok).toBe(true);
    expect(rpc).toEqual([{ fn: "tw4_act_suspend", args: { p_studio_id: STUDIO, p_actor: ADMIN, p_reason: NOTE } }]);
  });
});

describe("rendering", () => {
  type Reads = { compliance: { enabled: boolean; reason: string | null }; sender: { enabled: boolean; reason: string | null } };
  const readsOff: Reads = { compliance: { enabled: false, reason: "Twilio number purchase calls are switched off." }, sender: { enabled: false, reason: "Sender verification reads are switched off." } };
  const readsOn: Reads = { compliance: { enabled: true, reason: null }, sender: { enabled: true, reason: null } };
  const check = (over: Record<string, unknown> = {}): ActivationCheck => parseActivationCheck(checkData(over))!;
  const render = (c: ActivationCheck | "unavailable", reads: Reads = readsOff, state = "campaign_pending") =>
    renderToStaticMarkup(createElement(Activation, { studios: [{ studioId: STUDIO, name: "ConfiDance", state }], overview: { [STUDIO]: c }, reads, notice: null, error: null }));
  const button = (html: string, testid: string) => html.slice(html.indexOf(`data-testid="${testid}"`)).match(/<button[^>]*>/)![0];

  it("shows every checklist item (unknown ids too) with its reason and raw detail, and the ledger read-only", () => {
    const items = [...KNOWN.map((id) => ({ id, ok: false, detail: id === "funding_continuity" ? "pilot_current_period_unapproved" : "mystery_detail" })), { id: "brand_new_item", ok: false, detail: "new_detail" }];
    const html = render(check({ items, ready: false }));
    expect(html.match(/data-testid="activation-item"/g)).toHaveLength(KNOWN.length + 1);
    for (const id of KNOWN) expect(html).toContain(`data-item="${id}"`);
    expect(html).toContain("brand_new_item: new_detail");
    expect(html).toContain("Checklist item &quot;brand_new_item&quot;");
    expect(html).toContain("Pilot: the current period");
    expect(html).toContain("Checklist: not ready");
    for (const sid of [AC, MG, QE, PN, SENDER]) expect(html).toContain(sid);
    // identifiers are shown, never form inputs; no actor field anywhere
    expect(html).not.toMatch(/name="(accountSid|messagingServiceSid|campaignSid|phoneNumberSid|senderE164|senderId|actor|p_actor|actorId)"/);
  });

  it("KI-1: a prominent blocking note, no override, mark ready and activate disabled, suspend still offered when active", () => {
    const items = KNOWN.map((id) => ({ id, ok: id !== "pilot_ki1_redecided", detail: id === "pilot_ki1_redecided" ? "ki1_owner_redecision_pending:lifted_only_by_migration" : "ok" }));
    let html = render(check({ items, ready: false }), readsOn);
    expect(html).toContain(KI1_BLOCKING_NOTE);
    expect(html).toContain("No flag, switch or admin action can lift this");
    expect(html).not.toMatch(/override/i);
    expect(button(html, "activation-mark-ready")).toContain('disabled=""');
    expect(button(html, "activation-activate")).toContain('disabled=""');
    html = render(check({ items, ready: false, state: "active" }), readsOn, "active");
    expect(html).toContain(KI1_BLOCKING_NOTE);
    expect(html).toContain('data-testid="activation-suspend"');
    expect(button(html, "activation-suspend")).not.toContain('disabled=""');
    // a non-pilot business has no note
    expect(render(check())).not.toContain(KI1_BLOCKING_NOTE);
  });

  it("buttons follow ready AND state; suspend only for an active location", () => {
    let html = render(check());
    expect(button(html, "activation-mark-ready")).not.toContain('disabled=""');
    expect(button(html, "activation-activate")).toContain('disabled=""');
    expect(html).not.toContain('data-testid="activation-suspend"');
    html = render(check({ state: "ready_for_activation" }));
    expect(button(html, "activation-mark-ready")).toContain('disabled=""');
    expect(button(html, "activation-activate")).not.toContain('disabled=""');
    html = render(check({ state: "suspended" }));
    expect(button(html, "activation-activate")).not.toContain('disabled=""');
    html = render(check({ state: "ready_for_activation", ready: false }));
    expect(button(html, "activation-activate")).toContain('disabled=""');
  });

  it("the attestation names the Twilio Console step (D4) and requires all five items; reads off are explained and their buttons disabled", () => {
    const html = render(check());
    expect(html).toContain("Twilio Console, D4");
    for (const key of Object.keys(OPT_OUT)) expect(html).toMatch(new RegExp(`required="" name="${key}"`));
    expect(html).toMatch(/required="" minLength="10" maxLength="300" [^>]*name="evidenceRef"/);
    expect(html.match(/data-testid="activation-reads-off"/g)).toHaveLength(2);
    expect(html).toContain("Provider reads are not enabled in this environment");
    expect(button(html, "activation-compliance")).toContain('disabled=""');
    expect(button(html, "activation-verify")).toContain('disabled=""');
    const on = render(check(), readsOn);
    expect(on).not.toContain("activation-reads-off");
    expect(button(on, "activation-compliance")).not.toContain('disabled=""');
  });

  it("an unreadable checklist is shown as unreadable, never as ready; an ACTIVE location still offers Suspend and nothing else", () => {
    let html = render("unavailable");
    expect(html).toContain("activation-unavailable");
    expect(html).not.toContain("activation-forms");
    expect(html).not.toContain("activation-suspend");
    expect(html).not.toContain("Checklist: ready");
    html = render("unavailable", readsOn, "active");
    expect(html).toContain("activation-unavailable");
    expect(html).toContain('data-testid="activation-suspend"');
    expect(button(html, "activation-suspend")).not.toContain('disabled=""');
    expect(html.match(/<form/g)).toHaveLength(1);
    expect(html).not.toContain("activation-forms");
    expect(html).not.toContain("Checklist: ready");
  });

  it("Suspend follows the list state too: an active location whose checklist reports another state still offers it", () => {
    expect(render(check({ state: "campaign_pending" }), readsOff, "active")).toContain('data-testid="activation-suspend"');
  });

  it("the flash banner, an empty list, and an unreadable list (never shown as empty)", () => {
    const html = renderToStaticMarkup(createElement(Activation, { studios: [], overview: {}, reads: readsOff, notice: "Location activated.", error: null }));
    expect(html).toContain('role="status"');
    expect(html).toContain("Location activated.");
    expect(html).toContain("No location is at the campaign");
    const failed = renderToStaticMarkup(createElement(Activation, { studios: [], overview: {}, reads: readsOff, notice: null, error: null, listError: true }));
    expect(failed).toContain("activation-list-error");
    expect(failed).toContain("could not be read");
    expect(failed).not.toContain("No location is at the campaign");
  });

  it("panel row selection: active first, then suspended, never capped; only pre-activation rows are capped at 30", () => {
    const row = (n: number, state: string) => ({ studioId: `s${n}`, studioName: `S${n}`, accessEnabled: true, state, submissionSeq: null, submittedAt: null, updatedAt: null, einStored: false });
    const rows = [
      ...Array.from({ length: 40 }, (_, i) => row(i, i % 2 ? "campaign_pending" : "ready_for_activation")),
      ...Array.from({ length: 35 }, (_, i) => row(100 + i, "suspended")),
      ...Array.from({ length: 35 }, (_, i) => row(200 + i, "active")),
      row(999, "draft"),
    ];
    const picked = selectActivationRows(rows);
    expect(picked.filter((r) => r.state === "active")).toHaveLength(35);
    expect(picked.filter((r) => r.state === "suspended")).toHaveLength(35);
    expect(picked.filter((r) => r.state === "campaign_pending" || r.state === "ready_for_activation")).toHaveLength(30);
    expect(picked.some((r) => r.state === "draft")).toBe(false);
    expect(picked.slice(0, 35).every((r) => r.state === "active")).toBe(true);
    expect(picked.slice(35, 70).every((r) => r.state === "suspended")).toBe(true);
  });
});
