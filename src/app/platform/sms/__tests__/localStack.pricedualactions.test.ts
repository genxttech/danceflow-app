/**
 * D4-1 (application layer): the REAL price-change server actions (pricePropose / priceApprove / priceReject), the REAL role check (requirePlatformAdmin) and the REAL
 * session-assurance check (requirePlatformStepUp, aal2 / recent tier), against the throwaway database. Only the edges are simulated: the Supabase session (user, profile
 * lookup, verified JWT claims) and the service-role RPC client, which here executes the same RPC in the local Docker database. Same method as localStack.wpd4actions.
 *
 * LOCAL QA DATABASE ONLY (TW4A_LOCAL_DB_CONTAINER + TW4RFL_DB + marker). No hosted service, no real credentials, no provider call.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });
vi.mock("server-only", () => ({}));

const S = vi.hoisted(() => ({
  user: "" as string,
  claims: null as Record<string, unknown> | null,
  claimsError: false,
  redirects: [] as string[],
  cookieWrites: [] as { name: string; value: string }[],
  rpc: [] as { fn: string; args: Record<string, unknown> }[],
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    S.redirects.push(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: (name: string, value: string) => S.cookieWrites.push({ name, value }) }) }));
vi.mock("@/lib/supabase/server", async () => {
  const h = await import("../../../../lib/sms/twilioIsv/__tests__/wpd4Helpers");
  return {
    createClient: async () => ({
      auth: {
        getUser: async () => ({ data: { user: S.user ? { id: S.user } : null }, error: null }),
        getClaims: async () => (S.claimsError ? { data: null, error: { message: "unavailable" } } : { data: { claims: S.claims }, error: null }),
      },
      from: (_t: string) => ({
        select: () => ({
          eq: (_c: string, id: string) => ({
            maybeSingle: async () => {
              const found = h.psql(`select count(*) from public.profiles where id = '${id}'`) === "1";
              const role = found ? h.psql(`select coalesce(platform_role, '') from public.profiles where id = '${id}'`) : "";
              return !found ? { data: null, error: null } : { data: { id, email: null, platform_role: role === "" ? null : role }, error: null };
            },
          }),
        }),
      }),
    }),
  };
});
vi.mock("@/lib/supabase/admin", async () => {
  const h = await import("../../../../lib/sms/twilioIsv/__tests__/wpd4Helpers");
  return {
    createAdminClient: () => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        S.rpc.push({ fn, args });
        const named = Object.entries(args).map(([k, v]) => `${k} => ${h.lit(v)}`).join(", ");
        const err = h.psqlError(`select to_jsonb(public.${fn}(${named}))::text;`);
        if (err) return { data: null, error: { code: h.codeOf(err) || "unknown", message: "db refusal" } };
        return { data: JSON.parse(h.psql(`select to_jsonb(public.${fn}(${named}))::text;`) || "null"), error: null };
      },
    }),
  };
});

import { A, B, C, D, E, F, call, enabled, num, psql, rows, seedCast, seedPrices } from "../../../../lib/sms/twilioIsv/__tests__/wpd4Helpers";
import { ownerReactivate } from "../../../../lib/sms/twilioIsv/__tests__/priceFixture";
import { priceApprove, pricePropose, priceReject } from "../priceChangeActions";

const nowS = () => Math.floor(Date.now() / 1000);
const claimsFor = (sub: string, over: Record<string, unknown> = {}) => ({ sub, exp: nowS() + 3600, aal: "aal2", amr: [{ method: "totp", timestamp: nowS() - 60 }], ...over });
const aal1 = (sub: string) => claimsFor(sub, { aal: "aal1", amr: [{ method: "password", timestamp: nowS() - 30 }] });
const session = (user: string, claims: Record<string, unknown> | null) => {
  S.user = user;
  S.claims = claims;
  S.claimsError = false;
};
function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
async function run(action: (f: FormData) => Promise<unknown>, fields: Record<string, string>) {
  await expect(action(form(fields))).rejects.toThrow(/NEXT_REDIRECT/);
  const url = S.redirects[S.redirects.length - 1];
  const flash = S.cookieWrites.length ? (JSON.parse(S.cookieWrites[S.cookieWrites.length - 1].value) as { ok: boolean; message: string }) : null;
  return { url, flash, rpcCalls: S.rpc.length };
}
const active = (kind: string) => rows<{ id: string; customer_price_cents: number }>(`select id, customer_price_cents from public.studio_sms_price_list where kind = '${kind}' and active`);
const preq = (id: string) => rows<{ status: string; requested_by: string; decided_by: string | null; applied_price_id: string | null }>(`select status, requested_by, decided_by, applied_price_id from public.studio_sms_price_change_requests where id = '${id}'`)[0];
const openFor = (kind: string) => rows<{ id: string; requested_by: string }>(`select id, requested_by from public.studio_sms_price_change_requests where kind = '${kind}' and status = 'pending'`);
const PROPOSAL = { kind: "number", customerUsd: "2.50", providerUsd: "1.15", description: "Phone number rent (app test)", reason: "an application-layer test of the dual-control flow" };
const NOTE = "approved after reading the proposal and the Twilio invoice";

describe.skipIf(!enabled)("D4-1 application layer: AAL / role gates in front of the price dual-control RPCs (real actions, real database)", () => {
  let reqId: string;
  let seq = 0;
  beforeAll(() => {
    seedCast();
    seedPrices();
  });
  beforeEach(() => {
    S.redirects.length = 0;
    S.cookieWrites.length = 0;
    S.rpc.length = 0;
    for (const r of openFor("number")) call("tw4_price_reject", r.id, r.requested_by, "withdrawn to start the next scenario clean");
    // a fresh proposal by administrator A, made straight in the database
    reqId = call<{ request_id: string }>("tw4_price_propose", "number", 300 + (seq += 1), 115, "app layer proposal", "a proposal made straight in the database for the app test", A).request_id;
  });

  it("APP-P01 aal1 second administrator D: approve is redirected to the MFA challenge (reason=aal1), NO database call is made, the request stays pending and no price changes", async () => {
    const before = active("number");
    session(D, aal1(D));
    const r = await run(priceApprove, { requestId: reqId, note: NOTE });
    expect(r.url).toMatch(/^\/platform-mfa\/challenge\?stepup=1&reason=aal1&/);
    expect(r.rpcCalls).toBe(0);
    expect(preq(reqId)).toMatchObject({ status: "pending", decided_by: null });
    expect(active("number")).toEqual(before);
  });

  it("APP-P02 aal2 but the authenticator code is older than 15 minutes: approve (recent tier) is refused reason=stale, no database call", async () => {
    session(B, claimsFor(B, { amr: [{ method: "totp", timestamp: nowS() - 20 * 60 }] }));
    const r = await run(priceApprove, { requestId: reqId, note: NOTE });
    expect(r.url).toMatch(/reason=stale/);
    expect(r.rpcCalls).toBe(0);
    expect(preq(reqId).status).toBe("pending");
  });

  it("APP-P03 aal2 + fresh TOTP administrator B: the approval reaches the database as actor B and the new price is published, decided by B (not the proposer A)", async () => {
    session(B, claimsFor(B));
    const r = await run(priceApprove, { requestId: reqId, note: NOTE });
    expect(r.url).toMatch(/price=1/);
    expect(r.flash).toMatchObject({ ok: true });
    expect(S.rpc).toHaveLength(1);
    expect(S.rpc[0]).toMatchObject({ fn: "tw4_price_approve", args: { p_request_id: reqId, p_actor: B } });
    const row = preq(reqId);
    expect(row).toMatchObject({ status: "applied", requested_by: A, decided_by: B });
    expect(active("number")).toEqual([expect.objectContaining({ id: row.applied_price_id })]);
  });

  it("APP-P04 self-approval through the real action: administrator A (aal2, fresh) approving A's own proposal reaches the database and is refused 42501; still pending; no price published", async () => {
    const before = active("number");
    session(A, claimsFor(A));
    const r = await run(priceApprove, { requestId: reqId, note: NOTE });
    expect(r.flash).toMatchObject({ ok: false });
    expect(r.flash!.message).toMatch(/can never be approved by the administrator who proposed it/);
    expect(preq(reqId)).toMatchObject({ status: "pending", decided_by: null });
    expect(active("number")).toEqual(before);
  });

  it("APP-P05 aal1 administrator D cannot PROPOSE (recent tier) or REJECT (aal2 tier): both redirected reason=aal1, no database call, nothing created or decided", async () => {
    session(D, aal1(D));
    const open = num(`select count(*) from public.studio_sms_price_change_requests`);
    const a = await run(pricePropose, { ...PROPOSAL, kind: "monthly" });
    expect(a.url).toMatch(/reason=aal1/);
    expect(a.rpcCalls).toBe(0);
    expect(num(`select count(*) from public.studio_sms_price_change_requests`)).toBe(open);
    S.redirects.length = 0;
    const b = await run(priceReject, { requestId: reqId, note: "rejection attempt from an aal1 session" });
    expect(b.url).toMatch(/reason=aal1/);
    expect(b.rpcCalls).toBe(0);
    expect(preq(reqId).status).toBe("pending");
  });

  it("APP-P06 the verified token must belong to the signed-in administrator (subject_mismatch), must not be expired (session_expired), must carry TOTP (no_totp), and claims must be readable (claims_unavailable): all refused before any database call", async () => {
    const cases: Array<[string, () => void]> = [
      ["subject_mismatch", () => session(B, claimsFor(A))],
      ["session_expired", () => session(B, claimsFor(B, { exp: nowS() - 5 }))],
      ["no_totp", () => session(B, claimsFor(B, { amr: [{ method: "password", timestamp: nowS() }] }))],
      ["claims_unavailable", () => { session(B, null); S.claimsError = true; }],
    ];
    for (const [reason, setup] of cases) {
      S.redirects.length = 0;
      setup();
      const r = await run(priceApprove, { requestId: reqId, note: NOTE });
      expect(r.url, reason).toMatch(new RegExp(`reason=${reason}`));
      expect(r.rpcCalls, reason).toBe(0);
    }
    expect(preq(reqId).status).toBe("pending");
  });

  it("APP-P07 non-administrator C, and deactivated administrator E are redirected to /app by the role check: no database call, nothing proposed or decided", async () => {
    const before = num(`select count(*) from public.studio_sms_price_change_requests`);
    for (const who of [C, E]) {
      for (const action of [priceApprove, pricePropose, priceReject]) {
        S.redirects.length = 0;
        session(who, claimsFor(who));
        const r = await run(action, { requestId: reqId, note: NOTE, ...PROPOSAL });
        expect(r.url, who).toBe("/app");
        expect(r.rpcCalls, who).toBe(0);
      }
    }
    expect(preq(reqId).status).toBe("pending");
    expect(num(`select count(*) from public.studio_sms_price_change_requests`)).toBe(before);
  });

  it("APP-P08 the actor is the SESSION's administrator, never a form field: a forged actor / p_actor / requestedBy in the form does not change who proposes or decides", async () => {
    session(B, claimsFor(B));
    const r = await run(priceApprove, { requestId: reqId, note: NOTE, actor: A, actorId: A, p_actor: A, decidedBy: A, requestedBy: A });
    expect(r.flash).toMatchObject({ ok: true });
    expect(S.rpc[0].args.p_actor).toBe(B);
    expect(preq(reqId).decided_by).toBe(B);
    S.rpc.length = 0;
    session(F, claimsFor(F));
    const p = await run(pricePropose, { ...PROPOSAL, kind: "monthly", customerUsd: "13.37", actor: A, actorId: A, p_actor: A, requestedBy: A });
    expect(p.flash).toMatchObject({ ok: true });
    expect(S.rpc[0].args.p_actor).toBe(F);
    const row = rows<{ requested_by: string; customer_price_cents: number; status: string }>(`select requested_by, customer_price_cents, status from public.studio_sms_price_change_requests where kind = 'monthly' and customer_price_cents = 1337`)[0];
    expect(row).toMatchObject({ requested_by: F, status: "pending" });
    call("tw4_price_reject", rows<{ id: string }>(`select id from public.studio_sms_price_change_requests where kind = 'monthly' and status = 'pending'`)[0].id, F, "withdrawn: the forged-actor scenario is over");
  });

  it("APP-P09 propose through the real action: dollars become cents, the request is pending for the session administrator, NO price changes; invalid forms never reach the database", async () => {
    for (const r of openFor("number")) call("tw4_price_reject", r.id, r.requested_by, "withdrawn to start the next scenario clean");
    const before = active("number");
    session(A, claimsFor(A));
    const ok = await run(pricePropose, { ...PROPOSAL, customerUsd: "2.51" });
    expect(ok.flash).toMatchObject({ ok: true });
    expect(active("number")).toEqual(before);
    expect(openFor("number")[0]).toBeTruthy();
    expect(num(`select customer_price_cents from public.studio_sms_price_change_requests where kind = 'number' and status = 'pending'`)).toBe(251);
    S.rpc.length = 0;
    for (const bad of [{ ...PROPOSAL, kind: "bogus" }, { ...PROPOSAL, customerUsd: "0" }, { ...PROPOSAL, customerUsd: "-3" }, { ...PROPOSAL, description: "x" }, { ...PROPOSAL, reason: "short" }]) {
      const r = await run(pricePropose, bad);
      expect(r.flash).toMatchObject({ ok: false });
    }
    expect(S.rpc).toHaveLength(0);
    // a second proposal for the same kind is refused by the database (TW041) and says why
    const dup = await run(pricePropose, { ...PROPOSAL, customerUsd: "2.52" });
    expect(dup.flash).toMatchObject({ ok: false });
    expect(dup.flash!.message).toMatch(/another proposal for this price is still open/);
  });

  it("APP-P10 reject needs aal2 (not recency): an aal2 administrator with an old code may reject; the request becomes rejected by that administrator and no price changes", async () => {
    const before = active("number");
    session(F, claimsFor(F, { amr: [{ method: "totp", timestamp: nowS() - 3 * 3600 }] }));
    const r = await run(priceReject, { requestId: reqId, note: "rejected by a third administrator after review" });
    expect(r.flash).toMatchObject({ ok: true });
    expect(preq(reqId)).toMatchObject({ status: "rejected", decided_by: F });
    expect(active("number")).toEqual(before);
  });

  it("APP-P11 a stale or expired proposal approved through the action is a REFUSAL (flash not ok) and publishes nothing", async () => {
    const base = active("number")[0];
    psql(`update public.studio_sms_price_list set active = false where id = '${base.id}'`);
    session(B, claimsFor(B));
    const r = await run(priceApprove, { requestId: reqId, note: NOTE });
    expect(r.flash).toMatchObject({ ok: false });
    expect(r.flash!.message).toMatch(/invalidated/);
    expect(preq(reqId).status).toBe("invalidated");
    expect(active("number")).toHaveLength(0);
    ownerReactivate(psql, `id = '${base.id}'`); // put the fixture price back (owner-level; the production trigger refuses it for everyone else)
  });
});
