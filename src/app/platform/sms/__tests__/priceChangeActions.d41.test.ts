import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D4-1: the price-change server actions (propose / approve / reject). Mocked edges: the step-up guard records the tier it was asked for, the service-role client records
 * every RPC. Proven here: the guard runs first at the registered tier; the actor is the session's administrator and never a form value; every input is validated before
 * any client is built; database errors map to fixed sentences (never the database text); a stale / expired approval reads as a refusal, not a success.
 */

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
vi.mock("next/headers", () => ({ cookies: async () => ({ set: (name: string, value: string) => cookieWrites.push({ name, value }) }) }));

const ADMIN = "d4100000-0000-4000-8000-000000000001";
const state = { tiers: [] as string[], refuse: null as string | null };
vi.mock("@/lib/auth/platform-assurance", () => ({
  requirePlatformStepUp: async (tier: string) => {
    state.tiers.push(tier);
    if (state.refuse) throw new Error(state.refuse);
    return { id: ADMIN };
  },
}));

const rpc: { fn: string; args: Record<string, unknown> }[] = [];
let replies: Record<string, { data?: unknown; error?: { code?: string; message?: string } }> = {};
let clientsBuilt = 0;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("the service-role client must never be used on the price path");
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    clientsBuilt += 1;
    return {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpc.push({ fn, args });
        const r = replies[fn];
        if (!r) return { data: null, error: { code: "42883", message: "missing" } };
        return { data: r.data ?? null, error: r.error ?? null };
      },
    };
  },
}));

import { priceRecoveryEnroll, priceRecoveryFreeze, priceApprove, priceCredApply, priceCredBegin, priceCredCancel, priceCredEnroll, priceCredPending, priceCredRevoke, priceThaw, priceAuthzBegin, priceAuthzFinish, priceFreeze, pricePropose, priceReject, priceReportCompromise, priceRevise } from "../priceChangeActions";

const REQ = "d4100000-0000-4000-8000-0000000000aa";
const NOTE = "A written note that is long enough.";
const GOOD = { kind: "number", customerUsd: "3.25", providerUsd: "1.15", description: "Phone number rent", reason: "Twilio raised the monthly number rent" };

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
async function run(action: (f: FormData) => Promise<void>, fields: Record<string, string>): Promise<{ url: string; ok: boolean; message: string }> {
  await expect(action(form(fields))).rejects.toThrow("NEXT_REDIRECT");
  const flash = JSON.parse(cookieWrites[cookieWrites.length - 1].value) as { ok: boolean; message: string };
  return { url: redirects[redirects.length - 1], ok: flash.ok, message: flash.message };
}

beforeEach(() => {
  redirects.length = 0;
  cookieWrites.length = 0;
  rpc.length = 0;
  replies = {};
  clientsBuilt = 0;
  state.tiers.length = 0;
  state.refuse = null;
});

describe("the assurance guard comes first, at the registered tier", () => {
  it("propose and approve need a recent authenticator code; reject needs aal2; a refused guard builds no client and calls nothing", async () => {
    for (const [action, tier, fields] of [
      [pricePropose, "recent", GOOD], [priceApprove, "recent", { requestId: REQ, note: NOTE }], [priceReject, "aal2", { requestId: REQ, note: NOTE }],
    ] as const) {
      state.tiers.length = 0;
      state.refuse = "STEPUP_REFUSED";
      await expect(action(form({ ...fields }))).rejects.toThrow("STEPUP_REFUSED");
      expect(state.tiers).toEqual([tier]);
    }
    expect(clientsBuilt).toBe(0);
    expect(rpc).toHaveLength(0);
    expect(cookieWrites).toHaveLength(0);
  });
});

describe("propose", () => {
  it("converts dollars to cents, sends NO actor at all (the database takes the identity from the administrator's own session; a forged actor / requester in the form is ignored) and says nothing changed", async () => {
    replies.tw4_price_propose = { data: { request_id: REQ, status: "pending", replayed: false } };
    const r = await run(pricePropose, { ...GOOD, actor: "x", actorId: "x", p_actor: "x", requestedBy: "x" });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/no price has changed/);
    expect(r.url).toBe("/platform/sms?price=1#price-changes");
    expect(rpc).toEqual([{ fn: "tw4_price_propose", args: { p_kind: "number", p_customer_cents: 325, p_provider_cents: 115, p_description: "Phone number rent", p_reason: "Twilio raised the monthly number rent" } }]);
  });

  it("validates everything BEFORE any client is built: unknown kind, injection in the kind, zero / negative / malformed amounts, short description or reason", async () => {
    const bad: Record<string, string>[] = [
      { ...GOOD, kind: "bogus" }, { ...GOOD, kind: "number'; drop table x; --" }, { ...GOOD, kind: "" }, { ...GOOD, customerUsd: "0" }, { ...GOOD, customerUsd: "0.00" },
      { ...GOOD, customerUsd: "-1" }, { ...GOOD, customerUsd: "abc" }, { ...GOOD, customerUsd: "1.234" }, { ...GOOD, customerUsd: "" }, { ...GOOD, providerUsd: "-0.50" },
      { ...GOOD, providerUsd: "" }, { ...GOOD, description: "ab" }, { ...GOOD, description: "x".repeat(201) }, { ...GOOD, reason: "too short" }, { ...GOOD, reason: "x".repeat(501) },
    ];
    for (const fields of bad) {
      const r = await run(pricePropose, fields);
      expect(r.ok, JSON.stringify(fields)).toBe(false);
      expect(r.url).toBe("/platform/sms?price_error=1#price-changes");
    }
    expect(clientsBuilt).toBe(0);
    expect(rpc).toHaveLength(0);
  });

  it("accepts a zero provider cost (a free provider item) and every price kind of the price list", async () => {
    replies.tw4_price_propose = { data: { request_id: REQ, status: "pending", replayed: false } };
    for (const kind of ["brand", "brand_low_volume", "campaign_vetting", "number", "monthly", "monthly_low_volume", "sms_usage", "sms_inbound"]) {
      expect((await run(pricePropose, { ...GOOD, kind, providerUsd: "0" })).ok, kind).toBe(true);
    }
    expect(rpc).toHaveLength(8);
  });

  it("maps database refusals to fixed sentences and never shows the database text", async () => {
    for (const [code, expected] of [["TW041", /another proposal for this price is still open/], ["22023", /database refused the input/], ["42501", /Not allowed/], ["XX999", /The action failed/]] as const) {
      replies.tw4_price_propose = { error: { code, message: "SECRET database text with a stack and a sql fragment" } };
      const r = await run(pricePropose, GOOD);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(expected);
      expect(r.message).not.toContain("SECRET");
    }
  });
});

describe("approve and reject", () => {
  it("approve sends the note and the request id, nothing else from the form (no actor); an applied result is a success", async () => {
    replies.tw4_price_approve = { data: { status: "applied", replayed: false, price_id: REQ } };
    const r = await run(priceApprove, { requestId: REQ, note: NOTE, actor: "x", p_actor: "x", customerUsd: "999" });
    expect(r.ok).toBe(true);
    expect(rpc).toEqual([{ fn: "tw4_price_approve", args: { p_request_id: REQ, p_note: NOTE } }]);
  });

  it("expired and invalidated results are refusals, not successes; a self-approval refusal reads as separation of duties", async () => {
    replies.tw4_price_approve = { data: { status: "expired", replayed: false } };
    expect(await run(priceApprove, { requestId: REQ, note: NOTE })).toMatchObject({ ok: false, message: expect.stringMatching(/expired/) });
    replies.tw4_price_approve = { data: { status: "invalidated", replayed: false } };
    expect(await run(priceApprove, { requestId: REQ, note: NOTE })).toMatchObject({ ok: false, message: expect.stringMatching(/invalidated/) });
    replies.tw4_price_approve = { error: { code: "42501", message: "the requester cannot approve their own price proposal" } };
    const r = await run(priceApprove, { requestId: REQ, note: NOTE });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/can never be approved by the administrator who proposed it/);
  });

  it("a malformed request id or a short note is refused before any client is built", async () => {
    for (const fields of [{ requestId: "not-a-uuid", note: NOTE }, { requestId: REQ, note: "short" }, { requestId: "", note: NOTE }, { requestId: REQ.toUpperCase().replace("D41", "D4G"), note: NOTE }]) {
      expect((await run(priceApprove, fields)).ok).toBe(false);
      expect((await run(priceReject, fields)).ok).toBe(false);
    }
    expect(clientsBuilt).toBe(0);
    expect(rpc).toHaveLength(0);
  });

  it("reject distinguishes a withdrawal by the proposer", async () => {
    replies.tw4_price_reject = { data: { status: "rejected", replayed: false, withdrawn: true } };
    expect((await run(priceReject, { requestId: REQ, note: NOTE })).message).toMatch(/withdrawn/);
    replies.tw4_price_reject = { data: { status: "rejected", replayed: false, withdrawn: false } };
    expect((await run(priceReject, { requestId: REQ, note: NOTE })).message).toMatch(/rejected/);
    expect(rpc.every((c) => c.fn === "tw4_price_reject" && !("p_actor" in c.args))).toBe(true);
  });
});

describe("single-owner ceremony actions", () => {
  const CH = { nonce: "bm9uY2U", challenge: "Y2hhbGxlbmdl", rp_id: "admin.example.test", allow_credentials: ["Y3JlZA"], expires_in_seconds: 300,
    summary: { kind: "number", scope: "studio_sms_price_list", old_customer_cents: 200, old_provider_cents: 115, new_customer_cents: 250, new_provider_cents: 115, description: "d", proposal_version: 1, request_id: REQ, hash: "ab" } };
  const FIN = { requestId: REQ, nonce: "bm9uY2U", credentialId: "Y3JlZA", authData: "YXV0aA", clientData: "Y2xpZW50", signature: "c2ln" };

  it("begin and finish run the aal2 guard first, send NO actor, validate shapes before any client is built, and pass the database's answer through", async () => {
    for (const [action, arg] of [[priceAuthzBegin, REQ], [priceAuthzFinish, FIN]] as const) {
      state.tiers.length = 0;
      state.refuse = "STEPUP_REFUSED";
      await expect((action as (a: never) => Promise<unknown>)(arg as never)).rejects.toThrow("STEPUP_REFUSED");
      expect(state.tiers).toEqual(["aal2"]);
    }
    expect(clientsBuilt).toBe(0);
    state.refuse = null;
    replies.tw4_price_authz_begin = { data: CH };
    const b = await priceAuthzBegin(REQ);
    expect(b).toMatchObject({ ok: true, data: { nonce: "bm9uY2U", rpId: "admin.example.test", allowCredentials: ["Y3JlZA"], summary: { newCustomerCents: 250, oldCustomerCents: 200, kind: "number" } } });
    expect(rpc[0]).toEqual({ fn: "tw4_price_authz_begin", args: { p_request_id: REQ } });
    expect(await priceAuthzBegin("not-a-uuid")).toMatchObject({ ok: false });
    // a malformed database answer is not shown as a challenge
    replies.tw4_price_authz_begin = { data: { ...CH, allow_credentials: [] } };
    expect(await priceAuthzBegin(REQ)).toMatchObject({ ok: false });
    replies.tw4_price_authz_finish = { data: { status: "rejected", reason: "signature does not verify" } };
    expect(await priceAuthzFinish(FIN)).toMatchObject({ ok: true, data: { status: "rejected", reason: "signature does not verify" } });
    expect(rpc.at(-1)).toEqual({ fn: "tw4_price_authz_finish", args: { p_request_id: REQ, p_nonce: "bm9uY2U", p_credential_id: "Y3JlZA", p_auth_data: "YXV0aA", p_client_data: "Y2xpZW50", p_signature: "c2ln" } });
    const calls = rpc.length;
    for (const bad of [{ ...FIN, requestId: "x" }, { ...FIN, nonce: "!!" }, { ...FIN, signature: "" }, { ...FIN, credentialId: "a b" }, { ...FIN, authData: "x".repeat(5000) }]) expect(await priceAuthzFinish(bad)).toMatchObject({ ok: false });
    expect(rpc.length).toBe(calls);
  });

  it("revise, freeze and the compromise report: guard tiers, validation before any call, no actor, fixed sentences", async () => {
    replies.tw4_price_revise = { data: { request_id: REQ, version: 2 } };
    const r = await run(priceRevise, { requestId: REQ, customerUsd: "3.00", providerUsd: "1.15", description: "revised price", reason: "a revised written reason" });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/cooling-off starts again/);
    expect(rpc.at(-1)).toEqual({ fn: "tw4_price_revise", args: { p_request_id: REQ, p_customer_cents: 300, p_provider_cents: 115, p_description: "revised price", p_reason: "a revised written reason" } });
    const n = rpc.length;
    expect((await run(priceRevise, { requestId: "x", customerUsd: "3.00", providerUsd: "1", description: "abc", reason: "a revised written reason" })).ok).toBe(false);
    expect((await run(priceFreeze, { reason: "short" })).ok).toBe(false);
    expect((await run(priceReportCompromise, { note: "x" })).ok).toBe(false);
    expect(rpc.length).toBe(n);
    replies.tw4_price_freeze = { data: { status: "frozen", replayed: false } };
    expect(await run(priceFreeze, { reason: "a written reason for the suspension" })).toMatchObject({ ok: true });
    replies.tw4_price_report_compromise = { data: { status: "frozen" } };
    expect(await run(priceReportCompromise, { note: "I suspect my key is compromised" })).toMatchObject({ ok: true });
    replies.tw4_price_authz_begin = { error: { code: "TW045", message: "SECRET detail" } };
    const cool = await priceAuthzBegin(REQ);
    expect(cool).toMatchObject({ ok: false, message: expect.stringMatching(/cooling-off/) });
    expect(JSON.stringify(cool)).not.toContain("SECRET");
  });
});

describe("review fixes: refused answers and credential ceremonies", () => {
  const ID = "Y3JlZA";
  it("a recorded refusal from begin reads as the same fixed sentence as the error path, never the database text", async () => {
    replies.tw4_price_authz_begin = { data: { status: "refused", code: "TW045", reason: "SECRET detail" } };
    const r = await priceAuthzBegin(REQ);
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/cooling-off/) });
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("credential actions: aal2 guard first, shapes validated before any client, no actor sent, answers passed through", async () => {
    const calls: [() => Promise<unknown>][] = [
      [() => priceCredBegin({ purpose: "thaw" })], [() => priceCredEnroll({} as never)], [() => priceCredRevoke({} as never)],
      [() => priceThaw({} as never)], [() => priceCredApply(REQ)], [() => priceCredCancel({} as never)], [() => priceCredPending()],
    ];
    const built = clientsBuilt;
    for (const [c] of calls) {
      state.tiers.length = 0;
      state.refuse = "STEPUP_REFUSED";
      await expect(c()).rejects.toThrow("STEPUP_REFUSED");
      expect(state.tiers).toEqual(["aal2"]);
    }
    state.refuse = null;
    expect(clientsBuilt).toBe(built);
    // malformed input never reaches the database
    const n = rpc.length;
    expect(await priceCredBegin({ purpose: "enroll", credentialId: "a b", x: "x", y: "y", role: "spare", label: "spare key" })).toMatchObject({ ok: false });
    expect(await priceCredBegin({ purpose: "bogus" })).toMatchObject({ ok: false });
    expect(await priceCredEnroll({ nonce: ID } as never)).toMatchObject({ ok: false });
    expect(await priceThaw({ nonce: ID, credentialId: ID, authData: ID, clientData: ID, signature: "" })).toMatchObject({ ok: false });
    expect(await priceCredApply("nope")).toMatchObject({ ok: false });
    expect(await priceCredCancel({ changeId: REQ, nonce: ID, credentialId: ID, authData: ID, clientData: ID, signature: "" })).toMatchObject({ ok: false });
    expect(await priceCredBegin({ purpose: "cancel", changeId: "nope" })).toMatchObject({ ok: false });
    expect(rpc.length).toBe(n);
    replies.tw4_price_cred_begin = { data: { nonce: ID, challenge: ID, rp_id: "admin.example.test", allow_credentials: [ID] } };
    expect(await priceCredBegin({ purpose: "thaw" })).toMatchObject({ ok: true, data: { rpId: "admin.example.test", allowCredentials: [ID] } });
    replies.tw4_price_cred_begin = { data: { nonce: ID, challenge: ID, rp_id: "admin.example.test", allow_credentials: [ID] } };
    expect(await priceCredBegin({ purpose: "cancel", changeId: REQ })).toMatchObject({ ok: true });
    expect(rpc.at(-1)).toEqual({ fn: "tw4_price_cred_begin", args: { p_purpose: "cancel", p_cred_id: null, p_x: null, p_y: null, p_role: null, p_label: REQ } });
    replies.tw4_price_cred_cancel = { data: { status: "rejected", reason: "nope" } };
    expect(await priceCredCancel({ changeId: REQ, nonce: ID, credentialId: ID, authData: ID, clientData: ID, signature: ID })).toMatchObject({ ok: true, data: { status: "rejected", reason: "nope" } });
    replies.tw4_price_thaw = { data: { status: "refused", reason: "stale" } };
    expect(await priceThaw({ nonce: ID, credentialId: ID, authData: ID, clientData: ID, signature: ID })).toMatchObject({ ok: true, data: { status: "refused", reason: "stale" } });
    replies.tw4_price_cred_begin = { data: { nonce: ID, challenge: ID, rp_id: "admin.example.test", allow_credentials: [ID] } };
    expect(await priceCredBegin({ purpose: "recover_freeze" })).toMatchObject({ ok: true });
    expect(await priceCredBegin({ purpose: "recover_enroll", credentialId: ID, x: ID, y: ID, label: "ab" })).toMatchObject({ ok: false });
    replies.tw4_price_recovery_freeze = { data: { status: "frozen" } };
    expect(await priceRecoveryFreeze({ nonce: ID, credentialId: ID, authData: ID, clientData: ID, signature: ID })).toMatchObject({ ok: true, data: { status: "frozen" } });
    expect(await priceRecoveryFreeze({ nonce: ID, credentialId: ID, authData: ID, clientData: ID, signature: "" })).toMatchObject({ ok: false });
    replies.tw4_price_recovery_enroll = { data: { status: "pending", change_id: REQ } };
    const re = { nonce: ID, newCredentialId: ID, x: ID, y: ID, label: "recovered key", recCredentialId: ID, recAuth: ID, recClient: ID, recSig: ID, newAuth: ID, newClient: ID, newSig: ID };
    expect(await priceRecoveryEnroll(re)).toMatchObject({ ok: true, data: { status: "pending", changeId: REQ } });
    expect(await priceRecoveryEnroll({ ...re, label: "x" })).toMatchObject({ ok: false });
    replies.tw4_price_cred_pending = { data: { pending: [{ change_id: REQ, kind: "enroll", label: "spare", role: "spare", effective_at: "2026-11-02T00:00:00Z" }, { kind: "bogus" }], credentials: [{ id: ID, role: "primary", label: "main" }, { id: "!!" }] } };
    const s = await priceCredPending();
    expect(s).toMatchObject({ ok: true, data: { pending: [{ changeId: REQ, kind: "enroll" }], credentials: [{ id: ID }] } });
    expect(rpc.every((c) => !("p_actor" in c.args))).toBe(true);
  });
});
