/**
 * TW-4F: two rollbacks now restore the catalog EXACTLY (they used to leave a cosmetic difference, which made the strict reverse rollback differ from the pre-migration catalog):
 *   - 20261203090000 (inbound usage recording) re-creates studio_sms_price_list_kind_check in the ARRAY[...] text form 20261202090000 created (it used to use the '{...}'::text[] form),
 *     refuses (55000) when the kinds left are not exactly the 20261202090000 list, and asserts the restored definition.
 *   - 20261128090000 (monthly spending limits) restores tw4_recurring_due(text) byte for byte as 20261126090000 created it (trailing comment included) and asserts its md5.
 *
 * The relevant blocks are extracted from the committed rollback files and run inside a transaction that is ALWAYS rolled back, on a database with the full chain applied.
 * Nothing is committed and no other layer is touched.
 * LOCAL QA ONLY: a DEDICATED Postgres (scripts/qa/iso-qa.mjs), synthetic only; no Twilio, no SMS, no Stripe.
 *
 *   TW4A_LOCAL_DB_CONTAINER=<container> TW4RFL_DB=postgres npx vitest run src/lib/sms/twilioIsv/__tests__/localStack.tw4rbexact.test.ts
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const DB = process.env.TW4RFL_DB ?? "";
const enabled = Boolean(PG && DB);

const dir = join(process.cwd(), "src/lib/supabase/migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf8").replace(/\r/g, "");
const RB_1203 = read("rollback/20261203090000_twilio_inbound_usage_recording_rollback.sql");
const RB_1128 = read("rollback/20261128090000_twilio_monthly_spending_limits_rollback.sql");
const MIG_1126 = read("20261126090000_twilio_recurring_authorization.sql");

const slice = (text: string, startMarker: string, endMarker: string) => {
  const a = text.indexOf(startMarker);
  if (a < 0) return "";
  const b = text.indexOf(endMarker, a);
  return b < 0 ? "" : text.slice(a, b + endMarker.length);
};
// the price-kind block of the 1203 rollback: from its DO header to its end
const KIND_BLOCK = slice(RB_1203, "do $$\ndeclare\n  v_def text;\n  v_kinds text[];", "end $$;");
// the function and the md5 assertion of the 1128 rollback
const FN_BLOCK = slice(RB_1128, "create or replace function public.tw4_recurring_due(p_period_key text)", "end $$;");
const ASSERT_BLOCK = slice(RB_1128, "-- the restored body is exactly the one 20261126090000 created", "end $$;");
// the original body, and its md5 as the catalog fingerprint computes it
const ORIG_FN = slice(MIG_1126, "create or replace function public.tw4_recurring_due(p_period_key text)", "end $$;");
const ORIG_BODY = ORIG_FN.slice(ORIG_FN.indexOf("$$") + 2, ORIG_FN.lastIndexOf("$$"));
const ORIG_MD5 = createHash("md5").update(ORIG_BODY).digest("hex");

const EXPECTED_KIND_DEF = "CHECK ((kind = ANY (ARRAY['brand'::text, 'brand_low_volume'::text, 'campaign_vetting'::text, 'number'::text, 'monthly'::text, 'monthly_low_volume'::text, 'sms_usage'::text])))";
const KIND_DEF = "select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.studio_sms_price_list'::regclass and conname = 'studio_sms_price_list_kind_check'";
const FN_EXISTS = "select to_regprocedure('public.tw4_recurring_due(text)') is not null";
const FN_MD5 = "select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = 'public.tw4_recurring_due(text)'::regprocedure";

const run = (sql: string) => {
  const r = spawnSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-q", "-At", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", maxBuffer: 1 << 26 });
  return { code: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};

describe("rollback scripts (static)", () => {
  it("both rollbacks carry their restore block and its assertion", () => {
    expect(KIND_BLOCK.length).toBeGreaterThan(400);
    expect(KIND_BLOCK).toContain("using errcode = '55000'");
    expect(KIND_BLOCK).toContain("postcondition failed");
    expect(KIND_BLOCK).not.toContain("%L::text[]");
    expect(FN_BLOCK.length).toBeGreaterThan(400);
    expect(ASSERT_BLOCK).toContain(ORIG_MD5);
    expect(ASSERT_BLOCK).toContain("postcondition failed");
  });
  it("the restored function text is byte-identical to the one 20261126090000 created", () => {
    expect(FN_BLOCK).toBe(ORIG_FN);
    expect(ORIG_FN).toMatch(/retrying adds nothing/);
  });
});

describe.skipIf(!enabled)("exact-restore rollbacks (real schema, always rolled back)", () => {
  it("20261203: the live kind constraint is 1203's '{...}' form before the block", () => {
    const r = run(`${KIND_DEF};`);
    expect(r.code).toBe(0);
    expect(r.out).toContain("sms_inbound");
    expect(r.out).not.toContain("ARRAY[");
  });

  it("20261203: the block restores exactly the 20261202090000 definition (ARRAY form, same name)", () => {
    const r = run(`begin; set local lock_timeout = '5s'; ${KIND_BLOCK}\n${KIND_DEF}; rollback;`);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toBe(EXPECTED_KIND_DEF);
  });

  it("20261203: kinds that are not exactly the 20261202090000 list (plus the inbound kind) refuse (55000)", () => {
    const base = ["brand", "brand_low_volume", "campaign_vetting", "number", "monthly", "monthly_low_volume", "sms_usage", "sms_inbound"];
    const withExtra = [...base, "later_kind"].sort();
    const r = run(`begin; alter table public.studio_sms_price_list drop constraint studio_sms_price_list_kind_check;
      alter table public.studio_sms_price_list add constraint studio_sms_price_list_kind_check check (kind = any ('{${withExtra.join(",")}}'::text[])); ${KIND_BLOCK} rollback;`);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("not the 20261202090000 list");
    const missing = base.filter((k) => k !== "sms_usage").sort();
    const r2 = run(`begin; alter table public.studio_sms_price_list drop constraint studio_sms_price_list_kind_check;
      alter table public.studio_sms_price_list add constraint studio_sms_price_list_kind_check check (kind = any ('{${missing.join(",")}}'::text[])); ${KIND_BLOCK} rollback;`);
    expect(r2.code).not.toBe(0);
    expect(r2.err).toContain("not the 20261202090000 list");
    // nothing changed outside the aborted transactions
    expect(run(`${KIND_DEF};`).out).toContain("sms_inbound");
  });

  it("20261128: on the full chain the function does not exist before the block (20261128 dropped it; the rollback re-creates it)", () => {
    const r = run(`${FN_EXISTS};`);
    expect(r.code).toBe(0);
    expect(r.out).toBe("f");
  });

  it("20261128: the restored function has exactly the 20261126090000 body (md5 and trailing comment)", () => {
    const r = run(`begin; set local lock_timeout = '5s'; ${FN_BLOCK}\n${ASSERT_BLOCK}\n${FN_MD5}; select prosrc like '%retrying adds nothing%' from pg_proc where oid = 'public.tw4_recurring_due(text)'::regprocedure; rollback;`);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual([ORIG_MD5, "t"]);
    // the transaction was rolled back: the function is absent again, as on the full chain
    expect(run(`${FN_EXISTS};`).out).toBe("f");
  });

  it("20261128: the assertion fails when the restored body differs by even a comment", () => {
    const changed = FN_BLOCK.replace(/retrying adds nothing/, "retrying adds nothing here");
    expect(changed).not.toBe(FN_BLOCK);
    const r = run(`begin; ${changed}\n${ASSERT_BLOCK} rollback;`);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("is not the 20261126090000 body");
  });
});
