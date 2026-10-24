import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCUMENT_ID_PATTERN, DOCUMENT_LINK_PATTERN, SCOPE_KINDS } from "../pilotApprovalEvidence";

/**
 * Static guards on the pilot SPEND evidence migration (20261230090000; no database needed): one transaction, every replaced body is md5-prechecked against its live predecessor,
 * the old signatures are dropped (no evidence-free overload), nothing is granted to an API role, the changed bodies differ from their predecessors only by the intended lines,
 * the scope map is exhaustive and fail closed, and the rollback restores the predecessors byte for byte and refuses while evidence exists.
 */
const dir = join(process.cwd(), "src/lib/supabase/migrations");
const read = (name: string) => readFileSync(join(dir, name), "utf8").replace(/\r/g, "");
const m1122 = read("20261122090000_twilio_tw4f3b0_prepaid_credits.sql");
const m1202 = read("20261202090000_twilio_tw4f_financial_integrity.sql");
const m1229 = read("20261229090000_twilio_rfl_pilot_evidence.sql");
const mig = read("20261230090000_twilio_rfl_pilot_spend_evidence.sql");
const rollback = read("rollback/20261230090000_twilio_rfl_pilot_spend_evidence_rollback.sql");

const SIG = {
  authorize: "create or replace function public.tw4_spend_authorize(",
  exception: "create or replace function public.tw4_pilot_exception_create(",
  cover: "create or replace function public.tw4_rfl_pilot_cover(",
} as const;
function fnBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(source.indexOf(signature, start + 1)).toBe(-1);
  return source.slice(start, source.indexOf("end $$;", start) + "end $$;".length);
}
const prosrc = (fn: string) => fn.slice(fn.indexOf("as $$") + "as $$".length, fn.lastIndexOf("$$;"));
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const removed = (before: string, after: string) => {
  const afterLines = after.split("\n");
  const out: string[] = [];
  let at = 0;
  for (const line of before.split("\n")) {
    const i = afterLines.indexOf(line, at);
    if (i < 0) out.push(line.trim());
    else at = i + 1;
  }
  return out;
};

const pred = {
  authorize: prosrc(fnBody(m1202, SIG.authorize)),
  exception: prosrc(fnBody(m1122, SIG.exception)),
  cover: prosrc(fnBody(m1229, SIG.cover)),
};
const next = {
  authorize: fnBody(mig, SIG.authorize),
  exception: fnBody(mig, SIG.exception),
  cover: fnBody(mig, SIG.cover),
};

const SA_OLD = "public.tw4_spend_authorize(uuid,text,integer,text,uuid,text,uuid)";
const SA_NEW = "public.tw4_spend_authorize(uuid,text,integer,text,uuid,text,uuid,date,text,text,integer,text,text,text)";
const PE_OLD = "public.tw4_pilot_exception_create(uuid,integer,text,uuid)";
const PE_NEW = "public.tw4_pilot_exception_create(uuid,integer,text,uuid,date,text,text,integer,text,text)";

describe("20261230090000 pilot spend evidence: migration shape", () => {
  it("is one transaction with nothing after the commit, a lock timeout, and sorts after every earlier migration", () => {
    for (const text of [mig, rollback]) {
      expect((text.match(/^begin;/gm) ?? []).length).toBe(1);
      expect((text.match(/^commit;/gm) ?? []).length).toBe(1);
      expect(text.trimEnd().endsWith("commit;")).toBe(true);
      expect(text).toMatch(/set local lock_timeout/);
    }
    const others = readdirSync(dir).filter((f) => /^2026\d{10}_/.test(f) && f.slice(0, 14) < "20261230090000").sort();
    expect(others[others.length - 1].slice(0, 14) < "20261230090000").toBe(true);
    expect(others.some((f) => f.startsWith("20261229"))).toBe(true);
  });

  it("md5-prechecks all three predecessor bodies (20261202, 20261122, 20261229) before any DDL, and refuses a re-apply", () => {
    const precondition = mig.slice(0, mig.indexOf("-- the evidence table"));
    for (const [reg, body] of [[SA_OLD, pred.authorize], [PE_OLD, pred.exception], ["public.tw4_rfl_pilot_cover(uuid,text,text,uuid,date,text,text,integer,text,text,text)", pred.cover]] as const) {
      expect(precondition, reg).toContain(`'${reg}'::regprocedure`);
      expect(precondition, reg).toContain(`is distinct from '${md5(body)}'`);
    }
    expect(md5(pred.cover)).toBe("deffc1b878778dced134334260d62512");
    expect(precondition).toMatch(/already applied/);
    expect(mig.indexOf("is distinct from")).toBeLessThan(mig.indexOf("create table"));
    expect(mig.indexOf("is distinct from")).toBeLessThan(mig.indexOf("drop function"));
    expect(mig.indexOf("is distinct from")).toBeLessThan(mig.indexOf("create or replace function"));
  });

  it("the predecessors are the LATEST definitions on the chain: nothing between redefines them", () => {
    for (const f of readdirSync(dir).filter((x) => /^2026\d{10}_.*\.sql$/.test(x) && x.slice(0, 14) > "20261202090000" && x.slice(0, 14) < "20261230090000")) {
      const text = read(f);
      expect(text, f).not.toMatch(/create (or replace )?function public\.tw4_spend_authorize\(/);
      expect(text, f).not.toMatch(/create (or replace )?function public\.tw4_pilot_exception_create\(/);
    }
    for (const f of readdirSync(dir).filter((x) => /^2026\d{10}_.*\.sql$/.test(x) && x.slice(0, 14) > "20261122090000" && x.slice(0, 14) < "20261230090000")) {
      expect(read(f), f).not.toMatch(/create (or replace )?function public\.tw4_pilot_exception_create\(/);
    }
  });

  it("drops both old signatures and creates only the evidence-carrying ones: no evidence-free overload", () => {
    expect(mig).toContain("drop function public.tw4_spend_authorize(uuid, text, int, text, uuid, text, uuid);");
    expect(mig).toContain("drop function public.tw4_pilot_exception_create(uuid, int, text, uuid);");
    expect(mig.indexOf("drop function public.tw4_spend_authorize")).toBeLessThan(mig.indexOf(SIG.authorize));
    expect(mig.indexOf("drop function public.tw4_pilot_exception_create")).toBeLessThan(mig.indexOf(SIG.exception));
    for (const sig of Object.values(SIG)) expect((mig.match(new RegExp(sig.replace(/[()]/g, "\\$&"), "g")) ?? []).length, sig).toBe(1);
    const authHeader = next.authorize.slice(0, next.authorize.indexOf("returns jsonb"));
    // the seven evidence arguments all default to null: pilot refuses without them, credit refuses WITH them (tested below), so a default cannot create an evidence-free pilot path
    for (const arg of ["p_evidence_authorized_on date default null", "p_evidence_role text default null", "p_evidence_scope text default null", "p_evidence_amount_cents int default null",
      "p_evidence_period_key text default null", "p_evidence_document_ref text default null", "p_evidence_sha256 text default null"]) expect(authHeader).toContain(arg);
    expect(authHeader).toContain("p_funding text default 'credit', p_studio_id uuid default null");
    const excHeader = next.exception.slice(0, next.exception.indexOf("returns jsonb"));
    expect(excHeader).not.toMatch(/\bdefault\b/i);
    for (const arg of ["p_evidence_authorized_on date", "p_evidence_role text", "p_evidence_scope text", "p_evidence_amount_cents int", "p_evidence_document_ref text", "p_evidence_sha256 text"]) expect(excHeader).toContain(arg);
  });

  it("the changed bodies differ from their predecessors only by the intended lines", () => {
    const authRemoved = removed(pred.authorize, prosrc(next.authorize));
    expect(authRemoved).toHaveLength(1);
    expect(authRemoved[0]).toContain("'spend_authorized'");
    const excRemoved = removed(pred.exception, prosrc(next.exception));
    expect(excRemoved).toHaveLength(1);
    expect(excRemoved[0]).toContain("'credit_pilot_exception'");
    expect(removed(pred.cover, prosrc(next.cover))).toHaveLength(1);
    expect(removed(pred.cover, prosrc(next.cover))[0]).toContain("public.tw4_spend_authorize(r.legal_entity_id, r.fee_kind, p.customer_price_cents, p_approval_ref, p_actor, 'pilot', r.studio_id)");
    // the cover passes its already-validated evidence through, in the order of the new arguments (one transaction: both evidence rows carry the same fields)
    expect(next.cover).toContain("p_authorized_on, p_authorized_by_role, p_scope, p_amount_cents, p_period_key, p_document_ref, p_document_sha256)");
  });

  it("tw4_spend_authorize keeps its order and semantics: admin, entity row lock, pilot checks, evidence, ref lock/replay, price, cap, insert", () => {
    const body = prosrc(next.authorize);
    const order = [
      "_tw4_r1_is_platform_admin(p_actor)", "from public.studio_sms_legal_entities x where x.id = p_entity_id for update", "a pilot-funded authorization needs the pilot exception",
      "a credit-funded authorization takes no pilot evidence", "pg_advisory_xact_lock(hashtextextended('tw4fi_ref:'", "from public.studio_sms_price_list x where x.kind = p_kind and x.active",
      "this authorization would exceed the spend cap", "insert into public.studio_sms_spend_events", "insert into public.studio_sms_pilot_spend_evidence", "'spend_authorized'",
    ].map((needle) => body.indexOf(needle));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const code of ["22023", "42501", "TW004", "TW008", "TW019", "TW052"]) expect(body.includes(code), code).toBe(true);
    expect(body).toContain("set_config('tw4.pilotev_write', 'on', true)");
    expect(body).toContain("set_config('tw4.pilotev_write', 'off', true)");
    // a replay of a pilot approval must carry the same evidence
    expect(body).toMatch(/already recorded with different evidence/);
  });

  it("the scope map is exhaustive and fail closed: SQL and TS agree, an unknown scope or kind is refused, credit takes no evidence", () => {
    const body = prosrc(next.authorize);
    expect(body).toMatch(/when 'pilot_onboarding_fee' then p_kind in \('brand', 'brand_low_volume'\)/);
    expect(body).toMatch(/when 'pilot_campaign_fee' then p_kind in \('campaign_vetting', 'monthly', 'monthly_low_volume'\)/);
    expect(body).toMatch(/when 'pilot_number_purchase' then p_kind = 'number'/);
    expect(body).toMatch(/when 'pilot_period_cover' then p_kind in \('number', 'monthly', 'monthly_low_volume'\)/);
    expect(body).toMatch(/else false end/);
    expect(SCOPE_KINDS).toEqual({
      pilot_exception: [], pilot_onboarding_fee: ["brand", "brand_low_volume"], pilot_campaign_fee: ["campaign_vetting", "monthly", "monthly_low_volume"],
      pilot_number_purchase: ["number"], pilot_period_cover: ["number", "monthly", "monthly_low_volume"],
    });
    expect(body).toMatch(/if p_funding = 'credit' then\s+if p_evidence_authorized_on is not null or/);
    // the table accepts exactly the five scopes
    expect(mig).toMatch(/scope in \('pilot_exception', 'pilot_onboarding_fee', 'pilot_campaign_fee', 'pilot_number_purchase', 'pilot_period_cover'\)/);
  });

  it("tw4_pilot_exception_create validates the evidence AFTER its existing validations and BEFORE the replay/insert; the amount equals the ceiling", () => {
    const body = prosrc(next.exception);
    expect(body.indexOf("_tw4c_admin(p_actor)")).toBeLessThan(body.indexOf("the pilot ceiling must be positive"));
    expect(body.indexOf("the pilot ceiling must be positive")).toBeLessThan(body.indexOf("the date of the founder''s written authorization is required"));
    expect(body.indexOf("the sha256 of the retained text")).toBeLessThan(body.indexOf("from public.studio_sms_pilot_exceptions y where y.legal_entity_id = p_entity_id"));
    expect(body).toMatch(/p_evidence_amount_cents <> p_ceiling_cents/);
    expect(body).toMatch(/p_evidence_scope <> 'pilot_exception'/);
    expect(body).toMatch(/char_length\(btrim\(p_approval_ref\)\) > 200/);
    expect(body).toMatch(/p_evidence_authorized_on > v_today then/);
    expect(body).toMatch(/p_evidence_authorized_on < v_today - 400/);
    expect(body.indexOf("23505")).toBeLessThan(body.indexOf("already recorded with different evidence"));
  });

  it("shares the document id/link patterns with the TS validator and the #305 evidence table", () => {
    expect(mig.split("^[A-Za-z0-9][A-Za-z0-9._/#+-]{5,119}$").length - 1).toBeGreaterThanOrEqual(3);
    expect(mig.split("^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~!$''()*+,:@/-]*)?$").length - 1).toBeGreaterThanOrEqual(3);
    expect(DOCUMENT_ID_PATTERN.source).toBe("^[A-Za-z0-9][A-Za-z0-9._/#+-]{5,119}$");
    expect(DOCUMENT_LINK_PATTERN.source.replace(/\\\//g, "/")).toBe("^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~!$'()*+,:@/-]*)?$");
    expect(m1229.split("^[A-Za-z0-9][A-Za-z0-9._/#+-]{5,119}$").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("the evidence table is append-only, RLS on, no API grants, hash and reference only, with its own guard and flag; shared guards are not replaced", () => {
    expect(mig).toMatch(/create table public\.studio_sms_pilot_spend_evidence/);
    expect(mig).toMatch(/revoke all on public\.studio_sms_pilot_spend_evidence from public, anon, authenticated, service_role;/);
    expect(mig).toMatch(/alter table public\.studio_sms_pilot_spend_evidence enable row level security;/);
    expect(mig).toMatch(/spend_event_id uuid null unique references public\.studio_sms_spend_events\(id\) on delete restrict/);
    expect(mig).toMatch(/create unique index studio_sms_pilot_spend_evidence_exception on public\.studio_sms_pilot_spend_evidence \(legal_entity_id\) where subject = 'pilot_exception'/);
    expect(mig).toMatch(/document_sha256 text not null check \(document_sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/);
    expect(mig).toMatch(/before insert or update or delete on public\.studio_sms_pilot_spend_evidence/);
    expect(mig).toMatch(/before truncate on public\.studio_sms_pilot_spend_evidence/);
    expect(mig).toMatch(/enable always trigger studio_sms_pilot_spend_evidence_guard/);
    const start = mig.indexOf("create table public.studio_sms_pilot_spend_evidence");
    const table = mig.slice(start, mig.indexOf("create unique index", start));
    expect(table).not.toMatch(/\b(note|body|content|statement|authorization_text|reason|text_body)\b/i);
    for (const forbidden of ["_tw4rfl_guard", "_tw4rfl_evid_guard", "_tw4fi_append_only"]) expect(mig).not.toMatch(new RegExp(`create (or replace )?function public\\.${forbidden}\\(`));
  });

  it("refuses to apply while a live pilot-funded approval (other than a #305 cover) or any pilot exception exists without evidence, under table locks, before any DDL", () => {
    expect(mig).toMatch(/lock table public\.studio_sms_spend_events in share row exclusive mode;/);
    expect(mig).toMatch(/lock table public\.studio_sms_pilot_exceptions in share row exclusive mode;/);
    const live = mig.indexOf("se.funding = 'pilot' and se.status in ('authorized', 'reserved')");
    const exc = mig.indexOf("from public.studio_sms_pilot_exceptions)");
    expect(live).toBeGreaterThan(0);
    expect(exc).toBeGreaterThan(0);
    expect(mig).toMatch(/pilot-spend-evidence precondition failed: live pilot-funded spend approvals without evidence exist/);
    expect(mig).toMatch(/pilot-spend-evidence precondition failed: a pilot exception without evidence exists/);
    expect(mig).toMatch(/join public\.studio_sms_provider_cover_evidence ev on ev\.cover_id = c\.id where c\.spend_event_id = se\.id/);
    expect(Math.max(live, exc)).toBeLessThan(mig.indexOf("create table"));
  });

  it("grants nothing to API roles: both functions service_role only, the guard private", () => {
    expect(mig).toMatch(/revoke all on function public\.tw4_spend_authorize\(uuid, text, int, text, uuid, text, uuid, date, text, text, int, text, text, text\) from public, anon, authenticated;/);
    expect(mig).toMatch(/grant execute on function public\.tw4_spend_authorize\(uuid, text, int, text, uuid, text, uuid, date, text, text, int, text, text, text\) to service_role;/);
    expect(mig).toMatch(/revoke all on function public\.tw4_pilot_exception_create\(uuid, int, text, uuid, date, text, text, int, text, text\) from public, anon, authenticated;/);
    expect(mig).toMatch(/grant execute on function public\.tw4_pilot_exception_create\(uuid, int, text, uuid, date, text, text, int, text, text\) to service_role;/);
    expect(mig).toMatch(/revoke all on function public\._tw4pse_guard\(\) from public, anon, authenticated, service_role;/);
    for (const text of [mig, rollback]) {
      for (const g of text.match(/^grant .*$/gm) ?? []) {
        expect(g).toMatch(/ to service_role;$/);
        expect(g.slice(g.indexOf(" to "))).not.toMatch(/\b(anon|authenticated|public)\b/);
      }
      expect(text).not.toMatch(/\bgrant (select|insert|update|delete|all)\b/i);
    }
  });

  it("never deletes or truncates data and touches no other function", () => {
    expect(mig).not.toMatch(/\bdelete from\b|\btruncate\s+(table\s+)?public\.|\bdrop table\b/i);
    const replaced = [...mig.matchAll(/create (?:or replace )?function public\.(\w+)\(/g)].map((m) => m[1]).sort();
    expect(replaced).toEqual(["_tw4pse_guard", "tw4_pilot_exception_create", "tw4_rfl_pilot_cover", "tw4_spend_authorize"]);
  });

  it("the rollback restores all three predecessor bodies byte for byte, re-checks their md5, md5-checks the live new bodies first, and refuses while evidence exists", () => {
    expect(prosrc(fnBody(rollback, SIG.authorize))).toBe(pred.authorize);
    expect(prosrc(fnBody(rollback, SIG.exception))).toBe(pred.exception);
    expect(prosrc(fnBody(rollback, SIG.cover))).toBe(pred.cover);
    for (const [reg, body] of [[SA_OLD, pred.authorize], [PE_OLD, pred.exception], ["public.tw4_rfl_pilot_cover(uuid,text,text,uuid,date,text,text,integer,text,text,text)", pred.cover]] as const) {
      expect(rollback, reg).toContain(`'${reg}'::regprocedure`);
      expect(rollback, reg).toContain(`is distinct from '${md5(body)}'`);
    }
    for (const [reg, body] of [[SA_NEW, prosrc(next.authorize)], [PE_NEW, prosrc(next.exception)], ["public.tw4_rfl_pilot_cover(uuid,text,text,uuid,date,text,text,integer,text,text,text)", prosrc(next.cover)]] as const) {
      expect(rollback, reg).toContain(`'${reg}'::regprocedure`);
      expect(rollback, reg).toContain(`is distinct from '${md5(body)}'`);
    }
    expect(rollback).toMatch(/pilot-spend-evidence rollback refused: approval evidence exists and is permanent/);
    expect(rollback).toMatch(/differs from its 20261230 definition/);
    expect(rollback).toMatch(/lock table public\.studio_sms_pilot_spend_evidence in access exclusive mode;/);
    const refuse = rollback.indexOf("rollback refused: approval evidence exists");
    expect(refuse).toBeLessThan(rollback.indexOf("drop function public.tw4_spend_authorize"));
    expect(refuse).toBeLessThan(rollback.indexOf("drop table"));
    expect(rollback.indexOf("is distinct from", rollback.indexOf(`'${SA_NEW}'`))).toBeLessThan(rollback.indexOf("drop function"));
    expect(rollback).toContain("drop function public.tw4_spend_authorize(uuid, text, int, text, uuid, text, uuid, date, text, text, int, text, text, text);");
    expect(rollback).toContain("drop function public.tw4_pilot_exception_create(uuid, int, text, uuid, date, text, text, int, text, text);");
    expect(rollback).toContain("drop table public.studio_sms_pilot_spend_evidence;");
    expect(rollback).toContain("drop function public._tw4pse_guard();");
    expect(rollback).toMatch(/grant execute on function public\.tw4_spend_authorize\(uuid, text, int, text, uuid, text, uuid\) to service_role;/);
    expect(rollback).toMatch(/grant execute on function public\.tw4_pilot_exception_create\(uuid, int, text, uuid\) to service_role;/);
    // the post-restore re-check comes after the restore
    expect(rollback.lastIndexOf("was not restored byte-exactly")).toBeGreaterThan(rollback.indexOf(SIG.cover));
  });

  it("no non-test TypeScript calls the evidence-free shapes: every pilot call site goes through the stores that pass evidence", () => {
    const root = join(process.cwd(), "src/lib/sms/twilioIsv");
    for (const [file, needle] of [["entityStore.ts", "spendEvidenceParams"], ["panel.ts", "spendEvidenceParams"], ["panel.ts", "exceptionEvidenceParams"], ["creditStore.ts", "exceptionEvidenceParams"]] as const) {
      expect(readFileSync(join(root, file), "utf8"), `${file} ${needle}`).toContain(needle);
    }
  });
});
