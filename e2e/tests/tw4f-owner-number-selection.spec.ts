import { test } from "@playwright/test";
import { TW4F_E2E_BLOCKER, tw4fEnvironmentProblem } from "../helpers/tw4fFixture";

/**
 * TW-4F Q1 / J3: owner number selection (NumberSelection.tsx, migration 20261227).
 * UI exists on main. Stable ids present: sms-number-selection, sms-number-form, sms-number-option, sms-number-approve, sms-number-confirm, sms-number-result,
 * sms-number-waiting, sms-number-blocked, sms-number-error, sms-number-withdraw, sms-number-approved.
 * Still fixme for ONE reason: no auth-capable isolated stack for owner sign-in, and the offers need a seeded active subaccount in the fake universe (fixture addition once sign-in works).
 * Intended assertions: the owner picks exactly one offered fake number after the fee disclosure; a double click selects once; withdraw works before approval; an owner without an active subaccount sees the blocked state.
 */
test.describe("TW-4F owner number selection (J3)", () => {
  test.beforeEach(() => {
    test.skip(Boolean(tw4fEnvironmentProblem()), tw4fEnvironmentProblem() ?? "");
  });
  test.fixme("owner selects one offered fake number after the fee disclosure", { annotation: { type: "fixme", description: TW4F_E2E_BLOCKER } }, async () => {
    /* UI: src/app/app/settings/sms/NumberSelection.tsx (J3) */
  });
  test.fixme("a double click on approve selects once", { annotation: { type: "fixme", description: TW4F_E2E_BLOCKER } }, async () => {
    /* UI: src/app/app/settings/sms/NumberSelection.tsx (J3) */
  });
  test.fixme("an owner can withdraw a selection before it is approved", { annotation: { type: "fixme", description: TW4F_E2E_BLOCKER } }, async () => {
    /* UI: src/app/app/settings/sms/NumberSelection.tsx (J3) */
  });
  test.fixme("an owner without an active subaccount sees the blocked state", { annotation: { type: "fixme", description: TW4F_E2E_BLOCKER } }, async () => {
    /* UI: src/app/app/settings/sms/NumberSelection.tsx (J3) */
  });
});
