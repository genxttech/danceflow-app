import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * D7 static guard for the least-privilege migration on public.usage_addon_entitlements: only the
 * allowlisted files may write the table (insert / upsert / update / delete), and each of them must
 * do so through the service-role admin client, never the session client from "@/lib/supabase/server".
 * Adding a writer means adding it here deliberately (and checking the grants migration still fits).
 */

const SRC = path.join(process.cwd(), "src");
const TABLE = "usage_addon_entitlements";

/** file (relative to src, forward slashes) -> receivers allowed to write the table in that file. */
const WRITER_ALLOWLIST: Record<string, string[]> = {
  // The Stripe webhook no longer writes this table directly: since BILLING-QA-6 (#360) Suite rows are written by the
  // SECURITY DEFINER apply_studio_subscription_state RPC (service-role only), which keeps its rights under the
  // least-privilege grants. A direct write reappearing in the webhook would have to be added here deliberately.
  // Organizer Suite add-on purchase: upsert keyed on stripe_subscription_item_id.
  "app/api/billing/addons/organizer-suite/checkout/route.ts": ["params.supabaseAdmin"],
  // Organizer Suite add-on removal: marks the Stripe-item row canceled.
  "app/api/billing/addons/organizer-suite/remove/route.ts": ["supabaseAdmin"],
  // AI credit packs (used by the ai/checkout and ai/remove routes): insert / update / cancel.
  "lib/usage/ai-credit-packs.ts": ["supabaseAdmin"],
};

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

type Access = { file: string; receiver: string; chain: string; writes: boolean };

const FROM_PATTERN = new RegExp(`([\\w.]+)\\s*\\.from\\(\\s*["'\`]${TABLE}["'\`]\\s*\\)([\\s\\S]*?)(?:;|$)`, "g");

function scan(): { accesses: Access[]; strayMentions: string[] } {
  const accesses: Access[] = [];
  const strayMentions: string[] = [];
  for (const full of walk(SRC)) {
    const text = readFileSync(full, "utf8");
    if (!text.includes(TABLE)) continue;
    const file = path.relative(SRC, full).split(path.sep).join("/");

    let fromCount = 0;
    for (const match of text.matchAll(FROM_PATTERN)) {
      fromCount += 1;
      const chain = match[2];
      accesses.push({ file, receiver: match[1], chain, writes: /\.(insert|upsert|update|delete)\s*\(/.test(chain) });
    }

    // Every non-comment mention of the table name must be a literal .from(...) target, so a writer cannot hide
    // behind a constant or a dynamic table name. Whole-word mentions only: a longer identifier that merely contains the
    // table name (e.g. the RPC expire_due_usage_addon_entitlements) is not a table access.
    const wholeWord = new RegExp(`\\b${TABLE}\\b`);
    const codeMentions = text
      .split(/\r?\n/)
      .filter((line) => wholeWord.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)).length;
    if (codeMentions !== fromCount) strayMentions.push(`${file} (${codeMentions} mentions, ${fromCount} .from calls)`);
  }
  return { accesses, strayMentions };
}

describe("usage_addon_entitlements writers (D7 least-privilege guard)", () => {
  const { accesses, strayMentions } = scan();
  const writers = accesses.filter((access) => access.writes);

  it("finds the known accesses (sanity: the scanner works)", () => {
    expect(accesses.length).toBeGreaterThan(10);
    expect(writers.length).toBeGreaterThanOrEqual(Object.keys(WRITER_ALLOWLIST).length);
  });

  it("every table-name mention is a literal .from() call", () => {
    expect(strayMentions).toEqual([]);
  });

  it("only allowlisted files write the table, through allowlisted receivers", () => {
    const unexpected = writers
      .filter((access) => !(WRITER_ALLOWLIST[access.file] ?? []).includes(access.receiver))
      .map((access) => `${access.file} via ${access.receiver}`);
    expect(unexpected).toEqual([]);
  });

  it("every allowlisted file is still a writer (stale entries are removed)", () => {
    const writerFiles = new Set(writers.map((access) => access.file));
    expect(Object.keys(WRITER_ALLOWLIST).filter((file) => !writerFiles.has(file))).toEqual([]);
  });

  it.each(Object.entries(WRITER_ALLOWLIST))("%s writes with the service-role client", (file, receivers) => {
    const text = readFileSync(path.join(SRC, file), "utf8");
    expect(text).toContain("SUPABASE_SERVICE_ROLE_KEY");
    const importsSessionClient = /import\s*\{[^}]*\bcreateClient\b[^}]*\}\s*from\s*["']@\/lib\/supabase\/server["']/.test(text);

    for (const receiver of receivers) {
      const ident = receiver.split(".").pop()!;
      // Never bound to the session client.
      expect(text).not.toMatch(new RegExp(`\\b${ident}\\s*=\\s*(await\\s+)?createClient\\(`));
      if (importsSessionClient) {
        // A file that also has the session client must use a distinct, admin-bound name for writes.
        expect(ident).not.toBe("supabase");
        expect(text).toMatch(new RegExp(`\\b${ident}\\s*(=\\s*getSupabaseAdmin\\(\\)|:\\s*ReturnType<typeof getSupabaseAdmin>)`));
      }
    }
  });
});
