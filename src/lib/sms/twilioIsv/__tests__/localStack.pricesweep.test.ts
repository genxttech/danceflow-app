/**
 * TW-4F price request sweep (20270219090000, tw4_price_sweep_expired): closes pending proposals past their expiry and nothing else.
 * LOCAL QA DATABASE ONLY (TW4A_LOCAL_DB_CONTAINER + TW4RFL_DB, the tw4_local_qa_only marker). Run on a fresh database with the chain through 20270219090000.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { A, enabled, psql, psqlError, rows, seedCast } from "./wpd4Helpers";

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
  it("SW-4 the price list is untouched and the function is not callable by the API roles", () => {
    expect(Number(psql(`select count(*) from public.studio_sms_price_list`))).toBe(0);
    for (const role of ["anon", "authenticated"]) {
      expect(psqlError(`begin; set local role ${role}; select public.tw4_price_sweep_expired(); commit;`)).toMatch(/permission denied/i);
    }
  });
  it("SW-5 a request that is still pending after expiry cannot be moved to anything but expired by the sweep (direct update stays refused)", () => {
    expect(psqlError(`update public.studio_sms_price_change_requests set status = 'approved' where kind = 'sweep_live_b'`)).toMatch(/dual-control|not a legal|only through/i);
  });
});
