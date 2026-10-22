import { test } from "@playwright/test";
import { tw4fEnvironmentProblem } from "../helpers/tw4fFixture";

/**
 * TW-4F Q1 / J2 (session tw4f-j2-owner-read): the studio owner's 8-stage texting journey at /app/settings/sms, from journey.ts + ownerRead.ts.
 * FIXME until J2 lands its UI. Requested stable ids (J2 to confirm or rename; Q1 does not edit components):
 *   data-testid="owner-journey" (container), "journey-stage" with data-stage="1..8" and data-state="done|current|upcoming|blocked",
 *   "journey-next-action", "journey-money-line" (what the owner pays and when), "journey-blocked-reason".
 * Expected flow (fake adapter, local only): the owner submits setup, the admin creates the entity, the owner sees the next stage as "waiting on the platform";
 * the owner never sees another studio's journey, provider SIDs, internal ledger rows or admin-only evidence; stages advance only when the SQL state advances.
 */
test.describe("TW-4F owner journey (J2)", () => {
  test.beforeEach(() => {
    test.skip(Boolean(tw4fEnvironmentProblem()), tw4fEnvironmentProblem() ?? "");
  });
  test.fixme("renders eight stages in order with exactly one current stage", async () => {
    /* owner: tw4f-j2-owner-read */
  });
  test.fixme("a front-desk user sees a read-only journey without money lines", async () => {
    /* owner: tw4f-j2-owner-read */
  });
  test.fixme("a second studio's owner sees only their own journey and no provider identifiers", async () => {
    /* owner: tw4f-j2-owner-read */
  });
  test.fixme("a blocked stage shows one plain-language reason and no internal error codes", async () => {
    /* owner: tw4f-j2-owner-read */
  });
});
