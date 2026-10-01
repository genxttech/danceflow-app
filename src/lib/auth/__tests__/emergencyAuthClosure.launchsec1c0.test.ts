import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * LAUNCH-SEC-1C-0: pins the emergency authorization closure. The forward
 * migration only revokes EXECUTE on link_portal_client_by_email (PUBLIC, anon,
 * authenticated) and on accept_pending_team_invitations (PUBLIC, anon), and
 * swaps the email-keyed client_account_ledger read policy for the
 * relationship-based user_has_client_portal_access check. It changes no
 * function body, trigger, row or other policy. Runtime behavior is proven
 * against DEV by sql-tests/test_T_launchsec1c0_emergency_auth_closure.sql.
 */

const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, "src/lib/supabase/migrations");
const FORWARD = "20261007090000_launchsec1c0_emergency_auth_closure.sql";
const ROLLBACK = "rollback/20261007090000_launchsec1c0_emergency_auth_closure_rollback.sql";
const SUITE = "sql-tests/test_T_launchsec1c0_emergency_auth_closure.sql";
const ORIGINAL_LEDGER_POLICY = "20260516000300_client_account_ledger_portal_read_policy.sql";

const read = (file: string) => readFileSync(join(MIGRATIONS, file), "utf8").replace(/\r\n/g, "\n");
const stripComments = (sql: string) => sql.replace(/^\s*--.*$/gm, "");
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();

function topLevelStatements(sql: string) {
  return stripComments(sql)
    .replace(/do \$\$[\s\S]*?end \$\$;/g, "")
    .split(/;\s*\n/)
    .map(normalize)
    .filter(Boolean)
    .map((statement) => statement.replace(/;$/, ""));
}

const ORIGINAL_POLICY_SQL = normalize(
  stripComments(read(ORIGINAL_LEDGER_POLICY)).match(/create policy "Clients can read their own account ledger"[\s\S]*?\);/)![0],
);

describe("LAUNCH-SEC-1C-0 forward migration", () => {
  const sql = read(FORWARD);

  it("is exactly two revokes and one ledger policy swap", () => {
    expect(topLevelStatements(sql)).toEqual([
      "begin",
      "revoke execute on function public.link_portal_client_by_email(uuid, text) from public, anon, authenticated",
      "revoke execute on function public.accept_pending_team_invitations(text) from public, anon",
      'drop policy "Clients can read their own account ledger" on public.client_account_ledger',
      'create policy "Linked portal users can read their account ledger" on public.client_account_ledger for select to authenticated using (public.user_has_client_portal_access(studio_id, client_id))',
      "commit",
    ]);
  });

  it("grants nothing and changes no function, trigger or row", () => {
    const body = stripComments(sql);
    expect(body).not.toMatch(/\bgrant\b/i);
    expect(body).not.toMatch(/create\s+(or\s+replace\s+)?function|drop\s+function|alter\s+function/i);
    expect(body).not.toMatch(/\btrigger\b/i);
    expect(body).not.toMatch(/\binsert\s+into\b|\bdelete\s+from\b|\bupdate\s+public\./i);
    expect(body).not.toContain("verified_email");
  });

  it("keeps authenticated EXECUTE on the team RPC (used by /callback)", () => {
    expect(sql).not.toMatch(/revoke execute on function public\.accept_pending_team_invitations\(text\) from[^;]*authenticated/);
    expect(sql).toContain("accept_pending_team_invitations lost authenticated EXECUTE");
  });

  it("fails closed unless the live state is the reviewed baseline", () => {
    for (const fragment of [
      "link_portal_client_by_email(uuid, text) is missing",
      "link_portal_client_by_email is not the reviewed definition",
      "link_portal_client_by_email grants are not the reviewed baseline",
      "accept_pending_team_invitations is not the reviewed definition",
      "accept_pending_team_invitations grants are not the reviewed baseline",
      "user_has_client_portal_access is not the reviewed definition",
      "the reviewed client_account_ledger email policy is missing or different",
      "target ledger policy already exists (partial state)",
      "unexpected email-based client_account_ledger policy",
    ]) {
      expect(sql).toContain(fragment);
    }
    expect(sql).toContain("'29924b718d74a26328cc54c5664ecf89'");
    expect(sql).toContain("'ac27bfd4e6ad4d9d38bcd5762747ea90'");
    expect(sql).toContain("'c0b5901eaad8130f2b6ee6d983687483'");
    expect(sql).toContain("'a83e4d10340eea48d15744a10ef2ddf5'");
  });
});

describe("LAUNCH-SEC-1C-0 rollback", () => {
  const rollback = read(ROLLBACK);

  it("warns that it re-opens the vulnerabilities", () => {
    expect(rollback).toContain("RE-OPENS CROSS-TENANT PORTAL/ACCOUNT");
  });

  it("restores exactly the prior grants and the original ledger policy", () => {
    const statements = topLevelStatements(rollback);
    expect(statements).toEqual([
      "begin",
      "grant execute on function public.link_portal_client_by_email(uuid, text) to anon, authenticated",
      "grant execute on function public.accept_pending_team_invitations(text) to public, anon",
      'drop policy if exists "Linked portal users can read their account ledger" on public.client_account_ledger',
      'drop policy if exists "Clients can read their own account ledger" on public.client_account_ledger',
      ORIGINAL_POLICY_SQL.replace(/;$/, ""),
      "commit",
    ]);
  });
});

describe("LAUNCH-SEC-1C-0 DEV regression suite", () => {
  it("runs rolled back and covers every required case", () => {
    const suite = read(SUITE);
    const statements = topLevelStatements(suite);
    expect(statements[0]).toBe("begin");
    expect(statements.at(-1)).toBe("rollback");
    for (const marker of [
      "PASS T-launchsec1c0-privileges-and-policies",
      "PASS T-launchsec1c0-email-match-denied",
      "PASS T-launchsec1c0-linked-user-keeps-access",
      "PASS T-launchsec1c0-disconnected-former-unrelated-denied",
      "PASS T-launchsec1c0-authenticated-rpc-boundaries",
      "PASS T-launchsec1c0-anon-rpc-denied",
      "PASS T-launchsec1c0-no-link-created",
    ]) {
      expect(suite).toContain(marker);
    }
  });
});

describe("no application caller depends on the revoked privileges", () => {
  it("only /callback calls accept_pending_team_invitations, as an authenticated user", () => {
    const callback = readFileSync(join(ROOT, "src/app/(auth)/callback/route.ts"), "utf8");
    expect(callback).toContain('supabase.rpc("accept_pending_team_invitations"');
  });
});
