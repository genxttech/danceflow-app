import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * D7 release fix: production's usage_addon_entitlements has NO unique constraint on (studio_id, feature_key) (only the id key and
 * a plain UNIQUE on stripe_subscription_item_id; D7 adds only PARTIAL indexes for manual grants). The release line's webhook
 * upserted an Organizer Suite subscription item with onConflict "studio_id,feature_key", which Postgres rejects (42P10); the live
 * fix moved the target to stripe_subscription_item_id (proven in scripts/release/d7_core_sql_dryrun.sh, step 9).
 *
 * On main (since BILLING-QA-6, #360) the webhook no longer writes the table: the apply_studio_subscription_state RPC does, keyed
 * by stripe_subscription_item_id with an explicit select-then-update/insert (no ON CONFLICT). This guard pins both halves so the
 * non-unique (studio_id, feature_key) target cannot come back on either path.
 */
describe("Organizer Suite item entitlement write target", () => {
  const webhook = readFileSync(path.join(process.cwd(), "src/app/api/payments/webhook/route.ts"), "utf8");
  const rpc = readFileSync(
    path.join(process.cwd(), "src/lib/supabase/migrations/20270202100000_apply_studio_subscription_state_rpc.sql"),
    "utf8",
  );

  it("the webhook never upserts the entitlement on the non-unique (studio_id, feature_key) pair", () => {
    expect(webhook).not.toMatch(/onConflict:\s*["']studio_id,\s*feature_key["']/);
    const at = webhook.indexOf('.from("usage_addon_entitlements").upsert(');
    if (at >= 0) {
      const call = webhook.slice(at, webhook.indexOf("if (error)", at));
      expect(call).toContain('onConflict: "stripe_subscription_item_id"');
    }
  });

  it("the RPC locates Suite rows by stripe_subscription_item_id and uses no ON CONFLICT target", () => {
    expect(rpc).toMatch(/from public\.usage_addon_entitlements where stripe_subscription_item_id = v_item_id/);
    expect(rpc).toMatch(/where stripe_subscription_item_id = v_item_id and studio_id = p_studio_id/);
    const code = rpc.replace(/--[^\n]*/g, "").toLowerCase();
    expect(code).not.toMatch(/on\s+conflict/);
  });
});
