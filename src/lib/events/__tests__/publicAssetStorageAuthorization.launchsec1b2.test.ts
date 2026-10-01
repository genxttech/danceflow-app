import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * LAUNCH-SEC-1B2: event-media and studio-public-assets stay public for
 * delivery, but their bucket-wide authenticated write policies and public
 * listing policies are removed. event-media keeps one INSERT policy scoped to
 * the studio named by the first path segment (active membership or platform
 * admin via public.user_has_studio_access); studio-public-assets gets no
 * policies and 5 MB / image limits. The rollback restores exactly the
 * reviewed vulnerable baseline. Runtime behavior is proven against DEV by
 * sql-tests/test_T_launchsec1b2_public_asset_storage_authorization.sql.
 */

const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, "src/lib/supabase/migrations");
const FORWARD = "20261006090000_launchsec1b2_public_asset_storage_authorization.sql";
const ROLLBACK = "rollback/20261006090000_launchsec1b2_public_asset_storage_authorization_rollback.sql";
const SUITE = "sql-tests/test_T_launchsec1b2_public_asset_storage_authorization.sql";

const EVENT_MEDIA_POLICIES = [
  "Public can read event media",
  "Authenticated users can upload event media",
  "Authenticated users can update event media",
  "Authenticated users can delete event media",
];
const STUDIO_ASSET_POLICIES = [
  "Anyone can view studio public assets",
  "Authenticated users can upload studio public assets",
  "Authenticated users can update studio public assets",
  "Authenticated users can delete studio public assets",
];
const SCOPED_POLICY = "Studio members can upload event media";

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

const BASELINE_CREATES = [
  `create policy "Public can read event media" on storage.objects for select using (bucket_id = 'event-media')`,
  `create policy "Authenticated users can upload event media" on storage.objects for insert to authenticated with check (bucket_id = 'event-media')`,
  `create policy "Authenticated users can update event media" on storage.objects for update to authenticated using (bucket_id = 'event-media') with check (bucket_id = 'event-media')`,
  `create policy "Authenticated users can delete event media" on storage.objects for delete to authenticated using (bucket_id = 'event-media')`,
  `create policy "Anyone can view studio public assets" on storage.objects for select using (bucket_id = 'studio-public-assets')`,
  `create policy "Authenticated users can upload studio public assets" on storage.objects for insert to authenticated with check (bucket_id = 'studio-public-assets')`,
  `create policy "Authenticated users can update studio public assets" on storage.objects for update to authenticated using (bucket_id = 'studio-public-assets') with check (bucket_id = 'studio-public-assets')`,
  `create policy "Authenticated users can delete studio public assets" on storage.objects for delete to authenticated using (bucket_id = 'studio-public-assets')`,
];

describe("LAUNCH-SEC-1B2 forward migration", () => {
  const sql = read(FORWARD);
  const statements = topLevelStatements(sql);

  it("drops the eight reviewed policies, creates one scoped INSERT, and limits studio-public-assets", () => {
    expect(statements[0]).toBe("begin");
    expect(statements.at(-1)).toBe("commit");
    expect(statements.slice(1, 9)).toEqual(
      [...EVENT_MEDIA_POLICIES, ...STUDIO_ASSET_POLICIES].map(
        (name) => `drop policy if exists "${name}" on storage.objects`,
      ),
    );
    expect(statements[9]).toBe(`drop policy if exists "${SCOPED_POLICY}" on storage.objects`);
    expect(statements[10]).toMatch(new RegExp(`^create policy "${SCOPED_POLICY}" on storage\\.objects for insert to authenticated with check \\(`));
    expect(statements[11]).toBe(
      "update storage.buckets set file_size_limit = 5242880, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'] where id = 'studio-public-assets'",
    );
    expect(statements).toHaveLength(13);
  });

  it("the only created policy is the event-media INSERT scoped to the path's studio", () => {
    const creates = [...stripComments(sql).matchAll(/create policy "([^"]+)"/g)].map((m) => m[1]);
    expect(creates).toEqual([SCOPED_POLICY]);

    const policy = normalize(statements[10]);
    expect(policy).toContain("bucket_id = 'event-media'");
    expect(policy).toContain(
      "when split_part(objects.name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'",
    );
    expect(policy).toContain("select 1 from public.studios s where s.id = split_part(objects.name, '/', 1)::uuid");
    expect(policy).toContain("and public.user_has_studio_access(split_part(objects.name, '/', 1)::uuid)");
    expect(policy).toContain("else false end");
    // No unqualified `name` that could bind to studios.name inside the subquery.
    expect(policy).not.toMatch(/split_part\(name,/);
  });

  it("keeps both buckets public, never changes event-media, and touches no data, objects or grants", () => {
    const body = stripComments(sql);
    expect(body).not.toMatch(/\bpublic\s*=\s*false\b/);
    expect(body).not.toMatch(/set public\s*=/);
    expect(body).not.toMatch(/where id = 'event-media'/);
    expect(body).not.toMatch(/for (select|update|delete)\b/i);
    expect(body).not.toMatch(/\binsert\s+into\b/i);
    expect(body).not.toMatch(/\bdelete\s+from\b/i);
    expect(body).not.toMatch(/\bgrant\b|\brevoke\b|\balter\s+table\b/i);
    expect(body).not.toContain("client-photos");
  });

  it("fails closed on an unexpected pre-state and asserts the result", () => {
    expect(sql).toContain("event-media bucket is missing or not in the reviewed state");
    expect(sql).toContain("studio-public-assets bucket is missing or not in the reviewed state");
    expect(sql).toContain("public.user_has_studio_access(uuid) is missing");
    expect(sql).toContain("unexpected storage policy definition(s)");
    for (const name of [...EVENT_MEDIA_POLICIES, ...STUDIO_ASSET_POLICIES]) {
      expect(sql).toContain(`p.policyname = '${name}'`);
    }
    expect(sql).toContain("studio-public-assets limits were not applied");
    expect(sql).toContain("a storage policy still references studio-public-assets");
    expect(sql).toContain("event-media must have exactly the scoped INSERT policy");
  });
});

describe("LAUNCH-SEC-1B2 rollback", () => {
  const rollback = read(ROLLBACK);
  const statements = topLevelStatements(rollback);

  it("warns that it re-opens the vulnerability", () => {
    expect(rollback).toContain("RE-OPENS the cross-tenant Storage write");
  });

  it("restores exactly the reviewed baseline policies and studio-public-assets settings", () => {
    expect(statements).toEqual([
      "begin",
      `drop policy if exists "${SCOPED_POLICY}" on storage.objects`,
      "update storage.buckets set public = true, file_size_limit = null, allowed_mime_types = null where id = 'studio-public-assets'",
      ...[...EVENT_MEDIA_POLICIES, ...STUDIO_ASSET_POLICIES].flatMap((name, index) => [
        `drop policy if exists "${name}" on storage.objects`,
        BASELINE_CREATES[index],
      ]),
      "commit",
    ]);
  });
});

describe("LAUNCH-SEC-1B2 DEV regression suite", () => {
  const suite = read(SUITE);

  it("runs in one rolled-back transaction and covers every caller class", () => {
    const statements = topLevelStatements(suite);
    expect(statements[0]).toBe("begin");
    expect(statements.at(-1)).toBe("rollback");
    for (const marker of [
      "PASS T-launchsec1b2-configuration",
      "PASS T-launchsec1b2-member-scoped-insert",
      "PASS T-launchsec1b2-member-no-list-update-delete",
      "PASS T-launchsec1b2-inactive-member-denied",
      "PASS T-launchsec1b2-no-role-user-denied",
      "PASS T-launchsec1b2-platform-admin",
      "PASS T-launchsec1b2-anon-denied",
      "PASS T-launchsec1b2-existing-objects-unchanged",
      "PASS T-launchsec1b2-service-role-path",
    ]) {
      expect(suite).toContain(marker);
    }
  });
});

describe("application compatibility (no app change required)", () => {
  const appFiles = () => {
    const hits: Record<string, string[]> = { "event-media": [], "studio-public-assets": [] };
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          if (entry === "__tests__" || entry === "migrations" || entry === "node_modules") continue;
          walk(path);
        } else if (/\.(ts|tsx)$/.test(entry)) {
          const source = readFileSync(path, "utf8");
          for (const bucket of Object.keys(hits)) {
            if (source.includes(`"${bucket}"`)) hits[bucket].push(relative(ROOT, path).replace(/\\/g, "/"));
          }
        }
      }
    };
    walk(join(ROOT, "src"));
    return hits;
  };

  it("only the two reviewed server actions name these buckets", () => {
    expect(appFiles()).toEqual({
      "event-media": ["src/app/app/events/actions.ts"],
      "studio-public-assets": ["src/app/app/settings/public-profile/actions.ts"],
    });
  });

  it("event covers are uploaded under {studioId}/ with upsert:false (matches the scoped INSERT)", () => {
    const source = readFileSync(join(ROOT, "src/app/app/events/actions.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(source).toContain(
      "const path = `${studioId}/${safeSlug}/${Date.now()}-${crypto.randomUUID()}.${validation.extension}`;",
    );
    expect(source).toMatch(/\.from\(EVENT_IMAGE_BUCKET\)\s*\.upload\(path, file, \{\s*contentType: validation\.mimeType,\s*upsert: false,/);
    expect(source).not.toMatch(/\.from\(EVENT_IMAGE_BUCKET\)\s*\.(remove|update|move|list)\(/);
  });

  it("studio public assets are uploaded only through the admin client after an owner/admin gate", () => {
    const source = readFileSync(join(ROOT, "src/app/app/settings/public-profile/actions.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(source).toContain("const admin = createAdminClient();");
    expect(source).toContain("await admin.storage.from(ASSET_BUCKET).upload(path, image, { contentType: validation.mimeType, upsert: false });");
    expect(source).toContain('await requireStudioRole(["studio_owner", "studio_admin"]);');
    expect(source).not.toMatch(/supabase\.storage/);
  });
});
