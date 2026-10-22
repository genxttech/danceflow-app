import { test } from "@playwright/test";
import { tw4fEnvironmentProblem } from "../helpers/tw4fFixture";

/**
 * TW-4F Q1 / F4 (session tw4f-f4-recovery): admin evidence, orphan and recovery views (ProvisioningLedger.tsx / provisioningActions.ts).
 * FIXME until F4 lands. Requested ids: data-testid="prov-ledger", "prov-ledger-row" (data-step), "prov-evidence", "prov-orphan" (data-sid masked),
 * "prov-recover" (button), "prov-recover-confirm", "prov-recover-result" (data-outcome), "prov-ledger-fee" (money shown in formatted dollars).
 * Expected: an ambiguous provider outcome shows its evidence and offers recovery only after confirmation; an orphan number is listed read-only until adopted;
 * recovery never spends beyond the approved ceiling; a studio owner is redirected away from the page.
 */
test.describe("TW-4F admin evidence / orphan / recovery (F4)", () => {
  test.beforeEach(() => {
    test.skip(Boolean(tw4fEnvironmentProblem()), tw4fEnvironmentProblem() ?? "");
  });
  test.fixme("an ambiguous step shows its evidence and a confirm-gated Recover action", async () => {
    /* owner: tw4f-f4-recovery */
  });
  test.fixme("an orphan number is listed and can be adopted once", async () => {
    /* owner: tw4f-f4-recovery */
  });
  test.fixme("recovery is refused when it would exceed the approved ceiling", async () => {
    /* owner: tw4f-f4-recovery */
  });
  test.fixme("a studio owner cannot open the ledger page", async () => {
    /* owner: tw4f-f4-recovery */
  });
});
