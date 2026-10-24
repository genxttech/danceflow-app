import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TW-4F AAL2: every state-changing platform-admin action in the SMS panel runs the shared session-assurance guard FIRST, at the classified tier.
 *
 * Three independent checks so that removing or weakening a guard fails at least one of them:
 *  1. completeness: every exported action in the audited files is in REGISTRY (a new, unclassified action fails);
 *  2. source order: the guard is the first statement (or `guarded("<tier>", ...)`), at the registered tier, and the plain role guard is not imported;
 *  3. behaviour: with the guard refusing, the action throws and touches no database client, no provider runtime and no network.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ set: vi.fn(), get: vi.fn() })) }));

const effects = vi.hoisted(() => ({ admin: 0, user: 0, runtime: 0, tiers: [] as string[] }));
vi.mock("@/lib/auth/platform-assurance", () => ({
  requirePlatformStepUp: vi.fn(async (tier: string) => {
    effects.tiers.push(tier);
    throw new Error("STEPUP_REFUSED");
  }),
}));
vi.mock("@/lib/auth/platform", () => ({
  requirePlatformAdmin: vi.fn(async () => {
    throw new Error("ROLE_GUARD_SHOULD_NOT_BE_CALLED_DIRECTLY");
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    effects.admin += 1;
    throw new Error("ADMIN_CLIENT_TOUCHED");
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    effects.user += 1;
    throw new Error("USER_CLIENT_TOUCHED");
  },
}));
vi.mock("@/lib/sms/twilioIsv/factory", async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const trap = (name: string) => () => {
    effects.runtime += 1;
    throw new Error(`RUNTIME_TOUCHED:${name}`);
  };
  return { ...real, buildRunnerRuntime: trap("runner"), buildRunnerStore: trap("store"), buildProvisioningRuntime: trap("prov"), buildNumberRuntime: trap("num") };
});

type Tier = "aal2" | "recent";

/** file -> action -> tier. Classification rationale is in docs/twilio/TW-4F_Platform_Admin_AAL2.md. */
const REGISTRY: Record<string, Record<string, Tier>> = {
  "actions.ts": {
    saveStudioSmsRegistrationAction: "aal2",
    setSmsOnboardingAccessAction: "aal2",
    runSmsOnboardingAction: "recent",
    setSmsRunnerWindowAction: "recent",
  },
  "activationActions.ts": {
    recordActivationSenderAction: "aal2",
    attestOptOutAction: "aal2",
    runComplianceAction: "aal2",
    verifyActivationSenderAction: "aal2",
    markReadyAction: "recent",
    activateAction: "recent",
    suspendAction: "aal2",
  },
  "panelActions.ts": {
    panelCreateEntityAction: "aal2",
    panelDecideLinkAction: "aal2",
    panelSetSpendCapAction: "recent",
    panelAuthorizeFeeAction: "recent",
    panelWithdrawFeeAction: "aal2",
    panelCreatePilotExceptionAction: "recent",
    panelCreateSubaccountAction: "recent",
    panelDecideTierAction: "aal2",
  },
  "provisioningActions.ts": {
    resolveProvisioningOperationAction: "recent",
    recordProviderListingAction: "aal2",
    reopenProvisioningAction: "recent",
  },
  "provisioningRunActions.ts": { runProvisioningStepAction: "recent", runNumberStepAction: "recent" },
  "recoveryActions.ts": { retryRegistrationAction: "recent", retireDeferredAction: "aal2" },
  "recurringFeeActions.ts": {
    rflSetSwitchAction: "recent",
    rflVarianceAckAction: "aal2",
    rflDualRequestAction: "recent",
    rflDualApproveAction: "recent",
    rflDualRejectAction: "aal2",
    rflDisposeExposureAction: "recent",
    rflPilotCoverAction: "recent",
    rflSuspendAction: "aal2",
    rflCancelAuthorizeAction: "recent",
    rflCancelBeginAction: "recent",
    rflCancelFinishAction: "recent",
    rflCancelResolveAction: "recent",
    rflCancelReleaseAction: "recent",
    rflCancelWithdrawAction: "aal2",
  },
  "senderActions.ts": { recordSenderAction: "aal2", verifySenderAction: "aal2", revokeSenderAction: "aal2" },
  "usageReconcileActions.ts": { resolveUsageAttemptAction: "recent" },
};

const dir = join(process.cwd(), "src", "app", "platform", "sms");
const source = (file: string) => readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n");

function exportedActions(src: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /^export async function (\w+)\(/gm;
  const starts: { name: string; at: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) starts.push({ name: m[1], at: m.index });
  starts.forEach((s, i) => out.push({ name: s.name, body: src.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : src.length) }));
  return out;
}

describe("completeness and source order", () => {
  it("every 'use server' file in the SMS panel directory is in the registry (a new actions file cannot slip in unclassified)", () => {
    const useServer = readdirSync(dir)
      .filter((f) => /.tsx?$/.test(f) && !f.endsWith(".d.ts"))
      .filter((f) => /^s*["']use server["'];?/.test(readFileSync(join(dir, f), "utf8")))
      .sort();
    expect(useServer).toEqual(Object.keys(REGISTRY).sort());
  });

  for (const [file, actions] of Object.entries(REGISTRY)) {
    describe(file, () => {
      const src = source(file);
      const found = exportedActions(src);

      it("every exported action is classified, and every classified action exists", () => {
        expect(found.map((f) => f.name).sort()).toEqual(Object.keys(actions).sort());
      });

      it("does not import the role-only guard (the step-up guard is the single entry)", () => {
        expect(src).not.toMatch(/import\s*\{[^}]*requirePlatformAdmin[^}]*\}\s*from\s*"@\/lib\/auth\/platform"/);
        expect(src).toMatch(/from "@\/lib\/auth\/platform-assurance"/);
      });

      for (const { name, body } of found) {
        const tier = actions[name];
        it(`${name} runs the ${tier} guard before any other work`, () => {
          const inner = body.slice(body.indexOf("{", body.indexOf(")")) + 1);
          if (file === "recurringFeeActions.ts") {
            expect(inner.trimStart().startsWith(`await guarded("${tier}", `)).toBe(true);
          } else {
            expect(inner.trimStart().startsWith(`const admin = await requirePlatformStepUp("${tier}");`) || inner.trimStart().startsWith(`await requirePlatformStepUp("${tier}");`)).toBe(true);
          }
        });
      }
    });
  }

  it("the recurring-fee helper passes its tier to the guard before running the work", () => {
    const src = source("recurringFeeActions.ts");
    const helper = src.slice(src.indexOf("async function guarded("), src.indexOf("const ops = "));
    expect(helper).toContain("await requirePlatformStepUp(tier);");
    expect(helper.indexOf("requirePlatformStepUp(tier)")).toBeLessThan(helper.indexOf("await work(admin)"));
  });

  it("the sensitive set is what the design doc says: no recent-tier action is downgraded", () => {
    const recent = Object.values(REGISTRY).flatMap((a) => Object.entries(a).filter(([, t]) => t === "recent").map(([n]) => n));
    expect(recent.sort()).toEqual(
      [
        "runSmsOnboardingAction", "setSmsRunnerWindowAction", "markReadyAction", "activateAction", "panelSetSpendCapAction", "panelAuthorizeFeeAction",
        "panelCreatePilotExceptionAction", "panelCreateSubaccountAction", "resolveProvisioningOperationAction", "reopenProvisioningAction",
        "runProvisioningStepAction", "runNumberStepAction", "retryRegistrationAction", "rflSetSwitchAction", "rflDualRequestAction", "rflDualApproveAction",
        "rflDisposeExposureAction", "rflPilotCoverAction", "rflCancelAuthorizeAction", "rflCancelBeginAction", "rflCancelFinishAction",
        "rflCancelResolveAction", "rflCancelReleaseAction", "resolveUsageAttemptAction",
      ].sort(),
    );
  });
});

describe("behaviour: a refused step-up stops every action before any side effect", () => {
  // the first import of each action module is slow (large dependency graph): load them all once, outside any test timeout
  beforeAll(async () => {
    for (const file of Object.keys(REGISTRY)) await import(`../${file.replace(/.ts$/, "")}`);
  }, 120_000);

  beforeEach(() => {
    effects.admin = 0;
    effects.user = 0;
    effects.runtime = 0;
    effects.tiers.length = 0;
  });

  for (const [file, actions] of Object.entries(REGISTRY)) {
    for (const [name, tier] of Object.entries(actions)) {
      it(`${file} ${name} (${tier})`, async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
          throw new Error("NETWORK_TOUCHED");
        });
        try {
          const mod = (await import(`../${file.replace(/\.ts$/, "")}`)) as Record<string, (f: FormData) => Promise<unknown>>;
          // runtime exports (covers 'export const x = async' and 'export { x }' forms the source scan cannot see)
          expect(Object.keys(mod).sort()).toEqual(Object.keys(actions).sort());
          const form = new FormData();
          form.set("studioId", "00000000-0000-4000-8000-000000000001");
          await expect(mod[name](form)).rejects.toThrow("STEPUP_REFUSED");
          expect(effects.tiers).toEqual([tier]);
          expect(effects.admin).toBe(0);
          expect(effects.user).toBe(0);
          expect(effects.runtime).toBe(0);
          expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
          fetchSpy.mockRestore();
        }
      });
    }
  }
});
