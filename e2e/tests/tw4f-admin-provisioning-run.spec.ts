import { test } from "@playwright/test";
import { tw4fEnvironmentProblem } from "../helpers/tw4fFixture";

/**
 * TW-4F Q1 / J1 (session tw4f-j1-orchestration): the platform admin runs the R2a (messaging service + campaign) and R2b (number activation) steps from
 * ProvisioningSummary / SmsOnboardingPilot, with factory.ts building the FAKE adapter. FIXME until J1 lands. Requested ids:
 *   data-testid="prov-run-r2a", "prov-run-r2b", "prov-run-result" (data-outcome="succeeded|refused|deferred"), "prov-step" (data-step, data-state),
 *   "prov-confirm" (the separate confirmation control), "prov-refusal-reason".
 * Expected: each run needs the separate confirmation; a double click runs once; R2b is refused (not errored) while the R2a ledger is incomplete; with the
 * pilot exception exhausted a fee-bearing step is refused with the funding reason; every refusal leaves the ledger unchanged.
 */
test.describe("TW-4F admin provisioning run (J1)", () => {
  test.beforeEach(() => {
    test.skip(Boolean(tw4fEnvironmentProblem()), tw4fEnvironmentProblem() ?? "");
  });
  test.fixme("R2a runs once after confirmation and shows a succeeded result", async () => {
    /* owner: tw4f-j1-orchestration */
  });
  test.fixme("R2b is refused while R2a is incomplete and the ledger is unchanged", async () => {
    /* owner: tw4f-j1-orchestration */
  });
  test.fixme("a double click on a run control executes exactly one run", async () => {
    /* owner: tw4f-j1-orchestration */
  });
  test.fixme("a fee-bearing step is refused when funding is exhausted", async () => {
    /* owner: tw4f-j1-orchestration + F1 */
  });
});
