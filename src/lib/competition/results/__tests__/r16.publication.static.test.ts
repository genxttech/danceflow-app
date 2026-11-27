import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * R-16 (static, no database; reads the F3 migration text): Studio/Custom result-publication visibility. `entrants` is the default;
 * `public` is only an explicit choice by a verified manager. These are presence/shape checks on migration text, NOT behavioral proof;
 * the executing SQL suite is test_T_competition_cf1_f3_publication.sql (NOT RUN in this slice). Complements, does not duplicate,
 * publication.f3.test.ts and viewer.f3u66.test.ts.
 */
const f3 = fs.readFileSync(path.resolve(__dirname, "../../../supabase/migrations/20270122090000_competition_f3_publication.sql"), "utf8");
const fn = (name: string) => {
  const s = f3.indexOf(`function public.${name}`);
  expect(s, `${name} exists`).toBeGreaterThan(0);
  return f3.slice(s, f3.indexOf("$$;", s + 50));
};

describe("R-16: publication visibility (static)", () => {
  it("the stored visibility defaults to entrants and is limited to entrants or public", () => {
    expect(f3).toMatch(/visibility text not null default 'entrants'/);
    expect(f3).toMatch(/visibility in \('entrants', 'public'\)/);
  });

  it("the publish RPC is manager-only, needs a verified email, and coalesces a blank visibility to entrants (never public)", () => {
    const body = fn("publish_competition_round_result");
    expect(body).toMatch(/_compe2_round_role\(p_round_id\) is distinct from 'manager'/);
    expect(body).toMatch(/verified_email_for_user\(v_uid\) is null/);
    expect(body).toMatch(/coalesce\(nullif\(btrim\(p_visibility\), ''\), 'entrants'\)/);
    expect(body).toMatch(/COMP_PUBLICATION_VISIBILITY/);
  });

  it("the shared payload builder names no judge, ballot, hash, calculator or approver field", () => {
    const body = fn("_compf3_payload");
    for (const word of ["judge", "ballot", "input_hash", "trace", "calculated_by", "approved_by", "published_by", "reason"]) {
      expect(body.toLowerCase()).not.toContain(word);
    }
  });

  it("no F3 object is added to the realtime publication, and anon is granted only the two public readers", () => {
    expect(f3).not.toMatch(/supabase_realtime/);
    const anonGrants = [...f3.matchAll(/grant execute on function public\.(\w+)\([^)]*\) to [^;]*\banon\b/g)].map((m) => m[1]).sort();
    expect(anonGrants).toEqual(["competition_event_results_public", "competition_round_results_public"]);
  });

  it("the entrant reader requires a signed-in caller and resolves entries through the viewer helper (presence check only)", () => {
    const body = fn("competition_my_results");
    expect(body).toMatch(/auth\.uid\(\)/);
    expect(body).toMatch(/_compf3_viewer_entries/);
  });
});
