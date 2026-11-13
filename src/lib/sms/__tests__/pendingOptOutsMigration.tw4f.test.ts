import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(process.cwd(), "src/lib/supabase/migrations");
const forward = readFileSync(join(DIR, "20270215100000_twilio_pending_opt_outs.sql"), "utf8");
const rollback = readFileSync(join(DIR, "rollback/20270215100000_twilio_pending_opt_outs_rollback.sql"), "utf8");

describe("20270215100000 pending opt-outs migration shape (Git-only, never applied by this suite)", () => {
  it("is service-role only: RLS on, no client grants, every function revoked from public/anon/authenticated", () => {
    expect(forward).toMatch(/enable row level security/);
    expect(forward).not.toMatch(/^grant .* to (anon|authenticated|public)/im);
    for (const fn of ["sms_pending_opt_out_record(uuid, text, text)", "sms_pending_opt_out_supersede(uuid, text)", "sms_pending_opt_out_apply(integer)"]) {
      expect(forward).toContain(`revoke all on function public.${fn} from public, anon, authenticated, service_role`);
      expect(forward).toContain(`grant execute on function public.${fn} to service_role`);
    }
  });
  it("applies with the canonical STOP only, skips superseded rows, isolates per-row failures", () => {
    expect(forward).toMatch(/record_sms_inbound_opt_event\(r\.studio_id, r\.phone_e164, 'stop'\)/);
    expect(forward).toMatch(/applied_at is null and superseded_at is null/);
    expect(forward).toMatch(/skip locked/);
    expect(forward).toMatch(/exception when others/);
    expect(forward).not.toMatch(/'start'/);
  });
  it("orders by attempts (no starvation), validates record() input without echoing it, and purges finished rows in a bounded batch", () => {
    expect(forward).toContain("order by attempts, created_at");
    expect(forward).toContain("v_phone !~ '");
    expect(forward).toContain("or not exists (select 1 from public.studios s where s.id = p_studio_id) then");
    expect(forward).toContain("interval '90 days' limit 100");
  });
  it("the send gate reads only OPEN rows of the exact studio + phone, and is service-role only", () => {
    const body = forward.slice(forward.indexOf("function public.sms_pending_opt_out_blocks"), forward.indexOf("-- Applies waiting opt-outs"));
    expect(body).toContain("studio_id = p_studio_id and phone_e164 = trim(coalesce(p_phone_e164, ''))");
    expect(body).toContain("applied_at is null and superseded_at is null");
    expect(forward).toContain("grant execute on function public.sms_pending_opt_out_blocks(uuid, text) to service_role;");
    expect(rollback).toContain("drop function if exists public.sms_pending_opt_out_blocks(uuid, text);");
  });
  it("reloads the PostgREST schema cache before commit and documents the release step and smoke call", () => {
    expect(forward.indexOf("notify pgrst, 'reload schema';")).toBeGreaterThan(forward.indexOf("grant execute on function public.sms_pending_opt_out_blocks"));
    expect(forward.indexOf("notify pgrst, 'reload schema';")).toBeLessThan(forward.lastIndexOf("commit;"));
    expect(forward).toContain("SMS_PENDING_OPT_OUT_REQUIRED=1");
    expect(forward).toContain("select public.sms_pending_opt_out_blocks(");
  });
  it("has a re-runnable rollback (dynamic table check) that refuses to drop open opt-outs", () => {
    expect(rollback).toContain("execute 'select exists (select 1 from public.studio_sms_pending_opt_outs");
    expect(rollback).toContain("to_regclass('public.studio_sms_pending_opt_outs') is not null");
    expect(rollback).toMatch(/Refusing to drop: open pending opt-outs/);
    expect(rollback).toMatch(/drop table if exists public\.studio_sms_pending_opt_outs/);
  });
});
