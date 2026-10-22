import { test } from "@playwright/test";
import { tw4fEnvironmentProblem } from "../helpers/tw4fFixture";

/**
 * TW-4F Q1 / J3 (later; owner not assigned yet, route via the coordinator "DanceFlow TW-4F completion audit"): owner number selection.
 * FIXME: no UI exists. Requested ids: data-testid="number-search-area-code", "number-candidate" (data-e164 masked), "number-select", "number-selection-confirmation".
 * Expected: search uses the FAKE number inventory only (TW4_ISV_FAKE), the owner may select exactly one number, the monthly fee is disclosed before
 * confirmation, a repeat click selects once, and a studio with no active subaccount cannot reach the search.
 */
test.describe("TW-4F owner number selection (J3)", () => {
  test.beforeEach(() => {
    test.skip(Boolean(tw4fEnvironmentProblem()), tw4fEnvironmentProblem() ?? "");
  });
  test.fixme("owner searches an area code and selects one fake number after the fee disclosure", async () => {
    /* owner: J3 (unassigned) */
  });
  test.fixme("a double click on Select reserves the number once", async () => {
    /* owner: J3 (unassigned) */
  });
  test.fixme("an owner without an active subaccount cannot search", async () => {
    /* owner: J3 (unassigned) */
  });
});
