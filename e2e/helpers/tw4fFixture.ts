import { randomBytes } from "node:crypto";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import type { E2EConfig } from "@/lib/e2e/config";
import { e2eAdminClient } from "./competitionFixture";
import {
  cleanupSmsFixture,
  createSmsFixture,
  openPlatformAdmin,
  ownerSubmitsSetup,
  setPilotAccess,
  type SmsAccount,
  type SmsFixture,
} from "./smsOnboardingFixture";

/**
 * TW-4F Q1: the shared fixture for the TW-4F completion E2E specs (e2e/tests/tw4f-*.spec.ts).
 *
 * It layers on smsOnboardingFixture.ts (not edited): a platform admin (with a TOTP factor), a studio owner and front desk, a SECOND studio with its own
 * owner (tenant isolation), and then, through the real service-role SQL functions only, a legal entity, a $150 spend cap, the published test price list,
 * and the ConfiDance pilot exception ($150 non-spendable ceiling).
 *
 * Safety (all enforced by the callers' environment, restated here so a reader cannot miss it):
 *  - the app under test is a LOCAL dev server pointed at the isolated Supabase stack with TW4_ISV_FAKE=on: the Twilio adapter is an in-process fake,
 *    so no call can reach Twilio, Stripe, an SMS carrier or an email provider; nothing here is fee-bearing;
 *  - the synthetic EIN, names and refs are obviously fake; the pilot-exception legal name is the one the SQL function accepts, and exists only inside the
 *    isolated database;
 *  - the evidence tables have no API privileges, so rows these helpers create are removed by dropping the isolated stack, not by cleanup code.
 *
 * Stable test ids: specs only use data-testid hooks the owning slice has agreed to (see e2e/tests/tw4f-*.spec.ts, which name the owner of each). Until a
 * slice's UI exists its spec stays test.fixme.
 */

export const PILOT_LEGAL_NAME = "ConfiDance Unlimited, LLC";
export const PILOT_CEILING_CENTS = 15_000;

/** Published test prices (customer / provider cents). Synthetic: they exist only in the isolated database. */
export const TEST_PRICES: Record<"brand" | "campaign_vetting" | "number" | "monthly" | "sms_usage", [number, number]> = {
  brand: [1_000, 400],
  campaign_vetting: [1_500, 1_000],
  number: [500, 115],
  monthly: [300, 200],
  sms_usage: [1, 1],
};

export type Tw4fFixture = SmsFixture & {
  /** The legal entity created for studio A (set by seedTw4fEntity). */
  legalEntityId?: string;
  /** Studio B's own entity (set by seedTw4fSecondStudioEntity), for cross-tenant assertions. */
  otherLegalEntityId?: string;
};

export async function createTw4fFixture(config: E2EConfig): Promise<Tw4fFixture> {
  return createSmsFixture(config);
}
export const cleanupTw4fFixture = (config: E2EConfig, fixture: Tw4fFixture | undefined) => cleanupSmsFixture(config, fixture);

/** Whether the local environment is the isolated fake-adapter stack. Specs call this in beforeAll and skip (BLOCKED, never PASS) when it is not. */
export function tw4fEnvironmentProblem(): string | null {
  if (process.env.TW4_ISV_FAKE !== "on" && process.env.E2E_TW4_ISV_FAKE !== "on") {
    return "TW4_ISV_FAKE is not 'on' for the E2E run: the dev server must run with the in-process fake Twilio adapter (see e2e/README.md and scripts/qa/tw4f/README.md)";
  }
  return null;
}

async function rpc<T>(config: E2EConfig, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await e2eAdminClient(config).rpc(fn, args);
  if (error) throw new Error(`TW-4F E2E fixture: ${fn} failed (${error.code ?? "unknown"}): ${error.message}`);
  return data as T;
}

/** Publishes the five test prices (idempotent in effect: each call deactivates the previous price of that kind). */
export async function publishTestPrices(config: E2EConfig, actor: SmsAccount): Promise<void> {
  for (const [kind, [customer, provider]] of Object.entries(TEST_PRICES)) {
    await rpc(config, "tw4_price_set", { p_kind: kind, p_customer_cents: customer, p_provider_cents: provider, p_description: `${kind} (tw4f e2e)`, p_actor: actor.id });
  }
}

export type SeedOptions = {
  /** Create the pilot exception (default true): requires the entity legal name to be the pilot business and the cap to be <= $150. */
  pilotException?: boolean;
  /** Settled prepaid credit in cents (0 = none; the pilot exception then carries the first spend). */
  settledCreditCents?: number;
};

/**
 * Owner submits the setup through the real wizard with the pilot legal name, the platform admin turns the pilot on for studio A, then SQL creates the
 * entity, caps it at $150, publishes prices and (by default) creates the $150 pilot exception. Returns the entity id (also stored on the fixture).
 */
export async function seedTw4fEntity(browser: Browser, config: E2EConfig, fixture: Tw4fFixture, adminPage: Page, opts: SeedOptions = {}): Promise<string> {
  await setPilotAccess(adminPage, fixture.studioA.name, true);
  const ownerContext = await browser.newContext();
  try {
    await ownerSubmitsSetup(await ownerContext.newPage(), fixture.owner, PILOT_LEGAL_NAME);
  } finally {
    await ownerContext.close();
  }
  const actor = fixture.platformAdmin.id;
  const created = await rpc<{ legal_entity_id: string }>(config, "tw4_entity_create_for_studio", { p_studio_id: fixture.studioA.id, p_actor: actor, p_verification_note: "TW-4F E2E: synthetic legal entity" });
  const entity = created.legal_entity_id;
  await rpc(config, "tw4_entity_set_spend_cap", { p_entity_id: entity, p_cents: PILOT_CEILING_CENTS, p_actor: actor });
  await publishTestPrices(config, fixture.platformAdmin);
  if (opts.pilotException !== false) {
    await rpc(config, "tw4_pilot_exception_create", { p_entity_id: entity, p_ceiling_cents: PILOT_CEILING_CENTS, p_approval_ref: `TW-4F E2E pilot ${fixture.runId}`, p_actor: actor });
  }
  if (opts.settledCreditCents) {
    await rpc(config, "tw4_credit_settle_topup", { p_entity_id: entity, p_paid_by_studio_id: fixture.studioA.id, p_provider_ref: `pi_tw4f_${fixture.runId}`, p_amount_cents: opts.settledCreditCents, p_event_id: `evt_tw4f_${fixture.runId}` });
  }
  fixture.legalEntityId = entity;
  return entity;
}

/** Second studio: owner B submits a setup under a distinct, non-pilot legal name and gets its own entity (no pilot exception, no credit). */
export async function seedTw4fSecondStudioEntity(browser: Browser, config: E2EConfig, fixture: Tw4fFixture, adminPage: Page): Promise<string> {
  await setPilotAccess(adminPage, fixture.studioB.name, true);
  const ctx = await browser.newContext();
  try {
    await ownerSubmitsSetup(await ctx.newPage(), fixture.otherOwner, `E2E Second Studio ${fixture.runId} LLC`);
  } finally {
    await ctx.close();
  }
  const created = await rpc<{ legal_entity_id: string }>(config, "tw4_entity_create_for_studio", { p_studio_id: fixture.studioB.id, p_actor: fixture.platformAdmin.id, p_verification_note: "TW-4F E2E: synthetic second legal entity" });
  fixture.otherLegalEntityId = created.legal_entity_id;
  return created.legal_entity_id;
}

/** One signed-in platform admin browser context for a whole spec (platform sign-in needs an authenticator code each time a context is created). */
export async function openTw4fAdmin(browser: Browser, fixture: Tw4fFixture, config: E2EConfig): Promise<{ context: BrowserContext; page: Page }> {
  return openPlatformAdmin(browser, fixture.platformAdmin, config);
}

/** A unique, obviously synthetic suffix for names created inside a spec. */
export const tw4fRun = () => randomBytes(3).toString("hex");
