import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { SubaccountTokenProvider } from "@/lib/sms/twilioIsv/account";
import { fakeAdapterAllowed, loadIsvConfig, numberReadsAllowed } from "@/lib/sms/twilioIsv/config";
import { buildNumberRuntime } from "@/lib/sms/twilioIsv/factory";
import { SupabaseNumberStore } from "@/lib/sms/twilioIsv/numberStore";
import { createRealIsvParent, createScopedNumberReadAdapter } from "@/lib/sms/twilioIsv/real";
import { rotatingSubaccountAdapter } from "@/lib/sms/twilioIsv/rotation";
import { IsvApiError } from "@/lib/sms/twilioIsv/types";
import type { NumberReadRuntime } from "./run";

/**
 * TW-4F A9: the runtime the scheduled inventory route lists with. Never the purchase runtime:
 *  - non-production + TW4_ISV_FAKE=on + a loopback database -> the local fake (its evidence is `fake`, accepted only on a local QA database);
 *  - production + TW4_ISV_REAL_CALLS=on + TW4_NUMBER_READS=on + complete configuration -> the LIST-ONLY real adapter (real.ts RealNumberReadAdapter), signed with
 *    each subaccount's own token; TW4_NUMBER_REAL_CALLS (purchases) is neither required nor consulted;
 *  - anything else -> a refusal; nothing is constructed and nothing is called.
 */

type ReadFetch = Parameters<typeof createScopedNumberReadAdapter>[4];

const globalForReads = globalThis as unknown as { __tw4NumberReadTokens?: SubaccountTokenProvider };

export function buildNumberReadRuntime(env: Record<string, string | undefined> = process.env, fetchImpl?: ReadFetch): NumberReadRuntime {
  if (fakeAdapterAllowed(env)) {
    const fake = buildNumberRuntime(env);
    return fake.ok ? { ok: true, store: fake.store, adapterFor: fake.adapterFor } : { ok: false, reason: fake.reason };
  }
  const gate = numberReadsAllowed(env);
  if (!gate.allowed) return { ok: false, reason: gate.reason };
  const loaded = loadIsvConfig(env);
  if (!loaded.ok) return { ok: false, reason: `Twilio registration is not configured (missing: ${loaded.missing.join(", ")}).` };
  const parent = createRealIsvParent(loaded.config, env);
  const tokens = (globalForReads.__tw4NumberReadTokens ??= new SubaccountTokenProvider(parent, { refreshIntervalMs: 0 }));
  return {
    ok: true,
    store: new SupabaseNumberStore(createAdminClient()),
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
