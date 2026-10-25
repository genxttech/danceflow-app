/**
 * BILLING-QA-1. The PASS / FAIL / BLOCKED report format shared by the billing QA tools.
 *
 * Rules (docs/qa/billing-qa.md):
 *   - PASS means the property was checked and holds. Nothing else is a pass.
 *   - FAIL means it was checked and does not hold.
 *   - BLOCKED means it could not be checked (missing configuration, Stripe unreachable, no permission). BLOCKED is never
 *     counted as a pass, and a report with no checks at all is BLOCKED, not PASS.
 *   - Every FAIL and BLOCKED carries a machine-readable reason code.
 *   - A report holds Price IDs, amounts, flags and env variable NAMES only. Never a key, secret or customer data;
 *     `assertReportHasNoSecrets` refuses one that does.
 */

export const BILLING_QA_STATUSES = ["PASS", "FAIL", "BLOCKED"] as const;
export type BillingQaStatus = (typeof BILLING_QA_STATUSES)[number];

export type BillingQaEvidenceValue = string | number | boolean | null;

export type BillingQaCheck = {
  readonly id: string;
  readonly title: string;
  readonly status: BillingQaStatus;
  /** Required for FAIL and BLOCKED, absent for PASS. */
  readonly reason?: string;
  readonly detail?: string;
  readonly evidence?: Readonly<Record<string, BillingQaEvidenceValue>>;
};

export type BillingQaReport = {
  readonly tool: string;
  readonly mode: "test";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly config: Readonly<Record<string, BillingQaEvidenceValue>>;
  readonly overall: BillingQaStatus;
  readonly counts: Readonly<Record<BillingQaStatus, number>>;
  readonly checks: readonly BillingQaCheck[];
};

export const pass = (id: string, title: string, evidence?: Record<string, BillingQaEvidenceValue>, detail?: string): BillingQaCheck => ({
  id, title, status: "PASS", ...(detail ? { detail } : {}), ...(evidence ? { evidence } : {}),
});

export const fail = (id: string, title: string, reason: string, detail?: string, evidence?: Record<string, BillingQaEvidenceValue>): BillingQaCheck => ({
  id, title, status: "FAIL", reason, ...(detail ? { detail } : {}), ...(evidence ? { evidence } : {}),
});

export const blocked = (id: string, title: string, reason: string, detail?: string, evidence?: Record<string, BillingQaEvidenceValue>): BillingQaCheck => ({
  id, title, status: "BLOCKED", reason, ...(detail ? { detail } : {}), ...(evidence ? { evidence } : {}),
});

/** FAIL if anything failed; otherwise BLOCKED if anything was blocked or nothing ran; PASS only when every check passed. */
export function overallStatus(checks: readonly BillingQaCheck[]): BillingQaStatus {
  if (checks.some((c) => c.status === "FAIL")) return "FAIL";
  if (checks.length === 0 || checks.some((c) => c.status === "BLOCKED")) return "BLOCKED";
  return "PASS";
}

export function buildReport(params: {
  tool: string;
  startedAt: string;
  completedAt: string;
  config: Record<string, BillingQaEvidenceValue>;
  checks: BillingQaCheck[];
}): BillingQaReport {
  const ids = new Set<string>();
  for (const check of params.checks) {
    if (ids.has(check.id)) throw new Error(`billing QA report: duplicate check id ${check.id}`);
    ids.add(check.id);
    if (check.status !== "PASS" && !check.reason) throw new Error(`billing QA report: ${check.id} is ${check.status} without a reason code`);
  }
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0 };
  for (const check of params.checks) counts[check.status] += 1;
  const report: BillingQaReport = {
    tool: params.tool,
    mode: "test",
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    config: params.config,
    overall: overallStatus(params.checks),
    counts,
    checks: params.checks,
  };
  assertReportHasNoSecrets(report);
  return report;
}

// Stripe secret/restricted/webhook keys and the common JWT shape of a Supabase service key.
const SECRET_PATTERN = /\b(sk|rk)_(test|live)_[A-Za-z0-9]+|\bwhsec_[A-Za-z0-9]+|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./;

export function assertReportHasNoSecrets(report: BillingQaReport): void {
  if (SECRET_PATTERN.test(JSON.stringify(report))) {
    throw new Error("billing QA report: refusing to emit a report that contains a key or secret");
  }
}

/** 0 PASS, 1 FAIL, 4 BLOCKED (never a pass; same meaning as scripts/qa/iso-qa.mjs exit 4). 2 is reserved for usage/safety refusals. */
export function exitCodeFor(status: BillingQaStatus): number {
  if (status === "PASS") return 0;
  if (status === "FAIL") return 1;
  return 4;
}

export function renderReportTable(report: BillingQaReport): string {
  const rows = report.checks.map((c) => [c.status, c.id, c.reason ?? "", c.detail ?? c.title]);
  const widths = [7, Math.max(2, ...rows.map((r) => r[1].length)), Math.max(6, ...rows.map((r) => r[2].length))];
  const line = (cells: string[]) => cells.map((cell, i) => (i < widths.length ? cell.padEnd(widths[i]) : cell)).join("  ");
  return [
    `${report.tool} (${report.mode} mode) — ${report.overall}`,
    `PASS ${report.counts.PASS}  FAIL ${report.counts.FAIL}  BLOCKED ${report.counts.BLOCKED}`,
    "",
    line(["STATUS", "ID", "REASON", "DETAIL"]),
    ...rows.map(line),
  ].join("\n");
}
