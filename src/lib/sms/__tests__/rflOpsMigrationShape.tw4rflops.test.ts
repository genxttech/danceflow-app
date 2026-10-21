import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static guards on the RFL operations migration (no database needed): each replaced function differs from its 20261209 predecessor ONLY by the intended additions, the
 * migration refuses to apply over any other body, the rollback restores the four predecessors byte for byte, the vocabularies are extended from their live definitions, and
 * nothing here calls Twilio, posts to a ledger, extends an authorization or registers a schedule.
 */
const dir = join(process.cwd(), "src/lib/supabase/migrations");
const read = (name: string) => readFileSync(join(dir, name), "utf8");
const prev = read("20261209090000_twilio_recurring_fee_lifecycle.sql");
const mig = read("20261211090000_twilio_rfl_ops.sql");
const rollback = read("rollback/20261211090000_twilio_rfl_ops_rollback.sql");

const SIGS = {
  claim: "create or replace function public.tw4_rfl_alerts_claim(p_limit int)",
  scan: "create or replace function public.tw4_rfl_scan_entity(p_entity_id uuid)",
  dispose: "create or replace function public.tw4_rfl_exposure_dispose(p_resource_id uuid, p_period_key text, p_actor uuid, p_disposition text, p_note text)",
  cancel: "create or replace function public.tw4_rfl_cancel_authorize(p_resource_id uuid, p_actor uuid, p_approval_ref text, p_decided_by text, p_reason text, p_irreversible_ack boolean)",
} as const;

function fnBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(source.indexOf(signature, start + 1)).toBe(-1);
  return source.slice(start, source.indexOf("end $$;", start) + "end $$;".length);
}
const prosrc = (fn: string) => fn.slice(fn.indexOf("as $$") + "as $$".length, fn.lastIndexOf("$$;"));
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
/** the lines of the replacement that are not the predecessor's lines (greedy, in order: a repeated line such as `end if;` still counts when it was added) */
const added = (before: string, after: string) => {
  const old = before.split("\n");
  const out: string[] = [];
  let at = 0;
  for (const line of after.split("\n")) {
    if (at < old.length && line === old[at]) at += 1;
    else out.push(line);
  }
  return out;
};
/** every line of the predecessor survives in the replacement, in the same order */
function survivesInOrder(before: string, after: string) {
  const afterLines = after.split("\n");
  let at = 0;
  for (const line of before.split("\n")) {
    at = afterLines.indexOf(line, at);
    expect(at, `line lost: ${line}`).toBeGreaterThanOrEqual(0);
    at += 1;
  }
}

describe("20261211090000 RFL ops: migration shape", () => {
  it("is one transaction, nothing follows the commit, and it sorts after the lifecycle migration", () => {
    expect((mig.match(/^begin;/gm) ?? []).length).toBe(1);
    expect((mig.match(/^commit;/gm) ?? []).length).toBe(1);
    expect(mig.trimEnd().endsWith("commit;")).toBe(true);
    expect((rollback.match(/^begin;/gm) ?? []).length).toBe(1);
    expect(rollback.trimEnd().endsWith("commit;")).toBe(true);
    expect(mig).toContain("set local lock_timeout");
    expect("20261211090000_twilio_rfl_ops.sql" > "20261210090000_twilio_r2c_owner_provisioning_read.sql").toBe(true);
  });

  it("tw4_rfl_alerts_claim: only the delivery kill switch is added", () => {
    const before = fnBody(prev, SIGS.claim);
    const after = fnBody(mig, SIGS.claim);
    survivesInOrder(before, after);
    const a = added(before, after).map((l) => l.trim());
    expect(a).toHaveLength(3);
    expect(a[0]).toBe("if not public.tw4_rfl_switch_enabled('delivery') then");
    expect(a[1]).toMatch(/^return;/);
    expect(a[2]).toBe("end if;");
  });

  it("tw4_rfl_scan_entity: only the 14-day second notice and the administrator escalation are added (read-only apart from the alert helper)", () => {
    const before = fnBody(prev, SIGS.scan);
    const after = fnBody(mig, SIGS.scan);
    survivesInOrder(before, after);
    const text = added(before, after).join("\n");
    expect(text).toContain("'owner_notice_second'");
    expect(text).toContain("'owner_unresponsive'");
    expect(text).toContain("'auth2:' || v_auth.id");
    expect(text).toContain("':escalate'");
    expect(text).toContain("interval '14 days'");
    expect(text).not.toMatch(/insert into|update public|delete from|_tw4c_post|tw4_recurring_|tw4_credit_|tw4_spend_/);
    // the existing 35-day notice and every other alert are untouched
    expect(after).toContain("interval '35 days'");
    expect(added(before, after).every((l) => !/'authorization_expiring'|'funding_low'|'exposure_open'/.test(l))).toBe(true);
  });

  it("tw4_rfl_exposure_dispose: only the location lock and the dual-control consumption (absorbed only) are added", () => {
    const before = fnBody(prev, SIGS.dispose);
    const after = fnBody(mig, SIGS.dispose);
    survivesInOrder(before, after);
    const a = added(before, after).map((l) => l.trim());
    expect(a).toHaveLength(4);
    expect(a[0]).toMatch(/^perform public\._tw4sr_lock\(r\.studio_id\);/);
    expect(a[1]).toBe("if p_disposition = 'absorbed' then");
    expect(a[2]).toMatch(/^perform public\._tw4rflops_consume\('absorb_exposure', r, p_period_key, null, btrim\(p_note\), p_actor\);/);
    expect(a[3]).toBe("end if;");
    // the location lock comes before the business and credit locks; the approval is consumed only after the replay and closed-state checks
    expect(after.indexOf("_tw4sr_lock")).toBeLessThan(after.indexOf("_tw4rfl_lock"));
    expect(after.indexOf("'replayed', true")).toBeLessThan(after.indexOf("_tw4rflops_consume"));
    expect(after.indexOf("the exposure is already closed")).toBeLessThan(after.indexOf("_tw4rflops_consume"));
    expect(after.indexOf("_tw4rflops_consume")).toBeLessThan(after.indexOf("set_config('tw4.rfl_write', 'on', true)"));
  });

  it("tw4_rfl_cancel_authorize: only the location lock and the dual-control consumption (phone numbers only) are added", () => {
    const before = fnBody(prev, SIGS.cancel);
    const after = fnBody(mig, SIGS.cancel);
    survivesInOrder(before, after);
    const a = added(before, after).map((l) => l.trim());
    expect(a).toHaveLength(4);
    expect(a[0]).toMatch(/^perform public\._tw4sr_lock\(r\.studio_id\);/);
    expect(a[1]).toBe("if r.resource_kind = 'number' then");
    expect(a[2]).toMatch(/^perform public\._tw4rflops_consume\('cancel_number', r, null, p_approval_ref, btrim\(p_reason\), p_actor\);/);
    expect(a[3]).toBe("end if;");
    // every older refusal (reference reuse, open operation, policy_lapse on a number, live sender, lapse age) still runs BEFORE the approval is looked at, and the replay returns before it
    for (const marker of ["'replayed', true", "this approval reference was already used", "a cancellation of this resource is already open", "a phone number is never released on a policy decision",
      "suspend DanceFlow sending for this location before cancelling its number", "a lapse cancellation needs an exposure open for at least 14 days"]) {
      expect(after.indexOf(marker), marker).toBeGreaterThanOrEqual(0);
      expect(after.indexOf(marker), marker).toBeLessThan(after.indexOf("_tw4rflops_consume"));
    }
    expect(after.indexOf("_tw4rflops_consume")).toBeLessThan(after.indexOf("_tw4fi_register(p_approval_ref, 'cancellation'"));
  });

  it("the precondition refuses to apply over anything but the exact 20261209 bodies (md5 of each, line endings ignored)", () => {
    expect(mig).toContain(`'${md5(prosrc(fnBody(prev, SIGS.claim)))}'`);
    expect(mig).toContain(`'${md5(prosrc(fnBody(prev, SIGS.scan)))}'`);
    expect(mig).toContain(`'${md5(prosrc(fnBody(prev, SIGS.dispose)))}'`);
    expect(mig).toContain(`'${md5(prosrc(fnBody(prev, SIGS.cancel)))}'`);
    expect(mig).toContain("replace(p.prosrc, chr(13), '')");
    expect(mig).toContain("rfl-ops precondition failed: already applied");
  });

  it("the rollback restores the four predecessor bodies byte for byte, BEFORE dropping anything, and refuses (55000) once evidence exists", () => {
    for (const sig of Object.values(SIGS)) expect(fnBody(rollback, sig)).toBe(fnBody(prev, sig));
    const firstDrop = rollback.indexOf("\ndrop ");
    for (const sig of Object.values(SIGS)) expect(rollback.indexOf(sig)).toBeLessThan(firstDrop);
    expect(rollback).toContain("errcode = '55000'");
    expect(rollback).toContain("in access exclusive mode");
    for (const t of ["studio_sms_rfl_switch_log", "studio_sms_rfl_runs", "studio_sms_rfl_alert_deliveries", "studio_sms_provider_variance_acks", "studio_sms_rfl_dual_requests"]) {
      expect(rollback).toContain(`select 1 from public.${t}`);
      expect(rollback).toContain(`drop table public.${t};`);
    }
    // every function and table the migration creates is dropped by the rollback
    const created = [...mig.matchAll(/^create (?:or replace )?function public\.([a-z0-9_]+)\(/gm)].map((m) => m[1]).filter((n) => !["tw4_rfl_alerts_claim", "tw4_rfl_scan_entity", "tw4_rfl_exposure_dispose", "tw4_rfl_cancel_authorize"].includes(n));
    expect(created.length).toBeGreaterThanOrEqual(16);
    for (const name of created) expect(rollback, name).toContain(`drop function public.${name}(`);
    for (const t of [...mig.matchAll(/^create table public\.([a-z0-9_]+)/gm)].map((m) => m[1])) expect(rollback, t).toContain(`drop table public.${t};`);
  });

  it("the audit vocabulary and the alert kinds are extended from their live definitions, never rebuilt from a fixed list", () => {
    expect(mig).toContain("pg_get_constraintdef");
    expect(mig).not.toMatch(/add constraint studio_sms_onboarding_audit_action_check check \(action in \(/);
    expect(mig).not.toMatch(/check \(kind in \(/);
    for (const action of ["rfl_switch_set", "rfl_variance_acked", "rfl_dual_requested", "rfl_dual_approved", "rfl_dual_rejected", "rfl_dual_invalidated", "rfl_dual_consumed", "rfl_alert_delivery"]) {
      expect(mig).toContain(`'${action}'`);
    }
    for (const kind of ["owner_notice_second", "owner_unresponsive", "alert_delivery_exhausted"]) expect(mig).toContain(`'${kind}'`);
  });

  it("every switch is fail closed: no row is OFF, and nothing in the migration inserts an enabling row", () => {
    expect(fnBody(mig, "create or replace function public.tw4_rfl_switch_enabled(p_switch text)")).toContain("), false);");
    expect(mig).not.toMatch(/insert into public\.studio_sms_rfl_switch_log \([^)]*\)\s*values \([^)]*true/);
    expect(mig).not.toMatch(/insert into public\.studio_sms_rfl_switch_log[^;]*select/);
  });

  it("dual-control entry points take the location link before the business lock (R2b's order) and never change a request outside the write flag", () => {
    for (const name of ["tw4_rfl_dual_request", "tw4_rfl_dual_approve", "tw4_rfl_dual_reject"]) {
      const start = mig.indexOf(`create or replace function public.${name}(`);
      const body = mig.slice(start, mig.indexOf("end $$;", start));
      expect(body.indexOf("_tw4sr_lock"), name).toBeGreaterThanOrEqual(0);
      expect(body.indexOf("_tw4sr_lock"), name).toBeLessThan(body.indexOf("_tw4rfl_lock"));
    }
    expect(mig).toContain("studio_sms_rfl_dual_requests_distinct");
    expect(mig).toContain("coalesce(current_setting('tw4.rflops_write', true), '') <> 'on'");
    // the approver is a different administrator, checked in SQL
    expect(fnBody(mig, "create or replace function public.tw4_rfl_dual_approve(p_request_id uuid, p_actor uuid, p_note text)")).toContain("q.requested_by = p_actor");
  });

  it("nothing new calls Twilio, posts to a credit ledger, charges, creates or extends an authorization, or touches the sender / hold functions", () => {
    let own = mig;
    for (const sig of Object.values(SIGS)) own = own.replace(fnBody(mig, sig), "");
    own = own.replace(/--.*$/gm, "");
    expect(own).not.toMatch(/_tw4c_post|studio_sms_credit_ledger|studio_sms_credit_reservations|studio_sms_credit_accounts|tw4_credit_|tw4_recurring_|tw4_spend_|tw4_sender_|_tw4c_lock/);
    expect(own).not.toMatch(/insert into public\.studio_sms_recurring|update public\.studio_sms_recurring|studio_sms_recurring_authorizations set/);
    expect(own).not.toMatch(/https?:|twilio\.com|\bnet\.|pg_net|dblink/i);
    // suspension of sending and the pilot cover are not mentioned, let alone replaced
    expect(own).not.toMatch(/tw4_rfl_suspend_df|tw4_rfl_pilot_cover|_tw4rc_service_state/);
    expect(mig).not.toMatch(/create or replace function public\.(tw4_rfl_suspend_df|tw4_rfl_pilot_cover|_tw4rc_service_state|tw4_recurring_charge)\(/);
  });

  it("is dark: the cron route is still not registered for a schedule (D6), and the migration enables no flag", () => {
    const vercel = readFileSync(join(process.cwd(), "vercel.json"), "utf8");
    expect(vercel).not.toContain("sms-provider-fee-lifecycle");
    expect(mig).not.toMatch(/values \('(scan|delivery)', true/);
  });
});
