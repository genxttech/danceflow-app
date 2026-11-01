import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RESULT_EVENT_KINDS } from "../contract";

const migrations = join(__dirname, "..", "..", "..", "supabase", "migrations");

describe("CF1 A0 contract", () => {
  it("the result-events kind check of the A0 migration equals the TypeScript kinds it adds", () => {
    const sql = readFileSync(join(migrations, "20270120090000_competition_cf1_callback_final_advancement.sql"), "utf8");
    const check = sql.match(/event_competition_result_events_kind_check\s+check \(kind = any \(array\[([^\]]+)\]\)\)/);
    expect(check).not.toBeNull();
    const kinds = [...check![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    for (const kind of kinds) expect(RESULT_EVENT_KINDS as readonly string[]).toContain(kind);
    expect(kinds).toContain("advancement_applied");
    expect(kinds).toContain("advancement_revoked");
  });

  it("the rollback restores the kind check without the CF1 kinds", () => {
    const sql = readFileSync(join(migrations, "rollback", "20270120090000_competition_cf1_callback_final_advancement_rollback.sql"), "utf8");
    expect(sql).toMatch(/check \(kind = any \(array\['round_state_changed', 'result_calculated', 'result_approved', 'result_approval_override', 'result_invalidated'\]\)\)/);
  });
});
