import type { SupabaseClient } from "@supabase/supabase-js";
import { RunnerStoreError } from "./store";
import { approvalRefInRange, documentRefValid, EVIDENCE_ROLES, SHA256_PATTERN, type EvidenceRole } from "@/lib/sms/pilotApprovalEvidence";

/**
 * TW-4F controlled test credit (migration 20270223091000; operator procedure docs/twilio/TW-4F_Test_Credit_Runbook.md). SERVICE-ROLE ONLY, NO UI, DARK.
 *
 * Test credit lets the pilot business (the one legal business holding the pilot exception) send billed TEST texts. It is a distinct ledger kind: never purchasable,
 * never refundable, never usable for setup fees, recurring fees or set-asides, and it never touches the pilot ceiling. Every grant needs the database kill switch ON,
 * room in the business's TEST BUDGET (default 0; set only by `setBudget`, which also needs written evidence), and the owner's dated written authorization as U-4 evidence.
 *
 * Two independent off-switches: the database switch (`tw4_credit_test_set_switch`, default OFF) and this module's env flag TW4_TEST_CREDIT_ENABLED=1 (default off):
 * every mutating call refuses (code "test_credit_disabled") without the flag and never reaches the database. `status` is read-only and always allowed.
 * Errors carry the SQLSTATE (TW007, TW019, TW052, TW070, TW071, TW072, 22023, 42501, 23505), never the database message text.
 */

export const TEST_CREDIT_ENV_FLAG = "TW4_TEST_CREDIT_ENABLED";
/** The database bound for a single grant and for the budget (the existing $500 balance ceiling); the actual budget is data, set per business with evidence. */
export const TEST_CREDIT_MAX_CENTS = 50_000;
/** The database refuses evidence dated more than this many days before the UTC date. */
export const TEST_CREDIT_EVIDENCE_MAX_AGE_DAYS = 31;

export type TestCreditScope = "test_credit_grant" | "test_credit_budget";

/** The owner's dated written authorization for ONE test-credit decision. The text itself is never sent: only a reference to the retained document and its sha256. */
export type TestCreditEvidence = {
  authorizedOn: string; // YYYY-MM-DD, not in the future, at most 31 days old
  authorizedByRole: EvidenceRole;
  /** The business's CURRENT billing month (YYYY-MM): the database compares it with its own month key. */
  periodKey: string;
  documentRef: string;
  documentSha256: string;
};

export type TestCreditStatus = {
  switch_enabled: boolean;
  is_pilot: boolean;
  budget_cents: number;
  granted_cents: number;
  budget_left_cents: number;
  consumed_cents: number;
  restored_cents: number;
  reversed_cents: number;
  unused_cents: number;
  balance_cents: number;
  reserved_cents: number;
  non_test_available_cents: number;
  grants: number;
  ok: boolean;
};

export interface TestCreditStore {
  setSwitch(enabled: boolean, actorId: string, reason: string): Promise<{ enabled: boolean }>;
  setBudget(entityId: string, budgetCents: number, approvalRef: string, actorId: string, evidence: TestCreditEvidence): Promise<{ budgetCents: number; replayed: boolean }>;
  grant(entityId: string, cents: number, approvalRef: string, actorId: string, evidence: TestCreditEvidence): Promise<{ grantId: string; replayed: boolean }>;
  /** Takes back UNUSED test credit (never more than is unused, never money held by an open reservation). Allowed whatever the database switch says. */
  reverse(entityId: string, cents: number, key: string, reason: string, actorId: string): Promise<{ replayed: boolean }>;
  status(entityId: string): Promise<TestCreditStatus>;
}

type Client = Pick<SupabaseClient, "rpc">;
type Env = Record<string, string | undefined>;

export const testCreditEnabled = (env: Env = process.env): boolean => env[TEST_CREDIT_ENV_FLAG] === "1";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_MS = 86_400_000;

/** Local shape check (the database repeats every rule and also checks the period against the business's month, the budget, the switch and the pilot business). */
export function testCreditInputProblem(cents: number, approvalRef: string, evidence: TestCreditEvidence, nowMs: number, allowZero = false): string | null {
  if (!Number.isInteger(cents) || cents < (allowZero ? 0 : 1) || cents > TEST_CREDIT_MAX_CENTS) return "amount";
  if (!approvalRefInRange(approvalRef)) return "approval_ref";
  const m = ISO_DATE.exec(evidence.authorizedOn);
  if (!m) return "authorized_on";
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return "authorized_on";
  const day = Math.floor(ms / DAY_MS);
  const today = Math.floor(nowMs / DAY_MS);
  if (day > today || day < today - TEST_CREDIT_EVIDENCE_MAX_AGE_DAYS) return "authorized_on";
  if (!(EVIDENCE_ROLES as readonly string[]).includes(evidence.authorizedByRole)) return "role";
  if (!PERIOD.test(evidence.periodKey)) return "period";
  if (!documentRefValid(evidence.documentRef)) return "document_ref";
  if (!SHA256_PATTERN.test(evidence.documentSha256)) return "sha256";
  return null;
}

const evidenceParams = (scope: TestCreditScope, cents: number, e: TestCreditEvidence) => ({
  p_evidence_authorized_on: e.authorizedOn, p_evidence_role: e.authorizedByRole, p_evidence_scope: scope, p_evidence_amount_cents: cents,
  p_evidence_period_key: e.periodKey, p_evidence_document_ref: e.documentRef, p_evidence_sha256: e.documentSha256,
});

export class SupabaseTestCreditStore implements TestCreditStore {
  constructor(private readonly admin: Client, private readonly env: Env = process.env, private readonly now: () => number = Date.now) {}

  private requireEnabled() {
    if (!testCreditEnabled(this.env)) throw new RunnerStoreError("test_credit_disabled");
  }
  private async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = (await this.admin.rpc(fn, args)) as { data: unknown; error: { code?: string } | null };
    if (error) throw new RunnerStoreError(String(error.code ?? "unknown"));
    return data as T;
  }

  async setSwitch(enabled: boolean, actorId: string, reason: string) {
    this.requireEnabled();
    const r = reason.trim();
    if (r.length < 10 || r.length > 300) throw new RunnerStoreError("22023");
    const row = await this.call<{ enabled: boolean }>("tw4_credit_test_set_switch", { p_enabled: enabled, p_actor: actorId, p_reason: r });
    return { enabled: Boolean(row?.enabled) };
  }

  async setBudget(entityId: string, budgetCents: number, approvalRef: string, actorId: string, evidence: TestCreditEvidence) {
    this.requireEnabled();
    if (testCreditInputProblem(budgetCents, approvalRef, evidence, this.now(), true)) throw new RunnerStoreError("22023");
    const row = await this.call<{ budget_cents: number; replayed: boolean }>("tw4_credit_test_budget_set", {
      p_entity_id: entityId, p_budget_cents: budgetCents, p_approval_ref: approvalRef.trim(), p_actor: actorId, ...evidenceParams("test_credit_budget", budgetCents, evidence),
    });
    return { budgetCents: Number(row.budget_cents), replayed: Boolean(row.replayed) };
  }

  async grant(entityId: string, cents: number, approvalRef: string, actorId: string, evidence: TestCreditEvidence) {
    this.requireEnabled();
    if (testCreditInputProblem(cents, approvalRef, evidence, this.now())) throw new RunnerStoreError("22023");
    const row = await this.call<{ grant_id: string; replayed: boolean }>("tw4_credit_test_grant", {
      p_entity_id: entityId, p_cents: cents, p_approval_ref: approvalRef.trim(), p_actor: actorId, ...evidenceParams("test_credit_grant", cents, evidence),
    });
    return { grantId: String(row.grant_id), replayed: Boolean(row.replayed) };
  }

  async reverse(entityId: string, cents: number, key: string, reason: string, actorId: string) {
    this.requireEnabled();
    const k = key.trim();
    const r = reason.trim();
    if (!Number.isInteger(cents) || cents <= 0 || k.length < 3 || k.length > 120 || r.length < 10 || r.length > 280) throw new RunnerStoreError("22023");
    const row = await this.call<{ replayed: boolean }>("tw4_credit_test_reverse", { p_entity_id: entityId, p_cents: cents, p_key: k, p_reason: r, p_actor: actorId });
    return { replayed: Boolean(row?.replayed) };
  }

  status(entityId: string) {
    return this.call<TestCreditStatus>("tw4_credit_test_status", { p_entity_id: entityId });
  }
}
