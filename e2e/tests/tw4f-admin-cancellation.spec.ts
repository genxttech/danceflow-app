import { test } from "@playwright/test";
import { tw4fEnvironmentProblem } from "../helpers/tw4fFixture";

/**
 * TW-4F Q1 / F5 (session tw4f-f5-release): admin cancellation / release of a provisioned number with DUAL CONTROL (RecurringFeesCancel.tsx, cancelRunner.ts,
 * cancel actions in recurringFeeActions.ts; FAKE adapter only). FIXME until F5 lands. Requested ids:
 *   data-testid="cancel-request" (button), "cancel-reason", "cancel-pending" (data-requested-by), "cancel-approve" (button, second admin only),
 *   "cancel-result" (data-outcome), "cancel-self-approve-refusal".
 * Expected: one admin requests and a DIFFERENT admin approves; the requester cannot approve their own request; a replayed approval does nothing; the recurring
 * fee ledger is retired and the fake number released exactly once; an owner cannot see the control. Needs a second platform-admin account (fixture addition
 * when F5 lands).
 */
test.describe("TW-4F admin cancellation with dual control (F5)", () => {
  test.beforeEach(() => {
    test.skip(Boolean(tw4fEnvironmentProblem()), tw4fEnvironmentProblem() ?? "");
  });
  test.fixme("admin A requests, admin B approves, the number is released once", async () => {
    /* owner: tw4f-f5-release */
  });
  test.fixme("the requester cannot approve their own cancellation", async () => {
    /* owner: tw4f-f5-release */
  });
  test.fixme("a replayed approval changes nothing", async () => {
    /* owner: tw4f-f5-release */
  });
});
