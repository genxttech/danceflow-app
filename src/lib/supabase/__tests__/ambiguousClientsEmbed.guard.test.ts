import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static guard for PGRST201. These tables have MORE THAN ONE foreign key to `clients`, so PostgREST rejects an unhinted `clients ( ... )` embed from them on
 * every request (checked against the real schema, DEV-equivalent baseline and PROD, 2026-11-10):
 *   appointments (client_id, partner_client_id), client_relationships and client_source_relationships (client_id, related_client_id).
 * Such an embed must name its relationship, e.g. `clients:clients!appointments_client_id_fkey ( ... )`.
 *
 * The scan resolves an embed's parent from the nearest enclosing `name ( ... )` embed, or from the nearest `.from("table")` before an inline select string.
 * A select held in a separate constant is not traced to its `.from()`; keep such constants hinted (see src/lib/reports/appointmentsExportSelect.ts).
 * localStack.appointmentsClientsEmbed.test.ts proves the behaviour against a real PostgREST.
 */

const AMBIGUOUS_PARENTS = new Set(["appointments", "client_relationships", "client_source_relationships"]);

// Fixed on its own path (PR 445 brings the hint to main); listed so this guard does not collide with that change. Remove once main has it.
const KNOWN_ELSEWHERE = new Set(["src/lib/notifications/schedulePush.ts"]);

const SRC = path.resolve(import.meta.dirname, "../../..");

function sourceFiles(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

export function findUnhintedClientsEmbeds(source: string) {
  const findings: { line: number; parent: string }[] = [];
  const embed = /(?<![\w!])clients\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = embed.exec(source))) {
    let depth = 0;
    let parent: string | null = null;
    for (let i = match.index - 1; i >= 0; i--) {
      const ch = source[i];
      if (ch === ")") depth++;
      else if (ch === "(") {
        if (depth === 0) {
          parent = source.slice(Math.max(0, i - 80), i).match(/([A-Za-z_]\w*)(?:![\w]+)?\s*$/)?.[1] ?? null;
          break;
        }
        depth--;
      } else if ((ch === "`" || ch === '"') && depth === 0) {
        parent = source.slice(Math.max(0, i - 300), i).match(/\.from\(\s*["'`](\w+)["'`]\s*\)[\s\S]*$/)?.[1] ?? null;
        break;
      }
    }
    if (parent && AMBIGUOUS_PARENTS.has(parent)) {
      findings.push({ line: source.slice(0, match.index).split("\n").length, parent });
    }
  }
  return findings;
}

describe("unhinted clients embeds from tables with two foreign keys to clients (PGRST201)", () => {
  it("detects the shapes that failed in production", () => {
    expect(findUnhintedClientsEmbeds('supabase.from("appointments").select(`title, clients ( first_name ), rooms ( name )`)')).toEqual([
      { line: 1, parent: "appointments" },
    ]);
    expect(findUnhintedClientsEmbeds('supabase.from("appointments").select("client_id, clients ( id, email )")')).toHaveLength(1);
    expect(findUnhintedClientsEmbeds('x.from("payments").select("appointments ( id, clients ( first_name ) )")')).toEqual([{ line: 1, parent: "appointments" }]);
    expect(findUnhintedClientsEmbeds('x.from("appointments").select("id, lead:clients ( first_name )")')).toHaveLength(1);
  });

  it("accepts hinted embeds and embeds from single-FK tables", () => {
    expect(findUnhintedClientsEmbeds('x.from("appointments").select("id, clients:clients!appointments_client_id_fkey ( first_name )")')).toEqual([]);
    expect(findUnhintedClientsEmbeds('x.from("appointments").select("id, partner:clients!appointments_partner_client_id_fkey ( first_name )")')).toEqual([]);
    expect(findUnhintedClientsEmbeds('x.from("payments").select("id, clients ( first_name )")')).toEqual([]);
    expect(findUnhintedClientsEmbeds('x.from("appointment_attendees").select("client_id, clients ( id )")')).toEqual([]);
  });

  it("finds none in src", () => {
    const offenders = sourceFiles(SRC).flatMap((file) => {
      const relative = path.relative(path.resolve(SRC, ".."), file).split(path.sep).join("/");
      if (KNOWN_ELSEWHERE.has(relative)) return [];
      return findUnhintedClientsEmbeds(readFileSync(file, "utf8")).map((hit) => `${relative}:${hit.line} (from ${hit.parent})`);
    });
    expect(offenders).toEqual([]);
  });
});
