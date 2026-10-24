import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { SubaccountTokenProvider } from "@/lib/sms/twilioIsv/account";
import { fakeAdapterAllowed, loadIsvConfig, numberReadsAllowed } from "@/lib/sms/twilioIsv/config";
import { buildNumberRuntime } from "@/lib/sms/twilioIsv/factory";
import { SupabaseNumberStore } from "@/lib/sms/twilioIsv/numberStore";
import type { IsvNumberAdapter } from "@/lib/sms/twilioIsv/numberTypes";
import { createRealIsvParent, createScopedNumberReadAdapter } from "@/lib/sms/twilioIsv/real";
import { rotatingSubaccountAdapter } from "@/lib/sms/twilioIsv/rotation";
import { IsvApiError } from "@/lib/sms/twilioIsv/types";
import type { NumberReadRuntime } from "./run";

/**
 * TW-4F A9 / A9b: the READ-ONLY number adapter for one subaccount, used by the scheduled inventory route (listings) and by activation's compliance validation
 * (activation.ts runComplianceValidation: campaign compliance + service route). In production never the purchase runtime:
 *  - non-production + TW4_ISV_FAKE=on + a loopback database -> the local fake (its evidence is `fake`, accepted only on a local QA database; it is the full fake
 *    adapter, and both callers only read);
 *  - production + TW4_ISV_REAL_CALLS=on + TW4_NUMBER_READS=on + complete configuration -> the READ-ONLY real adapter (real.ts RealNumberReadAdapter: three GETs,
 *    every write refused), signed with each subaccount's own token; TW4_NUMBER_REAL_CALLS (purchases) is neither required nor consulted;
 *  - anything else -> a refusal; nothing is constructed and nothing is called.
 */

type ReadFetch = Parameters<typeof createScopedNumberReadAdapter>[4];

export type NumberReader =
  | { ok: true; mode: "fake" | "real"; adapterFor(accountSid: string): Promise<IsvNumberAdapter> }
  | { ok: false; reason: string };

const globalForReads = globalThis as unknown as { __tw4NumberReadTokens?: SubaccountTokenProvider };

/** The read-only number reader. Activation's compliance path passes its adapter to runComplianceValidation; nothing it returns can purchase, attach or release. */
export function buildNumberReader(env: Record<string, string | undefined> = process.env, fetchImpl?: ReadFetch): NumberReader {
  if (fakeAdapterAllowed(env)) {
    const fake = buildNumberRuntime(env);
    return fake.ok ? { ok: true, mode: "fake", adapterFor: fake.adapterFor } : { ok: false, reason: fake.reason };
  }
  const gate = numberReadsAllowed(env);
  if (!gate.allowed) return { ok: false, reason: gate.reason };
  const loaded = loadIsvConfig(env);
  if (!loaded.ok) return { ok: false, reason: `Twilio registration is not configured (missing: ${loaded.missing.join(", ")}).` };
  const parent = createRealIsvParent(loaded.config, env);
  const tokens = (globalForReads.__tw4NumberReadTokens ??= new SubaccountTokenProvider(parent, { refreshIntervalMs: 0 }));
  return {
    ok: true,
    mode: "real",
    adapterFor: (accountSid) =>
      rotatingSubaccountAdapter(accountSid, tokens, (sid, secret) => {
        try {
          return createScopedNumberReadAdapter(loaded.config, sid, secret.reveal(), env, fetchImpl);
        } catch (error) {
          throw error instanceof IsvApiError ? error : new IsvApiError("account", null, null, "subaccount adapter unavailable");
        }
      }),
  };
}

/** The scheduled inventory route's runtime: the reader plus the number store the reconciliation records through. */
export function buildNumberReadRuntime(env: Record<string, string | undefined> = process.env, fetchImpl?: ReadFetch): NumberReadRuntime {
  if (fakeAdapterAllowed(env)) {
    const fake = buildNumberRuntime(env);
    return fake.ok ? { ok: true, store: fake.store, adapterFor: fake.adapterFor } : { ok: false, reason: fake.reason };
  }
  const reader = buildNumberReader(env, fetchImpl);
  if (!reader.ok) return reader;
  return { ok: true, store: new SupabaseNumberStore(createAdminClient()), adapterFor: reader.adapterFor };
}
