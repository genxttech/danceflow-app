import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * LAUNCH-SEC-1C-A boundaries: what the slice must and must not do.
 * Runtime behaviour of the SQL is proven against DEV by
 * sql-tests/test_T_launchsec1ca_verified_email_proof.sql.
 */

const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, "src/lib/supabase/migrations");
const FORWARD = "20261008090000_launchsec1ca_verified_email_proof.sql";
const ROLLBACK = "rollback/20261008090000_launchsec1ca_verified_email_proof_rollback.sql";
const SUITE = "sql-tests/test_T_launchsec1ca_verified_email_proof.sql";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const code = (sql: string) => sql.replace(/^\s*--.*$/gm, "");

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "migrations") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe("LAUNCH-SEC-1C-A migration", () => {
  const sql = code(read(join(MIGRATIONS, FORWARD)));

  it("accepts exactly the validated mailbox method and fails closed on anything else", () => {
    expect(sql).toContain("and m.authentication_method = 'otp';");
    expect(sql).toContain("and m.authentication_method not in ('otp', 'password')");
    expect(sql).not.toMatch(/'magiclink'|'email\/signup'|'recovery'|'invite'|'pkce'/);
    expect(sql).toContain("v_auth_at < now() - interval '10 minutes'");
  });

  it("uses the binding model only (no reset_* states)", () => {
    expect(sql).toContain("check (credential_status in ('binding_required', 'bound'))");
    expect(sql).not.toMatch(/reset_required|reset_completed|credential_reset_at/);
  });

  it("never reads the JWT email or caller-supplied identity", () => {
    expect(sql).not.toMatch(/auth\.jwt\(\)\s*->>\s*'email'/);
    expect(sql).toContain("create function public.record_email_proof_web()");
    expect(sql).toContain("create function public.record_email_proof_mobile()");
    expect(sql).toContain("create function public.my_verified_email()");
  });

  it("gates eligibility on a live session created after binding", () => {
    expect(sql).toContain("and s.created_at >= v.bound_at");
    expect(sql).toContain("and (s.not_after is null or s.not_after > now())");
  });

  it("locks tables and grants only the reviewed EXECUTE rights", () => {
    expect(sql).toContain("revoke all on table public.verified_email_identities from public, anon, authenticated;");
    expect(sql).toContain("alter table public.verified_email_identities enable row level security;");
    expect(sql).not.toMatch(/create policy/i);
    const grants = sql.match(/^grant .*$/gm) ?? [];
    expect(grants).toEqual([
      "grant select on table public.verified_email_identities to service_role;",
      "grant select on table public.auth_email_change_markers to service_role;",
      "grant execute on function public.record_email_proof_web() to authenticated;",
      "grant execute on function public.record_email_proof_mobile() to authenticated;",
      "grant execute on function public.my_verified_email() to authenticated;",
      "grant execute on function public.email_binding_status() to authenticated;",
      "grant execute on function public.complete_email_binding(uuid, uuid) to service_role;",
    ]);
    expect((sql.match(/security definer/g) ?? []).length).toBe((sql.match(/set search_path = ''/g) ?? []).length);
  });

  it("does not touch LAUNCH-SEC-1C-0 objects or the ledger", () => {
    expect(sql).not.toMatch(/link_portal_client_by_email|accept_pending_team_invitations|client_account_ledger|user_has_client_portal_access/);
  });

  it("rollback is dependency-aware and fails closed", () => {
    const rollback = read(join(MIGRATIONS, ROLLBACK));
    expect(rollback).toContain("dependent functions exist");
    expect(rollback).toContain("dependent policies exist");
    expect(rollback).toContain("1C-A object set is not the reviewed state");
    expect(code(rollback)).not.toMatch(/link_portal_client_by_email|accept_pending_team_invitations|client_account_ledger/);
  });

  it("SQL regression suite covers the required cases and rolls back", () => {
    const suite = read(join(MIGRATIONS, SUITE));
    expect(suite.trimEnd().endsWith("rollback;")).toBe(true);
    for (const marker of [
      "PASS T-launchsec1ca-shape-grants-rls",
      "PASS T-launchsec1ca-direct-writes-denied",
      "PASS T-launchsec1ca-proof-rejections",
      "PASS T-launchsec1ca-first-proof-binding-required",
      "PASS T-launchsec1ca-password-session-cannot-bind",
      "PASS T-launchsec1ca-retry-updates-binding-session",
      "PASS T-launchsec1ca-complete-binding-exact-session",
      "PASS T-launchsec1ca-helper-bound-session-gating",
      "PASS T-launchsec1ca-repeat-proof-no-downgrade",
      "PASS T-launchsec1ca-revoked-session-not-eligible",
      "PASS T-launchsec1ca-email-change-requires-fresh-proof",
      "PASS T-launchsec1ca-1c0-and-ledger-unchanged",
    ]) {
      expect(suite).toContain(marker);
    }
  });
});

describe("LAUNCH-SEC-1C-A application boundaries", () => {
  it("password login and password reset never record proof", () => {
    const actions = read(join(ROOT, "src/app/(auth)/actions.ts"));
    expect(actions).not.toMatch(/record_email_proof|recordEmailProof/);
  });

  it("1C-B is not started: no app code consumes my_verified_email yet", () => {
    const users = walk(join(ROOT, "src"))
      .filter((file) => read(file).includes("my_verified_email"))
      .map((file) => relative(ROOT, file).replace(/\\/g, "/"));
    // verifiedEmail.ts only documents the helper; nothing calls it before 1C-B.
    expect(users).toEqual(["src/lib/auth/verifiedEmail.ts"]);
    expect(read(join(ROOT, "src/lib/auth/verifiedEmail.ts"))).not.toMatch(/rpc\(\s*"my_verified_email"/);
  });

  it("existing claim paths are untouched", () => {
    for (const file of ["src/lib/auth/portal-linking.ts", "src/app/api/student/marketplace/[catalogItemId]/checkout/route.ts"]) {
      expect(read(join(ROOT, file))).not.toMatch(/verifiedEmail|record_email_proof|email_binding/);
    }
    expect(read(join(ROOT, "src/app/(auth)/callback/route.ts"))).toContain('supabase.rpc("accept_pending_team_invitations"');
  });

  it("skip paths only navigate: they never bind, record proof or change credentials", () => {
    const page = read(join(ROOT, "src/app/account/verify-email/page.tsx"));
    const skip = page.slice(page.indexOf("1C-B MUST NOT rely on UI routing"), page.indexOf("Skip for now"));
    expect(skip).toContain("<Link");
    expect(skip).toContain("href={continueHref}");
    expect(skip).not.toMatch(/action=|bindPasswordAction|sendVerificationEmailAction/);

    const mobile = read(join(ROOT, "mobile/student/app/auth/secure-account.tsx"));
    const later = mobile.slice(mobile.indexOf("// \"Not now\" only navigates"), mobile.indexOf("return (", mobile.indexOf("async function handleLater()")));
    expect(later).toContain("1C-B MUST NOT rely on UI routing");
    expect(later).not.toMatch(/bindAccountPassword|rpc\(|danceflowApiFetch/);
  });

  it("mobile records proof only after its own email-link verifyOtp, never after setSession or PKCE", () => {
    const auth = read(join(ROOT, "mobile/student/src/lib/auth.tsx"));
    const tokenBranch = auth.slice(auth.indexOf("if (tokenHash) {"), auth.indexOf("if (code) {"));
    const rest = auth.slice(auth.indexOf("if (code) {"), auth.indexOf("return false;", auth.indexOf("if (code) {")));
    expect(tokenBranch).toContain("supabase.auth.verifyOtp(");
    expect(tokenBranch).toContain("recordMobileEmailProof()");
    expect(tokenBranch.indexOf("verifyOtp(")).toBeLessThan(tokenBranch.indexOf("recordMobileEmailProof()"));
    expect(rest).toContain("exchangeCodeForSession");
    expect(rest).toContain("setSession");
    expect(rest).not.toContain("recordMobileEmailProof");
    expect((auth.match(/recordMobileEmailProof\(\)/g) ?? []).length).toBe(1);
  });
});
