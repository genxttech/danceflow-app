/**
 * WP-D4 (application layer): the REAL platform-admin server actions for dual control (rflDualRequestAction / rflDualApproveAction / rflDualRejectAction), the REAL role check
 * (requirePlatformAdmin) and the REAL session-assurance check (requirePlatformStepUp, aal2 / recent tier), against the throwaway database.
 * Only the edges are simulated: the Supabase session (user, profile lookup, verified JWT claims) and the service-role RPC client, which here executes the same RPC in the
 * local Docker database. This is where AAL is enforced for the dual-control RPCs: those take p_actor from the service-role caller and check the profile role only.
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
              const role = h.psql(`select coalesce((select platform_role from public.profiles where id = '${id}'), '#none')`);
              return role === "#none" ? { data: null, error: null } : { data: { id, email: null, platform_role: role === "" ? null : role }, error: null };
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

import { A, B, C, D, E, F, NOTE, REASON, absorbRequest, enabled, exposed, num, reqRow, seedCast, seedPrices, world } from "../../../../lib/sms/twilioIsv/__tests__/wpd4Helpers";
import { rflDualApproveAction, rflDualRejectAction, rflDualRequestAction } from "../recurringFeeActions";

const nowS = () => Math.floor(Date.now() / 1000);
const claimsFor = (sub: string, over: Record<string, unknown> = {}) => ({ sub, exp: nowS() + 3600, aal: "aal2", amr: [{ method: "totp", timestamp: nowS() - 60 }], ...over });
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

describe.skipIf(!enabled)("WP-D4 application layer: AAL / role gates in front of the dual-control RPCs (real actions, real database)", () => {
  let reqId: string;
  let mkReq: () => string;
  beforeAll(() => {
    seedCast();
    seedPrices();
    mkReq = () => {
      const w = world();
      const { res, key } = exposed(w, "number");
      return absorbRequest(res.resource_id, key, A, REASON).request_id;
    };
  });
  beforeEach(() => {
    S.redirects.length = 0;
    S.cookieWrites.length = 0;
    S.rpc.length = 0;
    reqId = mkReq();
  });

  it("APP-01 aal1 second administrator D: approve is redirected to the MFA challenge (reason=aal1), NO database call is made, the request stays pending", async () => {
    session(D, claimsFor(D, { aal: "aal1", amr: [{ method: "password", timestamp: nowS() - 30 }] }));
    const r = await run(rflDualApproveAction, { requestId: reqId, note: NOTE });
    expect(r.url).toMatch(/^\/platform-mfa\/challenge\?stepup=1&reason=aal1&/);
    expect(r.rpcCalls).toBe(0);
    expect(reqRow(reqId)).toMatchObject({ status: "pending", decided_by: null });
  });

  it("APP-02 aal2 but the authenticator code is older than 15 minutes: approve (recent tier) is refused reason=stale, no database call", async () => {
    session(B, claimsFor(B, { amr: [{ method: "totp", timestamp: nowS() - 20 * 60 }] }));
    const r = await run(rflDualApproveAction, { requestId: reqId, note: NOTE });
    expect(r.url).toMatch(/reason=stale/);
    expect(r.rpcCalls).toBe(0);
    expect(reqRow(reqId).status).toBe("pending");
  });

  it("APP-03 aal2 + fresh TOTP administrator B: the approval reaches the database as actor B and the request becomes approved by B", async () => {
    session(B, claimsFor(B));
    const r = await run(rflDualApproveAction, { requestId: reqId, note: NOTE });
    expect(r.url).toMatch(/rfl=1/);
    expect(r.flash).toMatchObject({ ok: true });
    expect(S.rpc).toHaveLength(1);
    expect(S.rpc[0]).toMatchObject({ fn: "tw4_rfl_dual_approve", args: { p_request_id: reqId, p_actor: B } });
    expect(reqRow(reqId)).toMatchObject({ status: "approved", requested_by: A, decided_by: B });
  });

  it("APP-04 self-approval through the real action: administrator A (aal2, fresh) approving A's own request reaches the database and is refused 42501; still pending", async () => {
    session(A, claimsFor(A));
    const r = await run(rflDualApproveAction, { requestId: reqId, note: NOTE });
    expect(r.flash).toMatchObject({ ok: false });
    expect(r.flash!.message).toMatch(/can never be approved by the administrator who made it/);
    expect(reqRow(reqId)).toMatchObject({ status: "pending", decided_by: null });
  });

  it("APP-05 aal1 administrator D cannot REQUEST (recent tier) or REJECT (aal2 tier): both redirected reason=aal1, no database call, the request is untouched", async () => {
    session(D, claimsFor(D, { aal: "aal1", amr: [{ method: "password", timestamp: nowS() }] }));
    const w = world();
    const { res, key } = exposed(w, "number");
    const a = await run(rflDualRequestAction, { action: "absorb_exposure", resourceId: res.resource_id, periodKey: key, reason: REASON });
    expect(a.url).toMatch(/reason=aal1/);
    expect(a.rpcCalls).toBe(0);
    expect(num(`select count(*) from public.studio_sms_rfl_dual_requests where resource_id = '${res.resource_id}'`)).toBe(0);
    S.redirects.length = 0;
    const b = await run(rflDualRejectAction, { requestId: reqId, note: "rejection attempt from an aal1 session" });
    expect(b.url).toMatch(/reason=aal1/);
    expect(b.rpcCalls).toBe(0);
    expect(reqRow(reqId).status).toBe("pending");
  });

  it("APP-06 the verified token must belong to the signed-in administrator (subject_mismatch), must not be expired (session_expired), must carry TOTP (no_totp), and claims must be readable (claims_unavailable): all refused before any database call", async () => {
    const cases: Array<[string, () => void]> = [
      ["subject_mismatch", () => session(B, claimsFor(A))],
      ["session_expired", () => session(B, claimsFor(B, { exp: nowS() - 5 }))],
      ["no_totp", () => session(B, claimsFor(B, { amr: [{ method: "password", timestamp: nowS() }] }))],
      ["claims_unavailable", () => { session(B, null); S.claimsError = true; }],
    ];
    for (const [reason, setup] of cases) {
      S.redirects.length = 0;
      setup();
      const r = await run(rflDualApproveAction, { requestId: reqId, note: NOTE });
      expect(r.url, reason).toMatch(new RegExp(`reason=${reason}`));
      expect(r.rpcCalls, reason).toBe(0);
    }
    expect(reqRow(reqId).status).toBe("pending");
  });

  it("APP-07 non-administrator C and deactivated administrator E are redirected to /app by the role check: no database call, nothing created or decided", async () => {
    for (const who of [C, E]) {
      S.redirects.length = 0;
      session(who, claimsFor(who));
      const r = await run(rflDualApproveAction, { requestId: reqId, note: NOTE });
      expect(r.url, who).toBe("/app");
      expect(r.rpcCalls, who).toBe(0);
    }
    expect(reqRow(reqId).status).toBe("pending");
  });

  it("APP-08 the actor is the SESSION's administrator, never a form field: a forged actor / p_actor in the form does not change who decides", async () => {
    session(B, claimsFor(B));
    const r = await run(rflDualApproveAction, { requestId: reqId, note: NOTE, actor: A, actorId: A, p_actor: A, decidedBy: A });
    expect(r.flash).toMatchObject({ ok: true });
    expect(S.rpc[0].args.p_actor).toBe(B);
    expect(reqRow(reqId).decided_by).toBe(B);
  });

  it("APP-09 reject needs aal2 (not recency): an aal2 administrator with an old code may reject; the request becomes rejected by that administrator", async () => {
    session(F, claimsFor(F, { amr: [{ method: "totp", timestamp: nowS() - 3 * 3600 }] }));
    const r = await run(rflDualRejectAction, { requestId: reqId, note: "rejected by a third administrator after review" });
    expect(r.flash).toMatchObject({ ok: true });
    expect(reqRow(reqId)).toMatchObject({ status: "rejected", decided_by: F });
  });
});
