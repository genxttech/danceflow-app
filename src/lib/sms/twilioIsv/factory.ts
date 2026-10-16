import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fakeAdapterAllowed, loadIsvConfig, realCallsAllowed, type IsvConfig } from "./config";
import { FakeIsvAdapter } from "./fake";
import { createRealIsvAdapter } from "./real";
import { SupabaseRunnerStore } from "./store";
import type { IsvAdapter } from "./types";

/**
 * TW-4 R1: builds the adapter and store for a platform-admin action. SERVER ONLY.
 *  - production + TW4_ISV_REAL_CALLS=on + complete configuration -> the real adapter;
 *  - non-production + TW4_ISV_FAKE=on -> an in-memory fake (state lives in the server process; for demos and local QA);
 *  - anything else -> a refusal with a reason; nothing is constructed and nothing is called.
 */

export type RunnerRuntime = { ok: true; adapter: IsvAdapter; config: IsvConfig; store: SupabaseRunnerStore; mode: "real" | "fake" } | { ok: false; reason: string };

const FAKE_PRIMARY = `BU${"f".repeat(32)}`;
const FAKE_PRIMARY_POLICY = `RN${"f".repeat(32)}`;
const globalForFake = globalThis as unknown as { __tw4FakeIsvAdapter?: FakeIsvAdapter };

/** The service-role runner store (the 4A tables have no API privileges; everything goes through the tw4_runner_* functions). */
export function buildRunnerStore(): SupabaseRunnerStore {
  return new SupabaseRunnerStore(createAdminClient());
}

export function buildRunnerRuntime(env: Record<string, string | undefined> = process.env): RunnerRuntime {
  if (fakeAdapterAllowed(env)) {
    const adapter = (globalForFake.__tw4FakeIsvAdapter ??= new FakeIsvAdapter(FAKE_PRIMARY, { primaryPolicySid: FAKE_PRIMARY_POLICY }));
    const config: IsvConfig = {
      accountSid: `AC${"0".repeat(32)}`, authToken: "fake", primaryProfileSid: FAKE_PRIMARY, primaryProfilePolicySid: FAKE_PRIMARY_POLICY, secondaryProfilePolicySid: `RN${"0".repeat(32)}`, a2pPolicySid: `RN${"0".repeat(32)}`,
      complianceEmail: "sms-compliance@fake.invalid", envName: "development", mockBrand: false,
    };
    return { ok: true, adapter, config, store: new SupabaseRunnerStore(createAdminClient()), mode: "fake" };
  }
  const gate = realCallsAllowed(env);
  if (!gate.allowed) return { ok: false, reason: gate.reason };
  const loaded = loadIsvConfig(env);
  if (!loaded.ok) return { ok: false, reason: `Twilio registration is not configured (missing: ${loaded.missing.join(", ")}).` };
  return { ok: true, adapter: createRealIsvAdapter(loaded.config, env), config: loaded.config, store: new SupabaseRunnerStore(createAdminClient()), mode: "real" };
}
