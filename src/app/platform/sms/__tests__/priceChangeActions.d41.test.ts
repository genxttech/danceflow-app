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

import { priceApprove, pricePropose, priceReject } from "../priceChangeActions";

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
  it("converts dollars to cents, sends the SESSION administrator as the actor (a forged actor / requester in the form is ignored) and says nothing changed", async () => {
    replies.tw4_price_propose = { data: { request_id: REQ, status: "pending", replayed: false } };
    const r = await run(pricePropose, { ...GOOD, actor: "x", actorId: "x", p_actor: "x", requestedBy: "x" });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/no price has changed/);
    expect(r.url).toBe("/platform/sms?price=1#price-changes");
    expect(rpc).toEqual([{ fn: "tw4_price_propose", args: { p_kind: "number", p_customer_cents: 325, p_provider_cents: 115, p_description: "Phone number rent", p_reason: "Twilio raised the monthly number rent", p_actor: ADMIN } }]);
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
  it("approve sends the session administrator and the note, nothing else from the form; an applied result is a success", async () => {
    replies.tw4_price_approve = { data: { status: "applied", replayed: false, price_id: REQ } };
    const r = await run(priceApprove, { requestId: REQ, note: NOTE, actor: "x", p_actor: "x", customerUsd: "999" });
    expect(r.ok).toBe(true);
    expect(rpc).toEqual([{ fn: "tw4_price_approve", args: { p_request_id: REQ, p_actor: ADMIN, p_note: NOTE } }]);
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
    expect(rpc.every((c) => c.fn === "tw4_price_reject" && c.args.p_actor === ADMIN)).toBe(true);
  });
});
