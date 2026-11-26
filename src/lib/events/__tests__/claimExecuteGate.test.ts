import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../../..");
const M = "src/lib/supabase/migrations";
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const sha = (p: string) => createHash("sha256").update(readFileSync(path.join(root, p))).digest("hex");
const code = (s: string) => s.replace(/--[^\n]*/g, "").toLowerCase();

describe("claim RPC execute gate (withhold, then activate after the reader cutover)", () => {
  it("leaves the already-reviewed function and exclusion files byte-for-byte unchanged", () => {
    expect(sha(`${M}/20270221090000_event_registration_claim_function.sql`)).toBe("3c873d6f3840ca5da2cecaab524f33af3537f42643e1fc0cc5f937c55e4d08ec");
    expect(sha(`${M}/20270222090000_event_registration_claim_buyer_sources_only.sql`)).toBe("cd38c08e107894a7ab1d2e7977cf3a20f823bed6493ed4457a62eacb8ad49487");
  });

  it("withhold migration only revokes (no grant) and sorts after the exclusion and before the index", () => {
    const a = code(read(`${M}/20270222090500_claim_function_execute_withheld.sql`));
    expect(a).toMatch(/revoke all on function public\.claim_my_event_registrations\(\) from public, anon, authenticated, service_role/);
    expect(a).not.toMatch(/\bgrant\b/);
    const order = [
      "20270221090000_event_registration_claim_function",
      "20270222090000_event_registration_claim_buyer_sources_only",
      "20270222090500_claim_function_execute_withheld",
      "20270222091000_event_registrations_unclaimed_email_index",
      "20270222092000_dancer_event_registration_views",
      "20270222093000_dancer_direct_read_policies_cutover",
      "20270222094000_claim_function_execute_activation",
    ];
    for (const f of order) expect(existsSync(path.join(root, `${M}/${f}.sql`)), f).toBe(true);
    expect([...order].sort()).toEqual(order);
  });

  it("activation grants execute to authenticated only and sorts after the cutover", () => {
    const b = code(read(`${M}/20270222094000_claim_function_execute_activation.sql`));
    expect(b).toMatch(/grant execute on function public\.claim_my_event_registrations\(\) to authenticated;/);
    expect(b.match(/\bgrant\b/g)?.length).toBe(1);
    expect(b).toMatch(/revoke all on function public\.claim_my_event_registrations\(\) from public, anon, service_role/);
    expect(b).not.toMatch(/to\s+(public|anon|service_role)\b/);
  });

  it("rollbacks: withheld -> restores the step-2 ACL; activation -> withholds again", () => {
    const ra = code(read(`${M}/rollback/20270222090500_claim_function_execute_withheld_rollback.sql`));
    expect(ra).toMatch(/grant execute on function public\.claim_my_event_registrations\(\) to authenticated;/);
    const rb = code(read(`${M}/rollback/20270222094000_claim_function_execute_activation_rollback.sql`));
    expect(rb).toMatch(/revoke all on function public\.claim_my_event_registrations\(\) from public, anon, authenticated, service_role/);
    expect(rb).not.toMatch(/\bgrant\b/);
  });
});
