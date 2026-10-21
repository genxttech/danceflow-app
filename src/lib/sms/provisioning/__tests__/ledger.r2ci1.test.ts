import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ requirePlatformAdmin: vi.fn() }));
const admin = vi.hoisted(() => ({ rpc: vi.fn(), createAdminClient: vi.fn() }));
const nav = vi.hoisted(() => ({ cookieSet: vi.fn(), redirect: vi.fn() }));

vi.mock("@/lib/auth/platform", () => ({ requirePlatformAdmin: platform.requirePlatformAdmin }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: admin.rpc }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: nav.cookieSet }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    nav.redirect(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

import { loadLedgers, parseLedger, ProvisioningLedgerStore, type LedgerSnapshot } from "../provisionLedger";
import { CONFIRM_PHRASE, RESOLVE_WAIT_MS, reopenProvisioning, resolveOperation, type LedgerPort } from "../provisionCommands";
import { buildAdminProvisioningView } from "../adminView";
import { reopenProvisioningAction, resolveProvisioningOperationAction } from "@/app/platform/sms/provisioningActions";
import ProvisioningLedger from "@/app/platform/sms/ProvisioningLedger";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const OP_CAMPAIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OP_MS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OP_OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ADMIN = "99999999-9999-4999-8999-999999999999";
const NOW = Date.parse("2026-10-21T12:00:00Z");
const OLD = "2026-10-21T10:00:00Z";
const FRESH = "2026-10-21T11:55:00Z";
const QE = `QE${"a".repeat(32)}`;
const MG = `MG${"b".repeat(32)}`;

const rawOp = (over: Record<string, unknown> = {}) => ({
  id: OP_CAMPAIGN, kind: "campaign", attempt: 1, status: "unknown_outcome", provider_sid: null, fee_bearing: true, fee_kinds: ["campaign_vetting"], error_code: "timeout",
  error_detail: "no answer", started_at: OLD, finished_at: null, superseded: false, resolved_by: null, resolution_note: null, resource: null, ...over,
});
const rawLedger = (ops: unknown[], over: Record<string, unknown> = {}) => ({ onboarding_id: "o1", state: "campaign_pending", step: "C1", last_error_code: null, leased: false, window_open: true, operations: ops, ...over });

function port(raw: unknown, opts: { statusThrows?: boolean; resolveError?: string } = {}) {
  const calls = { status: vi.fn(), resolve: vi.fn(), reopen: vi.fn() };
  const p: LedgerPort = {
    async status(studioId, actorId) {
      calls.status(studioId, actorId);
      if (opts.statusThrows) throw new Error("down");
      return parseLedger(raw);
    },
    async resolve(args) {
      calls.resolve(args);
      if (opts.resolveError) throw Object.assign(new Error("db"), { code: opts.resolveError });
    },
    async reopen(studioId, actorId, reason) {
      calls.reopen(studioId, actorId, reason);
      if (opts.resolveError) throw Object.assign(new Error("db"), { code: opts.resolveError });
    },
  };
  return { p, calls };
}
const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) f.set(k, val);
  return f;
};
const good = (over: Record<string, string> = {}) => ({ studioId: S1, operationId: OP_CAMPAIGN, resolution: "not_created", note: "Checked the Twilio console: no campaign exists", confirm: "on", phrase: CONFIRM_PHRASE, ...over });

describe("ledger wrapper: strict, fail-closed parsing", () => {
  it("returns null for a studio with no onboarding and parses a well-formed ledger", () => {
    expect(parseLedger(null)).toBeNull();
    const l = parseLedger(rawLedger([rawOp()]))!;
    expect(l.operations[0]).toMatchObject({ id: OP_CAMPAIGN, kind: "campaign", status: "unknown_outcome", feeBearing: true, feeKinds: ["campaign_vetting"] });
  });
  it("throws on anything that is not the documented shape (never an empty ledger)", () => {
    for (const bad of ["x", [], {}, { onboarding_id: "o", state: "s" }, rawLedger([{ id: "x" }]), rawLedger([null])]) expect(() => parseLedger(bad)).toThrow();
  });
  it("keeps an unrecognized status verbatim and the admin view flags it instead of treating it as success or failure", () => {
    const l = parseLedger(rawLedger([rawOp({ status: "weird" })]))!;
    expect(l.operations[0].status).toBe("weird");
    const v = buildAdminProvisioningView({ studioId: S1, state: "campaign_pending", accessEnabled: true, evidence: undefined, sender: null, operations: l.operations });
    expect(v.blockers.join(" ")).toMatch(/does not recognize/);
  });
  it("store forwards exactly the documented rpc arguments, with the caller-supplied actor only", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const store = new ProvisioningLedgerStore({ rpc } as never);
    await store.status(S1, ADMIN);
    await store.resolve({ operationId: OP_CAMPAIGN, actorId: ADMIN, resolution: "created", providerSid: QE, note: "found it in the console" });
    await store.reopen(S1, ADMIN, "campaign corrected and reviewed");
    expect(rpc.mock.calls).toEqual([
      ["tw4_prov_status", { p_studio_id: S1, p_actor: ADMIN }],
      ["tw4_prov_resolve", { p_operation_id: OP_CAMPAIGN, p_actor: ADMIN, p_resolution: "created", p_provider_sid: QE, p_note: "found it in the console" }],
      ["tw4_prov_reopen", { p_studio_id: S1, p_actor: ADMIN, p_reason: "campaign corrected and reviewed" }],
    ]);
  });
  it("a database error becomes a LedgerError carrying only the code", async () => {
    const store = new ProvisioningLedgerStore({ rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "42501", message: "actor must be a platform admin" } }) } as never);
    await expect(store.status(S1, ADMIN)).rejects.toMatchObject({ code: "42501", message: expect.not.stringContaining("platform admin") });
  });
  it("loadLedgers: unreadable and none are distinct from an empty ledger; a failing studio never poisons the others", async () => {
    const status = vi.fn(async (id: string) => {
      if (id === S2) throw new Error("boom");
      return id === S1 ? parseLedger(rawLedger([])) : null;
    });
    const out = await loadLedgers({ status } as never, ADMIN, [S1, S2, "33333333-3333-4333-8333-333333333333"]);
    expect((out[S1] as LedgerSnapshot).operations).toEqual([]);
    expect(out[S2]).toBe("unreadable");
    expect(out["33333333-3333-4333-8333-333333333333"]).toBe("none");
  });
});

describe("resolveOperation: validation, replay and cross-studio refusal", () => {
  it("happy path (fee op, 'not created', 2h old): calls resolve once, with the session admin, and says the fee was released", async () => {
    const { p, calls } = port(rawLedger([rawOp()]));
    const r = await resolveOperation(p, ADMIN, form(good()), NOW);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/released/);
    expect(calls.resolve).toHaveBeenCalledTimes(1);
    expect(calls.resolve).toHaveBeenCalledWith({ operationId: OP_CAMPAIGN, actorId: ADMIN, resolution: "not_created", providerSid: null, note: "Checked the Twilio console: no campaign exists" });
  });
  it("'created' needs the right SID shape for the operation kind and captures nothing by itself", async () => {
    const { p, calls } = port(rawLedger([rawOp()]));
    expect((await resolveOperation(p, ADMIN, form(good({ resolution: "created", providerSid: MG })), NOW)).ok).toBe(false); // an MG sid for a campaign
    expect((await resolveOperation(p, ADMIN, form(good({ resolution: "created", providerSid: "" })), NOW)).ok).toBe(false);
    const ok = await resolveOperation(p, ADMIN, form(good({ resolution: "created", providerSid: QE })), NOW);
    expect(ok.ok).toBe(true);
    expect(ok.message).toMatch(/captured only after a provider read/);
    expect(calls.resolve).toHaveBeenCalledTimes(1);
    expect(calls.resolve.mock.calls[0][0].providerSid).toBe(QE);
  });
  it("tampered operation id from another studio's ledger is refused and never reaches resolve", async () => {
    const { p, calls } = port(rawLedger([rawOp({ id: OP_MS, kind: "messaging_service" })]));
    const r = await resolveOperation(p, ADMIN, form(good({ operationId: OP_OTHER })), NOW);
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toMatch(/not part of this studio/);
    expect(calls.resolve).not.toHaveBeenCalled();
  });
  it("a studio with no onboarding refuses, and malformed ids refuse before any read", async () => {
    const none = port(null);
    expect((await resolveOperation(none.p, ADMIN, form(good()), NOW)).ok).toBe(false);
    expect(none.calls.resolve).not.toHaveBeenCalled();
    const { p, calls } = port(rawLedger([rawOp()]));
    expect((await resolveOperation(p, ADMIN, form(good({ operationId: "not-a-uuid" })), NOW)).ok).toBe(false);
    expect(calls.status).not.toHaveBeenCalled();
  });
  it("replay: an already resolved operation is refused with a clear message", async () => {
    for (const status of ["succeeded", "abandoned", "failed"]) {
      const { p, calls } = port(rawLedger([rawOp({ status, resolved_by: ADMIN })]));
      const r = await resolveOperation(p, ADMIN, form(good()), NOW);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/already resolved/);
      expect(calls.resolve).not.toHaveBeenCalled();
    }
    const sup = port(rawLedger([rawOp({ superseded: true })]));
    expect((await resolveOperation(sup.p, ADMIN, form(good()), NOW)).ok).toBe(false);
  });
  it("two submissions of the same form: the second sees the closed operation and does nothing", async () => {
    let status = "unknown_outcome";
    const calls = vi.fn();
    const p: LedgerPort = {
      status: async () => parseLedger(rawLedger([rawOp({ status })])),
      resolve: async (a) => { calls(a); status = "abandoned"; },
      reopen: async () => {},
    };
    expect((await resolveOperation(p, ADMIN, form(good()), NOW)).ok).toBe(true);
    expect((await resolveOperation(p, ADMIN, form(good()), NOW)).ok).toBe(false);
    expect(calls).toHaveBeenCalledTimes(1);
  });
  it("financial rules: a fee operation cannot be declared not created within 20 minutes; an in-flight attempt waits 20 minutes", async () => {
    const fresh = port(rawLedger([rawOp({ started_at: FRESH })]));
    const r = await resolveOperation(fresh.p, ADMIN, form(good()), NOW);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/20 minutes/);
    expect(fresh.calls.resolve).not.toHaveBeenCalled();
    const inflight = port(rawLedger([rawOp({ status: "in_flight", started_at: FRESH })]));
    expect((await resolveOperation(inflight.p, ADMIN, form(good({ resolution: "created", providerSid: QE })), NOW)).ok).toBe(false);
    const oldInflight = port(rawLedger([rawOp({ status: "in_flight", started_at: OLD })]));
    expect((await resolveOperation(oldInflight.p, ADMIN, form(good()), NOW)).ok).toBe(true);
    expect(RESOLVE_WAIT_MS).toBe(1_200_000);
  });
  it("a missing or unparseable attempt time fails closed", async () => {
    const { p, calls } = port(rawLedger([rawOp({ started_at: null })]));
    expect((await resolveOperation(p, ADMIN, form(good()), NOW)).ok).toBe(false);
    expect(calls.resolve).not.toHaveBeenCalled();
  });
  it("written reason and explicit confirmation are required; a fee operation also needs the typed phrase", async () => {
    const { p, calls } = port(rawLedger([rawOp()]));
    for (const bad of <Record<string, string>[]>[{ note: "short" }, { note: "x".repeat(501) }, { note: "bad\u0007control chars here" }, { confirm: "" }, { phrase: "" }, { phrase: "resolve" }]) {
      expect((await resolveOperation(p, ADMIN, form(good(bad)), NOW)).ok).toBe(false);
    }
    expect(calls.resolve).not.toHaveBeenCalled();
    // a free operation needs the confirmation but not the phrase
    const free = port(rawLedger([rawOp({ id: OP_MS, kind: "messaging_service", fee_bearing: false, fee_kinds: [] })]));
    const r = await resolveOperation(free.p, ADMIN, form(good({ operationId: OP_MS, phrase: "" })), NOW);
    expect(r).toMatchObject({ ok: true, message: "Recorded as not created." });
  });
  it("fails closed when the ledger cannot be read or a run holds the lease", async () => {
    const down = port(rawLedger([rawOp()]), { statusThrows: true });
    expect((await resolveOperation(down.p, ADMIN, form(good()), NOW)).ok).toBe(false);
    expect(down.calls.resolve).not.toHaveBeenCalled();
    const leased = port(rawLedger([rawOp()], { leased: true }));
    expect((await resolveOperation(leased.p, ADMIN, form(good()), NOW)).message).toMatch(/run is working/);
  });
  it("database refusals are shown as fixed copy, never the database text", async () => {
    for (const code of ["42501", "22023", "55P03", "XX000"]) {
      const { p } = port(rawLedger([rawOp()]), { resolveError: code });
      const r = await resolveOperation(p, ADMIN, form(good()), NOW);
      expect(r.ok).toBe(false);
      expect(r.message).not.toMatch(/db|postgres|function/i);
    }
  });
  it("a caller-supplied admin id in the form is ignored: the actor is always the argument", async () => {
    const { p, calls } = port(rawLedger([rawOp()]));
    await resolveOperation(p, ADMIN, form({ ...good(), actor: "00000000-0000-4000-8000-000000000000", p_actor: "x", actorId: "y" }), NOW);
    expect(calls.resolve.mock.calls[0][0].actorId).toBe(ADMIN);
    expect(calls.status.mock.calls[0][1]).toBe(ADMIN);
  });
});

describe("access off", () => {
  it("an unknown outcome stays the next action even when pilot access is off", () => {
    const v = buildAdminProvisioningView({ studioId: S1, state: "campaign_pending", accessEnabled: false, evidence: undefined, sender: null, operations: parseLedger(rawLedger([rawOp()]))!.operations });
    expect(v.next.title).toMatch(/Resolve the unknown/);
    expect(buildAdminProvisioningView({ studioId: S1, state: "campaign_pending", accessEnabled: false, evidence: undefined, sender: null, operations: [] }).next.title).toMatch(/Switch pilot access on/);
  });
});

describe("reopenProvisioning", () => {
  const rform = (over: Record<string, string> = {}) => form({ studioId: S1, reason: "Corrected the sample messages and reviewed", confirm: "on", ...over });
  it("reopens an exception with no open operation; refuses otherwise", async () => {
    const ok = port(rawLedger([rawOp({ status: "failed" })], { state: "exception", last_error_code: "campaign_rejected" }));
    const earlyException = port(rawLedger([], { state: "exception", last_error_code: "brand_rejected" }));
    expect((await reopenProvisioning(earlyException.p, ADMIN, rform())).ok).toBe(false);
    expect(earlyException.calls.reopen).not.toHaveBeenCalled();
    expect((await reopenProvisioning(ok.p, ADMIN, rform())).ok).toBe(true);
    expect(ok.calls.reopen).toHaveBeenCalledWith(S1, ADMIN, "Corrected the sample messages and reviewed");
    const notException = port(rawLedger([]));
    expect((await reopenProvisioning(notException.p, ADMIN, rform())).ok).toBe(false);
    const open = port(rawLedger([rawOp()], { state: "exception", last_error_code: "prov_unknown_outcome" }));
    const r = await reopenProvisioning(open.p, ADMIN, rform());
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Resolve the unknown outcome first/);
    expect(open.calls.reopen).not.toHaveBeenCalled();
    expect((await reopenProvisioning(ok.p, ADMIN, rform({ reason: "short" }))).ok).toBe(false);
    expect((await reopenProvisioning(ok.p, ADMIN, rform({ confirm: "" }))).ok).toBe(false);
  });
});

describe("server actions: platform-admin only, identity from the session", () => {
  beforeEach(() => {
    platform.requirePlatformAdmin.mockReset();
    admin.rpc.mockReset();
    nav.cookieSet.mockReset();
    nav.redirect.mockReset();
  });
  const ledgerRpc = (status: string) => async (fn: string) => {
    if (fn === "tw4_prov_status") return { data: rawLedger([rawOp({ status })]), error: null };
    return { data: {}, error: null };
  };

  it("a non-admin is redirected before anything is read or written", async () => {
    platform.requirePlatformAdmin.mockImplementation(async () => {
      throw new Error("NEXT_REDIRECT:/app");
    });
    await expect(resolveProvisioningOperationAction(form(good()))).rejects.toThrow(/NEXT_REDIRECT:\/app/);
    await expect(reopenProvisioningAction(form({ studioId: S1, reason: "a documented reason", confirm: "on" }))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(nav.cookieSet).not.toHaveBeenCalled();
  });

  it("an admin's resolution uses the SESSION admin id and ignores any actor in the form; the result travels in a cookie, not the URL", async () => {
    platform.requirePlatformAdmin.mockResolvedValue({ id: ADMIN });
    admin.rpc.mockImplementation(ledgerRpc("unknown_outcome"));
    await expect(resolveProvisioningOperationAction(form({ ...good({ resolution: "not_created" }), actor: "evil", p_actor: "evil" }))).rejects.toThrow(/NEXT_REDIRECT:\/platform\/sms\?prov=1#ledger-/);
    const resolveCall = admin.rpc.mock.calls.find((c) => c[0] === "tw4_prov_resolve")!;
    expect(resolveCall[1]).toMatchObject({ p_actor: ADMIN, p_operation_id: OP_CAMPAIGN, p_resolution: "not_created" });
    expect(JSON.stringify(admin.rpc.mock.calls)).not.toContain("evil");
    const [name, value] = nav.cookieSet.mock.calls[0];
    expect(name).toBe("tw4_prov_flash");
    expect(JSON.parse(value)).toMatchObject({ ok: true });
    expect(nav.redirect.mock.calls[0][0]).not.toMatch(/released|fee/i);
  });

  it("a refused resolution redirects with an error flag and no resolve call", async () => {
    platform.requirePlatformAdmin.mockResolvedValue({ id: ADMIN });
    admin.rpc.mockImplementation(ledgerRpc("abandoned"));
    await expect(resolveProvisioningOperationAction(form(good()))).rejects.toThrow(/prov_error=1/);
    expect(admin.rpc.mock.calls.some((c) => c[0] === "tw4_prov_resolve")).toBe(false);
  });

  it("when the ledger read fails the action fails closed", async () => {
    platform.requirePlatformAdmin.mockResolvedValue({ id: ADMIN });
    admin.rpc.mockResolvedValue({ data: null, error: { code: "XX000" } });
    await expect(resolveProvisioningOperationAction(form(good()))).rejects.toThrow(/prov_error=1/);
    expect(admin.rpc.mock.calls.every((c) => c[0] === "tw4_prov_status")).toBe(true);
  });
});

describe("ProvisioningLedger rendering", () => {
  const snap = (ops: unknown[], over: Record<string, unknown> = {}) => parseLedger(rawLedger(ops, over))!;
  it("shows an unknown outcome as unknown (never failed), the held fee, and a collapsible resolve form with a typed confirmation for fee operations", () => {
    const html = renderToStaticMarkup(createElement(ProvisioningLedger, { studioId: S1, ledger: snap([rawOp()]) }));
    expect(html).toContain("Outcome unknown");
    expect(html).not.toMatch(/Outcome unknown[^<]*failed/i);
    expect(html).toContain("held-reservation");
    expect(html).toContain("<details");
    expect(html).toContain("lucide-chevron-down");
    expect(html).toContain(`Type ${CONFIRM_PHRASE} to confirm`);
    expect(html).toContain(`id="ledger-${S1}"`);
  });
  it("a free operation has no phrase field; a resolved operation has no form and no held-fee notice", () => {
    const free = renderToStaticMarkup(createElement(ProvisioningLedger, { studioId: S1, ledger: snap([rawOp({ id: OP_MS, kind: "messaging_service", fee_bearing: false, fee_kinds: [] })]) }));
    expect(free).toContain("resolve-form");
    expect(free).not.toContain("Type RESOLVE");
    const done = renderToStaticMarkup(createElement(ProvisioningLedger, { studioId: S1, ledger: snap([rawOp({ status: "succeeded", provider_sid: QE })]) }));
    expect(done).not.toContain("resolve-form");
    expect(done).not.toContain("held-reservation");
  });
  it("unreadable is an alert, not an empty ledger; none and null render nothing", () => {
    expect(renderToStaticMarkup(createElement(ProvisioningLedger, { studioId: S1, ledger: "unreadable" }))).toContain("could not be read");
    expect(renderToStaticMarkup(createElement(ProvisioningLedger, { studioId: S1, ledger: "none" }))).toBe("");
    expect(renderToStaticMarkup(createElement(ProvisioningLedger, { studioId: S1, ledger: null }))).toBe("");
  });
  it("offers reopen only for an exception with nothing open", () => {
    const exception = renderToStaticMarkup(createElement(ProvisioningLedger, { studioId: S1, ledger: snap([rawOp({ status: "failed" })], { state: "exception", last_error_code: "campaign_rejected" }) }));
    expect(exception).toContain("reopen-form");
    const blocked = renderToStaticMarkup(createElement(ProvisioningLedger, { studioId: S1, ledger: snap([rawOp()], { state: "exception" }) }));
    expect(blocked).not.toContain("reopen-form");
    const early = renderToStaticMarkup(createElement(ProvisioningLedger, { studioId: S1, ledger: snap([], { state: "exception", last_error_code: "brand_rejected" }) }));
    expect(early).not.toContain("reopen-form");
  });
  it("the owner-facing app never imports the ledger wrapper or this component (platform-admin data stays on the platform side)", () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const f = join(dir, n); return statSync(f).isDirectory() ? (n === "__tests__" ? [] : walk(f)) : /.(ts|tsx)$/.test(n) ? [f] : []; });
    const offenders = walk(join(process.cwd(), "src/app/app")).filter((f) => /provisionLedger|provisionCommands|ProvisioningLedger|provisioningActions/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
