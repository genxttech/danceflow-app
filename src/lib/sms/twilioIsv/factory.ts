import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { SubaccountTokenProvider } from "./account";
import { expectedInboundUrl } from "@/lib/sms/senderVerification";
import { fakeAdapterAllowed, loadIsvConfig, numberCallsAllowed, provisioningCallsAllowed, realCallsAllowed, type IsvConfig, type RealCallsGate } from "./config";
import { SupabaseEntityStore, type EntityStore } from "./entityStore";
import { FakeIsvParent } from "./fake";
import { FakeNumberHub, type FakeNumberAdapter } from "./fakeNumbers";
import { FakeProvisioningHub } from "./fakeProvisioning";
import { SupabaseNumberStore } from "./numberStore";
import type { IsvNumberAdapter } from "./numberTypes";
import type { IsvProvisioningAdapter } from "./provisioningTypes";
import { SupabaseProvisionStore } from "./provisionStore";
import { createRealIsvParent, createScopedNumberAdapter, createScopedProvisioningAdapter, createScopedRealAdapter } from "./real";
import { rotatingSubaccountAdapter } from "./rotation";
import { SupabaseRunnerStore } from "./store";
import { IsvApiError, type IsvAdapter, type IsvEnvName, type IsvParentAdapter } from "./types";

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
  const tokens = (globalForTokens.__tw4TokenProvider ??= new SubaccountTokenProvider(parent, { refreshIntervalMs: 0 }));
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

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// TW-4F J1: the R2a provisioning and R2b number adapters for a platform-admin action, under the SAME rules as the registration runtime above:
//  - real: production deployment + production build + TW4_ISV_REAL_CALLS=on + TW4_PROVISIONING_REAL_CALLS=on (+ TW4_NUMBER_REAL_CALLS=on for numbers, see
//    config.ts) + complete configuration. Each adapter is scoped to ONE subaccount and signed with that subaccount's own credentials (rotation-safe);
//  - fake: non-production + TW4_ISV_FAKE=on + a loopback database, in-memory and shared within the process;
//  - anything else: a refusal with a reason; nothing is constructed and nothing is called.
// The fee gates (published price, approval, spend cap, pilot ceiling) are not here: they stay in the runners and the database.
// ---------------------------------------------------------------------------------------------------------------------------------------------------

type Env = Record<string, string | undefined>;
type ScopedRuntimeBase = { entities: EntityStore; envName: IsvEnvName; mode: "real" | "fake" };

export type ProvisioningRuntime =
  | (ScopedRuntimeBase & {
      ok: true;
      /** The provisioning adapter for ONE subaccount; the caller has already read that SID from the database for the studio's legal entity. */
      adapterFor(accountSid: string): Promise<IsvProvisioningAdapter>;
      store: SupabaseProvisionStore;
      /** DanceFlow's inbound route the Messaging Service must point at; null = not configured (the runner then calls nothing). */
      inboundUrl: string | null;
      /** Public origin of the campaign package links (opt-in, Terms, Privacy). */
      origin: string;
    })
  | { ok: false; reason: string };

export type NumberRuntime =
  | (ScopedRuntimeBase & {
      ok: true;
      /** The number adapter for ONE subaccount; the caller has already read that SID from the database for the studio's legal entity. */
      adapterFor(accountSid: string): Promise<IsvNumberAdapter>;
      store: SupabaseNumberStore;
    })
  | { ok: false; reason: string };

const globalForFakeScoped = globalThis as unknown as { __tw4FakeProvisioningHub?: FakeProvisioningHub; __tw4FakeNumberHub?: FakeNumberHub };

/** Fictional 555-01xx numbers the fake search offers on a local database (nothing can be bought for real in fake mode). */
export const FAKE_NUMBER_CATALOGUE = ["+12025550140", "+12025550141", "+12025550142", "+13125550143", "+13125550144"] as const;

/** The process-wide fake provisioning provider (local QA seam: a test or a local operator decides a fake campaign). Null outside fake mode. */
export function fakeProvisioningHub(env: Env = process.env): FakeProvisioningHub | null {
  if (!fakeAdapterAllowed(env)) return null;
  return (globalForFakeScoped.__tw4FakeProvisioningHub ??= new FakeProvisioningHub());
}

/** The process-wide fake number provider (one shared universe with a seeded catalogue). Null outside fake mode. */
export function fakeNumberHub(env: Env = process.env): FakeNumberHub | null {
  if (!fakeAdapterAllowed(env)) return null;
  if (!globalForFakeScoped.__tw4FakeNumberHub) {
    const hub = new FakeNumberHub();
    const seeder = hub.adapterFor(`AC${"0".repeat(32)}`);
    for (const e164 of FAKE_NUMBER_CATALOGUE) seeder.seedAvailable(e164, { locality: "Fakeville", region: "FK" });
    globalForFakeScoped.__tw4FakeNumberHub = hub;
  }
  return globalForFakeScoped.__tw4FakeNumberHub;
}

/**
 * In ONE fake account the Messaging Service and campaign live in the provisioning fake, while the number fake keeps its own copy of their facts. Copy them
 * across before every number action so a combined fake run sees one provider state (Twilio is one system; the fakes are two). Number attachments stay put.
 * The provisioning fake is the source of truth: a service or campaign fact changed directly in the number fake is overwritten here (tamper the provisioning fake).
 */
function syncFakeAccount(number: FakeNumberAdapter, env: Env): FakeNumberAdapter {
  const provisioning = fakeProvisioningHub(env)?.adapterFor(number.accountSid);
  if (!provisioning) return number;
  for (const service of provisioning.services.values()) {
    const known = number.services.get(service.sid);
    if (known) Object.assign(known, { inbound_request_url: service.inbound_request_url, use_inbound_webhook_on_number: service.use_inbound_webhook_on_number });
    else number.registerService(service.sid, { inbound_request_url: service.inbound_request_url, use_inbound_webhook_on_number: service.use_inbound_webhook_on_number });
  }
  for (const campaign of provisioning.campaigns.values()) {
    const facts = { messaging_service_sid: campaign.messaging_service_sid, campaign_status: campaign.campaign_status, mock: campaign.mock };
    const known = number.campaigns.get(campaign.sid);
    if (known) Object.assign(known, facts);
    else number.registerCampaign(campaign.sid, facts);
  }
  return number;
}

/** The inbound route and package origin. A real run needs an https app origin (else the runner calls nothing); the fake falls back to a reserved, unroutable https name. */
function provisioningRoutes(env: Env, mode: "real" | "fake"): { inboundUrl: string | null; origin: string } {
  const configured = expectedInboundUrl(env);
  const https = configured && configured.startsWith("https://") ? configured : null;
  if (mode === "fake" && !https) return { inboundUrl: "https://danceflow-local.invalid/api/sms/twilio/inbound", origin: "https://danceflow-local.invalid" };
  // no https origin: the inbound URL is null, so the runner refuses (config_missing) before any call and the empty origin is never used
  return { inboundUrl: https, origin: https ? https.slice(0, -"/api/sms/twilio/inbound".length) : "" };
}

/**
 * The real, rotation-safe, subaccount-scoped construction shared by both builders. Reached only once the matching real-call gate allowed it. Any further
 * subaccount-scoped adapter (e.g. a provider-release adapter) is built the same way: its own gate from config.ts plus its own scoped constructor from real.ts.
 */
function realScoped<T extends { readonly accountSid: string }>(
  env: Env,
  gate: RealCallsGate,
  build: (config: IsvConfig, accountSid: string, authToken: string) => T,
): { ok: true; config: IsvConfig; adapterFor(accountSid: string): Promise<T> } | { ok: false; reason: string } {
  if (!gate.allowed) return { ok: false, reason: gate.reason };
  const loaded = loadIsvConfig(env);
  if (!loaded.ok) return { ok: false, reason: `Twilio registration is not configured (missing: ${loaded.missing.join(", ")}).` };
  const parent = createRealIsvParent(loaded.config, env);
  const tokens = (globalForTokens.__tw4TokenProvider ??= new SubaccountTokenProvider(parent, { refreshIntervalMs: 0 }));
  return {
    ok: true,
    config: loaded.config,
    adapterFor: (accountSid) =>
      rotatingSubaccountAdapter(accountSid, tokens, (sid, secret) => {
        try {
          return build(loaded.config, sid, secret.reveal());
        } catch (error) {
          throw error instanceof IsvApiError ? error : new IsvApiError("account", null, null, "subaccount adapter unavailable");
        }
      }),
  };
}

/**
 * Both subaccount-scoped adapters for ONE account, each under its own gate (null for a kind whose gate is off; a construction failure is a null too).
 * The extension point for provider release (TW-4F F5): the same real classes carry the release methods, so this is what a release runner's
 * `adaptersFor` / `realAdaptersFor` takes; in fake mode it hands out the same process-wide fakes that provisioned the resources.
 */
export function buildSubaccountAdaptersFor(env: Env = process.env): (accountSid: string) => Promise<{ numbers: IsvNumberAdapter | null; provisioning: IsvProvisioningAdapter | null }> {
  const provisioning = buildProvisioningRuntime(env);
  const numbers = buildNumberRuntime(env);
  const safely = async <T>(build: () => Promise<T>): Promise<T | null> => {
    try {
      return await build();
    } catch {
      return null;
    }
  };
  return async (accountSid) => ({
    numbers: numbers.ok ? await safely(() => numbers.adapterFor(accountSid)) : null,
    provisioning: provisioning.ok ? await safely(() => provisioning.adapterFor(accountSid)) : null,
  });
}

/** R2a: Messaging Service and campaign. Real needs provisioningCallsAllowed(); the fake needs fakeAdapterAllowed(). */
export function buildProvisioningRuntime(env: Env = process.env): ProvisioningRuntime {
  if (fakeAdapterAllowed(env)) {
    const hub = fakeProvisioningHub(env)!;
    const admin = createAdminClient();
    return { ok: true, mode: "fake", envName: "development", adapterFor: async (accountSid) => hub.adapterFor(accountSid), store: new SupabaseProvisionStore(admin), entities: new SupabaseEntityStore(admin), ...provisioningRoutes(env, "fake") };
  }
  const real = realScoped(env, provisioningCallsAllowed(env), (config, sid, token) => createScopedProvisioningAdapter(config, sid, token, env));
  if (!real.ok) return real;
  const admin = createAdminClient();
  return { ok: true, mode: "real", envName: real.config.envName, adapterFor: real.adapterFor, store: new SupabaseProvisionStore(admin), entities: new SupabaseEntityStore(admin), ...provisioningRoutes(env, "real") };
}

/** R2b: number search, purchase, attachment. Real needs numberCallsAllowed() (the provisioning gate plus TW4_NUMBER_REAL_CALLS=on); the fake needs fakeAdapterAllowed(). */
export function buildNumberRuntime(env: Env = process.env): NumberRuntime {
  if (fakeAdapterAllowed(env)) {
    const hub = fakeNumberHub(env)!;
    const admin = createAdminClient();
    return { ok: true, mode: "fake", envName: "development", adapterFor: async (accountSid) => syncFakeAccount(hub.adapterFor(accountSid), env), store: new SupabaseNumberStore(admin), entities: new SupabaseEntityStore(admin) };
  }
  const real = realScoped(env, numberCallsAllowed(env), (config, sid, token) => createScopedNumberAdapter(config, sid, token, env));
  if (!real.ok) return real;
  const admin = createAdminClient();
  return { ok: true, mode: "real", envName: real.config.envName, adapterFor: real.adapterFor, store: new SupabaseNumberStore(admin), entities: new SupabaseEntityStore(admin) };
}
