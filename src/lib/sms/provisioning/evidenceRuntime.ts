import "server-only";
import { SubaccountTokenProvider } from "@/lib/sms/twilioIsv/account";
import { fakeAdapterAllowed, loadIsvConfig, provisioningCallsAllowed } from "@/lib/sms/twilioIsv/config";
import { FakeProvisioningHub } from "@/lib/sms/twilioIsv/fakeProvisioning";
import type { IsvProvisioningAdapter } from "@/lib/sms/twilioIsv/provisioningTypes";
import { createRealIsvParent, createScopedProvisioningAdapter } from "@/lib/sms/twilioIsv/real";
import { rotatingSubaccountAdapter } from "@/lib/sms/twilioIsv/rotation";
import { IsvApiError } from "@/lib/sms/twilioIsv/types";

/**
 * TW-4F F4: the provisioning adapter the evidence console reads campaign listings with. SERVER ONLY. The console only ever calls the adapter's GET listing
 * (`checkCampaignAbsence` -> `findCampaigns`); it never creates, cancels or pays for anything.
 *  - non-production + TW4_ISV_FAKE=on + a loopback database -> an in-memory fake (its evidence is `fake`, which the database accepts only on a local QA database);
 *  - production + TW4_ISV_REAL_CALLS=on + TW4_PROVISIONING_REAL_CALLS=on + complete configuration -> a real adapter signed with the subaccount's own credentials;
 *  - anything else (the default everywhere today) -> a refusal with a reason; nothing is constructed and nothing is called.
 */

export type EvidenceRuntime =
  | { ok: true; mode: "fake" | "real"; adapterFor(accountSid: string): Promise<IsvProvisioningAdapter> }
  | { ok: false; reason: string };

const globalForEvidence = globalThis as unknown as { __tw4EvidenceHub?: FakeProvisioningHub; __tw4EvidenceTokens?: SubaccountTokenProvider };

export function buildEvidenceRuntime(env: Record<string, string | undefined> = process.env): EvidenceRuntime {
  if (fakeAdapterAllowed(env)) {
    const hub = (globalForEvidence.__tw4EvidenceHub ??= new FakeProvisioningHub());
    return { ok: true, mode: "fake", adapterFor: async (accountSid) => hub.adapterFor(accountSid) };
  }
  const gate = provisioningCallsAllowed(env);
  if (!gate.allowed) return { ok: false, reason: gate.reason };
  const loaded = loadIsvConfig(env);
  if (!loaded.ok) return { ok: false, reason: `Twilio provisioning is not configured (missing: ${loaded.missing.join(", ")}).` };
  const parent = createRealIsvParent(loaded.config, env);
  const tokens = (globalForEvidence.__tw4EvidenceTokens ??= new SubaccountTokenProvider(parent, { refreshIntervalMs: 0 }));
  return {
    ok: true,
    mode: "real",
    adapterFor: (accountSid) =>
      rotatingSubaccountAdapter(accountSid, tokens, (sid, secret) => {
        try {
          return createScopedProvisioningAdapter(loaded.config, sid, secret.reveal(), env);
        } catch (error) {
          throw error instanceof IsvApiError ? error : new IsvApiError("account", null, null, "subaccount adapter unavailable");
        }
      }),
  };
}
