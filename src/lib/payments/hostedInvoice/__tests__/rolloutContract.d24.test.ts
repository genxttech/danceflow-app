import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { handleHostedInvoiceEvent } from "../handlers";

/**
 * D24 M1 rollout contract: SQL migration -> deploy with defer -> drain -> on. The handler must call the database
 * functions with exactly the parameter names the migration defines, in both modes, and must never call anything else.
 */
const SQL = readFileSync("src/lib/supabase/migrations/20270203110000_d24_hosted_invoice_facts.sql", "utf8");

function paramsOf(fn: string): string[] {
  const m = new RegExp("create or replace function public\\." + fn + "\\(([^)]*)\\)", "s").exec(SQL);
  if (!m) throw new Error("function not found in migration: " + fn);
  return m[1].split(",").map((p) => p.trim().split(/\s+/)[0]).filter(Boolean);
}

const event = {
  id: "evt_c1", type: "invoice_payment.paid", created: 1_800_000_000, livemode: false, account: "acct_1",
  data: { object: { id: "inpay_1", invoice: "in_1", status: "paid", amount_requested: 5, amount_paid: 5, currency: "usd" } },
} as never;
const claim = { eventId: "evt_c1", owner: "00000000-0000-0000-0000-0000000000a1" };

async function argsFor(mode: string, result: unknown) {
  const rpc = vi.fn(async (..._a: unknown[]) => ({ data: result, error: null }));
  await handleHostedInvoiceEvent({ supabase: { rpc } as never, event, claim, env: { D24_HOSTED_INVOICE_EVENTS: mode } });
  return { fn: rpc.mock.calls[0][0] as string, keys: Object.keys(rpc.mock.calls[0][1] as Record<string, unknown>) };
}

describe("D24 rollout contract (migration <-> handler)", () => {
  it("defer mode calls d24_defer_event with exactly the migration's parameters", async () => {
    const { fn, keys } = await argsFor("defer", { outcome: "deferred" });
    expect(fn).toBe("d24_defer_event");
    expect([...keys].sort()).toEqual([...paramsOf("d24_defer_event")].sort());
  });
  it("on mode calls d24_apply_event with exactly the migration's parameters", async () => {
    const { fn, keys } = await argsFor("on", { outcome: "applied", matched: false });
    expect(fn).toBe("d24_apply_event");
    expect([...keys].sort()).toEqual([...paramsOf("d24_apply_event")].sort());
  });
  it("off mode never touches the database", async () => {
    const rpc = vi.fn();
    await handleHostedInvoiceEvent({ supabase: { rpc } as never, event, claim, env: {} });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("the only functions granted to service_role are the five the rollout uses, and the app calls only apply and defer", () => {
    const grants = [...SQL.matchAll(/grant execute on function public\.(d24_[a-z_]+)\(/g)].map((m) => m[1]).sort();
    expect(grants).toEqual(["d24_acknowledge_anomalies", "d24_apply_event", "d24_defer_event", "d24_drain_deferred", "d24_register_invoice"]);
    expect(SQL).not.toMatch(/grant execute on function public\.d24_[a-z_]+\([^)]*\) to (anon|authenticated|public)/i);
  });
  it("the acknowledgement RPC is revoked from every untrusted role and granted to service_role only", () => {
    expect(SQL).toMatch(/revoke all on function public\.d24_acknowledge_anomalies\(uuid, text\[\], uuid, text\) from public, anon, authenticated;/);
    expect(SQL).toMatch(/grant execute on function public\.d24_acknowledge_anomalies\(uuid, text\[\], uuid, text\) to service_role;/);
  });
});
