import { test } from "@playwright/test";
import { TW4F_E2E_BLOCKER, tw4fEnvironmentProblem } from "../helpers/tw4fFixture";

/**
 * TW-4F Q1 / J2 (#276): the studio owner's texting journey at /app/settings/sms.
 * UI exists on main. Stable ids already present: sms-journey, sms-journey-stages, sms-next-action, sms-next-cta, sms-charges.
 * Still fixme for ONE reason: the isolated stack has no auth service, so owner/front-desk/second-owner sign-in cannot run (see TW4F_E2E_BLOCKER).
 * Intended assertions: stages render in order with one current stage; front desk sees no charges; a second studio's owner sees only their own journey and no provider identifiers;
 * a blocked stage shows one plain-language reason and no internal codes.
 */
test.describe("TW-4F owner journey (J2)", () => {
  test.beforeEach(() => {
    test.skip(Boolean(tw4fEnvironmentProblem()), tw4fEnvironmentProblem() ?? "");
  });
  test.fixme("renders the journey stages in order with exactly one current stage", { annotation: { type: "fixme", description: TW4F_E2E_BLOCKER } }, async () => {
    /* UI: src/app/app/settings/sms/SmsJourney.tsx (J2, #276) */
  });
  test.fixme("a front-desk user sees a read-only journey without charges", { annotation: { type: "fixme", description: TW4F_E2E_BLOCKER } }, async () => {
    /* UI: src/app/app/settings/sms/SmsJourney.tsx (J2, #276) */
  });
  test.fixme("a second studio's owner sees only their own journey and no provider identifiers", { annotation: { type: "fixme", description: TW4F_E2E_BLOCKER } }, async () => {
    /* UI: src/app/app/settings/sms/SmsJourney.tsx (J2, #276) */
  });
  test.fixme("a blocked stage shows one plain-language reason and no internal error codes", { annotation: { type: "fixme", description: TW4F_E2E_BLOCKER } }, async () => {
    /* UI: src/app/app/settings/sms/SmsJourney.tsx (J2, #276) */
  });
});
