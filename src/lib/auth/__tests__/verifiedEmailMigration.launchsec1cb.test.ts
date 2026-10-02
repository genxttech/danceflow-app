import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * LAUNCH-SEC-1C-B migration/source guards. Runtime behaviour is proven against
 * DEV by sql-tests/test_T_launchsec1cb_verified_email_enforcement.sql.
 */

const ROOT = process.cwd();
const M = join(ROOT, "src/lib/supabase/migrations");
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const code = (sql: string) => sql.replace(/^\s*--.*$/gm, "");
const forward = read(join(M, "20261009090000_launchsec1cb_verified_email_enforcement.sql"));
const rollback = read(join(M, "rollback/20261009090000_launchsec1cb_verified_email_enforcement_rollback.sql"));
const suite = read(join(M, "sql-tests/test_T_launchsec1cb_verified_email_enforcement.sql"));

describe("LAUNCH-SEC-1C-B forward migration", () => {
  it("fails closed unless 1C-A and the reviewed 1C-0-hardened definitions are present", () => {
    for (const fragment of [
      "LAUNCH-SEC-1C-A objects are missing",
      "partial 1C-B state present",
      "md5(replace(p.prosrc, E'\\r', '')) = 'ac27bfd4e6ad4d9d38bcd5762747ea90'",
      "md5(replace(p.prosrc, E'\\r', '')) = '72b7dd2d66b5f79dff27fd0acb447024'",
      "link_portal_client_by_email has dependents",
    ]) {
      expect(forward).toContain(fragment);
    }
  });

  it("team invitations use the verified bound email, never the JWT email claim", () => {
    const body = code(forward);
    expect(body).toContain("v_email := coalesce(public.my_verified_email(), '');");
    expect(body).not.toMatch(/auth\.jwt\(\)\s*->>\s*'email'/);
  });

  it("client claims are wrapped by the verified-email gate; the original body is preserved by rename", () => {
    const body = code(forward);
    expect(body).toContain("rename to _claim_client_account_invitation_unverified");
    expect(body).toContain("if public.verified_email_for_user(p_user_id) is distinct from v_email then");
    const wrapper = body.slice(body.indexOf("create function public.claim_client_account_invitation("), body.indexOf("CREATE OR REPLACE FUNCTION public.accept_pending_team_invitations"));
    const helper = body.slice(body.indexOf("create function public.verified_email_for_user("), body.indexOf("alter function public.claim_client_account_invitation"));
    expect(`${wrapper}${helper}`).not.toMatch(/ilike|like\s/i);
  });

  it("grants only service_role on the new helper and wrapper; the private body is owner-only", () => {
    const grants = code(forward).match(/^grant .*$/gm) ?? [];
    expect(grants).toEqual([
      "grant execute on function public.verified_email_for_user(uuid) to service_role;",
      "grant execute on function public.claim_client_account_invitation(uuid, text, uuid) to service_role;",
    ]);
    expect(forward).toContain("revoke all on function public._claim_client_account_invitation_unverified(uuid, text, uuid) from public, anon, authenticated, service_role;");
  });

  it("drops the legacy link RPC and leaves the ledger alone", () => {
    expect(forward).toContain("drop function public.link_portal_client_by_email(uuid, text);");
    expect(code(forward)).not.toMatch(/client_account_ledger|create policy|drop policy/i);
    expect(code(forward)).not.toMatch(/email_confirmed_at/);
  });
});

describe("LAUNCH-SEC-1C-B rollback", () => {
  it("warns, is dependency-aware and restores the prior definitions", () => {
    expect(rollback).toContain("RE-OPENS UNVERIFIED EMAIL CLAIMS");
    expect(rollback).toContain("1C-B object set is not the reviewed state");
    expect(rollback).toContain("other functions depend on verified_email_for_user");
    expect(rollback).toContain("v_email := lower(trim(coalesce(auth.jwt() ->> 'email', '')));");
    expect(rollback).toContain("rename to claim_client_account_invitation;");
    expect(rollback).toContain("grant execute on function public.link_portal_client_by_email(uuid, text) to service_role;");
  });
});

describe("LAUNCH-SEC-1C-B SQL suite and app gates", () => {
  it("covers the required cases and rolls back", () => {
    expect(suite.trimEnd().endsWith("rollback;")).toBe(true);
    for (const marker of [
      "PASS T-launchsec1cb-shape-and-grants",
      "PASS T-launchsec1cb-verified-email-for-user",
      "PASS T-launchsec1cb-team-invitations",
      "PASS T-launchsec1cb-client-claims",
      "PASS T-launchsec1cb-email-change-invalidates",
      "PASS T-launchsec1cb-ledger-unchanged",
    ]) {
      expect(suite).toContain(marker);
    }
  });

  it("platform repair requires target proof and never revives closed relationships", () => {
    const platform = read(join(ROOT, "src/app/platform/actions.ts"));
    const repair = platform.slice(platform.indexOf("skippedClosedRelationship += 1"), platform.indexOf("await linkExistingClientAccount({ studioId"));
    expect(platform).toContain('["disconnected", "former_client", "rejected", "conflict"].includes(link.status)');
    expect(repair).toContain("getVerifiedEmailForUser(adminSupabase, matchingAuthUser.id)");
  });
});
