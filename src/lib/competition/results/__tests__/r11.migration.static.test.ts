import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * R-11 correction migration (20270224090000), STATIC proof. No database. It re-derives the effective text of
 * approve_competition_round_result from the migration files (F2 body + the A3 and PV-1 exact-text patches), checks the pinned md5 values the
 * migration and its rollback assert, applies / reverses the R-11 fragments exactly as the SQL does, and checks the shape of the new text.
 * The behavior is proven by test_T_competition_r11_approval_override_scope.sql (local isolated Postgres; see R-11-CORRECTION-MIGRATION.md).
 *
 * pg_get_functiondef(...) with CRs removed is: header + body + "$function$\n". The header below is the one Postgres prints for this function.
 * This file is NEW and independent of PR 859's r11.approval.static.test.ts, whose `it.fails` markers read only the F2 file; the flip condition is
 * documented in docs/competition/governance/audit/RELEASE-BLOCKERS.md.
 */
const dir = path.resolve(__dirname, "../../../supabase/migrations");
const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r/g, "");
const md5 = (s: string) => crypto.createHash("md5").update(s, "utf8").digest("hex");

const F2 = read("20270114090000_competition_f2_results_lifecycle.sql");
const A3 = read("20270120093000_competition_cf1_a3_results_integrity.sql");
const PV1 = read("20270215090000_competition_pv1_result_recompute.sql");
const R11 = read("20270224090000_competition_r11_approval_override_scope.sql");
const RB = read("rollback/20270224090000_competition_r11_approval_override_scope_rollback.sql");

const HEADER =
  "CREATE OR REPLACE FUNCTION public.approve_competition_round_result(p_round_id uuid, p_result_version_id uuid, p_override_reason text, p_request_id uuid)\n" +
  " RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'public', 'pg_temp'\nAS $function$\n";
const def = (body: string) => HEADER + body + "$function$\n";

function between(src: string, start: string, open: string, close: string, from = 0): { text: string; end: number } {
  const i = src.indexOf(start, from);
  if (i < 0) throw new Error("start not found: " + start);
  const a = src.indexOf(open, i) + open.length;
  const b = src.indexOf(close, a);
  return { text: src.slice(a, b), end: b + close.length };
}
function pair(src: string, from: string, oldTag = "$o$", newTag = "$n$") {
  const o = between(src, from, oldTag, oldTag);
  const n = between(src, "", newTag, newTag, o.end);
  return { old: o.text, neu: n.text };
}
function replaceOnce(s: string, a: string, b: string): string {
  expect(s.split(a).length - 1, "anchor must occur exactly once").toBe(1);
  return s.replace(a, () => b);
}
function fragments(src: string) {
  const out: { old: string; neu: string }[] = [];
  for (const k of [1, 2, 3]) {
    const o = between(src, `v_old${k} constant text :=`, "$o$", "$o$;");
    const n = between(src, `v_new${k} constant text :=`, "$n$", "$n$;");
    out.push({ old: o.text, neu: n.text });
  }
  return out;
}

const f2Start = F2.indexOf("create function public.approve_competition_round_result(");
const bodyStart = F2.indexOf("as $$\n", f2Start) + "as $$\n".length;
const f2Body = F2.slice(bodyStart, F2.indexOf("\n$$;", bodyStart) + 1);
const a3p = pair(A3.slice(A3.indexOf("select pg_temp.cf1a3_pin_replace(\n  'public.approve_competition_round_result")), "array[");
const pvSlice = PV1.slice(PV1.indexOf("-- approve_competition_round_result: re-verify the stored version at approval"));
const pvo = between(pvSlice, "v_old constant text :=", "$o$", "$o$;");
const pvn = between(pvSlice, "v_new constant text :=", "$n$", "$n$;");
const preBody = f2Body.replace(a3p.old, () => a3p.neu).replace(pvo.text, () => pvn.text);

const PRE = "3cf63c3bb00a78142ea2c8e70a8b4a0c";
const POST = /v_post constant text := '([0-9a-f]{32})'/.exec(R11)![1];
const frags = fragments(R11);
const postBody = frags.reduce((s, f) => replaceOnce(s, f.old, f.neu), preBody);

describe("R-11 migration: pinned texts are reproducible offline", () => {
  it("F2 body + A3 patch + PV-1 patch reproduces the pinned pre-migration md5 (and the intermediate pins)", () => {
    expect(md5(def(f2Body))).toBe("0650367be64e3d1b4387a3dbceba3d4a");
    expect(md5(def(f2Body.replace(a3p.old, () => a3p.neu)))).toBe("ac33e456925e64665db1ea0547bae18b");
    expect(md5(def(preBody))).toBe(PRE);
  });

  it("the three fragments applied to the pre text give exactly the post md5 pinned in the migration and in the rollback", () => {
    expect(md5(def(postBody))).toBe(POST);
    expect(R11).toContain(`v_pre constant text := '${PRE}'`);
    expect(RB).toContain(`v_post constant text := '${POST}'`);
    expect(RB).toContain(`v_pre constant text := '${PRE}'`);
    expect(R11).not.toContain("__POST_MD5__");
  });

  it("the rollback fragments are the migration fragments, and reversing them restores the pre text byte for byte", () => {
    const rb = fragments(RB);
    expect(rb).toEqual(frags);
    const back = [...rb].reverse().reduce((s, f) => replaceOnce(s, f.neu, f.old), postBody);
    expect(back).toBe(preBody);
    expect(md5(def(back))).toBe(PRE);
  });

  it("neither file contains a carriage return in a function body (CRLF would change the md5 on a CRLF checkout)", () => {
    expect(fs.readFileSync(path.join(dir, "20270224090000_competition_r11_approval_override_scope.sql"), "utf8")).not.toMatch(/\r/);
    expect(fs.readFileSync(path.join(dir, "rollback/20270224090000_competition_r11_approval_override_scope_rollback.sql"), "utf8")).not.toMatch(/\r/);
  });
});

describe("R-11 migration: shape of the new approve text", () => {
  const t = postBody;
  const at = (s: string) => t.indexOf(s);

  it("keeps the refusal order: forbidden, request id, replay, state, stale checks, PV-1 verify BEFORE the history read and the reason rule", () => {
    const order = ["COMP_FORBIDDEN", "COMP_REQUEST_ID_REQUIRED", "COMP_REQUEST_REUSED", "COMP_RESULT_INVALID_TRANSITION", "COMP_RESULT_STALE", "_comppv1_verify", "v_initial :=", "_cf1_reason_is_substantive"]
      .map(at);
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // the stale refusal for a hash mismatch (the second COMP_RESULT_STALE) is also before the history read
    expect(t.lastIndexOf("COMP_RESULT_STALE")).toBeLessThan(at("v_initial :="));
  });

  it("the audit event and the roster check come after the reason rule; the roster check is untouched and unconditional (no override variable reaches it)", () => {
    expect(at("_cf1_reason_is_substantive")).toBeLessThan(at("_compf2_event"));
    expect(at("_compf2_event")).toBeLessThan(at("_cf1_require_roster_eligible(p_round_id, 'approve')"));
    expect(t.split("_cf1_require_roster_eligible").length - 1).toBe(1);
    expect(t).not.toMatch(/if[^;\n]*v_override[^;\n]*_cf1_require_roster_eligible/);
    expect(t).not.toMatch(/COMP_ADVANCEMENT_BELOW_MINIMUM|COMP_EXCLUSION|COMP_WITHDRAWAL/);
  });

  it("initial/corrected is read only from the three append-only tables, never from a parameter, correction_open or the round status", () => {
    const hist = t.slice(at("v_initial :="), at("v_override := v_ver.calculated_by = v_uid;"));
    expect(hist).toContain("public.event_competition_result_approvals");
    expect(hist).toContain("public.event_competition_correction_causes");
    expect(hist).toContain("public.event_competition_result_events");
    expect(hist).toMatch(/refs ->> 'correction' = 'true'/);
    expect(hist).not.toMatch(/p_override_reason|correction_open|v_round\.status|v_ver\.version|p_request_id/);
  });

  it("a corrected result is refused for the calculator OR any correction opener with the new code, whatever reason was supplied", () => {
    const corrected = t.slice(at("if not v_initial then"), at("elsif v_override and (not public._cf1_reason_is_substantive(v_reason)"));
    expect(corrected).toMatch(/if v_override or v_opener then/);
    expect(corrected).toContain("COMP_CORRECTION_APPROVER_REQUIRED");
    expect(corrected).toMatch(/opened_by = v_uid/);
    expect(corrected).toMatch(/actor_user_id = v_uid/);
    expect(corrected).not.toMatch(/v_reason/);
  });

  it("the initial override requires the substantive reason rule and keeps the old code; the reason is discarded for a non-calculator", () => {
    expect(t).toMatch(/elsif v_override and \(not public\._cf1_reason_is_substantive\(v_reason\)[\s\S]*?\[\^\[:alnum:\]\][\s\S]*?COMP_SECOND_APPROVER_REQUIRED/);
    expect(t).toMatch(/if not v_override then\s+v_reason := null;\s+end if;/);
  });

  it("the audit refs carry refs.initial for both event kinds; the event kind choice is unchanged", () => {
    expect(t).toContain("'override', v_override, 'initial', v_initial));");
    expect(t).toMatch(/case when v_override then 'result_approval_override' else 'result_approved' end/);
  });

  it("the migration is guarded: pre md5 pin, idempotent no-op on the post text, anchors exactly once, ACL / definer / search_path re-asserted, one transaction, header says NOT APPLIED", () => {
    expect(R11).toMatch(/^-- 20270224090000_competition_r11_approval_override_scope\.sql\n-- [-=]+\n-- NOT APPLIED ANYWHERE\. DRAFT\. Applying this migration to ANY hosted environment \(DEV, PROD, staging\) needs separate owner approval\./);
    expect(R11).toMatch(/if md5\(v_def\) = v_post then[\s\S]*?return;/);
    expect(R11).toMatch(/if md5\(v_def\) <> v_pre then/);
    expect(R11).toContain("does not contain each anchor exactly once");
    expect(R11).toContain("has_function_privilege('anon'");
    expect(R11.match(/^begin;$/gm)?.length).toBe(1);
    expect(R11.match(/^commit;$/gm)?.length).toBe(1);
  });

  it("touches only this one function: no create/drop/alter table, no grant, no revoke, no other function", () => {
    const code = R11.split("\n").filter((l) => !l.startsWith("--")).join("\n").replace(/\$[on]\$[\s\S]*?\$[on]\$/g, "");
    expect(code).not.toMatch(/\b(create|drop|alter)\s+(table|function|trigger|index|policy|type)\b/i);
    expect(code).not.toMatch(/\b(grant|revoke)\b/i);
  });
});
