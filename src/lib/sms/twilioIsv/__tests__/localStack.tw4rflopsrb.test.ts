/**
 * TW-4F: the 20261211090000 rollback restores the alert-kind CHECK constraint to its 20261209090000 definition (it used to leave 1211's wider list behind, which made the
 * strict reverse rollback differ from the pre-1211 catalog), refuses while an alert row uses a kind only 1211 allows, and refuses when the live constraint is not exactly 1211's.
 *
 * The constraint block of the rollback script is extracted from the committed file and run inside a transaction that is ALWAYS rolled back, on a database with the full chain
 * (the live alert-kind constraint is 20261211's; no later migration changes it). Nothing is committed, no row survives, no other layer is touched.
 * LOCAL QA ONLY: a DEDICATED Postgres (scripts/qa/iso-qa.mjs), synthetic ids only; no Twilio, no SMS, no Stripe.
 *
 *   TW4A_LOCAL_DB_CONTAINER=<container> TW4RFL_DB=postgres npx vitest run src/lib/sms/twilioIsv/__tests__/localStack.tw4rflopsrb.test.ts
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const DB = process.env.TW4RFL_DB ?? "";
const enabled = Boolean(PG && DB);

const ROLLBACK_FILE = join(process.cwd(), "src/lib/supabase/migrations/rollback/20261211090000_twilio_rfl_ops_rollback.sql");
const START = "-- the alert-kind constraint goes back to its 20261209090000";
const text = readFileSync(ROLLBACK_FILE, "utf8").replace(/\r/g, "");
const from = text.indexOf(START);
const BLOCK = from < 0 ? "" : text.slice(from, text.indexOf("end $$;", from) + "end $$;".length);

const KINDS_1209 = ["authorization_expiring", "next_period_uncovered", "pilot_approval_needed", "funding_low", "negative_balance", "account_on_hold", "exposure_open", "provider_variance",
  "inventory_gap", "cancel_unknown", "cancelled_authorization_active", "charged_after_cancellation", "released_resource_active"];
const EXPECTED_1209 = `CHECK ((kind = ANY (ARRAY[${KINDS_1209.map((k) => `'${k}'::text`).join(", ")}])))`;

const run = (sql: string) => {
  const r = spawnSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-At", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", maxBuffer: 1 << 26 });
  return { code: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};
const DEF = "select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.studio_sms_provider_alerts'::regclass and conname = 'studio_sms_provider_alerts_kind_check'";
const ALERT = (kind: string, key: string) => `insert into public.studio_sms_provider_alerts (legal_entity_id, kind, dedupe_key, audience, severity, summary)
  values ('00000000-0000-4000-8000-0000000000e1', '${kind}', '${key}', 'admin', 'info', 'rollback constraint test row');`;

describe("rollback script (static)", () => {
  it("carries the constraint block with its refusals, its restore and its postcondition", () => {
    expect(BLOCK.length).toBeGreaterThan(500);
    expect(BLOCK).toContain("using errcode = '55000'");
    expect(BLOCK).toContain("alter table public.studio_sms_provider_alerts drop constraint studio_sms_provider_alerts_kind_check");
    expect(BLOCK).toContain("postcondition failed");
    for (const k of KINDS_1209) expect(BLOCK).toContain(`'${k}'`);
    // the block never deletes or rewrites alert rows
    expect(BLOCK).not.toMatch(/delete\s+from|update\s+public\.studio_sms_provider_alerts|truncate/i);
  });
});

describe.skipIf(!enabled)("20261211 rollback: alert-kind constraint (real schema, always rolled back)", () => {
  it("the live constraint is 1211's wider list before the block", () => {
    const r = run(`${DEF};`);
    expect(r.code).toBe(0);
    expect(r.out).toContain("owner_unresponsive");
    expect(r.out).toContain("alert_delivery_exhausted");
    expect(r.out).not.toBe(EXPECTED_1209);
  });

  it("with no 1211-only row, the block restores exactly the 20261209 definition (same name)", () => {
    const r = run(`begin; set local lock_timeout = '5s'; ${BLOCK}\n${DEF}; rollback;`);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out.split("\n").filter((l) => l.startsWith("CHECK"))).toEqual([EXPECTED_1209]);
  });

  it.each(["owner_notice_second", "owner_unresponsive", "alert_delivery_exhausted"])("an alert row of the 1211-only kind %s refuses the rollback (55000) and nothing changes", (kind) => {
    const r = run(`begin; set local session_replication_role = replica; ${ALERT(kind, `rbtest:${kind}`)} set local session_replication_role = origin; ${BLOCK} rollback;`);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("alert rows use a kind that only 20261211 allows");
    // the session aborted inside a transaction: no row and no constraint change survives
    const after = run(`${DEF}; select count(*) from public.studio_sms_provider_alerts where dedupe_key like 'rbtest:%';`);
    expect(after.out.split("\n")).toEqual([expect.stringContaining("owner_unresponsive"), "0"]);
  });

  it("a row of a 1209 kind does not block the rollback, and the row is kept", () => {
    const r = run(`begin; set local session_replication_role = replica; ${ALERT("inventory_gap", "rbtest:inventory_gap")} set local session_replication_role = origin; ${BLOCK}
      select count(*) from public.studio_sms_provider_alerts where dedupe_key = 'rbtest:inventory_gap'; ${DEF}; rollback;`);
    expect(r.err).toBe("");
    expect(r.out.split("\n")).toEqual(["1", EXPECTED_1209]);
  });

  it("a live constraint that is not exactly 1211's refuses (a later layer changed it)", () => {
    const narrower = KINDS_1209.map((k) => `'${k}'`).join(", ");
    const r = run(`begin; alter table public.studio_sms_provider_alerts drop constraint studio_sms_provider_alerts_kind_check;
      alter table public.studio_sms_provider_alerts add constraint studio_sms_provider_alerts_kind_check check (kind in (${narrower}, 'owner_unresponsive')); ${BLOCK} rollback;`);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("not exactly the 20261211 definition");
    const wrongName = run(`begin; alter table public.studio_sms_provider_alerts rename constraint studio_sms_provider_alerts_kind_check to studio_sms_provider_alerts_kind_check2; ${BLOCK} rollback;`);
    expect(wrongName.code).not.toBe(0);
    expect(wrongName.err).toContain("not exactly the 20261211 definition");
    expect(run(`${DEF};`).out).toContain("alert_delivery_exhausted");
  });
});
