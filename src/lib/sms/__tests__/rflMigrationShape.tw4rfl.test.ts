import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static guards on the lifecycle migration (no database needed): the replaced financial functions differ from their predecessors ONLY by the intended
 * additions, the rollback restores the predecessors byte for byte, and the migration is a single transaction with nothing after its commit.
 */
const dir = join(process.cwd(), "src/lib/supabase/migrations");
const read = (name: string) => readFileSync(join(dir, name), "utf8");
const mig = read("20261209090000_twilio_recurring_fee_lifecycle.sql");
const rollback = read("rollback/20261209090000_twilio_recurring_fee_lifecycle_rollback.sql");

function fnBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("end $$;", start) + "end $$;".length;
  return source.slice(start, end);
}

describe("20261209090000 recurring fee lifecycle: migration shape", () => {
  it("is one transaction and nothing follows the commit", () => {
    expect((mig.match(/^begin;/gm) ?? []).length).toBe(1);
    expect((mig.match(/^commit;/gm) ?? []).length).toBe(1);
    expect(mig.trimEnd().endsWith("commit;")).toBe(true);
    expect(rollback.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("tw4_recurring_charge differs from the 20261203 body ONLY by the retired-resource refusal", () => {
    const sig = "create or replace function public.tw4_recurring_charge(p_authorization_id uuid, p_period_key text, p_run_id uuid default null)";
    const before = fnBody(read("20261203090000_twilio_inbound_usage_recording.sql"), sig);
    const after = fnBody(mig, sig);
    const removedAdded = after.split("\n").filter((line) => !before.split("\n").includes(line));
    // exactly two new refusal branches (an open cancellation holds the charge; a retired resource is never charged), nothing else
    expect(removedAdded).toHaveLength(6);
    expect(removedAdded.filter((l) => l.trim().startsWith("elsif "))).toHaveLength(2);
    expect(removedAdded.filter((l) => /v_status := 'held'; v_reason :=/.test(l))).toHaveLength(2);
    expect(removedAdded.join("\n")).toContain("_tw4rfl_retired");
    expect(removedAdded.join("\n")).toContain("nothing left to charge for");
    expect(removedAdded.join("\n")).toContain("a cancellation of this location");
    expect(removedAdded.join("\n")).not.toMatch(/_tw4c_post|insert into|update public/);
    // every line of the old body survives, in order
    const afterLines = after.split("\n");
    let at = 0;
    for (const line of before.split("\n")) {
      at = afterLines.indexOf(line, at);
      expect(at).toBeGreaterThanOrEqual(0);
    }
  });

  it("_tw4rc_service_state differs from the 20261128 body ONLY by the lifecycle gate and the retired skip", () => {
    const sig = "create or replace function public._tw4rc_service_state(p_studio_id uuid)";
    const before = fnBody(read("20261128090000_twilio_monthly_spending_limits.sql"), sig);
    const after = fnBody(mig, sig);
    const added = after.split("\n").filter((line) => !before.split("\n").includes(line));
    expect(added.join("\n")).toContain("_tw4rfl_gate_suspended");
    expect(added.join("\n")).toContain("_tw4rfl_retired");
    expect(added.every((l) => /_tw4rfl_|20261209|^\s*end if;$|^\s*return 'suspended';/.test(l))).toBe(true);
    const afterLines = after.split("\n");
    let at = 0;
    for (const line of before.split("\n")) {
      at = afterLines.indexOf(line, at);
      expect(at).toBeGreaterThanOrEqual(0);
    }
  });

  it("the rollback restores both predecessor bodies byte for byte", () => {
    const chargeSig = "create or replace function public.tw4_recurring_charge(p_authorization_id uuid, p_period_key text, p_run_id uuid default null)";
    const stateSig = "create or replace function public._tw4rc_service_state(p_studio_id uuid)";
    expect(fnBody(rollback, chargeSig)).toBe(fnBody(read("20261203090000_twilio_inbound_usage_recording.sql"), chargeSig));
    expect(fnBody(rollback, stateSig)).toBe(fnBody(read("20261128090000_twilio_monthly_spending_limits.sql"), stateSig));
  });

  it("the audit vocabulary is extended from the live list, never replaced with a fixed list", () => {
    expect(mig).toContain("pg_get_constraintdef");
    expect(mig).not.toMatch(/add constraint studio_sms_onboarding_audit_action_check check \(action in \(/);
  });
});
