import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { SubaccountTokenProvider } from "./account";
import { fakeAdapterAllowed, loadIsvConfig, realCallsAllowed, type IsvConfig } from "./config";
import { SupabaseEntityStore, type EntityStore } from "./entityStore";
import { FakeIsvParent } from "./fake";
import { createRealIsvParent, createScopedRealAdapter } from "./real";
import { rotatingSubaccountAdapter } from "./rotation";
import { SupabaseRunnerStore } from "./store";
import { IsvApiError, type IsvAdapter, type IsvParentAdapter } from "./types";

/**
 * TW-4 R1 / TW-4F-3a: builds the account-scoped adapters and the stores for a platform-admin action. SERVER ONLY.
 *  - production + TW4_ISV_REAL_CALLS=on + complete configuration -> the real parent client and real per-subaccount adapters;
 *  - non-production + TW4_ISV_FAKE=on (local database only) -> an in-memory fake parent with one fake adapter per account;
 *  - anything else -> a refusal with a reason; nothing is constructed and nothing is called.
 *
 * There is NO adapter for the parent account: registration calls are only ever built through `adapterFor(subaccountSid)`, which signs with that
 * subaccount's own credentials (fetched from the parent at call time, kept in memory only, see SubaccountTokenProvider).
 */

export type RunnerRuntime =
  | {
      ok: true;
      parent: IsvParentAdapter;
      /** The registration adapter for ONE subaccount. The caller has already read that SID from the database for the studio's legal entity. */
      adapterFor(accountSid: string): Promise<IsvAdapter>;
      config: IsvConfig;
      store: SupabaseRunnerStore;
      entities: EntityStore;
      mode: "real" | "fake";
    }
  | { ok: false; reason: string };

const FAKE_PRIMARY = `BU${"f".repeat(32)}`;
const FAKE_PRIMARY_POLICY = `RN${"f".repeat(32)}`;
const globalForFake = globalThis as unknown as { __tw4FakeIsvParent?: FakeIsvParent };
const globalForTokens = globalThis as unknown as { __tw4TokenProvider?: SubaccountTokenProvider };

/** The service-role runner store (the 4A tables have no API privileges; everything goes through the tw4_runner_* functions). */
export function buildRunnerStore(): SupabaseRunnerStore {
  return new SupabaseRunnerStore(createAdminClient());
}

export function buildRunnerRuntime(env: Record<string, string | undefined> = process.env): RunnerRuntime {
  if (fakeAdapterAllowed(env)) {
    const parent = (globalForFake.__tw4FakeIsvParent ??= new FakeIsvParent(FAKE_PRIMARY, { primaryPolicySid: FAKE_PRIMARY_POLICY }));
    const config: IsvConfig = {
      accountSid: `AC${"0".repeat(32)}`, authToken: "fake", primaryProfileSid: FAKE_PRIMARY, primaryProfilePolicySid: FAKE_PRIMARY_POLICY, secondaryProfilePolicySid: `RN${"0".repeat(32)}`, a2pPolicySid: `RN${"0".repeat(32)}`,
      complianceEmail: "sms-compliance@fake.invalid", envName: "development", mockBrand: false,
    };
    const admin = createAdminClient();
    return { ok: true, parent, adapterFor: async (accountSid) => parent.adapterFor(accountSid), config, store: new SupabaseRunnerStore(admin), entities: new SupabaseEntityStore(admin), mode: "fake" };
  }
  const gate = realCallsAllowed(env);
  if (!gate.allowed) return { ok: false, reason: gate.reason };
  const loaded = loadIsvConfig(env);
  if (!loaded.ok) return { ok: false, reason: `Twilio registration is not configured (missing: ${loaded.missing.join(", ")}).` };
  const parent = createRealIsvParent(loaded.config, env);
  const tokens = (globalForTokens.__tw4TokenProvider ??= new SubaccountTokenProvider(parent));
  const admin = createAdminClient();
  return {
    ok: true,
    parent,
    // TW-4F provider integration: a 401 after a token rotation re-reads the subaccount token once and repeats that request (see rotation.ts)
    adapterFor: (accountSid) =>
      rotatingSubaccountAdapter(accountSid, tokens, (sid, secret) => {
        try {
          return createScopedRealAdapter(loaded.config, sid, secret.reveal(), env);
        } catch (error) {
          throw error instanceof IsvApiError ? error : new IsvApiError("account", null, null, "subaccount adapter unavailable");
        }
      }),
    config: loaded.config,
    store: new SupabaseRunnerStore(admin),
    entities: new SupabaseEntityStore(admin),
    mode: "real",
  };
}
