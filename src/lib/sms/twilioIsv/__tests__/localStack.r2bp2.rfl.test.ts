/**
 * TW-4F R2b-P2 against the REAL recurring-fee-lifecycle alert outbox (migration 20261209: studio_sms_provider_alerts, _tw4rfl_alert, tw4_rfl_alerts_claim). The main R2b suite proves escalation against
 * a stand-in with the same signature; this file proves the contract against the real objects. It needs a database with 20261207, 20261208, 20261209, 20261213 and 20261214 applied
 * (an ISOLATED one: it writes and removes only its own synthetic rows). Synthetic fixtures only; no Twilio, no SMS, no Stripe.
 *
 *   TW4A_RFL_DB_CONTAINER=<container> TW4A_RFL_DB_NAME=postgres npx vitest run src/lib/sms/twilioIsv/__tests__/localStack.r2bp2.rfl.test.ts
 */
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 600_000 });

const PG = process.env.TW4A_RFL_DB_CONTAINER ?? "";
const DBN = process.env.TW4A_RFL_DB_NAME ?? "postgres";
const enabled = Boolean(PG);

const ENT = "e2b00000-0000-4000-8000-0000000000f1";
const ACC = `AC${"f3".repeat(16)}`;
const SID_A = `PN${"a1".repeat(16)}`;
const SID_B = `PN${"b1".repeat(16)}`;

const psql = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DBN, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
const psqlFile = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DBN, "-q", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });

const CLEAN = `begin; set local session_replication_role = replica;
delete from public.studio_sms_num_orphan_events where orphan_id in (select id from public.studio_sms_num_orphans where legal_entity_id = '${ENT}');
delete from public.studio_sms_num_orphans where legal_entity_id = '${ENT}';
delete from public.studio_sms_provider_alerts where legal_entity_id = '${ENT}';
delete from public.studio_sms_legal_entities where id = '${ENT}';
commit;`;

describe.skipIf(!enabled)("R2b-P2 escalation against the REAL recurring-fee alert outbox", () => {
  beforeAll(() => {
    expect(psql("select to_regprocedure('public._tw4rfl_alert(uuid,uuid,uuid,text,text,text,text,text)') is not null and to_regclass('public.studio_sms_provider_alerts') is not null")).toBe("t");
    expect(psql("select count(*) from pg_proc where proname = '_tw4rfl_alert' and prosrc like '%tw4_p2_stub%'")).toBe("0");
    psqlFile(CLEAN);
    psqlFile(`begin; set local session_replication_role = replica;
      insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${ENT}', 'R2B RFL Contract LLC', '9895', 50000, '00000000-0000-4000-8000-0000000000f2');
      insert into public.studio_sms_num_orphans (legal_entity_id, twilio_account_sid, phone_number_sid, e164, kind, first_seen_at, last_seen_at)
        values ('${ENT}', '${ACC}', '${SID_A}', '+12025550201', 'unknown', now() - interval '25 hours', now()), ('${ENT}', '${ACC}', '${SID_B}', '+12025550202', 'ownership_mismatch', now() - interval '1 hour', now());
      commit;`);
  });
  afterAll(() => {
    if (enabled) psqlFile(CLEAN);
  });

  it("raises one alert per finding level through the real outbox, with the outbox's own shape, idempotently", () => {
    const run = () => JSON.parse(psql("select public.tw4_num_orphan_escalate(100)::text")) as { outbox: boolean; raised: number; failed: number };
    const first = run();
    expect(first).toMatchObject({ outbox: true, failed: 0 });
    expect(first.raised).toBe(2);
    // the unknown finding is 25 hours old (level 2, critical); the mismatch is a contradiction (level 2 at once)
    const rows = psql(`select string_agg(kind || '|' || audience || '|' || severity || '|' || status, ';' order by dedupe_key) from public.studio_sms_provider_alerts where legal_entity_id = '${ENT}'`);
    expect(rows).toBe("inventory_gap|admin|critical|pending;inventory_gap|admin|critical|pending");
    expect(psql(`select count(*) from public.studio_sms_provider_alerts where legal_entity_id = '${ENT}' and dedupe_key like 'numorphan:%:0:L2'`)).toBe("2");
    // the summary carries no number, cost or secret
    expect(psql(`select bool_and(summary !~ '\\+1[0-9]{10}' and summary !~ 'AC[0-9a-f]{32}') from public.studio_sms_provider_alerts where legal_entity_id = '${ENT}'`)).toBe("t");
    // idempotent: the same levels are never raised twice
    expect(run().raised).toBe(0);
    expect(psql(`select count(*) from public.studio_sms_provider_alerts where legal_entity_id = '${ENT}'`)).toBe("2");
    expect(psql(`select string_agg(escalation_level::text, ',' order by phone_number_sid) from public.studio_sms_num_orphans where legal_entity_id = '${ENT}'`)).toBe("2,2");
  });

  it("the real outbox's own runner can claim and finish what P2 raised", () => {
    const claimed = JSON.parse(psql("select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb)::text from (select * from public.tw4_rfl_alerts_claim(50)) c")) as { alert_id: string; claim_token: string; legal_entity_id: string; kind: string }[];
    const mine = claimed.filter((row) => row.legal_entity_id === ENT);
    expect(mine.length).toBe(2);
    expect(mine.every((row) => row.kind === "inventory_gap")).toBe(true);
    for (const alert of mine) {
      expect(JSON.parse(psql(`select public.tw4_rfl_alert_finish('${alert.alert_id}'::uuid, '${alert.claim_token}'::uuid, true, null)::text`))).toEqual({ updated: true });
    }
    expect(psql(`select count(*) from public.studio_sms_provider_alerts where legal_entity_id = '${ENT}' and status = 'delivered'`)).toBe(String(mine.length));
  });

  it("a reopened finding re-alerts under a new generation key, and a failing outbox is recorded without advancing the level", () => {
    const id = psql(`select id from public.studio_sms_num_orphans where phone_number_sid = '${SID_A}'`);
    psqlFile(`begin; set local session_replication_role = replica; update public.studio_sms_num_orphans set reopen_count = 1, escalation_level = 0 where id = '${id}'; commit;`);
    const run = () => JSON.parse(psql("select public.tw4_num_orphan_escalate(100)::text")) as { raised: number; failed: number };
    expect(run().raised).toBeGreaterThanOrEqual(1);
    expect(psql(`select count(*) from public.studio_sms_provider_alerts where dedupe_key like 'numorphan:${id}:1:L2'`)).toBe("1");
    // a failing outbox: the failure is recorded (SQLSTATE only) and retried; the level does not advance
    psqlFile(`begin; set local session_replication_role = replica; update public.studio_sms_num_orphans set reopen_count = 2, escalation_level = 0 where id = '${id}';
      update public.studio_sms_legal_entities set id = id where id = '${ENT}'; commit;`);
    psqlFile(`alter table public.studio_sms_provider_alerts add constraint tw4_p2_rfl_block check (dedupe_key not like 'numorphan:${id}:2:%') not valid;`);
    try {
      const failed = run();
      expect(failed.failed).toBeGreaterThanOrEqual(1);
      expect(psql(`select escalation_level || ':' || (escalation_failures >= 1)::text from public.studio_sms_num_orphans where id = '${id}'`)).toBe("0:true");
      expect(psql(`select count(*) from public.studio_sms_num_orphan_events where orphan_id = '${id}' and event = 'escalation_failed' and detail like 'sqlstate=23514%'`)).toBe("1");
    } finally {
      psqlFile("alter table public.studio_sms_provider_alerts drop constraint tw4_p2_rfl_block;");
    }
    // recovered: the next run raises it
    expect(run().raised).toBeGreaterThanOrEqual(1);
    expect(psql(`select escalation_level from public.studio_sms_num_orphans where id = '${id}'`)).toBe("2");
  });
});
