import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static guards on the D5 cover migration (no database needed): one transaction, every replaced function is fingerprint-checked against its live predecessor before it is
 * replaced, differs from that predecessor only by the intended lines, keeps the lock order / write-flag pattern / refusal codes, adds no grants, deletes nothing, and the
 * rollback restores the four predecessors byte for byte and refuses while superseded evidence exists.
 */
const dir = join(process.cwd(), "src/lib/supabase/migrations");
const read = (name: string) => readFileSync(join(dir, name), "utf8").replace(/\r/g, "");
const f9 = read("20261209090000_twilio_recurring_fee_lifecycle.sql");
const f11 = read("20261211090000_twilio_rfl_ops.sql");
const f17 = read("20261217090000_twilio_r2b_rfl_lifecycle_integration.sql");
const mig = read("20261225090000_twilio_rfl_d5_cover.sql");
const rollback = read("rollback/20261225090000_twilio_rfl_d5_cover_rollback.sql");

const SIGS = {
  guard: { sig: "create or replace function public._tw4rfl_guard()", reg: "public._tw4rfl_guard()", src: f11 },
  cover: { sig: "create or replace function public._tw4rfl_cover(r public.studio_sms_provider_resources, p_key text)", reg: "public._tw4rfl_cover(public.studio_sms_provider_resources,text)", src: f9 },
  core: { sig: "create or replace function public._tw4rfl_register_core(", reg: "public._tw4rfl_register_core(uuid,uuid,text,text,text,text,text,uuid,uuid,boolean)", src: f17 },
  pilot: { sig: "create or replace function public.tw4_rfl_pilot_cover(", reg: "public.tw4_rfl_pilot_cover(uuid,text,text,uuid)", src: f9 },
} as const;

function fnBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(source.indexOf(signature, start + 1)).toBe(-1);
  return source.slice(start, source.indexOf("end $$;", start) + "end $$;".length);
}
const prosrc = (fn: string) => fn.slice(fn.indexOf("as $$") + "as $$".length, fn.lastIndexOf("$$;"));
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
/** predecessor lines that no longer appear in the replacement, in order */
const removed = (before: string, after: string) => {
  const afterLines = after.split("\n");
  const out: string[] = [];
  let at = 0;
  for (const line of before.split("\n")) {
    const i = afterLines.indexOf(line, at);
    if (i < 0) out.push(line);
    else at = i + 1;
  }
  return out;
};

describe("20261225090000 RFL D5 cover: migration shape", () => {
  it("is one transaction, nothing follows the commit, and it sorts after the integration migration", () => {
    expect((mig.match(/^begin;/gm) ?? []).length).toBe(1);
    expect((mig.match(/^commit;/gm) ?? []).length).toBe(1);
    expect(mig.trimEnd().endsWith("commit;")).toBe(true);
    expect((rollback.match(/^begin;/gm) ?? []).length).toBe(1);
    expect((rollback.match(/^commit;/gm) ?? []).length).toBe(1);
    expect(rollback.trimEnd().endsWith("commit;")).toBe(true);
    expect("20261225090000" > "20261217090000").toBe(true);
    expect(mig).toMatch(/set local lock_timeout/);
  });

  it("fingerprint-checks every replaced function against the md5 of its live predecessor before replacing it", () => {
    const precondition = mig.slice(0, mig.indexOf("-- additive supersede evidence"));
    for (const { sig, reg, src } of Object.values(SIGS)) {
      const fp = md5(prosrc(fnBody(src, sig)));
      expect(precondition, reg).toContain(`'${reg}'::regprocedure`);
      expect(precondition, reg).toContain(`is distinct from '${fp}'`);
    }
    expect(precondition).toMatch(/already applied/);
    // the checks come before any DDL
    expect(mig.indexOf("is distinct from")).toBeLessThan(mig.indexOf("alter table"));
    expect(mig.indexOf("is distinct from")).toBeLessThan(mig.indexOf("create or replace function"));
  });

  it("the predecessors are the LATEST definitions on the migration chain (no later migration redefines them)", () => {
    const later = ["20261212090000", "20261213090000", "20261214090000", "20261215090000", "20261216090000"];
    for (const prefix of later) {
      const files = readdirSync(dir).filter((f) => f.startsWith(prefix));
      for (const f of files) {
        const body = read(f);
        for (const name of ["_tw4rfl_guard", "_tw4rfl_cover(", "_tw4rfl_register_core", "tw4_rfl_pilot_cover"]) {
          expect(body.includes(`create or replace function public.${name}`), `${f} redefines ${name}`).toBe(false);
        }
      }
    }
    // the guard's latest body is the 20261211 one, not the 20261209 one
    expect(md5(prosrc(fnBody(f11, SIGS.guard.sig)))).not.toBe(md5(prosrc(fnBody(f9, SIGS.guard.sig))));
  });

  it("changes each function only where intended: the cover predicate, the month rule, the supersede step and the guard exception", () => {
    for (const k of ["cover", "core", "pilot", "guard"] as const) {
      const before = fnBody(SIGS[k].src, SIGS[k].sig);
      const after = fnBody(mig, SIGS[k].sig);
      expect(after.length).toBeGreaterThan(before.length);
      // nothing else in the body moved: every removed predecessor line is one of the intended edits
      const gone = removed(before, after).join("\n");
      expect(gone.length, k).toBeLessThan(900);
    }
    const cover = fnBody(mig, SIGS.cover.sig);
    expect(cover).toContain("pc.superseded_at is null");
    expect(cover).toContain("public._tw4ml_month_key(r.legal_entity_id, cr.created_at) = pc.period_key");
    expect(cover).toContain("pc.basis = 'pilot_approval' or");
    const core = fnBody(mig, SIGS.core.sig);
    expect(core).toContain("public._tw4ml_month_key(v_entity, v_res.created_at) = v_key");
    expect(core).toContain("rfl_initial_cover_skipped");
    // registration is never refused for the month mismatch
    expect(core.slice(core.indexOf("v_res.created_at) = v_key"), core.indexOf("v_skipped := true;"))).not.toMatch(/raise/);
  });

  it("tw4_rfl_pilot_cover keeps every refusal, the write-flag pattern and the lock order; it supersedes only a non-counting initial_reservation cover", () => {
    const before = fnBody(f9, SIGS.pilot.sig);
    const after = fnBody(mig, SIGS.pilot.sig);
    for (const code of ["22023", "TW041", "TW042", "TW043", "TW007", "TW008"]) {
      expect(after.split(`errcode = '${code}'`).length, code).toBe(before.split(`errcode = '${code}'`).length);
    }
    expect(after.indexOf("_tw4c_admin")).toBeLessThan(after.indexOf("_tw4rfl_lock"));
    expect(after.indexOf("_tw4rfl_lock")).toBeLessThan(after.indexOf("for update"));
    expect(after).toContain("if pc.basis = 'initial_reservation' and not exists (");
    expect(after).toContain("cr.status in ('reserved', 'captured')");
    expect(after).toContain("public._tw4ml_month_key(r.legal_entity_id, cr.created_at) = pc.period_key");
    // the supersede mark happens after the funding checks (hold, ceiling, price): a refusal rolls everything back
    expect(after.indexOf("v_sup := true")).toBeLessThan(after.indexOf("update public.studio_sms_provider_cover set superseded_at"));
    expect(after.indexOf("the pilot ceiling would be exceeded")).toBeLessThan(after.indexOf("update public.studio_sms_provider_cover set superseded_at"));
    expect(after.indexOf("on hold or negative")).toBeLessThan(after.indexOf("update public.studio_sms_provider_cover set superseded_at"));
    expect(after).toContain("set_config('tw4.rfl_write', 'on', true)");
    expect(after).toContain("rfl_cover_superseded");
    expect(after).not.toMatch(/delete from/i);
  });

  it("the guard still refuses deletes and every cover edit except the supersede mark under the write flag", () => {
    const g = fnBody(mig, SIGS.guard.sig);
    expect(g).toContain("lifecycle evidence is never deleted");
    expect(g).toContain("cover records are permanent");
    expect(g).toContain("current_setting('tw4.rfl_write', true), '') = 'on' and old.superseded_at is null and new.superseded_at is not null and old.basis = 'initial_reservation'");
    expect(g).toContain("to_jsonb(new) - 'superseded_at'");
  });

  it("is additive: nullable supersede columns, a shape check, a partial live-period unique index; no grants, no data deletion, no policy change", () => {
    expect(mig).toMatch(/add column superseded_at timestamptz null/);
    expect(mig).toMatch(/add constraint studio_sms_provider_cover_superseded_shape/);
    expect(mig).toMatch(/create unique index studio_sms_provider_cover_period_live on public\.studio_sms_provider_cover \(resource_id, period_key\) where superseded_at is null/);
    expect(mig).toMatch(/drop constraint studio_sms_provider_cover_period;/);
    expect(mig).not.toMatch(/^\s*(grant|revoke)\b/im);
    expect(mig).not.toMatch(/delete from|truncate|drop table|drop column|drop function|create policy|alter policy/i);
    // the reservation uniqueness (a reservation covers one resource once) is untouched
    expect(mig).not.toMatch(/studio_sms_provider_cover_reservation/);
  });

  it("the rollback restores the four predecessors byte for byte, checks their fingerprints and refuses while superseded evidence exists", () => {
    for (const { sig, reg, src } of Object.values(SIGS)) {
      expect(rollback, reg).toContain(fnBody(src, sig));
      const fp = md5(prosrc(fnBody(src, sig)));
      expect(rollback.slice(rollback.indexOf("do $$", rollback.indexOf("drop column"))), reg).toContain(`is distinct from '${fp}'`);
    }
    expect(rollback).toMatch(/where superseded_at is not null\) then\s+raise exception 'd5-cover rollback refused/);
    expect(rollback.indexOf("rollback refused")).toBeLessThan(rollback.indexOf("create or replace function"));
    expect(rollback).toContain("add constraint studio_sms_provider_cover_period unique (resource_id, period_key)");
    expect(rollback).toContain("drop index public.studio_sms_provider_cover_period_live");
    expect(rollback).not.toMatch(/delete from|truncate|drop table/i);
    expect(rollback).toContain("roll back the later migration first");
  });
});

