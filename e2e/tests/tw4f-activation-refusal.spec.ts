import { test } from "@playwright/test";
import { tw4fEnvironmentProblem } from "../helpers/tw4fFixture";

/**
 * TW-4F Q1 / F1 + F3 (sessions tw4f-f1-funding, tw4f-f3-recon-gate): activation (SMS switch / sending) is REFUSED without a passing usage reconciler and
 * without compliance (tw4_usage_begin, tw4_usage_set_switch, _tw4usage_reconciler_ready, _tw4act_* / tw4_act_*). FIXME until the admin surfaces exist.
 * Requested ids: data-testid="activation-switch" (data-state), "activation-enable" (button), "activation-refusal" (data-reason="reconciler|compliance|funding|approval"),
 * "activation-checklist-item" (data-key, data-ok).
 * Expected: with the reconciler not ready the switch stays OFF and the refusal names the reconciler; with compliance incomplete it names compliance; with both
 * satisfied it still needs the recorded owner approval; nothing sends an SMS (fake adapter, no carrier).
 */
test.describe("TW-4F activation refusal (F1/F3)", () => {
  test.beforeEach(() => {
    test.skip(Boolean(tw4fEnvironmentProblem()), tw4fEnvironmentProblem() ?? "");
  });
  test.fixme("enabling is refused while the usage reconciler is not ready", async () => {
    /* owner: tw4f-f3-recon-gate */
  });
  test.fixme("enabling is refused while compliance evidence is incomplete", async () => {
    /* owner: tw4f-f1-funding */
  });
  test.fixme("enabling is refused without the recorded approval even when both checks pass", async () => {
    /* owner: tw4f-f1-funding */
  });
});
