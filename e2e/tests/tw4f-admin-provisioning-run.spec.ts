import { test } from "@playwright/test";
import { TW4F_E2E_BLOCKER, tw4fEnvironmentProblem } from "../helpers/tw4fFixture";

/**
 * TW-4F Q1 / J1 (#278): the platform admin runs the campaign / number steps from ProvisioningSummary on /platform/sms.
 * UI exists on main. Stable ids present: provisioning-summary, prov-run-controls, prov-run-service, prov-run-campaign, prov-run-campaign-form, prov-run-campaign-phrase,
 * prov-run-campaign-confirm, prov-run-refresh, num-run-area-code, num-run-offer, num-run-acquire, num-run-acquire-form, num-run-acquire-confirm, num-run-refresh, admin-blockers, admin-ledger.
 * Still fixme for ONE reason: no auth-capable isolated stack for platform-admin sign-in (TOTP); tw4fFixture.seedTw4fEntity already seeds the entity, $150 cap, prices and pilot exception for it.
 * Intended assertions: a run needs the typed confirmation phrase; a double click runs once; a refused step leaves the ledger unchanged; a fee-bearing step is refused when funding is exhausted.
 */
test.describe("TW-4F admin provisioning run (J1)", () => {
  test.beforeEach(() => {
    test.skip(Boolean(tw4fEnvironmentProblem()), tw4fEnvironmentProblem() ?? "");
  });
  test.fixme("the campaign step runs once after the typed confirmation", { annotation: { type: "fixme", description: TW4F_E2E_BLOCKER } }, async () => {
    /* UI: src/app/platform/sms/ProvisioningSummary.tsx (J1, #278) */
  });
  test.fixme("a run without the confirmation phrase is refused and the ledger is unchanged", { annotation: { type: "fixme", description: TW4F_E2E_BLOCKER } }, async () => {
    /* UI: src/app/platform/sms/ProvisioningSummary.tsx (J1, #278) */
  });
  test.fixme("a double click on a run control executes exactly one run", { annotation: { type: "fixme", description: TW4F_E2E_BLOCKER } }, async () => {
    /* UI: src/app/platform/sms/ProvisioningSummary.tsx (J1, #278) */
  });
  test.fixme("a fee-bearing step is refused when funding is exhausted", { annotation: { type: "fixme", description: TW4F_E2E_BLOCKER } }, async () => {
    /* UI: src/app/platform/sms/ProvisioningSummary.tsx (J1, #278) */
  });
});
