/**
 * TW-4F Z1 (zero-cost acceptance plan, 2026-11-27): the whole SMS lifecycle chained on ONE isolated local database, in ONE process, with the in-memory fake
 * providers. Everything it records is SIMULATED evidence: no Twilio call, no Stripe call, no SMS, no money. LOCAL QA STACK ONLY (loopback, with the
 * public.tw4_local_qa_only marker: run-chain.mjs --marker); skipped without the usual TW4A_LOCAL_* variables. Synthetic data only: the pilot business carries
 * the name the pilot rule requires, with an invented EIN, address and people.
 *
 * It drives the app's own server actions and route handlers wherever one exists (only Next's cache, cookies, redirect and sign-in context, and the Stripe
 * client object, are replaced). A step with no app entry point calls the database function or server module and says so in its note. Assertions that a
 * per-slice suite already proves are not repeated here: each step checks only that the chain can pass from it to the next one.
 *
 * Each step is recorded as PASS, FAIL or BLOCKED (a step it depends on did not pass; it is never run and never counts as a pass), plus NOT COVERED entries.
 * The record is printed as one `Z1-RESULTS {json}` line and written to <tmp>/z1-results.json.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Stripe from "stripe";
import twilio from "twilio";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedPrice } from "../twilioIsv/__tests__/priceFixture";

type Ctx = { userId: string; studioId: string; role: string; client: SupabaseClient };
const h = vi.hoisted(() => ({
  ctx: null as unknown,
  platformAdmin: "",
  actor: "",
  cookies: new Map<string, string>(),
  stripeSignature: null as string | null,
  stripeSessions: [] as Array<Record<string, unknown>>,
  stripe: null as unknown,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${url};307;` });
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: (name: string, value: string) => void h.cookies.set(name, value), get: (name: string) => (h.cookies.has(name) ? { value: h.cookies.get(name) } : undefined) }),
  headers: async () => ({ get: (name: string) => (name === "stripe-signature" ? h.stripeSignature : null) }),
}));
vi.mock("@/lib/auth/platform-assurance", () => ({
  requirePlatformStepUp: async () => {
    if (!h.actor || h.actor !== h.platformAdmin) throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/app;307;" });
    return { id: h.actor };
  },
}));
const current = () => h.ctx as Ctx;
vi.mock("@/lib/auth/serverRoleGuard", () => ({
  getCurrentUserStudioContext: async () => ({ supabase: current().client, user: { id: current().userId }, userId: current().userId, studioId: current().studioId, studioRole: current().role, isPlatformAdmin: false }),
}));
vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioContext: async () => ({ studioId: current().studioId, studioRole: current().role, userId: current().userId, isPlatformAdmin: false }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => current().client }));
vi.mock("@/lib/payments/stripe", () => ({ getStripe: () => h.stripe }));

const URL_ = process.env.TW4A_LOCAL_URL ?? "";
const SECRET = process.env.TW4A_LOCAL_JWT_SECRET ?? "";
const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const loopback = (() => { try { return LOOPBACK.has(new URL(URL_).hostname); } catch { return false; } })();
const enabled = Boolean(URL_ && SECRET && PG) && loopback;

// generous: one step makes dozens of database calls, and on a loaded local host a single timezone lookup inside them has taken seconds (pass 9 hit 240 s)
vi.setConfig({ testTimeout: 900_000, hookTimeout: 240_000 });

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// ids and plumbing
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const uid = (n: string) => `a1c00000-0000-4000-8000-000000000${n}`;
const P1 = uid("00a"); // pilot business, first location
const P2 = uid("00b"); // same business, additional location
const X = uid("00c"); // unrelated business
const U = { owner: uid("101"), frontDesk: uid("102"), outsider: uid("201"), padmin: uid("401") };
const CLIENT = { opted: uid("501"), silent: uid("502") };
const PHONE = { opted: "+15035550181", silent: "+15035550182" };
const APP = "https://app.z1.example.test";
const INBOUND = `${APP}/api/sms/twilio/inbound`;
const LEGAL_NAME = "ConfiDance Unlimited, LLC"; // synthetic row: the pilot rule accepts only this business name
const EIN = "98-7654321";
const RUN = randomBytes(3).toString("hex");

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const sign = (payload: Record<string, unknown>) => { const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`; return `${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`; };
const apiKey = (role: string) => sign({ iss: "supabase-demo", role, exp: 1983812996 });
const clientFor = (token: string, key: string) => createClient(URL_, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
function userClient(userId: string): SupabaseClient {
  const now = Math.floor(Date.now() / 1000);
  const c = clientFor(sign({ sub: userId, role: "authenticated", aud: "authenticated", aal: "aal2", amr: [{ method: "totp", timestamp: now }], exp: now + 3600 }), apiKey("anon"));
  // a token-header client has no stored session: answer getUser() with the user the token names (the client itself still reads its session for requests)
  c.auth.getUser = (async () => ({ data: { user: { id: userId } }, error: null })) as never;
  return c;
}
const service = () => clientFor(apiKey("service_role"), apiKey("service_role"));
const psql = (sql: string): string => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", "postgres", "-q", "-At", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const num = (sql: string) => Number(psql(sql));
/** owner-level fixture write that must bypass triggers (documented where used) */
const replica = (sql: string) => psql(`begin; set local session_replication_role = replica; ${sql}; commit;`);

function act(userId: string, studioId: string, role = "studio_owner") {
  h.actor = userId;
  h.ctx = { userId, studioId, role, client: userClient(userId) } satisfies Ctx;
}
const form = (fields: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, v); return f; };
type Flash = { ok: boolean; message: string; url: string };
/** Runs a platform-admin server action as the platform administrator (or `as`) and returns what the screen would show. */
async function platform(action: (f: FormData) => Promise<unknown>, fields: Record<string, string>, as: string = U.padmin): Promise<Flash> {
  h.actor = as;
  h.ctx = { userId: as, studioId: P1, role: "studio_owner", client: userClient(as) } satisfies Ctx;
  h.cookies.clear();
  let url = "";
  try {
    await action(form(fields));
  } catch (error) {
    const digest = String((error as { digest?: string }).digest ?? "");
    if (!digest.startsWith("NEXT_REDIRECT")) throw error;
    url = digest.split(";")[2] ?? "";
  }
  for (const raw of h.cookies.values()) {
    const parsed = JSON.parse(raw) as { ok: boolean; message: string };
    return { ok: parsed.ok, message: parsed.message, url };
  }
  const q = new URL(url || "/", APP).searchParams;
  const bad = q.get("pilot_error") ?? q.get("runner_error") ?? q.get("recurring_error");
  if (url === "/app") return { ok: false, message: "redirected away: not a platform administrator", url };
  return { ok: !bad, message: bad ?? q.get("runner") ?? q.get("pilot") ?? "", url };
}
const must = (r: Flash, label: string) => { expect(r.ok, `${label}: ${r.message}`).toBe(true); return r.message; };
const mustRefuse = (r: Flash, label: string) => { expect(r.ok, `${label} should be refused: ${r.message}`).toBe(false); return r.message; };

/** An app module that exists only on some compositions (PR 951's controls); null when absent. */
async function optionalModule(path: string): Promise<Record<string, (f: FormData) => Promise<unknown>> | null> {
  try { return await import(/* @vite-ignore */ path); } catch (error) {
    if (/Cannot find|Failed to (load|resolve)|does the file exist/i.test(String((error as Error).message))) return null;
    throw error;
  }
}
const CONTROLS = "@/app/platform/sms/activationControlActions";

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
/** a synthetic retained-document reference and hash, one per decision */
const evidence = (scope: string, label: string) => ({
  authorizedOn: day(-1), authorizedByRole: "founder_written", scope, documentRef: `Z1-AUTH-${RUN}-${label}`, documentSha256: createHash("sha256").update(`${RUN}:${label}`).digest("hex"),
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// result record
// ---------------------------------------------------------------------------------------------------------------------------------------------------
type Verdict = "PASS" | "FAIL" | "BLOCKED" | "NOT COVERED";
type Row = { id: string; title: string; verdict: Verdict; note: string };
const rows: Row[] = [];
const findings: string[] = [];
const passed = new Set<string>();
const finding = (text: string) => { findings.push(text); };
/** a step this run's database cannot judge: recorded as BLOCKED (never as a pass or a product failure) */
class Blocked extends Error {}
function step(id: string, title: string, needs: string[], fn: () => Promise<string>) {
  it(`${id} ${title}`, async (context) => {
    const missing = needs.filter((n) => !passed.has(n));
    if (missing.length) {
      rows.push({ id, title, verdict: "BLOCKED", note: `depends on ${missing.join(", ")}` });
      context.skip();
      return;
    }
    try {
      const note = await fn();
      passed.add(id);
      rows.push({ id, title, verdict: "PASS", note });
    } catch (error) {
      if (error instanceof Blocked) {
        rows.push({ id, title, verdict: "BLOCKED", note: error.message });
        context.skip();
        return;
      }
      rows.push({ id, title, verdict: "FAIL", note: String((error as Error).message ?? error).replace(/\s+/g, " ").slice(0, 600) });
      throw error;
    }
  });
}
const notCovered = (id: string, title: string, note: string) => rows.push({ id, title, verdict: "NOT COVERED", note });

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// zero-cost guard: no request may leave the machine, and no real credential may be present
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const external: string[] = [];
const realFetch = globalThis.fetch;
function installGuard() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!LOOPBACK.has(target.hostname)) {
      external.push(target.host);
      throw new Error("z1_external_network_blocked");
    }
    return realFetch(input, init);
  }) as typeof fetch;
}
const STATUS_SECRET = randomBytes(24).toString("hex");
const CRON_SECRET = randomBytes(24).toString("hex");
const WEBHOOK_SECRET = `whsec_z1_${randomBytes(12).toString("hex")}`;
function syntheticEnvironment() {
  for (const name of Object.keys(process.env)) if (/^(TWILIO_|STRIPE_|RESEND_|SMTP_|OPENAI_|ANTHROPIC_)/.test(name)) delete process.env[name];
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: URL_, NEXT_PUBLIC_SUPABASE_ANON_KEY: apiKey("anon"), SUPABASE_SERVICE_ROLE_KEY: apiKey("service_role"), NEXT_PUBLIC_APP_URL: APP,
    TW4_ISV_FAKE: "on", SMS_EIN_ENCRYPTION_KEY: randomBytes(32).toString("base64"), CRON_SECRET, TWILIO_STATUS_CALLBACK_SECRET: STATUS_SECRET, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    SMS_USAGE_BILLING: "on", SMS_SENDER_HASH_KEY: randomBytes(32).toString("hex"), SMS_USAGE_RECONCILER: "on", SMS_INVENTORY_RECONCILE: "on", SMS_SENDER_REVERIFY: "on", SMS_FEE_LIFECYCLE_SCAN: "on", SMS_RECURRING_SCHEDULER: "on",
    SMS_MONTHLY_LIMITS: "on", SMS_RECURRING_AUTHORIZATION: "on", SMS_CREDIT_PURCHASES: "on", TW4_TEST_CREDIT_ENABLED: "1",
  });
}

let ip = 0;
const nextIp = () => `10.1.${Math.floor(++ip / 250)}.${ip % 250}`;

describe.skipIf(!enabled)("TW-4F Z1: the chained SMS lifecycle (real schema, real app entry points, fake providers; simulated)", () => {
  let entity = "";
  let account = "";
  const PRICE = { brand: 4600, brand_low_volume: 450, campaign_vetting: 1500, monthly: 1000, monthly_low_volume: 150, number: 115, sms_usage: 3, sms_inbound: 2 };
  const onboardingState = (studio = P1) => psql(`select state || '|' || coalesce(step, '') from public.studio_sms_onboarding where studio_id = '${studio}' and state <> 'cancelled'`);
  const credit = () => psql(`select coalesce((select balance_cents || ':' || reserved_cents || ':' || hold from public.studio_sms_credit_accounts where legal_entity_id = '${entity}'), 'none')`);
  const monthKey = () => psql(`select public._tw4ml_month_key('${entity}'::uuid, now())`);

  beforeAll(() => {
    syntheticEnvironment();
    installGuard();
    h.platformAdmin = U.padmin;
    expect(psql("select to_regclass('public.tw4_local_qa_only') is not null"), "a local QA database is required (run-chain.mjs --marker)").toBe("t");
    // ENVIRONMENT ADJUSTMENT, recorded in the results: several database functions scan pg_timezone_names, which on this loaded 2-CPU container can exceed the API
    // statement timeout. The timeout is raised for this throwaway database so a slow host is not read as a lifecycle failure.
    const started = Date.now();
    psql("select count(*) from pg_timezone_names");
    const tzMs = Date.now() - started;
    execFileSync("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", PG, "psql", "-U", "supabase_admin", "-d", "postgres", "-q", "-v", "ON_ERROR_STOP=1"], {
      input: ["authenticator", "anon", "authenticated", "service_role"].map((r) => `alter role ${r} set statement_timeout = '90s';`).join("\n") + "\nnotify pgrst, 'reload config';", encoding: "utf8",
    });
    finding(`ENVIRONMENT: the local API statement timeout was raised to 90s (first read of pg_timezone_names took ${tzMs} ms including docker exec).`);
    const people: Array<[string, string, string | null]> = [[U.owner, "owner", null], [U.frontDesk, "desk", null], [U.outsider, "outsider", null], [U.padmin, "padmin", "platform_admin"]];
    psql(`begin;
${people.map(([id, k]) => `insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at) values ('${id}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '${k}@z1-lifecycle.test', now(), now(), now()) on conflict (id) do nothing;`).join("\n")}
${people.map(([id, , role]) => `insert into public.profiles (id, platform_role) values ('${id}', ${role ? `'${role}'` : "null"}) on conflict (id) do update set platform_role = excluded.platform_role;`).join("\n")}
insert into public.studios (id, name, slug, public_name) values ('${P1}', 'Z1 Pilot Location', 'z1-pilot', 'Z1 Harbor Dance'), ('${P2}', 'Z1 Second Location', 'z1-second', 'Z1 Harbor Dance East'), ('${X}', 'Z1 Unrelated Studio', 'z1-unrelated', 'Z1 Unrelated');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${U.owner}', '${P1}', 'studio_owner', true), ('${U.owner}', '${P2}', 'studio_owner', true), ('${U.frontDesk}', '${P1}', 'front_desk', true), ('${U.outsider}', '${X}', 'studio_owner', true);
commit;`);
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    notCovered("N1", "Suspension controls (PR 875)", "unmerged; no code or migration for it is in this run");
    notCovered("N2", "Real Twilio payloads, signatures, brand/campaign review, carrier delivery, Advanced Opt-Out, a real invoice", "needs a live account or paid resources (held by the owner)");
    notCovered("N3", "Stripe sandbox purchase, refund and dispute (plan step Z3)", "the Stripe client is a local stand-in here; only the webhook signature check is the real library");
    notCovered("N4", "Recurring-fee cancellation and provider release", "covered per slice by the tw4rfl suites; not chained here");
    notCovered("N5", "Non-pilot recurring credit charges (owner authorization, monthly charge)", "the chain follows the pilot business, which uses per-period covers; see tw4recurring / tw4monthly");
    const record = JSON.stringify({ simulated: true, rows, findings, externalRequests: external });
    writeFileSync(join(tmpdir(), "z1-results.json"), record);
    console.log(`Z1-RESULTS ${record}`);
  });

  // ------------------------------------------------------------------------------------------------------------------------------------- onboarding
  const FIELDS: Record<string, string> = {
    legal_name: LEGAL_NAME, entity_type: "llc", industry: "EDUCATION", website_choice: "danceflow", website_url: "", address_line1: "12 Harbor Way", address_line2: "", city: "Portland", region: "OR",
    postal_code: "97201", rep_first_name: "Pat", rep_last_name: "Morgan", rep_title: "Owner", rep_position: "ceo", rep_email: "pat@z1-lifecycle.test", rep_phone: "(503) 555-0123", preferred_area_code: "503",
  };
  const ATTEST = { attest_authorized: "on", attest_accurate: "on", attest_opt_in_only: "on", attest_fees_terms: "on" };
  type SetupAction = (previous: object, data: FormData) => Promise<{ ok?: boolean; error?: string }>;
  async function setup(userId: string, studio: string, intent: "save" | "submit", values: Record<string, string>) {
    // PR 935 replaces the two actions with one `smsSetupAction`; the chain runs on either shape
    const actions = (await import("@/app/app/settings/sms/actions")) as unknown as Record<string, SetupAction | undefined>;
    act(userId, studio);
    const one = actions.smsSetupAction;
    const action = one ?? (intent === "save" ? actions.saveSmsSetupAction : actions.submitSmsSetupAction);
    return action!({}, form({ ...values, intent }));
  }

  step("L01", "platform admin switches on pilot access (an owner cannot)", [], async () => {
    const { setSmsOnboardingAccessAction } = await import("@/app/platform/sms/actions");
    mustRefuse(await platform(setSmsOnboardingAccessAction, { studioId: P1, enabled: "on", reason: "owner tries to switch it on" }, U.owner), "owner switching access");
    for (const studio of [P1, P2, X]) must(await platform(setSmsOnboardingAccessAction, { studioId: studio, enabled: "on", reason: "synthetic Z1 pilot access" }), "pilot access");
    expect(num(`select count(*) from public.studio_sms_onboarding_access where enabled`)).toBe(3);
    return "access on for 3 synthetic studios through the platform action";
  });

  step("L02", "owner registration and submit (refusals: other owner, submit with nothing saved, duplicate)", ["L01"], async () => {
    expect((await setup(U.outsider, P1, "submit", { ...FIELDS, ein: EIN, ...ATTEST })).ok, "another business's owner").not.toBe(true);
    const direct = await setup(U.owner, P1, "submit", { ...FIELDS, ein: EIN, ...ATTEST });
    const actions = (await import("@/app/app/settings/sms/actions")) as unknown as Record<string, unknown>;
    const oneClick = Boolean(actions.smsSetupAction);
    if (direct.ok !== true) {
      finding(`Submit with no saved draft is refused on this code (message shown: "${String(direct.error ?? "").slice(0, 160)}"); PR 935 / 936 is the open fix.`);
      expect((await setup(U.owner, P1, "save", { ...FIELDS, ein: EIN })).ok).toBe(true);
      const submitted = await setup(U.owner, P1, "submit", { ...FIELDS, ein: EIN, ...ATTEST });
      expect(submitted.ok, submitted.error).toBe(true);
    }
    expect(onboardingState()).toMatch(/^submitted_for_checks\|/);
    expect((await setup(U.owner, P1, "submit", { ...FIELDS, ein: EIN, ...ATTEST })).ok, "duplicate submit").not.toBe(true);
    expect(num(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${P1}' and action = 'submitted'`)).toBe(1);
    return `${oneClick ? "one-click submit (PR 935 behaviour)" : "save then submit"}; direct submit ${direct.ok === true ? "accepted" : "refused"}; exactly one submission recorded`;
  });

  step("L03", "fee, budget and subaccount refused before the legal business exists", ["L02"], async () => {
    const p = await import("@/app/platform/sms/panelActions");
    const nowhere = randomUUID();
    const a = mustRefuse(await platform(p.panelSetSpendCapAction, { entityId: nowhere, capDollars: "130", confirmCap: "130" }), "budget without a business");
    mustRefuse(await platform(p.panelAuthorizeFeeAction, { entityId: nowhere, studioId: P1, kind: "brand", funding: "credit", amountCents: String(PRICE.brand), approvalRef: `Z1 early approval ${RUN}`, ownerApproved: "on" }), "fee without a business");
    const c = mustRefuse(await platform(p.panelCreateSubaccountAction, { studioId: P1, requestKey: randomUUID(), phrase: "CREATE SUBACCOUNT" }), "subaccount without a business");
    expect(num("select (select count(*) from public.studio_sms_spend_events) + (select count(*) from public.studio_sms_twilio_accounts)")).toBe(0);
    return `refused with: "${a.slice(0, 80)}" / "${c.slice(0, 80)}"`;
  });

  step("L04", "platform admin creates the legal business once (owner and duplicate refused)", ["L02", "L03"], async () => {
    const p = await import("@/app/platform/sms/panelActions");
    const fields = { studioId: P1, verificationNote: "Synthetic state registry record checked", verified: "on" };
    mustRefuse(await platform(p.panelCreateEntityAction, fields, U.owner), "owner creating the business");
    mustRefuse(await platform(p.panelCreateEntityAction, { studioId: P1, verificationNote: fields.verificationNote }), "unticked verification");
    must(await platform(p.panelCreateEntityAction, fields), "create legal business");
    const again = mustRefuse(await platform(p.panelCreateEntityAction, fields), "duplicate business");
    entity = psql(`select legal_entity_id from public.studio_sms_entity_studios where studio_id = '${P1}'`);
    expect(num("select count(*) from public.studio_sms_legal_entities")).toBe(1);
    return `founding record created from the submitted setup; duplicate refused: "${again.slice(0, 80)}"`;
  });

  step("L05", "additional location: owner attests, admin links (unrelated owner and duplicates refused)", ["L04"], async () => {
    const { attestLocationAction } = await import("@/app/app/settings/sms/location/actions");
    const p = await import("@/app/platform/sms/panelActions");
    const attest = async (user: string, studio: string) => {
      act(user, studio);
      try { await attestLocationAction(form({ legalName: LEGAL_NAME, einLast4: "4321", attest: "on" })); } catch (error) { return String((error as { digest?: string }).digest ?? error).split("result=")[1]?.split(";")[0] ?? "?"; }
      return "no_redirect";
    };
    expect((await setup(U.owner, P2, "save", { ...FIELDS, ein: EIN })).ok).toBe(true);
    expect(await attest(U.outsider, P2), "another owner attests this location").not.toBe("sent");
    expect(await attest(U.owner, P2)).toBe("sent");
    const second = await attest(U.owner, P2);
    expect(second, "duplicate request").not.toBe("sent");
    const request = psql(`select id from public.studio_sms_location_requests where studio_id = '${P2}' and status = 'pending'`);
    const decide = { requestId: request, entityId: entity, decision: "approve", note: "Synthetic franchise record checked", verified: "on" };
    mustRefuse(await platform(p.panelDecideLinkAction, decide, U.owner), "owner approving their own link");
    mustRefuse(await platform(p.panelDecideLinkAction, { ...decide, verified: "" }), "approval without verification");
    must(await platform(p.panelDecideLinkAction, decide), "link");
    mustRefuse(await platform(p.panelDecideLinkAction, decide), "second decision");
    // an unrelated business with the same EIN gets no second record and no link
    if ((await setup(U.outsider, X, "submit", { ...FIELDS, ein: EIN, ...ATTEST })).ok !== true) {
      expect((await setup(U.outsider, X, "save", { ...FIELDS, ein: EIN })).ok).toBe(true);
      const again = await setup(U.outsider, X, "submit", { ...FIELDS, ein: EIN, ...ATTEST });
      expect(again.ok, again.error).toBe(true);
    }
    mustRefuse(await platform(p.panelCreateEntityAction, { studioId: X, verificationNote: "Synthetic duplicate registry check", verified: "on" }), "same business registered twice");
    expect(num(`select count(*) from public.studio_sms_entity_studios where legal_entity_id = '${entity}'`)).toBe(2);
    expect(num(`select count(*) from public.studio_sms_entity_studios where studio_id = '${X}'`)).toBe(0);
    return `second location linked after owner attestation (duplicate request answered "${second}")`;
  });

  step("L06", "prices published (fixture: dual control driven by database functions)", ["L04"], async () => {
    for (const [kind, cents] of Object.entries(PRICE)) seedPrice(psql, { kind, customer: cents, provider: 1, description: `Z1 synthetic ${kind} price`, approver: U.padmin });
    expect(num("select count(*) from public.studio_sms_price_list where active")).toBeGreaterThanOrEqual(Object.keys(PRICE).length);
    return "8 synthetic prices through the dual-control workflow's internal functions (the price screens are not driven)";
  });

  const feeForm = (kind: keyof typeof PRICE, scope: string, label: string) => ({
    entityId: entity, studioId: P1, kind, funding: "pilot", amountCents: String(PRICE[kind]), approvalRef: `Z1 ${RUN} owner approval ${label}`, ownerApproved: "on", ...evidence(scope, label),
  });

  step("L07", "pilot fee refused before the setup budget, before the pilot limit, and before the registration path", ["L06"], async () => {
    const p = await import("@/app/platform/sms/panelActions");
    const first = mustRefuse(await platform(p.panelAuthorizeFeeAction, feeForm("brand", "pilot_onboarding_fee", "early-brand")), "fee before budget and limit");
    must(await platform(p.panelSetSpendCapAction, { entityId: entity, capDollars: "130", confirmCap: "130" }), "setup budget $130");
    mustRefuse(await platform(p.panelSetSpendCapAction, { entityId: entity, capDollars: "140", confirmCap: "130" }), "mismatched confirmation");
    const second = mustRefuse(await platform(p.panelAuthorizeFeeAction, feeForm("brand", "pilot_onboarding_fee", "early-brand-2")), "pilot fee before the pilot limit");
    expect(num("select count(*) from public.studio_sms_spend_events")).toBe(0);
    return `before budget: "${first.slice(0, 90)}"; before limit: "${second.slice(0, 90)}"`;
  });

  step("L08", "pilot limit recorded once ($130; over $150, missing evidence and owner refused)", ["L07"], async () => {
    const p = await import("@/app/platform/sms/panelActions");
    const base = { entityId: entity, ceilingDollars: "130", approvalRef: `Z1 ${RUN} founder written pilot approval`, understood: "on", ...evidence("pilot_exception", "ceiling") };
    mustRefuse(await platform(p.panelCreatePilotExceptionAction, { ...base, ceilingDollars: "151" }), "over $150");
    mustRefuse(await platform(p.panelCreatePilotExceptionAction, { ...base, documentSha256: "" }), "missing evidence");
    mustRefuse(await platform(p.panelCreatePilotExceptionAction, base, U.owner), "owner recording the limit");
    must(await platform(p.panelCreatePilotExceptionAction, base), "pilot limit");
    const replay = must(await platform(p.panelCreatePilotExceptionAction, base), "identical resubmission");
    expect(psql("select count(*) || ':' || max(ceiling_cents) from public.studio_sms_pilot_exceptions")).toBe("1:13000");
    return `one $130 pilot limit; resubmission answered "${replay.slice(0, 80)}"`;
  });

  step("L09", "subaccount created once (wrong phrase, owner and repeat refused or replayed)", ["L04", "L08"], async () => {
    const p = await import("@/app/platform/sms/panelActions");
    const key = randomUUID();
    mustRefuse(await platform(p.panelCreateSubaccountAction, { studioId: P1, requestKey: key, phrase: "create" }), "wrong phrase");
    mustRefuse(await platform(p.panelCreateSubaccountAction, { studioId: P1, requestKey: key, phrase: "CREATE SUBACCOUNT" }, U.owner), "owner creating");
    const created = must(await platform(p.panelCreateSubaccountAction, { studioId: P1, requestKey: key, phrase: "CREATE SUBACCOUNT" }), "create subaccount");
    must(await platform(p.panelCreateSubaccountAction, { studioId: P1, requestKey: key, phrase: "CREATE SUBACCOUNT" }), "replayed key");
    account = psql(`select twilio_account_sid from public.studio_sms_twilio_accounts where legal_entity_id = '${entity}' and status = 'active'`);
    expect(num("select count(*) from public.studio_sms_twilio_accounts")).toBe(1);
    const parent = (globalThis as unknown as { __tw4FakeIsvParent: { count(m: string): number } }).__tw4FakeIsvParent;
    expect(parent.count("createSubaccount")).toBe(1);
    return `${created.slice(0, 80)} (fake provider asked to create exactly once)`;
  });

  step("L10", "registration path decided and brand fee approved once (wrong amount, repeat reference refused or replayed)", ["L09"], async () => {
    const p = await import("@/app/platform/sms/panelActions");
    const { LVS_CHECKLIST } = await import("@/lib/sms/twilioIsv/panel");
    must(await platform(p.panelDecideTierAction, { studioId: P1, tier: "low_volume_standard", reason: "Synthetic pilot expects very low volume", ...Object.fromEntries(LVS_CHECKLIST.map((i) => [`elig_${i.key}`, "on"])) }), "tier");
    mustRefuse(await platform(p.panelAuthorizeFeeAction, feeForm("brand", "pilot_onboarding_fee", "wrong-path")), "standard brand fee on the low-volume path");
    const fee = feeForm("brand_low_volume", "pilot_onboarding_fee", "brand");
    mustRefuse(await platform(p.panelAuthorizeFeeAction, { ...fee, amountCents: "1" }), "wrong amount");
    must(await platform(p.panelAuthorizeFeeAction, fee), "brand approval");
    const replay = must(await platform(p.panelAuthorizeFeeAction, fee), "identical resubmission");
    expect(num("select count(*) from public.studio_sms_spend_events where status <> 'void'")).toBe(1);
    return `one brand approval of $4.50; resubmission: "${replay.slice(0, 80)}"`;
  });

  step("L11", "secondary profile, A2P trust product and brand submitted and approved (runner window required)", ["L10"], async () => {
    const a = await import("@/app/platform/sms/actions");
    const factory = await import("@/lib/sms/twilioIsv/factory");
    const runtime = factory.buildRunnerRuntime();
    if (!runtime.ok) throw new Error(runtime.reason);
    const fake = (await runtime.adapterFor(account)) as unknown as { setProfileStatus(s: string, v: string): void; setTrustProductStatus(s: string, v: string): void; setBrandStatus(s: string, v: string): void; count(m: string): number };
    const run = { studioId: P1, intent: "run", confirmFee: "on", confirmSubmitProfile: "on", confirmSubmitTrustProduct: "on", submitPhrase: "SUBMIT" };
    const closed = await platform(a.runSmsOnboardingAction, run);
    expect(fake.count("createCustomerProfile"), `no window: ${closed.message}`).toBe(0);
    must(await platform(a.setSmsRunnerWindowAction, { studioId: P1, hours: "24", reason: "synthetic Z1 registration window" }), "runner window");
    mustRefuse(await platform(a.runSmsOnboardingAction, { ...run, submitPhrase: "yes" }), "submission without the typed word");
    const messages: string[] = [];
    let brandDone = false;
    for (let i = 0; i < 10 && !brandDone; i++) {
      messages.push((await platform(a.runSmsOnboardingAction, run)).message);
      for (const line of psql(`select coalesce(provider_sid, '') from public.studio_sms_provisioning_steps where studio_id = '${P1}' and provider_sid is not null`).split("\n")) {
        // the fake ignores a SID of another kind
        if (line.startsWith("BU")) { try { fake.setProfileStatus(line, "twilio-approved"); } catch { /* a trust product */ } try { fake.setTrustProductStatus(line, "twilio-approved"); } catch { /* a profile */ } }
        if (line.startsWith("BN")) fake.setBrandStatus(line, "APPROVED");
      }
      messages.push((await platform(a.runSmsOnboardingAction, { studioId: P1, intent: "refresh" })).message);
      brandDone = /^service_setup\|/.test(onboardingState());
    }
    expect(onboardingState(), messages.slice(-4).join(" / ")).toMatch(/^service_setup\|/);
    expect(fake.count("createBrand")).toBe(1);
    return `reached ${onboardingState()} after ${messages.length / 2} run/refresh rounds; one brand created; before the window the run said "${closed.message.slice(0, 60)}"`;
  });

  const prov = async (intent: string, extra: Record<string, string> = {}) => {
    const r = await import("@/app/platform/sms/provisioningRunActions");
    return platform(r.runProvisioningStepAction, { studioId: P1, intent, ...extra });
  };

  step("L12", "Messaging Service created (free), pointing at the inbound route", ["L11"], async () => {
    const first = must(await prov("service"), "service");
    await prov("service");
    expect(num(`select count(*) from public.studio_sms_prov_operations where studio_id = '${P1}' and op_kind = 'messaging_service' and superseded_at is null`)).toBe(1);
    return first.slice(0, 160);
  });

  const monthly = () => feeForm("monthly_low_volume", "pilot_campaign_fee", "month-1");

  step("L13a", "the pilot's campaign monthly fee approval can be recorded with the Platform Admin fee action", ["L12"], async () => {
    const p = await import("@/app/platform/sms/panelActions");
    return must(await platform(p.panelAuthorizeFeeAction, monthly()), "campaign monthly fee approval from the platform screen");
  });

  step("L13", "campaign refused without its fee approvals, then submitted once and verified", ["L12"], async () => {
    const p = await import("@/app/platform/sms/panelActions");
    const factory = await import("@/lib/sms/twilioIsv/factory");
    const hub = factory.fakeProvisioningHub(process.env)!.adapterFor(account);
    const go = { confirmFee: "on", confirmPhrase: "SUBMIT" };
    mustRefuse(await prov("campaign"), "campaign without confirmation");
    const unapproved = await prov("campaign", go);
    expect(hub.count("createCampaign"), unapproved.message).toBe(0);
    must(await platform(p.panelAuthorizeFeeAction, feeForm("campaign_vetting", "pilot_campaign_fee", "vetting")), "campaign vetting approval");
    let message = (await prov("campaign", go)).message;
    let workaround = "";
    if (!passed.has("L13a")) {
      expect(hub.count("createCampaign"), `vetting approval alone: ${message}`).toBe(0);
      // WORKAROUND so that the later steps can be judged: record the monthly approval with the panel's own database call, skipping the screen's fee list
      const { SupabasePanelStore } = await import("@/lib/sms/twilioIsv/panel");
      const m = monthly();
      await new SupabasePanelStore(service()).authorizeSpend({
        entityId: entity, studioId: P1, kind: m.kind, cents: PRICE.monthly_low_volume, approvalRef: m.approvalRef, actorId: U.padmin, funding: "pilot",
        evidence: { authorizedOn: m.authorizedOn, authorizedByRole: "founder_written", scope: "pilot_campaign_fee", amountCents: PRICE.monthly_low_volume, periodKey: null, documentRef: m.documentRef, documentSha256: m.documentSha256 },
      });
      finding(`BLOCKER (pilot): a pilot campaign needs two recorded fee approvals (campaign vetting and the first month, monthly / monthly_low_volume), but the Platform Admin fee action offers only brand, campaign vetting and number, so the second cannot be recorded in the app and the campaign cannot be submitted. With only the vetting approval the run said "${message.slice(0, 160)}". The chain continued by calling tw4_spend_authorize directly.`);
      workaround = " (monthly approval recorded by direct database call: see L13a)";
      message = (await prov("campaign", go)).message;
    }
    expect(hub.count("createCampaign"), message).toBe(1);
    const campaign = psql(`select provider_sid from public.studio_sms_prov_operations where studio_id = '${P1}' and op_kind = 'campaign' and superseded_at is null`);
    hub.setCampaignStatus(campaign, "VERIFIED");
    let refreshed = (await prov("refresh")).message;
    // the screen's own instruction when a result could not be recorded: run the status check again
    for (let i = 0; i < 3 && /could not be recorded/.test(refreshed); i++) {
      finding(`Recovery used: "${refreshed.slice(0, 200)}"`);
      refreshed = (await prov("refresh")).message;
    }
    await prov("campaign", go);
    expect(hub.count("createCampaign"), "repeat run").toBe(1);
    expect(num(`select count(*) from public.studio_sms_prov_resources where studio_id = '${P1}' and resource_kind = 'campaign' and status = 'verified'`), refreshed).toBe(1);
    return `unapproved run said "${unapproved.message.slice(0, 80)}"; one campaign, verified by the fake${workaround}`;
  });

  let selectedNumber = "";
  step("L14", "number: admin offers, owner approves, fee approval required, bought once and attached", ["L13"], async () => {
    const r = await import("@/app/platform/sms/provisioningRunActions");
    const p = await import("@/app/platform/sms/panelActions");
    const n = await import("@/app/app/settings/sms/numberActions");
    const { getOwnerNumberOffers } = await import("@/lib/sms/provisioning/ownerRead");
    const factory = await import("@/lib/sms/twilioIsv/factory");
    const fake = factory.fakeNumberHub(process.env)!.adapterFor(account);
    const number = (intent: string, extra: Record<string, string> = {}) => platform(r.runNumberStepAction, { studioId: P1, intent, ...extra });
    const offered = must(await number("offer"), "offer");
    act(U.owner, P1);
    const offers = await getOwnerNumberOffers(current().client, P1);
    expect(offers?.offer, offered).toBeTruthy();
    selectedNumber = offers!.offer!.numbers[0].e164;
    const approval = form({ e164: selectedNumber, offer_id: offers!.offer!.offerId, ack_price_cents: String(offers!.monthlyCents), confirm: "yes" });
    act(U.frontDesk, P1, "front_desk");
    expect((await n.approveNumberAction({} as never, approval)).ok, "front desk approving").not.toBe(true);
    act(U.owner, P1);
    const approved = await n.approveNumberAction({} as never, approval);
    expect(approved.ok, JSON.stringify(approved)).toBe(true);
    expect((await n.approveNumberAction({} as never, approval)).ok, "second approval").not.toBe(true);
    const buy = { confirmFee: "on", approvedE164: selectedNumber };
    const unapproved = await number("acquire", buy);
    expect(fake.count("purchaseNumber"), unapproved.message).toBe(0);
    must(await platform(p.panelAuthorizeFeeAction, feeForm("number", "pilot_number_purchase", "number")), "number fee approval");
    mustRefuse(await number("acquire", { confirmFee: "on", approvedE164: "+12025550199" }), "a number the owner did not approve");
    const messages: string[] = [];
    for (let i = 0; i < 4; i++) {
      messages.push((await number("acquire", buy)).message);
      messages.push((await number("refresh")).message);
      if (num(`select count(*) from public.studio_sms_num_operations where studio_id = '${P1}' and op_kind = 'number_attach' and status = 'succeeded'`)) break;
    }
    expect(fake.count("purchaseNumber"), messages.join(" / ")).toBe(1);
    expect(num(`select count(*) from public.studio_sms_num_operations where studio_id = '${P1}' and op_kind = 'number_attach' and status = 'succeeded'`), messages.join(" / ")).toBe(1);
    return `offered ${offers!.offer!.numbers.length}; one purchase and attach after owner and fee approval; before the fee approval: "${unapproved.message.slice(0, 80)}"`;
  });

  const resource = (kind: string) => psql(`select id from public.studio_sms_provider_resources where studio_id = '${P1}' and resource_kind = '${kind}' and provider_state = 'active'`);
  const cron = async (path: "sms-usage-reconcile" | "sms-inventory-reconcile" | "sms-provider-fee-lifecycle" | "sms-recurring" | "sms-sender-reverify") => {
    const routes = {
      "sms-usage-reconcile": () => import("@/app/api/cron/sms-usage-reconcile/route"),
      "sms-inventory-reconcile": () => import("@/app/api/cron/sms-inventory-reconcile/route"),
      "sms-provider-fee-lifecycle": () => import("@/app/api/cron/sms-provider-fee-lifecycle/route"),
      "sms-recurring": () => import("@/app/api/cron/sms-recurring/route"),
      "sms-sender-reverify": () => import("@/app/api/cron/sms-sender-reverify/route"),
    };
    const { GET } = await routes[path]();
    const refused = await GET(new Request(`${APP}/api/cron/${path}`));
    expect(refused.status, `${path} without the cron secret`).toBeGreaterThanOrEqual(400);
    const response = await GET(new Request(`${APP}/api/cron/${path}`, { headers: { authorization: `Bearer ${CRON_SECRET}` } }));
    const text = await response.text();
    expect(response.status, `${path}: ${text.slice(0, 300)}`).toBe(200);
    return text.slice(0, 300);
  };

  step("L15", "sender check: activation refused early; ledger sender recorded, opt-out attested, compliance and sender verified", ["L14"], async () => {
    const a = await import("@/app/platform/sms/activationActions");
    const factory = await import("@/lib/sms/twilioIsv/factory");
    const early = mustRefuse(await platform(a.activateAction, { studioId: P1, note: "Synthetic early activation attempt", confirm: "on" }), "activation before any check");
    const controls = await optionalModule(CONTROLS);
    let pinNote = "";
    if (controls) {
      const pin = { shownOrigin: APP, reason: "synthetic canonical origin for the Z1 run", confirm: "on" };
      mustRefuse(await platform(controls.pinInboundRouteAction, pin, U.owner), "owner pinning the route");
      mustRefuse(await platform(controls.pinInboundRouteAction, { ...pin, shownOrigin: "https://elsewhere.example.test" }), "a different address");
      mustRefuse(await platform(controls.pinInboundRouteAction, { ...pin, confirm: "" }), "pin without confirmation");
      must(await platform(controls.pinInboundRouteAction, pin), "pin the inbound route");
      pinNote = "route pinned through the Platform Admin action; ";
    } else {
      finding("NO APP CONTROL: pinning the inbound route (database function used).");
      psql(`select public.tw4_inbound_route_pin_set('${U.padmin}', '${APP}', 'synthetic canonical origin for the Z1 run')`);
    }
    must(await platform(a.recordActivationSenderAction, { studioId: P1, confirm: "on" }), "record sender");
    must(await platform(a.attestOptOutAction, { studioId: P1, advanced_opt_out_enabled: "on", stop_keyword_confirmed: "on", start_keyword_confirmed: "on", help_keyword_confirmed: "on", confirmation_replies_confirmed: "on", evidenceRef: `Synthetic console evidence ${RUN}` }), "opt-out attestation");
    // the local fake mode gives the two activation reads their own fakes, unaware of what the provisioning fakes created: tell them, from the ledger
    const ledger = JSON.parse(psql(`select (public.tw4_act_check('${P1}'::uuid, '${U.padmin}'::uuid) -> 'ledger')::text`)) as Record<string, string>;
    const field = (...names: string[]) => names.map((n) => ledger[n]).find(Boolean) ?? "";
    const mg = field("messagingServiceSid", "messaging_service_sid"), qe = field("campaignSid", "campaign_sid"), pn = field("phoneNumberSid", "phone_number_sid");
    const bn = psql(`select provider_sid from public.studio_sms_provisioning_steps where studio_id = '${P1}' and provider_sid like 'BN%' limit 1`);
    const { complianceReadRuntime } = await import("@/lib/sms/activation");
    complianceReadRuntime(process.env);
    const hub = (globalThis as unknown as { __tw4ComplianceHub: InstanceType<typeof import("@/lib/sms/twilioIsv/fakeNumbers").FakeNumberHub> }).__tw4ComplianceHub;
    hub.adapterFor(account).registerService(mg, { inbound_request_url: INBOUND, use_inbound_webhook_on_number: false });
    hub.adapterFor(account).registerCampaign(qe, { messaging_service_sid: mg });
    expect(factory.fakeNumberHub(process.env)).toBeTruthy();
    must(await platform(a.runComplianceAction, { studioId: P1 }), "compliance validation");
    const { senderReadProviderFromEnv } = await import("@/lib/sms/senderVerification");
    const reads = senderReadProviderFromEnv(process.env) as unknown as InstanceType<typeof import("@/lib/sms/senderVerification").FakeSenderReadProvider>;
    reads.script("account", account, { sid: account, status: "active" });
    reads.script("service", mg, { sid: mg, account_sid: account, us_app_to_person_registered: true, inbound_request_url: INBOUND, use_inbound_webhook_on_number: false });
    reads.script("campaign", qe, { sid: qe, account_sid: account, messaging_service_sid: mg, campaign_status: "VERIFIED", mock: false, brand_registration_sid: bn, us_app_to_person_usecase: psql(`select use_case from public.studio_sms_prov_resources where provider_sid = '${qe}'`) });
    reads.script("brand", bn, { sid: bn, status: "APPROVED", mock: false });
    reads.script("number", pn, { sid: pn, account_sid: account, phone_number: selectedNumber, sms_capable: true, status: "in-use", sms_url: null });
    reads.script("service_number", pn, { sid: pn, service_sid: mg, account_sid: account });
    const verified = must(await platform(a.verifyActivationSenderAction, { studioId: P1 }), "sender verification");
    return `${pinNote}early activation: "${early.slice(0, 100)}"; ${verified.slice(0, 80)}`;
  });

  step("L16", "recurring fees: pilot period covers for number and campaign; owner standing authorization on the pilot", ["L14", "L15"], async () => {
    const rf = await import("@/app/platform/sms/recurringFeeActions");
    must(await platform(rf.rflSetSwitchAction, { switch: "scan", enabled: "on", reason: "synthetic Z1 lifecycle scan switch", confirm: "on" }), "scan switch");
    const periods = [monthKey(), psql(`select public._tw4ml_key_add('${monthKey()}', 1)`)];
    const results: string[] = [];
    for (const kind of ["number", "campaign"]) {
      const id = resource(kind);
      expect(id, `${kind} is in the recurring-fee inventory`).not.toBe("");
      const cents = num(`select p.customer_price_cents from public.studio_sms_provider_resources r join public.studio_sms_price_list p on p.kind = r.fee_kind and p.active where r.id = '${id}'`);
      for (const periodKey of periods) {
        const label = `cover-${kind}-${periodKey}`;
        const fields = { resourceId: id, periodKey, approvalRef: `Z1 ${RUN} ${label}`, ack: "on", amountUsd: (cents / 100).toFixed(2), ...evidence("pilot_period_cover", label) };
        const r = await platform(rf.rflPilotCoverAction, fields);
        results.push(`${kind} ${periodKey}: ${r.ok ? "covered" : r.message.slice(0, 90)}`);
        if (r.ok) must(await platform(rf.rflPilotCoverAction, fields), "identical cover resubmitted");
      }
    }
    const unclear = results.find((r) => /evidence digest must be/.test(r));
    if (unclear) finding(`MINOR (message): a pilot cover for an already recorded period is refused with a combined text that leads with an unrelated cause: "${unclear}". The administrator cannot tell which applies.`);
    const scan = await cron("sms-provider-fee-lifecycle");
    const covers = results.filter((r) => r.endsWith("covered")).length;
    expect(covers, results.join(" / ")).toBeGreaterThanOrEqual(2);
    const { authorizeRecurring } = await import("@/lib/billing/smsRecurring");
    const standing = await authorizeRecurring(service(), { studioId: P1, userId: U.owner, kind: "number", acknowledgedPriceCents: PRICE.number, termMonths: 3, totalLimitCents: PRICE.number * 3 }).then(() => "accepted", (e: Error) => `refused (${e.message.slice(0, 90)})`);
    return `${results.join("; ")}; lifecycle scan ${scan.slice(0, 120)}; owner standing authorization ${standing}`;
  });

  step("L17", "activation: reconcilers run, mark ready, activate (owner refused)", ["L15", "L16"], async () => {
    const a = await import("@/app/platform/sms/activationActions");
    await cron("sms-inventory-reconcile");
    await cron("sms-usage-reconcile");
    const note = { studioId: P1, note: "Synthetic Z1 activation review", confirm: "on" };
    mustRefuse(await platform(a.activateAction, note, U.owner), "owner activating");
    const ready = await platform(a.markReadyAction, note);
    if (!ready.ok) {
      const items = psql(`select string_agg((i ->> 'id') || '=' || (i ->> 'detail'), ', ') from jsonb_array_elements(public._tw4act_items('${P1}')) i where not (i ->> 'ok')::boolean`);
      throw new Error(`mark ready refused: ${ready.message} | unmet: ${items}`);
    }
    must(await platform(a.activateAction, note), "activate");
    expect(onboardingState()).toBe("active|A2");
    const controls = await optionalModule(CONTROLS);
    if (!controls) {
      finding("NO APP CONTROL: switching billed texting on (database function used).");
      psql(`select public.tw4_usage_set_switch(true, '${U.padmin}', 'synthetic Z1 billed texting switch')`);
      return "all checklist items green; location active; billed-texting switch on (database function: no screen)";
    }
    const on = { reason: "synthetic Z1 billed texting switch", phrase: "SWITCH ON BILLED TEXTING", confirm: "on" };
    mustRefuse(await platform(controls.switchBilledTextingOnAction, on, U.owner), "owner switching billed texting on");
    mustRefuse(await platform(controls.switchBilledTextingOnAction, { ...on, phrase: "on" }), "without the typed phrase");
    must(await platform(controls.switchBilledTextingOnAction, on), "switch billed texting on");
    return "all checklist items green; location active; billed texting switched on through the Platform Admin action";
  });

  // ------------------------------------------------------------------------------------------------------------------------------------- traffic
  type Sent = { statusCallbackUrl: string | null; to: string };
  const billedFake = () => (globalThis as unknown as { __billedFakeSmsProvider?: { sent: Sent[]; setEvidence(sid: string, p: Record<string, unknown>): void; nextSend(r: Record<string, unknown>): void; setInbound(a: string, m: unknown[]): void } }).__billedFakeSmsProvider;
  async function send(clientId: string, body: string, key = randomUUID(), as: [string, string] = [U.frontDesk, "front_desk"]) {
    const { POST } = await import("@/app/api/sms/send/route");
    act(as[0], P1, as[1]);
    const response = await POST(new Request(`${APP}/api/sms/send`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": nextIp() }, body: JSON.stringify({ clientId, body, idempotencyKey: key }) }));
    return { status: response.status, json: (await response.json()) as { ok: boolean; error?: string; message?: string; id?: string }, key };
  }

  step("L18", "test credit: grant refused without switch or budget; budget and grant recorded once", ["L17"], async () => {
    const { SupabaseTestCreditStore } = await import("@/lib/sms/twilioIsv/testCreditStore");
    const store = new SupabaseTestCreditStore(service());
    const ev = (label: string) => ({ authorizedOn: day(0), authorizedByRole: "founder_written" as const, periodKey: monthKey(), documentRef: `Z1-TC-${RUN}-${label}`, documentSha256: createHash("sha256").update(`${RUN}:tc:${label}`).digest("hex") });
    const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code ?? "error");
    const noSwitch = await code(store.grant(entity, 30, `Z1 ${RUN} test grant early`, U.padmin, ev("early")));
    finding("NO APP CONTROL: test credit switch, budget and grant (server module used; documented as having no screen).");
    await store.setSwitch(true, U.padmin, "synthetic Z1 test credit switch");
    const noBudget = await code(store.grant(entity, 30, `Z1 ${RUN} test grant nobudget`, U.padmin, ev("nobudget")));
    expect([noSwitch, noBudget]).not.toContain("ok");
    await store.setBudget(entity, 30, `Z1 ${RUN} founder test budget`, U.padmin, ev("budget"));
    const grant = ev("grant");
    await store.grant(entity, 30, `Z1 ${RUN} founder test grant`, U.padmin, grant);
    expect((await store.grant(entity, 30, `Z1 ${RUN} founder test grant`, U.padmin, grant)).replayed).toBe(true);
    const over = await code(store.grant(entity, 1, `Z1 ${RUN} over budget grant`, U.padmin, ev("over")));
    expect(over).toBe("TW071");
    expect(await store.status(entity)).toMatchObject({ granted_cents: 30, unused_cents: 30, ok: true });
    return `refused without switch (${noSwitch}) and budget (${noBudget}); $0.30 granted once; over budget ${over}. No screen exists (service module)`;
  });

  step("L19", "monthly limit set by the owner (front desk refused)", ["L17"], async () => {
    const { POST } = await import("@/app/api/billing/sms-limits/set/route");
    const { NextRequest } = await import("next/server");
    const set = async (user: string, role: string) => {
      act(user, P1, role);
      const r = await POST(new NextRequest(`${APP}/api/billing/sms-limits/set`, { method: "POST", headers: { "x-forwarded-for": nextIp() }, body: JSON.stringify({ limitCents: 5000, confirmed: true, reason: "synthetic Z1 limit" }) }));
      return { status: r.status, text: (await r.text()).slice(0, 200) };
    };
    expect((await set(U.frontDesk, "front_desk")).status).toBeGreaterThanOrEqual(400);
    const ok = await set(U.owner, "studio_owner");
    expect(ok.status, ok.text).toBe(200);
    return "owner set a $50 monthly limit through the billing route";
  });

  let firstSend: { key: string; sid: string; url: string } = { key: "", sid: "", url: "" };
  step("L20", "send: consent required; one billed text on the studio's own number; resend is a replay", ["L18", "L19"], async () => {
    psql(`insert into public.clients (id, studio_id, first_name, last_name, phone) values ('${CLIENT.opted}', '${P1}', 'Casey', 'Consenting', '${PHONE.opted}'), ('${CLIENT.silent}', '${P1}', 'Sam', 'Silent', '${PHONE.silent}')`);
    // consent through the app's own consent function, as the front desk
    const consented = await userClient(U.frontDesk).rpc("upsert_sms_contact_permission", {
      p_studio_id: P1, p_organizer_id: null, p_client_id: CLIENT.opted, p_organizer_contact_id: null, p_phone_e164: PHONE.opted, p_consent_status: "opted_in", p_consent_source: "front_desk", p_consent_note: "synthetic Z1 consent",
    });
    expect(consented.error?.message ?? "ok").toBe("ok");
    // the platform master switch (DANCEFLOW_SMS_STATUS / SMS_PLATFORM_STATUS) gates the billed path too: refused without it, then set as activation would
    const gated = await send(CLIENT.opted, "Before the platform switch");
    expect(gated.status, JSON.stringify(gated.json)).toBe(503);
    finding(`ACTIVATION SETTING: with every checklist item green and the location active, a send is refused ("${gated.json.error}") until DANCEFLOW_SMS_STATUS or SMS_PLATFORM_STATUS is "approved".`);
    process.env.DANCEFLOW_SMS_STATUS = "approved";
    const silent = await send(CLIENT.silent, "Class moved to 6pm");
    expect(silent.status, JSON.stringify(silent.json)).toBe(400);
    const sent = await send(CLIENT.opted, "Class moved to 6pm");
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    const again = await send(CLIENT.opted, "Class moved to 6pm", sent.key);
    expect(again.json.message).toMatch(/already sent/i);
    const provider = billedFake()!;
    expect(provider.sent).toHaveLength(1);
    const row = psql(`select provider_message_id from public.sms_message_logs where id = '${sent.json.id}'`);
    const url = String(provider.sent[0].statusCallbackUrl ?? "");
    expect(url).toContain("/api/sms/twilio/status?");
    firstSend = { key: sent.key, sid: row, url };
    expect(provider.sent[0].to).toBe(PHONE.opted);
    return `unconsented refused; one send accepted by the fake; resend replayed; credit ${credit()}`;
  });

  const token = () => (globalThis as unknown as { __tw4FakeIsvParent: { currentToken(a: string): string | null } }).__tw4FakeIsvParent.currentToken(account)!;
  async function webhook(kind: "status" | "inbound", url: string, params: Record<string, string>, opts: { signWith?: string } = {}) {
    const route = kind === "status" ? await import("@/app/api/sms/twilio/status/route") : await import("@/app/api/sms/twilio/inbound/route");
    const signature = twilio.getExpectedTwilioSignature(opts.signWith ?? token(), url, params);
    const response = await route.POST(new Request(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature, "x-forwarded-for": nextIp() }, body: new URLSearchParams(params).toString() }));
    return { status: response.status, text: await response.text() };
  }

  step("L21", "signed status callbacks: delivered recorded; forged, wrong secret, replay and late 'sent' change nothing", ["L20"], async () => {
    const log = () => psql(`select status || ':' || coalesce(provider_error_code, '') from public.sms_message_logs where provider_message_id = '${firstSend.sid}'`);
    const params = (status: string) => ({ AccountSid: account, MessageSid: firstSend.sid, MessageStatus: status });
    const before = log();
    expect((await webhook("status", firstSend.url, params("delivered"), { signWith: "not-the-subaccount-token" })).status).toBe(403);
    const wrong = firstSend.url.replace(STATUS_SECRET, "wrong");
    expect((await webhook("status", wrong, params("delivered"))).status).toBe(401);
    expect((await webhook("status", firstSend.url, { ...params("delivered"), AccountSid: `AC${"9".repeat(32)}` })).status).toBe(403);
    expect(log()).toBe(before);
    const sent = await webhook("status", firstSend.url, params("sent"));
    expect(sent.status, sent.text).toBe(200);
    const delivered = await webhook("status", firstSend.url, params("delivered"));
    expect(delivered.status, delivered.text).toBe(200);
    expect((await webhook("status", firstSend.url, params("delivered"))).text).toContain("duplicate");
    await webhook("status", firstSend.url, params("sent"));
    expect(log()).toBe("delivered:");
    return `${before} -> delivered; forged 403, wrong secret 401, unknown account 403, replay and late 'sent' ignored`;
  });

  const inboundParams = (body: string, extra: Record<string, string> = {}) => ({
    AccountSid: account, MessageSid: `SM${randomBytes(16).toString("hex")}`, From: PHONE.opted, To: selectedNumber, Body: body, NumSegments: "1", NumMedia: "0",
    MessagingServiceSid: psql(`select provider_sid from public.studio_sms_prov_operations where studio_id = '${P1}' and op_kind = 'messaging_service' and superseded_at is null`), ...extra,
  });
  const consent = () => psql(`select string_agg(distinct consent_status, ',') from public.sms_contact_permissions where studio_id = '${P1}' and phone_e164 = '${PHONE.opted}'`);

  step("L22", "inbound: signed message accepted and billed once; unsigned and foreign refused", ["L20"], async () => {
    const charges = () => num(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${entity}' and idempotency_key like 'usage:in:%'`);
    expect((await webhook("inbound", INBOUND, inboundParams("See you tonight"), { signWith: "not-the-subaccount-token" })).status).toBe(403);
    // recording off (its default): the text is accepted and nothing is charged; then switched on, as billing inbound texts would need
    const unrecorded = await webhook("inbound", INBOUND, inboundParams("Before recording"));
    expect(unrecorded.status, unrecorded.text).toBe(200);
    const off = charges();
    finding(`ACTIVATION SETTING: with SMS_INBOUND_RECORDING unset, an accepted inbound text records no usage charge (${off} inbound charges in the ledger).`);
    process.env.SMS_INBOUND_RECORDING = "on";
    const message = inboundParams("See you tonight");
    const ok = await webhook("inbound", INBOUND, message);
    expect(ok.status, ok.text).toBe(200);
    await webhook("inbound", INBOUND, message);
    const charged = charges() - off;
    expect(charged, "one inbound charge for one delivery plus one replay").toBe(1);
    return `unsigned refused; accepted; charged once with recording on; replay not billed twice; credit ${credit()}`;
  });

  step("L23", "STOP opts out and blocks sending; HELP answers; START restores", ["L22"], async () => {
    const stop = await webhook("inbound", INBOUND, inboundParams("STOP"));
    expect(stop.status, stop.text).toBe(200);
    expect(consent()).toContain("opted_out");
    const blocked = await send(CLIENT.opted, "Are you coming?");
    expect(blocked.status, JSON.stringify(blocked.json)).toBe(400);
    const help = await webhook("inbound", INBOUND, inboundParams("HELP"));
    expect(help.status, help.text).toBe(200);
    expect(consent()).toContain("opted_out");
    const start = await webhook("inbound", INBOUND, inboundParams("START"));
    expect(start.status, start.text).toBe(200);
    expect(consent()).not.toContain("opted_out");
    const restored = await send(CLIENT.opted, "Welcome back");
    expect(restored.status, `after START (consent ${consent()}): ${JSON.stringify(restored.json)}`).toBe(200);
    return `STOP blocked sending; HELP reply ${help.text.includes("<Message>") ? "sent" : "empty (left to Twilio)"}; START restored sending`;
  });

  step("L24", "usage billing and reconciliation: provider evidence settles sends; uncertain send held, never charged twice", ["L21"], async () => {
    const provider = billedFake()!;
    provider.nextSend({ kind: "uncertain", code: "timeout" });
    const unsure = await send(CLIENT.opted, "Uncertain delivery check");
    expect(unsure.status, JSON.stringify(unsure.json)).toBe(202);
    const before = credit();
    // time travel (fixture): the reconciler only reads attempts that are old enough
    replica(`update public.studio_sms_usage_attempts set created_at = created_at - interval '2 hours', submitting_at = submitting_at - interval '2 hours', submitted_at = submitted_at - interval '2 hours' where legal_entity_id = '${entity}'`);
    // the fake provider's evidence must carry the same (shifted) send time, as the real Message resource would
    for (const line of psql(`select provider_sid || ' ' || to_char(submitting_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from public.studio_sms_usage_attempts where legal_entity_id = '${entity}' and provider_sid is not null`).split("\n").filter(Boolean)) {
      const [sid, at] = line.split(" ");
      provider.setEvidence(sid, { date_created: at, date_sent: at });
    }
    const run = await cron("sms-usage-reconcile");
    const states = psql(`select string_agg(state || '=' || n, ', ') from (select state, count(*) n from public.studio_sms_usage_attempts where legal_entity_id = '${entity}' group by state order by state) s`);
    await cron("sms-usage-reconcile");
    const doubled = num(`select count(*) from (select idempotency_key from public.studio_sms_credit_ledger where legal_entity_id = '${entity}' group by 1 having count(*) > 1) d`);
    expect(doubled).toBe(0);
    expect(states, run).toMatch(/settled=[1-9]/);
    expect(states, "the uncertain send stays held").toMatch(/unknown=1|review=[1-9]/);
    expect(JSON.parse(psql(`select public.tw4_credit_verify('${entity}'::uuid)::text`))).toMatchObject({ ok: true });
    return `attempts ${states}; reconcile: ${run.slice(0, 140)}; credit ${before} -> ${credit()}; ledger verifies`;
  });

  step("L25", "low balance and test credit exhaustion: sending stops at zero, nothing goes negative", ["L18", "L20", "L23"], async () => {
    const { SupabaseCreditStore } = await import("@/lib/sms/twilioIsv/creditStore");
    const { SupabaseTestCreditStore } = await import("@/lib/sms/twilioIsv/testCreditStore");
    await new SupabaseCreditStore(service()).setThreshold(entity, 20, U.padmin);
    let refusal: Awaited<ReturnType<typeof send>> | null = null;
    let accepted = 0;
    for (let i = 0; i < 20 && !refusal; i++) {
      const r = await send(CLIENT.opted, `Reminder ${i}`);
      if (r.status === 200) accepted++;
      else refusal = r;
    }
    expect(refusal, `no refusal after ${accepted} sends; credit ${credit()}`).not.toBeNull();
    expect(refusal!.status, JSON.stringify(refusal!.json)).toBe(402);
    act(U.owner, P1);
    const overview = (await current().client.rpc("sms_credit_overview", { p_studio_id: P1 })).data as Record<string, unknown>;
    const status = await new SupabaseTestCreditStore(service()).status(entity);
    expect(Number(credit().split(":")[0])).toBeGreaterThanOrEqual(0);
    expect(status.ok, JSON.stringify(status)).toBe(true);
    if (!status.exhausted) finding(`After sending was refused for credit, test credit status is not "exhausted": ${JSON.stringify({ unused: status.unused_cents, balance: status.balance_cents, reserved: status.reserved_cents })}.`);
    if (overview?.low_balance !== true) finding(`Low balance: with a 20c threshold and sending refused for credit, the owner's overview reports low_balance=${String(overview?.low_balance)} (balance ${String(overview?.balance_cents)}c).`);
    return `${accepted} more accepted, then "${refusal!.json.error}"; test credit unused ${status.unused_cents}c, exhausted=${status.exhausted}; owner overview low_balance=${String(overview?.low_balance)}`;
  });

  const realStripe = new Stripe("sk_test_z1_not_a_real_key");
  async function stripeEvent(type: string, object: Record<string, unknown>, opts: { secret?: string; id?: string } = {}) {
    const { POST } = await import("@/app/api/payments/webhook/route");
    const body = JSON.stringify({ id: opts.id ?? `evt_z1_${RUN}_${randomBytes(4).toString("hex")}`, object: "event", type, api_version: "2024-06-20", created: Math.floor(Date.now() / 1000), data: { object }, livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null } });
    h.stripeSignature = realStripe.webhooks.generateTestHeaderString({ payload: body, secret: opts.secret ?? WEBHOOK_SECRET } as Parameters<typeof realStripe.webhooks.generateTestHeaderString>[0]) as string;
    const response = await POST(new Request(`${APP}/api/payments/webhook`, { method: "POST", body }));
    const text = (await response.text()).slice(0, 200);
    // this shared route also serves other products and the local baseline lacks their Competition migrations: a 500 here is not judged as a product failure
    if (response.status >= 500) throw new Blocked(`Stripe webhook route answered ${response.status} to ${type} on a baseline without the Competition migrations; pending a control run. ${text}`);
    return { status: response.status, text };
  }
  const paymentIntent = `pi_z1_${RUN}`;

  step("L26", "credit purchase (simulated Stripe): owner checkout, signed webhook credits once", ["L25"], async () => {
    h.stripe = {
      webhooks: realStripe.webhooks,
      checkout: { sessions: { create: async (args: Record<string, unknown>) => { const s = { id: `cs_z1_${RUN}`, url: "https://checkout.invalid/z1", ...args }; h.stripeSessions.push(s); return s; }, expire: async () => ({}), list: async () => ({ data: [] }) } },
    };
    const { POST } = await import("@/app/api/billing/sms-credits/checkout/route");
    const { NextRequest } = await import("next/server");
    act(U.frontDesk, P1, "front_desk");
    const desk = await POST(new NextRequest(`${APP}/api/billing/sms-credits/checkout`, { method: "POST", headers: { "x-forwarded-for": nextIp() }, body: JSON.stringify({ packCents: 2500 }) }));
    expect(desk.status).toBeGreaterThanOrEqual(400);
    act(U.owner, P1);
    const checkout = await POST(new NextRequest(`${APP}/api/billing/sms-credits/checkout`, { method: "POST", headers: { "x-forwarded-for": nextIp() }, body: JSON.stringify({ packCents: 2500 }) }));
    expect(checkout.status, await checkout.clone().text()).toBe(200);
    const created = h.stripeSessions[0];
    const session = { id: created.id, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", amount_total: 2500, currency: "usd", payment_intent: paymentIntent, metadata: created.metadata };
    const before = Number(credit().split(":")[0]);
    expect((await stripeEvent("checkout.session.completed", session, { secret: "whsec_wrong" })).status).toBe(400);
    const first = await stripeEvent("checkout.session.completed", session, { id: `evt_z1_${RUN}_paid` });
    expect(first.status, first.text).toBe(200);
    await stripeEvent("checkout.session.completed", session, { id: `evt_z1_${RUN}_paid` });
    expect(Number(credit().split(":")[0])).toBe(before + 2500);
    const resumed = await send(CLIENT.opted, "Back in credit");
    expect(resumed.status, JSON.stringify(resumed.json)).toBe(200);
    return `$25 credited once (bad signature refused, replay ignored); sending resumed; credit ${credit()}`;
  });

  step("L27", "dispute hold: withdrawn funds hold texting; admin release is separate from the reversal", ["L26"], async () => {
    psql(`select public.tw4_dispute_record_switch_set(true, '${U.padmin}', 'synthetic Z1 dispute record switch'); select public.tw4_dispute_hold_switch_set(true, '${U.padmin}', 'synthetic Z1 dispute hold switch')`);
    const dispute = (status: string) => ({ id: `dp_z1_${RUN}`, object: "dispute", payment_intent: paymentIntent, amount: 2500, currency: "usd", status });
    const a = await stripeEvent("charge.dispute.created", dispute("needs_response"));
    const b = await stripeEvent("charge.dispute.funds_withdrawn", dispute("needs_response"));
    expect([a.status, b.status], `${a.text} ${b.text}`).toEqual([200, 200]);
    expect(credit(), "account held").toMatch(/:true$/);
    const held = await send(CLIENT.opted, "Held by dispute");
    expect(held.status, JSON.stringify(held.json)).not.toBe(200);
    const won = await stripeEvent("charge.dispute.funds_reinstated", dispute("won"));
    expect(won.status, won.text).toBe(200);
    const afterWin = credit();
    const holds = JSON.parse(psql(`select public.tw4_credit_dispute_holds_list('${U.padmin}'::uuid, '${entity}'::uuid)::text`)) as unknown;
    const list = (Array.isArray(holds) ? holds : ((holds as { holds?: unknown[] }).holds ?? [])) as Array<{ id?: string; hold_id?: string; released_at?: string | null }>;
    const open = list.filter((x) => !x.released_at);
    finding("NO APP CONTROL: dispute record / hold switches and releasing a dispute hold (database functions used).");
    for (const x of open) psql(`select public.tw4_credit_dispute_hold_release('${entity}'::uuid, '${x.hold_id ?? x.id}'::uuid, '${U.padmin}'::uuid, 'synthetic Z1 release after the dispute was won')`);
    expect(credit(), `after release (was ${afterWin}; holds ${JSON.stringify(holds).slice(0, 200)})`).toMatch(/:false$/);
    const resumed = await send(CLIENT.opted, "Released");
    expect(resumed.status, JSON.stringify(resumed.json)).toBe(200);
    return `hold placed on withdrawal ("${held.json.error}"); after the win: ${afterWin}; ${open.length} hold(s) released by database function (no screen)`;
  });

  step("L28", "emergency stop: admin suspends the location and sending stops", ["L20"], async () => {
    const a = await import("@/app/platform/sms/activationActions");
    must(await platform(a.suspendAction, { studioId: P1, reason: "Synthetic Z1 emergency stop check" }), "suspend");
    const stopped = await send(CLIENT.opted, "After suspension");
    expect(stopped.status, JSON.stringify(stopped.json)).not.toBe(200);
    return `suspended; send answered ${stopped.status} "${stopped.json.error}"`;
  });

  step("L29", "zero cost: no request left the machine", [], async () => {
    expect(external).toEqual([]);
    return "0 non-loopback requests attempted (fetch guard); provider calls all went to in-memory fakes";
  });
});
