import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * LAUNCH-SEC-1B Stage 2: the forward migration makes the client-photos bucket
 * private and drops exactly the four permissive policies from
 * 20260606_client_photo_verification_v1.sql without adding replacements; the
 * rollback restores exactly that prior configuration. Runtime behavior (anon /
 * authenticated denied, service_role still reads) is proven against DEV by
 * sql-tests/test_T_launchsec1b_client_photos_private_storage.sql.
 */

const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, "src/lib/supabase/migrations");
const FORWARD = "20261005090000_launchsec1b_client_photos_private_storage.sql";
const ROLLBACK = "rollback/20261005090000_launchsec1b_client_photos_private_storage_rollback.sql";
const ORIGINAL = "20260606_client_photo_verification_v1.sql";
const SUITE = "sql-tests/test_T_launchsec1b_client_photos_private_storage.sql";

const POLICIES = [
  "Public read client photos",
  "Authenticated upload client photos",
  "Authenticated update client photos",
  "Authenticated delete client photos",
];

const read = (file: string) => readFileSync(join(MIGRATIONS, file), "utf8").replace(/\r\n/g, "\n");
const stripComments = (sql: string) => sql.replace(/^\s*--.*$/gm, "");
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();

// Top-level statements outside DO blocks (the DO blocks only read and raise).
function topLevelStatements(sql: string) {
  return stripComments(sql)
    .replace(/do \$\$[\s\S]*?end \$\$;/g, "")
    .split(";")
    .map(normalize)
    .filter(Boolean);
}

function createPolicyStatements(sql: string) {
  return [...stripComments(sql).matchAll(/create policy "([^"]+)"[\s\S]*?;/g)].map((m) => ({
    name: m[1],
    sql: normalize(m[0]),
  }));
}

describe("LAUNCH-SEC-1B Stage 2 forward migration", () => {
  const sql = read(FORWARD);

  it("is exactly: drop the four reviewed policies, then make client-photos private", () => {
    expect(topLevelStatements(sql)).toEqual([
      "begin",
      ...POLICIES.map((name) => `drop policy if exists "${name}" on storage.objects`),
      "update storage.buckets set public = false where id = 'client-photos'",
      "commit",
    ]);
  });

  it("adds no replacement policy and touches no business rows or objects", () => {
    const body = stripComments(sql);
    expect(body).not.toMatch(/create\s+policy/i);
    expect(body).not.toMatch(/\balter\s+(table|policy)\b/i);
    expect(body).not.toMatch(/\binsert\s+into\b/i);
    expect(body).not.toMatch(/\bdelete\s+from\b/i);
    expect(body).not.toMatch(/\bpublic\.\w+/);
    expect(body).not.toMatch(/\bgrant\b|\brevoke\b/i);
    expect(body).not.toMatch(/file_size_limit\s*=|allowed_mime_types\s*=/);
  });

  it("fails closed on a missing bucket or an unexpected client-photos policy", () => {
    expect(sql).toContain("raise exception 'LAUNCH-SEC-1B: storage bucket client-photos does not exist'");
    expect(sql).toContain("unexpected client-photos storage policy definition(s)");
    expect(sql).toContain("raise exception 'LAUNCH-SEC-1B: client-photos bucket is still public'");
    expect(sql).toContain("raise exception 'LAUNCH-SEC-1B: a storage policy still grants access to client-photos'");
    // The pre-check pins each reviewed policy's exact definition.
    for (const name of POLICIES) {
      expect(sql).toContain(`p.policyname = '${name}'`);
    }
    expect(sql.match(/'\(bucket_id = ''client-photos''::text\)'/g)?.length).toBe(5);
  });
});

describe("LAUNCH-SEC-1B Stage 2 rollback", () => {
  const rollback = read(ROLLBACK);
  const original = read(ORIGINAL);

  it("restores public = true and recreates exactly the original four policies", () => {
    expect(topLevelStatements(rollback)).toEqual([
      "begin",
      "update storage.buckets set public = true where id = 'client-photos'",
      ...POLICIES.flatMap((name) => [
        `drop policy if exists "${name}" on storage.objects`,
        expect.stringMatching(new RegExp(`^create policy "${name}" on storage\\.objects `)),
      ]),
      "commit",
    ]);
  });

  it("recreated policies are textually identical to 20260606_client_photo_verification_v1.sql", () => {
    const restored = createPolicyStatements(rollback);
    const originals = createPolicyStatements(original);
    expect(restored.map((p) => p.name)).toEqual(POLICIES);
    expect(originals.map((p) => p.name)).toEqual(POLICIES);
    expect(restored.map((p) => p.sql)).toEqual(originals.map((p) => p.sql));
  });

  it("the original migration set public = true (the state the rollback restores)", () => {
    expect(normalize(original)).toContain("values ( 'client-photos', 'client-photos', true, 5242880,");
  });
});

describe("LAUNCH-SEC-1B Stage 2 DEV regression suite", () => {
  const suite = read(SUITE);

  it("runs in one rolled-back transaction and covers anon, authenticated and service_role", () => {
    const statements = topLevelStatements(suite);
    expect(statements[0]).toBe("begin");
    expect(statements.at(-1)).toBe("rollback");
    for (const marker of [
      "PASS T-launchsec1b-bucket-private",
      "PASS T-launchsec1b-policies",
      "PASS T-launchsec1b-anon-denied",
      "PASS T-launchsec1b-studio-owner-denied",
      "PASS T-launchsec1b-no-role-user-denied",
      "PASS T-launchsec1b-object-unchanged",
      "PASS T-launchsec1b-service-role-read",
    ]) {
      expect(suite).toContain(marker);
    }
    expect(suite).toContain("select set_config('storage.allow_delete_query', 'true', true);");
  });
});

describe("Stage 1 compatibility", () => {
  it("only the server-only signer names the client-photos bucket in application code", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          if (entry === "__tests__" || entry === "migrations" || entry === "node_modules") continue;
          walk(path);
        } else if (/\.(ts|tsx)$/.test(entry) && readFileSync(path, "utf8").includes("client-photos")) {
          hits.push(relative(ROOT, path).replace(/\\/g, "/"));
        }
      }
    };
    walk(join(ROOT, "src"));
    expect(hits).toEqual(["src/lib/clients/clientPhotoAccess.ts"]);
    expect(readFileSync(join(ROOT, hits[0]), "utf8").startsWith('import "server-only";')).toBe(true);
  });
});
