/**
 * TW-4F price request sweep (20270219090000, tw4_price_sweep_expired): closes pending proposals past their expiry and nothing else.
 * LOCAL QA DATABASE ONLY (TW4A_LOCAL_DB_CONTAINER + TW4RFL_DB, the tw4_local_qa_only marker). Run on a fresh database with the chain through 20270219090000.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { A, B, enabled, psql, psqlError, rows, seedCast } from "./wpd4Helpers";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ownerSql = (sql: string) => psql(`begin; do $q$ begin if to_regclass('public.tw4_local_qa_only') is null then raise exception 'not a local QA database'; end if; end $q$; ${sql} commit;`);
const seedReq = (kind: string, requestedAgoHours: number, expiresInHours: number) =>
  ownerSql(`set local tw4.pricedual_write = 'on'; insert into public.studio_sms_price_change_requests (kind, customer_price_cents, provider_cost_cents, description, reason, requested_by, requested_at, expires_at)
    values ('${kind}', 777, 500, 'sweep fixture ${kind}', 'sweep fixture reason for ${kind}', '${A}', clock_timestamp() - interval '${requestedAgoHours} hours', clock_timestamp() + interval '${expiresInHours} hours');`);
const status = (kind: string) => rows<{ status: string; decided_by: string | null; decision_note: string | null }>(`select status, decided_by, decision_note from public.studio_sms_price_change_requests where kind = '${kind}'`)[0];

describe.skipIf(!enabled)("price request sweep", () => {
  beforeAll(() => { seedCast(); });

  it("SW-1 expires only pending requests past expiry, as a system decision, and leaves an unexpired one alone", () => {
    seedReq("sweep_old_a", 100, -52); // expired 52 hours ago: the monitor's anomaly state
    seedReq("sweep_live_b", 1, 24);
    const out = JSON.parse(psql(`select public.tw4_price_sweep_expired()::text`).split("\n").filter(Boolean).pop()!) as { expired: number; request_ids: string[] };
    expect(out.expired).toBeGreaterThanOrEqual(1);
    expect(status("sweep_old_a")).toMatchObject({ status: "expired", decided_by: null });
    expect(status("sweep_old_a").decision_note).toMatch(/^expired:/);
    expect(status("sweep_live_b").status).toBe("pending");
  });
  it("SW-2 is idempotent: a second call finds nothing for the already closed request", () => {
    const out = JSON.parse(psql(`select public.tw4_price_sweep_expired()::text`).split("\n").filter(Boolean).pop()!) as { expired: number };
    expect(out.expired).toBe(0);
    expect(status("sweep_old_a").status).toBe("expired");
  });
  it("SW-3 after the sweep the verifier no longer reports the swept request as an anomaly", () => {
    const v = JSON.parse(psql(`select public.tw4_price_verify()::text`).split("\n").filter(Boolean).pop()!) as { anomalies: { code: string; request_id?: string }[] };
    expect(v.anomalies.filter((a) => a.code === "request_anomaly")).toHaveLength(0);
  });
  it("SW-4 the price list is untouched and only service_role can execute", () => {
    expect(Number(psql(`select count(*) from public.studio_sms_price_list`))).toBe(0);
    expect(psql(`select has_function_privilege('anon','public.tw4_price_sweep_expired()','execute') or has_function_privilege('authenticated','public.tw4_price_sweep_expired()','execute')`)).toBe("f");
    expect(psql(`select has_function_privilege('service_role','public.tw4_price_sweep_expired()','execute')`)).toBe("t");
    for (const role of ["anon", "authenticated"]) {
      expect(psqlError(`begin; set local role ${role}; select public.tw4_price_sweep_expired(); commit;`)).toMatch(/permission denied/i);
    }
  });
  it("SW-5 returns exactly the swept ids and leaves an already-decided past-expiry request alone", () => {
    seedReq("sweep_edge_c", 49, -1);
    const idC = psql(`select id from public.studio_sms_price_change_requests where kind = 'sweep_edge_c'`);
    ownerSql(`set local tw4.pricedual_write = 'on'; update public.studio_sms_price_change_requests set status = 'rejected', decided_by = '${B}', decided_at = clock_timestamp(), decision_note = 'rejected by fixture for sweep test' where kind = 'sweep_edge_c';`);
    seedReq("sweep_new_d", 60, -2);
    const idD = psql(`select id from public.studio_sms_price_change_requests where kind = 'sweep_new_d'`);
    const out = JSON.parse(psql(`select public.tw4_price_sweep_expired()::text`).split("\n").filter(Boolean).pop()!) as { expired: number; request_ids: string[] };
    expect(out.request_ids).toEqual([idD]);
    expect(out.request_ids).not.toContain(idC);
    expect(status("sweep_edge_c").status).toBe("rejected");
    expect(status("sweep_new_d").status).toBe("expired");
  });
  it("SW-6 the function skips rows another transaction holds and bounds its lock wait", () => {
    const def = psql(`select pg_get_functiondef('public.tw4_price_sweep_expired()'::regprocedure)`);
    expect(def).toMatch(/for update skip locked/i);
    expect(def).toMatch(/lock_timeout/i);
  });
});
