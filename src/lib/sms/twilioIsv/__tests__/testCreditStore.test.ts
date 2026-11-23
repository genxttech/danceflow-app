import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunnerStoreError } from "../store";
import { SupabaseTestCreditStore, TEST_CREDIT_ENV_FLAG, testCreditEnabled, testCreditInputProblem, type TestCreditEvidence } from "../testCreditStore";

const NOW = Date.UTC(2027, 1, 23, 15, 0, 0); // 2027-02-23
const ON = { [TEST_CREDIT_ENV_FLAG]: "1" };
const ev = (o: Partial<TestCreditEvidence> = {}): TestCreditEvidence => ({
  authorizedOn: "2027-02-20", authorizedByRole: "owner_written", periodKey: "2027-02", documentRef: "AUTH-DOC-abc123", documentSha256: "a".repeat(64), ...o,
});
const REF = "Founder written test credit 2027-02-20";

function fakeClient(reply: { data?: unknown; error?: { code?: string } | null } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: reply.data ?? { replayed: false, grant_id: "g1", budget_cents: 0, enabled: true }, error: reply.error ?? null };
    },
  };
  return { client: client as never, calls };
}
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return e instanceof RunnerStoreError ? e.code : String(e);
  }
};

describe("TW-4F controlled test credit wrapper (dark, service role)", () => {
  it("is OFF unless TW4_TEST_CREDIT_ENABLED is exactly 1", () => {
    expect(testCreditEnabled({})).toBe(false);
    expect(testCreditEnabled({ [TEST_CREDIT_ENV_FLAG]: "true" })).toBe(false);
    expect(testCreditEnabled({ [TEST_CREDIT_ENV_FLAG]: "0" })).toBe(false);
    expect(testCreditEnabled(ON)).toBe(true);
  });

  it("every call that can create test credit refuses without the flag and never reaches the database", async () => {
    const { client, calls } = fakeClient();
    const s = new SupabaseTestCreditStore(client, {}, () => NOW);
    expect(await codeOf(s.grant("e", 500, REF, "a", ev()))).toBe("test_credit_disabled");
    expect(await codeOf(s.setBudget("e", 500, REF, "a", ev()))).toBe("test_credit_disabled");
    expect(await codeOf(s.setSwitch(true, "a", "turning on for the pilot test"))).toBe("test_credit_disabled");
    expect(calls).toHaveLength(0);
  });

  it("the safe directions work while dark: switch OFF and reversing unused test credit", async () => {
    const { client, calls } = fakeClient({ data: { enabled: false, replayed: false } });
    const s = new SupabaseTestCreditStore(client, {}, () => NOW);
    expect(await s.setSwitch(false, "a", "emergency stop of test credit")).toEqual({ enabled: false });
    expect(await s.reverse("e", 100, "rev-1", "unused after the pilot test", "a")).toEqual({ replayed: false });
    expect(calls.map((c) => c.fn)).toEqual(["tw4_credit_test_set_switch", "tw4_credit_test_reverse"]);
  });

  it("status is read-only and allowed while dark", async () => {
    const { client, calls } = fakeClient({ data: { ok: true, unused_cents: 0 } });
    const s = new SupabaseTestCreditStore(client, {}, () => NOW);
    expect(await s.status("e1")).toEqual({ ok: true, unused_cents: 0 });
    expect(calls).toEqual([{ fn: "tw4_credit_test_status", args: { p_entity_id: "e1" } }]);
  });

  it("grant maps every argument, with the scope and the amount taken from the call (never from the caller's evidence)", async () => {
    const { client, calls } = fakeClient({ data: { grant_id: "g9", replayed: true } });
    const s = new SupabaseTestCreditStore(client, ON, () => NOW);
    expect(await s.grant("e1", 750, `  ${REF}  `, "admin1", ev())).toEqual({ grantId: "g9", replayed: true });
    expect(calls).toEqual([{
      fn: "tw4_credit_test_grant",
      args: {
        p_entity_id: "e1", p_cents: 750, p_approval_ref: REF, p_actor: "admin1", p_evidence_authorized_on: "2027-02-20", p_evidence_role: "owner_written",
        p_evidence_scope: "test_credit_grant", p_evidence_amount_cents: 750, p_evidence_period_key: "2027-02", p_evidence_document_ref: "AUTH-DOC-abc123", p_evidence_sha256: "a".repeat(64),
      },
    }]);
  });

  it("setBudget uses the budget scope and allows 0 (closing the budget), never a negative amount", async () => {
    const { client, calls } = fakeClient({ data: { budget_cents: 0, replayed: false } });
    const s = new SupabaseTestCreditStore(client, ON, () => NOW);
    expect(await s.setBudget("e1", 0, REF, "admin1", ev())).toEqual({ budgetCents: 0, replayed: false });
    expect(calls[0].fn).toBe("tw4_credit_test_budget_set");
    expect(calls[0].args.p_evidence_scope).toBe("test_credit_budget");
    expect(calls[0].args.p_evidence_amount_cents).toBe(0);
    expect(await codeOf(s.setBudget("e1", -1, REF, "admin1", ev()))).toBe("22023");
    expect(await codeOf(s.grant("e1", 0, REF, "admin1", ev()))).toBe("22023");
    expect(calls).toHaveLength(1);
  });

  it("refuses malformed input locally (zero, negative, fractional, over the bound, short reference, stale / future / unreal dates, role, period, document, hash)", () => {
    const ok = (c: number, e: TestCreditEvidence = ev(), r = REF) => testCreditInputProblem(c, r, e, NOW);
    expect(ok(500)).toBeNull();
    expect(ok(0)).toBe("amount");
    expect(ok(-5)).toBe("amount");
    expect(ok(1.5)).toBe("amount");
    expect(ok(50_001)).toBe("amount");
    expect(ok(500, ev(), "short")).toBe("approval_ref");
    expect(ok(500, ev({ authorizedOn: "2027-02-24" }))).toBe("authorized_on");
    expect(ok(500, ev({ authorizedOn: "2027-01-22" }))).toBe("authorized_on"); // 32 days
    expect(ok(500, ev({ authorizedOn: "2027-01-23" }))).toBeNull(); // 31 days
    expect(ok(500, ev({ authorizedOn: "2027-02-30" }))).toBe("authorized_on");
    expect(ok(500, ev({ authorizedByRole: "studio_admin" as never }))).toBe("role");
    expect(ok(500, ev({ periodKey: "2027-13" }))).toBe("period");
    expect(ok(500, ev({ documentRef: "https://x.test/a?token=1" }))).toBe("document_ref");
    expect(ok(500, ev({ documentSha256: "A".repeat(64) }))).toBe("sha256");
  });

  it("database refusals surface only the SQLSTATE", async () => {
    const { client } = fakeClient({ error: { code: "TW071" } });
    const s = new SupabaseTestCreditStore(client, ON, () => NOW);
    expect(await codeOf(s.grant("e1", 500, REF, "admin1", ev()))).toBe("TW071");
  });

  it("reverse validates key, reason and amount and passes them through", async () => {
    const { client, calls } = fakeClient({ data: { replayed: false } });
    const s = new SupabaseTestCreditStore(client, ON, () => NOW);
    expect(await codeOf(s.reverse("e1", 0, "rev-1", "unused after the test", "a"))).toBe("22023");
    expect(await codeOf(s.reverse("e1", 100, "x", "unused after the test", "a"))).toBe("22023");
    expect(await codeOf(s.reverse("e1", 100, "rev-1", "short", "a"))).toBe("22023");
    await s.reverse("e1", 100, " rev-1 ", " unused after the test ", "a");
    expect(calls).toEqual([{ fn: "tw4_credit_test_reverse", args: { p_entity_id: "e1", p_cents: 100, p_key: "rev-1", p_reason: "unused after the test", p_actor: "a" } }]);
  });

  it("no application module imports the wrapper (no UI, no route, no cron: dark by construction)", () => {
    const out = execFileSync("git", ["grep", "-l", "testCreditStore", "--", "src"], { encoding: "utf8", cwd: process.cwd() });
    const users = out.split("\n").filter(Boolean).map((p) => p.replace(/\\/g, "/")).filter((p) => !p.includes("/__tests__/") && !p.endsWith("testCreditStore.ts"));
    expect(users).toEqual([]);
  });

  it("the migration never encodes a budget amount and keeps the switch default OFF", () => {
    const sql = readFileSync(join(process.cwd(), "src/lib/supabase/migrations/20270223091000_twilio_test_credit_grant.sql"), "utf8");
    expect(sql).not.toMatch(/\r/);
    expect(sql).toMatch(/budget_cents bigint not null default 0/);
    expect(sql).not.toMatch(/insert into public\.studio_sms_test_credit_switch_log[^;]*values \(true/i);
    // the owner's proposed $10 is not encoded anywhere (the only 1000 is the pre-existing $10 low-balance threshold default carried over in sms_credit_overview's body)
    expect(sql.replace(/coalesce\(a\.low_balance_threshold_cents, 1000\)/g, "")).not.toMatch(/\b1000\b/);
  });
});
