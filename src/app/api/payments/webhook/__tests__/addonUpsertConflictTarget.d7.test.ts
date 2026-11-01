import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * D7 release fix: production's usage_addon_entitlements has NO unique constraint on (studio_id, feature_key) (only the id key and
 * a plain UNIQUE on stripe_subscription_item_id; D7 adds only PARTIAL indexes for manual grants). The webhook sync of an
 * Organizer Suite subscription item used onConflict "studio_id,feature_key", which Postgres rejects (42P10), so a studio that
 * bought the add-on would have failed its own subscription webhook. Proven against a PROD-shaped table in
 * scripts/release/d7_core_sql_dryrun.sh (step 9). This guard pins the corrected target.
 */
describe("webhook Organizer Suite item upsert", () => {
  const source = readFileSync(path.join(process.cwd(), "src/app/api/payments/webhook/route.ts"), "utf8");

  it("upserts the entitlement on stripe_subscription_item_id, never on the non-unique (studio_id, feature_key) pair", () => {
    const block = source.slice(source.indexOf('.from("usage_addon_entitlements").upsert('));
    const call = block.slice(0, block.indexOf("if (error)"));
    expect(call).toContain('onConflict: "stripe_subscription_item_id"');
    expect(call).not.toContain("studio_id,feature_key");
  });
});
