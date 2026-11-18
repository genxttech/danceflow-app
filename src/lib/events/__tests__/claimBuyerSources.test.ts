import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const strip = (sql: string) => sql.replace(/--.*$/gm, "");
const M = "src/lib/supabase/migrations";

const original = strip(read(`${M}/20270221090000_event_registration_claim_function.sql`));
const next = strip(read(`${M}/20270222090000_event_registration_claim_buyer_sources_only.sql`));
const rollback = strip(read(`${M}/rollback/20270222090000_event_registration_claim_buyer_sources_only_rollback.sql`));

describe("claim function: buyer-originated sources only (owner decision 1)", () => {
  it("claims only through an ALLOWLIST (fail closed): one allowed source, no negative filter", () => {
    expect(next).toContain("and registration_source in ('public_event_page')");
    expect(next).not.toMatch(/registration_source\s*(<>|!=|not in|is distinct from)/i);
    expect(next).not.toMatch(/'admin'|'import'|'organizer_portal'|'other'/);
  });

  it("keeps every other safety property of the 604 definition", () => {
    for (const must of [
      "create or replace function public.claim_my_event_registrations()",
      "security definer",
      "set search_path = ''",
      "public.my_verified_email()",
      "set user_id = v_uid",
      "where user_id is null",
      "lower(btrim(attendee_email)) = v_email",
      "revoke all on function public.claim_my_event_registrations() from public, anon, authenticated, service_role",
      "grant execute on function public.claim_my_event_registrations() to authenticated",
    ]) {
      expect(next).toContain(must);
      expect(original).toContain(must);
    }
    expect(next.match(/\bupdate\s+public\.\w+/gi)).toEqual(["update public.event_registrations"]);
    expect(next).not.toMatch(/\binsert\s+into\b|\bdelete\s+from\b/i);
    expect(next).not.toMatch(/clients|client_account_links|notifications|payments|marketing/i);
  });

  it("the rollback restores exactly the 604 body (no source filter)", () => {
    expect(rollback).not.toContain("registration_source");
    const body = (s: string) => s.slice(s.indexOf("create or replace function"), s.indexOf("alter function")).replace(/\s+/g, " ").trim();
    expect(body(rollback)).toBe(body(original));
  });

  it("the merged 604 files are untouched", () => {
    expect(original).not.toContain("registration_source");
  });

  it("the SQL suite pins the allowlist cases", () => {
    const suite = read(`${M}/sql-tests/test_T_claim_buyer_sources_only.sql`);
    for (const s of ["import", "organizer_portal", "other", "zz_future_source"]) expect(suite).toContain(s);
    expect(suite).toContain("NULL source");
  });
});
