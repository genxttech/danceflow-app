/**
 * Shared types for the Production Synthetic Testing harness.
 *
 * Governance source: C:\Dev\flowops quality/PRODUCTION-SYNTHETIC-TESTING.md,
 * quality/SYNTHETIC-TEST-CATALOG.md. Owners: Ethan (technical), Daniel
 * (quality/release), Maya (security).
 */

export type SyntheticRole = "owner" | "organizer" | "student";

export type SyntheticSuite =
  | "auth"
  | "client"
  | "schedule"
  | "entitlement"
  | "events"
  | "payments-read";

export type SyntheticTestId =
  | "SYN-AUTH-001"
  | "SYN-CLIENT-001"
  | "SYN-SCHED-001"
  | "SYN-ENT-001"
  | "SYN-EVENT-001"
  | "SYN-PAY-READ-001";

export const SUITE_TEST_IDS: Record<SyntheticSuite, SyntheticTestId> = {
  auth: "SYN-AUTH-001",
  client: "SYN-CLIENT-001",
  schedule: "SYN-SCHED-001",
  entitlement: "SYN-ENT-001",
  events: "SYN-EVENT-001",
  "payments-read": "SYN-PAY-READ-001",
};

export const ALL_SUITES: SyntheticSuite[] = [
  "auth",
  "client",
  "schedule",
  "entitlement",
  "events",
  "payments-read",
];

/**
 * Non-sensitive failure classification. Never put raw exception messages,
 * stack traces, emails, or record contents here -- this is what gets
 * persisted to synthetic_test_runs and surfaced in machine-readable output.
 */
export interface SafeFailure {
  code: string;
  summary: string;
}

export type CreatedRecordRefs = Record<string, string[]>;

export interface DeploymentInfo {
  sha: string;
  version: string | null;
  environment: string;
}

export interface SyntheticIdentityConfig {
  email: string;
  password: string;
  /** Only present for the student identity: the clients.id this Supabase
   * Auth user is linked to via client_account_links (status = 'linked'). */
  clientId?: string;
}

export interface SyntheticEventFixtureConfig {
  eventId: string;
  ticketTypeId: string;
}

export interface SyntheticConfig {
  studioId: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  identities: Partial<Record<SyntheticRole, SyntheticIdentityConfig>>;
  eventFixture: SyntheticEventFixtureConfig | null;
}

export interface SyntheticTestOutcome {
  testId: SyntheticTestId;
  suite: SyntheticSuite;
  status: "passed" | "failed" | "error";
  startedAt: string;
  completedAt: string;
  safeFailure: SafeFailure | null;
  createdRecordRefs: CreatedRecordRefs;
  cleanupStatus: "not_required" | "completed" | "failed" | "partial";
  cleanupError: string | null;
}

/** Machine-readable result envelope -- matches the "Required result fields"
 * table in FlowOps quality/SYNTHETIC-TEST-CATALOG.md. */
export interface SyntheticRunResult {
  syntheticRunId: string;
  deployment: DeploymentInfo;
  environment: string;
  tenantId: string;
  startedAt: string;
  completedAt: string;
  overallStatus: "passed" | "failed" | "error";
  tests: SyntheticTestOutcome[];
}

export class SyntheticSafetyError extends Error {
  code: string;

  constructor(message: string, code = "SAFETY_GUARD_FAILED") {
    super(message);
    this.name = "SyntheticSafetyError";
    this.code = code;
  }
}
