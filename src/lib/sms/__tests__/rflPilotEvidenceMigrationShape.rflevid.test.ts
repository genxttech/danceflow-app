import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static guards on the pilot-evidence migration (no database needed): one transaction, the predecessor (20261225) body is fingerprint-checked before it is replaced, the old
 * four-argument signature is dropped (no evidence-free overload), no API role gets anything, the shared guard is not replaced, the reference length is widened additively, and the
 * rollback restores the predecessor byte for byte and refuses while evidence exists.
 */
const dir = join(process.cwd(), "src/lib/supabase/migrations");
const read = (name: string) => readFileSync(join(dir, name), "utf8").replace(/\r/g, "");
const d5 = read("20261225090000_twilio_rfl_d5_cover.sql");
const mig = read("20261229090000_twilio_rfl_pilot_evidence.sql");
const rollback = read("rollback/20261229090000_twilio_rfl_pilot_evidence_rollback.sql");

const PILOT_SIG = "create or replace function public.tw4_rfl_pilot_cover(";
function fnBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(source.indexOf(signature, start + 1)).toBe(-1);
  return source.slice(start, source.indexOf("end $$;", start) + "end $$;".length);
}
const prosrc = (fn: string) => fn.slice(fn.indexOf("as $$") + "as $$".length, fn.lastIndexOf("$$;"));
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const predecessor = prosrc(fnBody(d5, PILOT_SIG));
const replacement = fnBody(mig, PILOT_SIG);

describe("20261229090000 pilot approval evidence: migration shape", () => {
  it("is one transaction with nothing after the commit, a lock timeout, and sorts after every earlier migration", () => {
    for (const text of [mig, rollback]) {
      expect((text.match(/^begin;/gm) ?? []).length).toBe(1);
      expect((text.match(/^commit;/gm) ?? []).length).toBe(1);
      expect(text.trimEnd().endsWith("commit;")).toBe(true);
      expect(text).toMatch(/set local lock_timeout/);
    }
    const latestOther = readdirSync(dir).filter((f) => /^2026\d{10}_/.test(f) && !f.startsWith("20261229")).sort().pop() ?? "";
    expect("20261229090000" > latestOther.slice(0, 14)).toBe(true);
  });

  it("fingerprint-checks the 20261225 body of tw4_rfl_pilot_cover before replacing it, and every check comes before any DDL", () => {
    const fp = md5(predecessor);
    expect(fp).toBe("00e9bff4d2ce4e0cca135317216541fb");
    const precondition = mig.slice(0, mig.indexOf("-- 1. widen"));
    expect(precondition).toContain("'public.tw4_rfl_pilot_cover(uuid,text,text,uuid)'::regprocedure");
    expect(precondition).toContain(`is distinct from '${fp}'`);
    expect(precondition).toMatch(/already applied/);
    expect(mig.indexOf("is distinct from")).toBeLessThan(mig.indexOf("alter table"));
    expect(mig.indexOf("is distinct from")).toBeLessThan(mig.indexOf("create table"));
    expect(mig.indexOf("is distinct from")).toBeLessThan(mig.indexOf("create or replace function"));
  });

  it("the predecessor is the LATEST definition on the chain: no migration after 20261225 redefines tw4_rfl_pilot_cover", () => {
    for (const f of readdirSync(dir).filter((x) => /^2026\d{10}_.*\.sql$/.test(x) && x.slice(0, 14) > "20261225090000" && !x.startsWith("20261229"))) {
      expect(read(f), f).not.toMatch(/create (or replace )?function public\.tw4_rfl_pilot_cover\(/);
      expect(read(f), f).not.toMatch(/drop function public\.tw4_rfl_pilot_cover/);
    }
  });

  it("drops the old four-argument signature and creates only the eleven-argument one: no evidence-free overload", () => {
    expect(mig).toContain("drop function public.tw4_rfl_pilot_cover(uuid, text, text, uuid);");
    expect(mig.indexOf("drop function public.tw4_rfl_pilot_cover(uuid, text, text, uuid);")).toBeLessThan(mig.indexOf(PILOT_SIG));
    expect((mig.match(/create or replace function public\.tw4_rfl_pilot_cover\(/g) ?? []).length).toBe(1);
    const header = replacement.slice(0, replacement.indexOf("returns jsonb"));
    for (const arg of ["p_authorized_on date", "p_authorized_by_role text", "p_scope text", "p_amount_cents int", "p_evidence_period_key text", "p_document_ref text", "p_document_sha256 text"]) {
      expect(header).toContain(arg);
    }
    // no defaults on the evidence arguments (a default would let a caller omit them)
    expect(header).not.toMatch(/\bdefault\b/i);
  });

  it("changes the predecessor only by the intended additions: every refusal, the write-flag pattern, the lock order and the supersede logic are kept", () => {
    const body = prosrc(replacement);
    const predLines = predecessor.split("\n");
    const bodyLines = body.split("\n");
    let at = 0;
    const removed: string[] = [];
    for (const line of predLines) {
      const i = bodyLines.indexOf(line, at);
      if (i < 0) removed.push(line.trim());
      else at = i + 1;
    }
    // the only predecessor lines that may disappear are the declarations/inserts/audit/return the evidence extends
    expect(removed.filter((l) => !/^(v_new uuid|v_sup boolean|insert into public\.studio_sms_provider_cover \(|values \(v_new|return jsonb_build_object|perform public\._tw4rfl_audit\(r\.studio_id, p_actor, 'rfl_cover_recorded'|if pc\.basis = 'pilot_approval' and pc\.approval_ref|return jsonb_build_object\('cover_id', pc\.id, 'replayed', true\);|a := |end if;|$)/.test(l))).toEqual([]);
    for (const code of ["22023", "TW007", "TW008", "TW019", "TW041", "TW042", "TW043", "TW052", "42501"]) expect(mig.includes(code), code).toBe(true);
    expect(body).toContain("perform public._tw4c_admin(p_actor);");
    // lock order: the legal business row and the credit account (via _tw4rfl_lock) before the resource row, before tw4_spend_authorize
    expect(body.indexOf("_tw4rfl_lock(r.legal_entity_id)")).toBeGreaterThan(0);
    expect(body.indexOf("_tw4rfl_lock(r.legal_entity_id)")).toBeLessThan(body.indexOf("from public.studio_sms_provider_resources x where x.id = p_resource_id for update"));
    expect(body.indexOf("for update")).toBeLessThan(body.indexOf("tw4_spend_authorize("));
    expect(body).toContain("perform set_config('tw4.rfl_write', 'on', true);");
    expect(body).toContain("perform set_config('tw4.rfl_write', 'off', true);");
    expect(body).toContain("set_config('tw4.rflevid_write', 'on', true)");
    expect(body).toContain("set_config('tw4.rflevid_write', 'off', true)");
    expect(body).toMatch(/v_used \+ p\.customer_price_cents > pe\.ceiling_cents/);
    expect(body).toMatch(/a\.hold or a\.balance_cents < 0/);
    expect(body).toMatch(/p_period_key < v_cur or p_period_key > public\._tw4ml_key_add\(v_cur, 1\)/);
    expect(body).toMatch(/superseded_reason = case when not exists/);
  });

  it("validates the reference length (10..200), the date window (not future, 400 days), the role vocabulary, the scope, the amount against the price, the period and the sha256", () => {
    const body = prosrc(replacement);
    expect(body).toMatch(/char_length\(btrim\(p_approval_ref\)\) < 10 or char_length\(btrim\(p_approval_ref\)\) > 200/);
    expect(body).toMatch(/p_authorized_on > v_today \+ 1/);
    expect(body).toMatch(/p_authorized_on < v_today - 400/);
    expect(body).toMatch(/p_authorized_by_role not in \('founder_written', 'owner_written'\)/);
    expect(body).toMatch(/p_scope <> 'pilot_period_cover'/);
    expect(body).toMatch(/p_amount_cents <> p\.customer_price_cents/);
    expect(body).toMatch(/p_evidence_period_key <> p_period_key/);
    expect(body).toMatch(/p_document_sha256 !~ '\^\[0-9a-f\]\{64\}\$'/);
    expect(body).toMatch(/https:\/\//);
    // the amount check uses the price lookup the function already uses (the active published price of the covered fee), and runs before the ceiling and before any spend approval
    expect(body.indexOf("p_amount_cents <> p.customer_price_cents")).toBeGreaterThan(body.indexOf("from public.studio_sms_price_list x where x.kind = r.fee_kind and x.active"));
    expect(body.indexOf("p_amount_cents <> p.customer_price_cents")).toBeLessThan(body.indexOf("pe.ceiling_cents"));
    expect(body.indexOf("p_amount_cents <> p.customer_price_cents")).toBeLessThan(body.indexOf("tw4_spend_authorize("));
    // every parameter-only refusal comes before the first lock
    expect(body.indexOf("p_document_sha256 !~")).toBeLessThan(body.indexOf("_tw4rfl_lock("));
  });

  it("widens the reference length check additively: new check first, floor stays 3, old check discovered by definition and dropped, never a column rewrite", () => {
    expect(mig).toMatch(/add constraint studio_sms_spend_events_approval_ref_len check \(char_length\(btrim\(approval_ref\)\) between 3 and 200\)/);
    expect(mig.indexOf("add constraint studio_sms_spend_events_approval_ref_len")).toBeLessThan(mig.indexOf("drop constraint %I"));
    expect(mig).toMatch(/like '%char_length\(btrim\(approval_ref\)\)%'/);
    expect(mig).not.toMatch(/alter column approval_ref/i);
    expect(mig).not.toMatch(/between 10 and 200\)\s*;/);
  });

  it("the evidence table is append-only, RLS on, no API grants, hash and reference only, with its own guard; the shared guards are not replaced", () => {
    expect(mig).toMatch(/create table public\.studio_sms_provider_cover_evidence/);
    expect(mig).toMatch(/revoke all on public\.studio_sms_provider_cover_evidence from public, anon, authenticated, service_role;/);
    expect(mig).toMatch(/alter table public\.studio_sms_provider_cover_evidence enable row level security;/);
    expect(mig).toMatch(/cover_id uuid not null unique references public\.studio_sms_provider_cover\(id\)/);
    expect(mig).toMatch(/document_sha256 text not null check \(document_sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/);
    expect(mig).toMatch(/before insert or update or delete on public\.studio_sms_provider_cover_evidence/);
    expect(mig).toMatch(/before truncate on public\.studio_sms_provider_cover_evidence/);
    expect(mig).toMatch(/enable always trigger studio_sms_provider_cover_evidence_guard/);
    const table = mig.slice(mig.indexOf("create table public.studio_sms_provider_cover_evidence"), mig.indexOf(");", mig.indexOf("create table public.studio_sms_provider_cover_evidence")));
    expect(table).not.toMatch(/\b(note|text_body|body|content|statement|authorization_text|reason)\b/i);
    expect(mig).not.toMatch(/create (or replace )?function public\._tw4rfl_guard\(/);
    expect(mig).not.toMatch(/create (or replace )?function public\._tw4rfl_cover\(/);
    expect(mig).not.toMatch(/studio_sms_provider_cover_guard/);
  });

  it("grants nothing to API roles: the function is service_role only, like the original, and the guard function is private", () => {
    expect(mig).toMatch(/revoke all on function public\.tw4_rfl_pilot_cover\(uuid, text, text, uuid, date, text, text, int, text, text, text\) from public, anon, authenticated;/);
    expect(mig).toMatch(/grant execute on function public\.tw4_rfl_pilot_cover\(uuid, text, text, uuid, date, text, text, int, text, text, text\) to service_role;/);
    expect(mig).toMatch(/revoke all on function public\._tw4rfl_evid_guard\(\) from public, anon, authenticated, service_role;/);
    for (const text of [mig, rollback]) {
      const grants = text.match(/^grant .*$/gm) ?? [];
      for (const g of grants) {
        expect(g).toMatch(/ to service_role;$/);
        expect(g.slice(g.indexOf(" to "))).not.toMatch(/\b(anon|authenticated|public)\b/);
      }
    }
    expect(mig).not.toMatch(/\bgrant (select|insert|update|delete|all)\b/i);
  });

  it("does not touch the spend, registry or other approval tables and functions beyond the one length check", () => {
    expect(mig).not.toMatch(/create (or replace )?function public\.tw4_spend_authorize/);
    expect(mig).not.toMatch(/studio_sms_approval_refs/);
    expect(mig).not.toMatch(/tw4_prov_observe/);
    expect(mig).not.toMatch(/\bdelete from\b|\btruncate\s+(table\s+)?public\.|\bdrop table\b/i);
  });

  it("the rollback restores the 20261225 body byte for byte, checks its fingerprint after, refuses while evidence exists, and cannot lose references longer than 120", () => {
    expect(prosrc(fnBody(rollback, PILOT_SIG))).toBe(predecessor);
    expect(rollback).toContain(`is distinct from '${md5(predecessor)}'`);
    expect(rollback).toMatch(/pilot-evidence rollback refused: approval evidence exists and is permanent/);
    expect(rollback).toMatch(/char_length\(btrim\(approval_ref\)\) > 120/);
    expect(rollback).toMatch(/pilot-evidence rollback refused: an approval reference longer than 120 characters exists/);
    expect(rollback).toContain("drop function public.tw4_rfl_pilot_cover(uuid, text, text, uuid, date, text, text, int, text, text, text);");
    expect(rollback).toContain("drop table public.studio_sms_provider_cover_evidence;");
    expect(rollback).toContain("drop function public._tw4rfl_evid_guard();");
    expect(rollback).toMatch(/add constraint studio_sms_spend_events_approval_ref_check check \(char_length\(btrim\(approval_ref\)\) between 3 and 120\)/);
    expect(rollback.indexOf("refused: approval evidence exists")).toBeLessThan(rollback.indexOf("drop table"));
    expect(rollback.indexOf("drop table")).toBeLessThan(rollback.indexOf(PILOT_SIG));
    expect(rollback).toMatch(/lock table public\.studio_sms_provider_cover_evidence in access exclusive mode;/);
    expect(rollback).toMatch(/grant execute on function public\.tw4_rfl_pilot_cover\(uuid, text, text, uuid\) to service_role;/);
  });

  it("no non-test source calls the old four-argument shape", () => {
    const lifecycle = readFileSync(join(process.cwd(), "src/lib/sms/providerFeeLifecycle.ts"), "utf8");
    const call = lifecycle.slice(lifecycle.indexOf("async pilotCover("), lifecycle.indexOf("async observeProviderBill("));
    for (const p of ["p_authorized_on", "p_authorized_by_role", "p_scope", "p_amount_cents", "p_evidence_period_key", "p_document_ref", "p_document_sha256"]) expect(call).toContain(p);
  });
});
