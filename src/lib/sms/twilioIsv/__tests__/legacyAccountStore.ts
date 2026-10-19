import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_FAKE_ACCOUNT_SID } from "../fake";
import { SupabaseRunnerStore, type RunnerAccount, type SpendKind } from "../store";

/**
 * The older local-stack suites (R1, R1.1, 4F-1b) test leases, the ledger, the gates and the state graph with real SQL and ONE fake adapter for
 * several synthetic studios. They are not about accounts, so this store answers the two TW-4F-3a questions (which Twilio account? which approved
 * spend?) locally and passes everything else to the real SQL functions. The real `tw4_runner_account`, `tw4_spend_reserve`, the ledger account
 * guard and the entity/subaccount functions are exercised against the database by `localStack.tw4f3a.test.ts`.
 */
export class LegacyAccountStore extends SupabaseRunnerStore {
  constructor(admin: Pick<SupabaseClient, "rpc">) {
    super(admin);
  }
  async getAccount(): Promise<RunnerAccount> {
    return { legalEntityId: "legacy-suite-entity", accountSid: DEFAULT_FAKE_ACCOUNT_SID, status: "active" };
  }
  async settleSpend(): Promise<void> {
    /* nothing was reserved by this shim */
  }
  async reserveSpend(_onboardingId: string, _leaseOwner: string, kind: SpendKind) {
    return { spendEventId: `legacy-${kind}`, amountCents: 0 };
  }
}
