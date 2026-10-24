import { test } from "@playwright/test";
import { TW4F_E2E_BLOCKER, tw4fEnvironmentProblem } from "../helpers/tw4fFixture";

/**
 * TW-4F Q1 / F4 (#288, #296, #300): recovery, exposure and ledger views on /platform/sms.
 * UI exists on main. Stable ids present: sms-recovery, recovery-unavailable, gap-row, gap-last-retry, deferred-row, deferred-blockers, exposure-row,
 * provisioning-ledger, number-ledger, number-ledger-unreadable, number-held, resolve-form, reopen-form, record-listing-form, sms-step-evidence.
 * Still fixme for ONE reason: no auth-capable isolated stack for platform-admin sign-in; the orphan/gap/deferred rows also need seeded provider evidence in the fake universe.
 * Intended assertions: a gap row shows its last retry; an orphan is listed and resolved/reopened through its confirm form; an owner cannot open the page.
 */
test.describe("TW-4F admin evidence / orphan / recovery (F4)", () => {
  test.beforeEach(() => {
    test.skip(Boolean(tw4fEnvironmentProblem()), tw4fEnvironmentProblem() ?? "");
  });
  test.fixme("a gap row shows its evidence and last retry", { annotation: { type: "fixme", description: TW4F_E2E_BLOCKER } }, async () => {
    /* UI: src/app/platform/sms/Recovery.tsx, ExposureConsolidated.tsx, ProvisioningLedger.tsx (F4, #288) */
  });
  test.fixme("an orphan number can be resolved once and reopened", { annotation: { type: "fixme", description: TW4F_E2E_BLOCKER } }, async () => {
    /* UI: src/app/platform/sms/Recovery.tsx, ExposureConsolidated.tsx, ProvisioningLedger.tsx (F4, #288) */
  });
  test.fixme("recovery shows the unavailable state when the reads switch is off", { annotation: { type: "fixme", description: TW4F_E2E_BLOCKER } }, async () => {
    /* UI: src/app/platform/sms/Recovery.tsx, ExposureConsolidated.tsx, ProvisioningLedger.tsx (F4, #288) */
  });
  test.fixme("a studio owner cannot open the platform page", { annotation: { type: "fixme", description: TW4F_E2E_BLOCKER } }, async () => {
    /* UI: src/app/platform/sms/Recovery.tsx, ExposureConsolidated.tsx, ProvisioningLedger.tsx (F4, #288) */
  });
});
