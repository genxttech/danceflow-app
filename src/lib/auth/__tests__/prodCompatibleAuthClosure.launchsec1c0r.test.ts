import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * LAUNCH-SEC-1C-0-R: the PROD-compatible revision of LAUNCH-SEC-1C-0.
 * - The original 1C-0 migration is preserved byte-for-byte.
 * - The revision accepts exactly two starting states (reviewed vulnerable
 *   STATE A, or already-hardened STATE B as a no-op) through one classifier
 *   that is byte-identical in the migration, its rollback and the SQL test.
 * - The only fingerprint relaxation is removing carriage returns from the
 *   accept_pending_team_invitations body before md5.
 * - The migration contains no business-data or forensic query.
 * Runtime behavior is proven against DEV by
 * sql-tests/test_T_launchsec1c0r_prod_compatible_auth_closure.sql.
 */

const MIGRATIONS = join(process.cwd(), "src/lib/supabase/migrations");
const ORIGINAL = "20261007090000_launchsec1c0_emergency_auth_closure.sql";
const FORWARD = "20261007093000_launchsec1c0r_prod_compatible_auth_closure.sql";
const ROLLBACK = "rollback/20261007093000_launchsec1c0r_prod_compatible_auth_closure_rollback.sql";
const SUITE = "sql-tests/test_T_launchsec1c0r_prod_compatible_auth_closure.sql";

const raw = (file: string) => readFileSync(join(MIGRATIONS, file));
const read = (file: string) => raw(file).toString("utf8").replace(/\r\n/g, "\n");
const stripComments = (sql: string) => sql.replace(/^\s*--.*$/gm, "");

const CLASSIFIER_START = "-- >>> LAUNCH-SEC-1C-0-R CLASSIFIER";
const CLASSIFIER_END = "-- <<< LAUNCH-SEC-1C-0-R CLASSIFIER";

function classifier(sql: string) {
  const start = sql.indexOf(CLASSIFIER_START);
  const end = sql.indexOf(CLASSIFIER_END);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + CLASSIFIER_END.length);
}

function applyBlocks(sql: string) {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const start = sql.indexOf("do $$\ndeclare\n  v_start text := pg_temp.launchsec1c0r_state();", from);
    if (start < 0) break;
    const end = sql.indexOf("end $$;", start) + "end $$;".length;
    blocks.push(sql.slice(start, end));
    from = end;
  }
  return blocks;
}

describe("original LAUNCH-SEC-1C-0 artifact is preserved", () => {
  it("keeps its reviewed SHA-256 (git normalizes it to LF)", () => {
    const lf = raw(ORIGINAL).toString("utf8").replace(/\r\n/g, "\n");
    expect(createHash("sha256").update(lf).digest("hex")).toBe(
      "ebcb9bbd0faeb9932926a4bbd13a081eeb7d131851b0d318574aa2e4aed9900a",
    );
  });

  it("the revision documents that it supersedes the original for PROD", () => {
    const sql = read(FORWARD);
    expect(sql).toContain("SUPERSEDES 20261007090000_launchsec1c0_emergency_auth_closure.sql FOR PROD");
    expect(sql).toContain("Catalog inspection indicates the legacy RPC path is functional in the");
    expect(sql).toContain("No PROD call was made and no historical exploitation has been");
  });
});

describe("LAUNCH-SEC-1C-0-R classifier", () => {
  const forward = read(FORWARD);
  const cls = classifier(forward);

  it("is byte-identical in the migration, the rollback and the SQL test", () => {
    expect(classifier(read(ROLLBACK))).toBe(cls);
    expect(classifier(read(SUITE))).toBe(cls);
  });

  it("only removes carriage returns, and only for the team-invite body", () => {
    const body = stripComments(cls);
    expect(body.match(/replace\(/g)).toHaveLength(1);
    expect(body).toContain("md5(replace(p.prosrc, E'\\r', '')) = 'ac27bfd4e6ad4d9d38bcd5762747ea90'");
    expect(body).not.toMatch(/regexp_replace|btrim|\btrim\(|lower\(|upper\(|translate\(/);
    expect(body).toContain("md5(p.prosrc) = '29924b718d74a26328cc54c5664ecf89'");
    expect(body).toContain("md5(p.prosrc) = 'c0b5901eaad8130f2b6ee6d983687483'");
  });

  it("pins exact STATE A and STATE B grants and ledger policies", () => {
    for (const fragment of [
      "when 'anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres' then 'A'",
      "when 'postgres=X/postgres,service_role=X/postgres' then 'B'",
      "when '=X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres' then 'A'",
      "when 'authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres' then 'B'",
      "md5(p.qual) = 'a83e4d10340eea48d15744a10ef2ddf5'",
      "md5(p.qual) = 'e110929c652dcb4ae89439a1a1abb39d'",
      "md5(p.with_check) = '7f552e02a161934a62947e7cd562f35d'",
      "md5(p.qual) = '493593a8cb85e8ee1eb2a59402ed0aca'",
      "md5(p.qual) = '31221fbfe83cb563e75f9c05ca87a97a'",
      "LAUNCH-SEC-1C-0-R: unexpected function overload",
      "LAUNCH-SEC-1C-0-R: partial or unexpected state",
    ]) {
      expect(cls).toContain(fragment);
    }
  });
});

describe("LAUNCH-SEC-1C-0-R forward migration", () => {
  const forward = read(FORWARD);

  it("applies exactly the reviewed hardening only from STATE A, then requires STATE B", () => {
    const blocks = applyBlocks(forward);
    expect(blocks).toHaveLength(1);
    const apply = blocks[0];
    expect(apply).toContain("if v_start = 'A' then");
    const executed = [...apply.matchAll(/execute '([^']+)'(?:\s*\|\|\s*'([^']+)')?;/g)].map((m) => m[1] + (m[2] ?? ""));
    expect(executed).toEqual([
      "revoke execute on function public.link_portal_client_by_email(uuid, text) from public, anon, authenticated",
      "revoke execute on function public.accept_pending_team_invitations(text) from public, anon",
      'drop policy "Clients can read their own account ledger" on public.client_account_ledger',
      'create policy "Linked portal users can read their account ledger" on public.client_account_ledger for select to authenticated using (public.user_has_client_portal_access(studio_id, client_id))',
    ]);
    expect(apply).toContain("if pg_temp.launchsec1c0r_state() <> 'B' then");
  });

  it("the SQL test embeds the identical apply block", () => {
    const suiteBlocks = applyBlocks(read(SUITE));
    expect(suiteBlocks).toHaveLength(2);
    for (const block of suiteBlocks) expect(block).toBe(applyBlocks(forward)[0]);
  });

  it("leaves no catalog object behind and queries no business data", () => {
    const code = stripComments(forward);
    expect(code).toContain("create or replace function pg_temp.launchsec1c0r_state()");
    expect(code).toContain("drop function pg_temp.launchsec1c0r_state();");
    expect(code).not.toMatch(/create\s+(or\s+replace\s+)?function\s+public\./i);
    expect(code).not.toMatch(/\bfrom\s+public\.(clients|client_account_links|client_account_ledger|profiles|user_studio_roles)\b/i);
    expect(code).not.toMatch(/initiated_by|legacy_email_repair/);
    expect(code).not.toMatch(/\binsert\s+into\b|\bdelete\s+from\b|\bupdate\s+public\./i);
    expect(code).not.toMatch(/\bgrant\b/i);
    expect(code).not.toMatch(/\btrigger\b|create\s+(unique\s+)?index/i);
  });
});

describe("LAUNCH-SEC-1C-0-R rollback", () => {
  const rollback = read(ROLLBACK);

  it("warns and only runs from the exact hardened state", () => {
    expect(rollback).toContain("RE-OPENS LEGACY AUTHORIZATION SURFACES AND MUST NEVER RUN");
    expect(rollback).toContain("if pg_temp.launchsec1c0r_state() <> 'B' then");
    expect(rollback).toContain("if pg_temp.launchsec1c0r_state() <> 'A' then");
  });
});

describe("LAUNCH-SEC-1C-0-R DEV regression suite", () => {
  it("covers every required case and runs rolled back", () => {
    const suite = read(SUITE);
    expect(suite.trimEnd().endsWith("rollback;")).toBe(true);
    for (const marker of [
      "PASS T-launchsec1c0r-dev-is-state-b",
      "PASS T-launchsec1c0r-state-b-exact-noop",
      "PASS T-launchsec1c0r-line-endings",
      "PASS T-launchsec1c0r-partial-states-fail-closed (11 cases)",
      "PASS T-launchsec1c0r-state-a-recognized",
      "PASS T-launchsec1c0r-state-a-hardened-to-dev-target",
      "PASS T-launchsec1c0r-linked-user-keeps-access",
      "PASS T-launchsec1c0r-unlinked-disconnected-former-denied",
      "PASS T-launchsec1c0r-anon-rpc-denied",
      "PASS T-launchsec1c0r-no-link-created",
    ]) {
      expect(suite).toContain(marker);
    }
  });
});
