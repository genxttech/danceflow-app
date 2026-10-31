import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { runOperatorAction, buildOperatorCall, type OperatorDeps } from "../operator";

const SQL = readFileSync("src/lib/supabase/migrations/20270205090000_d24_operator_actions.sql", "utf8");
const USER = "00000000-0000-0000-0000-0000000000c1";
const INV = "00000000-0000-0000-0000-0000000000d1";
const NOW = 1_800_000_000;
const REASON = "reviewed against the Stripe dashboard";
const goodClaims = { sub: USER, exp: NOW + 600, aal: "aal2", amr: [{ method: "totp", timestamp: NOW - 60 }] };

function deps(over: Partial<OperatorDeps> = {}, data: unknown = { outcome: "ok" }, error: { code?: string; message?: string } | null = null) {
  const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({ data, error }));
  return { d: { env: { D24_OPERATOR_ACTIONS: "enabled" }, nowSeconds: NOW, userId: USER, claims: goodClaims, rpc, ...over } as OperatorDeps, rpc };
}

describe("gates (fail closed, before any database call)", () => {
  it("is dark unless D24_OPERATOR_ACTIONS is exactly 'enabled'", async () => {
    for (const env of [{}, { D24_OPERATOR_ACTIONS: "on" }, { D24_OPERATOR_ACTIONS: "ENABLED" }, { D24_OPERATOR_ACTIONS: "" }]) {
      const { d, rpc } = deps({ env });
      expect(await runOperatorAction(d, "dismiss", { invoiceRowId: INV, reason: REASON })).toEqual({ ok: false, code: "disabled" });
      expect(rpc).not.toHaveBeenCalled();
    }
  });
  it("needs a signed-in user", async () => {
    const { d, rpc } = deps({ userId: null });
    expect(await runOperatorAction(d, "dismiss", { invoiceRowId: INV, reason: REASON })).toEqual({ ok: false, code: "unauthenticated" });
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each([
    ["no claims", null, "claims_unavailable"],
    ["aal1", { ...goodClaims, aal: "aal1" }, "aal1"],
    ["no totp method", { ...goodClaims, amr: [{ method: "password", timestamp: NOW }] }, "no_totp"],
    ["expired token", { ...goodClaims, exp: NOW - 1 }, "session_expired"],
    ["claims of another subject", { ...goodClaims, sub: "00000000-0000-0000-0000-0000000000ff" }, "subject_mismatch"],
  ])("refuses %s", async (_n, claims, assurance) => {
    const { d, rpc } = deps({ claims: claims as never });
    expect(await runOperatorAction(d, "requeue", { providerEventId: "evt_1", reason: REASON })).toEqual({ ok: false, code: "mfa_required", assurance });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("input validation and the allow-listed RPC call", () => {
  it.each([
    ["acknowledge", { invoiceRowId: INV, codes: ["unverified_void_origin"], reason: "short" }],
    ["acknowledge", { invoiceRowId: "not-a-uuid", codes: ["unverified_void_origin"], reason: REASON }],
    ["acknowledge", { invoiceRowId: INV, codes: [], reason: REASON }],
    ["acknowledge", { invoiceRowId: INV, codes: ["Bad Code; drop"], reason: REASON }],
    ["dismiss", { invoiceRowId: INV, reason: "          " }],
    ["dismiss", { invoiceRowId: INV, reason: "x".repeat(1001) }],
    ["requeue", { providerEventId: "in_1", reason: REASON }],
    ["requeue", { providerEventId: "evt_1", reason: 42 }],
    ["list_invoices", { state: "bogus" }],
    ["list_invoices", { limit: 5000 }],
    ["list_deferred", { state: "weird" }],
    ["get_invoice", {}],
  ] as const)("rejects invalid %s input without a database call", async (action, input) => {
    const { d, rpc } = deps();
    expect(await runOperatorAction(d, action, input as never)).toEqual({ ok: false, code: "invalid_input" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("builds exact argument sets and trims the reason; an actor or studio smuggled into the input never reaches the database", () => {
    const hostile = { invoiceRowId: INV, codes: ["a_code", "a_code"], reason: `  ${REASON}  `, actor: "x", p_actor: "x", userId: "x", studioId: "x", p_studio_id: "x" };
    expect(buildOperatorCall("acknowledge", hostile)).toEqual({
      fn: "d24_op_acknowledge_anomalies",
      args: { p_invoice_row_id: INV, p_codes: ["a_code"], p_reason: REASON },
    });
    expect(buildOperatorCall("dismiss", hostile)).toEqual({ fn: "d24_op_dismiss_unmatched", args: { p_invoice_row_id: INV, p_reason: REASON } });
    expect(buildOperatorCall("requeue", { providerEventId: "evt_9", reason: REASON, actor: "x" })).toEqual({
      fn: "d24_op_requeue_deferred",
      args: { p_provider_event_id: "evt_9", p_reason: REASON },
    });
    for (const a of ["acknowledge", "dismiss", "requeue", "list_invoices", "get_invoice", "list_deferred"] as const) {
      const c = buildOperatorCall(a, { ...hostile, providerEventId: "evt_1" });
      expect(Object.keys(c?.args ?? {}).filter((k) => /actor|user/i.test(k))).toEqual([]);
    }
  });

  it("list defaults: invoices unfiltered, deferred = rejected", () => {
    expect(buildOperatorCall("list_invoices", {})?.args).toEqual({ p_state: null, p_studio_id: null, p_include_dismissed: false, p_limit: 50, p_offset: 0 });
    expect(buildOperatorCall("list_deferred", {})?.args).toEqual({ p_state: "rejected", p_limit: 50, p_offset: 0 });
  });

  it("passes the database result through on success", async () => {
    const { d, rpc } = deps({}, { outcome: "dismissed" });
    expect(await runOperatorAction(d, "dismiss", { invoiceRowId: INV, reason: REASON })).toEqual({ ok: true, data: { outcome: "dismissed" } });
    expect(rpc).toHaveBeenCalledWith("d24_op_dismiss_unmatched", { p_invoice_row_id: INV, p_reason: REASON });
  });
});

describe("database errors map to stable codes and never leak text", () => {
  it.each([
    [{ code: "P0001", message: "d24_op_aal2_required" }, "mfa_required"],
    [{ code: "42501", message: "d24_op_authentication_required" }, "unauthenticated"],
    [{ code: "42501", message: "d24_op_platform_admin_required" }, "forbidden"],
    [{ code: "42501", message: "d24_op_code_requires_platform_admin" }, "forbidden"],
    [{ code: "P0002", message: "d24_invoice_not_found" }, "not_found"],
    [{ code: "55000", message: "d24_op_not_dismissable: secret detail" }, "not_allowed_state"],
    [{ code: "55000", message: "d24_op_requeue_limit_reached" }, "limit_reached"],
    [{ code: "22023", message: "d24_unknown_anomaly_code" }, "invalid_input"],
    [{ code: "XX000", message: "connection to 10.0.0.5 refused" }, "unavailable"],
  ])("%j -> %s", async (error, code) => {
    const { d } = deps({}, null, error);
    const r = await runOperatorAction(d, "dismiss", { invoiceRowId: INV, reason: REASON });
    expect(r).toEqual({ ok: false, code });
    expect(JSON.stringify(r)).not.toMatch(/secret|10\.0\.0\.5/);
  });
  it("a thrown rpc is 'unavailable'", async () => {
    const d = { ...deps().d, rpc: async () => { throw new Error("socket hang up"); } } as OperatorDeps;
    expect(await runOperatorAction(d, "dismiss", { invoiceRowId: INV, reason: REASON })).toEqual({ ok: false, code: "unavailable" });
  });
});

describe("migration contract (the SQL the app depends on)", () => {
  const paramsOf = (fn: string) => {
    const m = SQL.match(new RegExp(`create or replace function public\\.${fn}\\(([^)]*)\\)`));
    return m ? m[1].split(",").map((s) => s.trim().split(/\s+/)[0]).filter(Boolean) : null;
  };
  it("the app's argument names are exactly the SQL parameter names", () => {
    for (const [action, input] of [
      ["acknowledge", { invoiceRowId: INV, codes: ["a_code"], reason: REASON }],
      ["dismiss", { invoiceRowId: INV, reason: REASON }],
      ["requeue", { providerEventId: "evt_1", reason: REASON }],
      ["get_invoice", { invoiceRowId: INV }],
      ["list_invoices", {}],
      ["list_deferred", {}],
    ] as const) {
      const c = buildOperatorCall(action, input)!;
      expect(Object.keys(c.args).sort(), c.fn).toEqual((paramsOf(c.fn) ?? []).sort());
    }
  });
  it("no operator function takes an actor or user argument", () => {
    for (const fn of ["d24_op_acknowledge_anomalies", "d24_op_dismiss_unmatched", "d24_op_requeue_deferred", "d24_op_list_invoices", "d24_op_get_invoice", "d24_op_list_deferred"]) {
      expect((paramsOf(fn) ?? []).filter((p) => /actor|user/i.test(p)), fn).toEqual([]);
    }
  });
  it("grants: operator functions to authenticated only; the p_actor function is closed to every API role", () => {
    const grants = [...SQL.matchAll(/grant execute on function public\.(d24_[a-z_]+)\([^)]*\) to ([a-z_, ]+);/g)];
    expect(grants.map((g) => g[1]).sort()).toEqual(["d24_op_acknowledge_anomalies", "d24_op_dismiss_unmatched", "d24_op_get_invoice", "d24_op_list_deferred", "d24_op_list_invoices", "d24_op_requeue_deferred"]);
    for (const g of grants) expect(g[2].trim()).toBe("authenticated");
    expect(SQL).toMatch(/revoke all on function public\.d24_acknowledge_anomalies\(uuid, text\[\], uuid, text\) from public, anon, authenticated, service_role;/);
    expect(SQL).not.toMatch(/grant execute[^;]*(anon|public|service_role);/);
  });
  it("every definer function pins search_path and aal2 is checked in SQL", () => {
    expect(SQL).toMatch(/auth\.jwt\(\) ->> 'aal', ''\) <> 'aal2'/);
    expect(SQL).toMatch(/auth\.uid\(\)/);
    const definers = SQL.split(/create or replace function/).slice(1).filter((b) => /security definer/.test(b.split("as $$")[0]));
    expect(definers.length).toBeGreaterThanOrEqual(6);
    for (const b of definers) expect(b.split("as $$")[0]).toMatch(/set search_path = pg_catalog, public, pg_temp/);
  });
  it("the server actions use the user-scoped client, never the admin client", () => {
    const src = readFileSync("src/lib/payments/hostedInvoice/operatorActions.ts", "utf8");
    expect(src).not.toMatch(/createAdminClient|service_role|SERVICE_ROLE/);
    expect(src).toMatch(/createClient\(\)/);
  });
});
