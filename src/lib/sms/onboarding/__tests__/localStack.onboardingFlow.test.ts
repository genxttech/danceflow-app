/**
 * Onboarding acceptance on a REAL schema (real server actions, PostgREST, real JWTs): direct submission, duplicate submission, the platform
 * administrator creating the first legal business record, an additional location being linked, and the refusals around both. LOCAL QA STACK
 * ONLY (same variables as localStack.tw4a.test.ts); synthetic fixtures; never contacts Twilio.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ ctx: null as unknown, admin: null as unknown }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// each action call reads the context synchronously at its start, so concurrent calls for different studios stay separate
vi.mock("@/lib/auth/serverRoleGuard", () => ({ getCurrentUserStudioContext: async () => state.ctx }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.admin }));

import { smsSetupAction } from "@/app/app/settings/sms/actions";
import { setPilotAccess } from "@/lib/sms/onboarding/client";

const URL_ = process.env.TW4A_LOCAL_URL ?? "";
const SECRET = process.env.TW4A_LOCAL_JWT_SECRET ?? "";
const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const loopback = (() => { try { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(URL_).hostname); } catch { return false; } })();
const enabled = Boolean(URL_ && SECRET && PG) && loopback;

const A = "a5e20000-0000-4000-8000-00000000000a"; // first-time business
const B = "a5e20000-0000-4000-8000-00000000000b"; // an unrelated business
const D = "a5e20000-0000-4000-8000-00000000000d"; // second location of A's business, same owner
const U = { owner_a: "a5e20000-0000-4000-8000-000000000101", owner_b: "a5e20000-0000-4000-8000-000000000201", padmin: "a5e20000-0000-4000-8000-000000000401" };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const sign = (payload: Record<string, unknown>) => { const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`; return `${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`; };
const key = (role: string) => sign({ iss: "supabase-demo", role, exp: 1983812996 });
const client = (token: string, apiKey: string): SupabaseClient => createClient(URL_, apiKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
const as = (who: keyof typeof U) => client(sign({ sub: U[who], role: "authenticated", aud: "authenticated", aal: "aal2", exp: Math.floor(Date.now() / 1000) + 3600 }), key("anon"));
const service = () => client(key("service_role"), key("service_role"));
const psql = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-q", "-At", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" }).trim();

const FIELDS: Record<string, string> = {
  legal_name: "E2E Harbor Dance Studio LLC", entity_type: "llc", industry: "EDUCATION", website_choice: "danceflow", website_url: "",
  address_line1: "12 Harbor Way", address_line2: "", city: "Portland", region: "OR", postal_code: "97201",
  rep_first_name: "Pat", rep_last_name: "Morgan", rep_title: "Owner", rep_position: "ceo", rep_email: "pat@tw4a-e2e.test", rep_phone: "(503) 555-0123", preferred_area_code: "503",
};
const ATTEST = { attest_authorized: "on", attest_accurate: "on", attest_opt_in_only: "on", attest_fees_terms: "on" };
function press(who: "owner_a" | "owner_b", studioId: string, intent: "save" | "submit", values: Record<string, string>) {
  state.ctx = { supabase: as(who), user: { id: U[who] }, studioId, studioRole: "studio_owner", isPlatformAdmin: false };
  const data = new FormData();
  for (const [k, v] of Object.entries({ ...values, intent })) data.set(k, v);
  return smsSetupAction({}, data);
}
const rows = (studio: string) => psql(`select state || ':' || submission_seq from public.studio_sms_onboarding where studio_id = '${studio}' and state <> 'cancelled'`);
const code = async (call: PromiseLike<{ error: { code?: string } | null }>) => (await call).error?.code ?? "ok";
const createEntity = (studio: string, actor: string) => service().rpc("tw4_entity_create_for_studio", { p_studio_id: studio, p_actor: actor, p_verification_note: "Synthetic registry entry checked" });

describe.skipIf(!enabled)("onboarding flows on a real schema", () => {
  beforeAll(async () => {
    process.env.SMS_EIN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    state.admin = service();
    psql(readFileSync(join(__dirname, "localStackFixtures.sql"), "utf8"));
    psql(`insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${U.owner_a}', '${D}', 'studio_owner', true);`);
    for (const studio of [A, B, D]) await setPilotAccess(as("padmin") as never, studio, true, "synthetic acceptance fixture");
  }, 120_000);
  afterAll(() => {
    delete process.env.SMS_EIN_ENCRYPTION_KEY;
  });

  it("an owner cannot submit another studio's setup", async () => {
    const result = await press("owner_b", A, "submit", { ...FIELDS, ein: "98-7654321", ...ATTEST });
    expect(result.ok).toBe(false);
    expect(rows(A)).toBe("");
  });

  it("a first-time studio submits directly, and simultaneous submissions record exactly one", async () => {
    const results = await Promise.all([press("owner_a", A, "submit", { ...FIELDS, ein: "98-7654321", ...ATTEST }), press("owner_a", A, "submit", { ...FIELDS, ein: "98-7654321", ...ATTEST })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(rows(A)).toBe("submitted_for_checks:1");
    expect(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${A}' and action = 'submitted'`)).toBe("1");
    expect(JSON.stringify(results)).not.toMatch(/987654321|98-7654321/);
  });

  it("before DanceFlow creates the business record nothing fee-bearing is available", async () => {
    expect(await code(service().rpc("tw4_credit_checkout_context", { p_studio_id: A, p_user_id: U.owner_a }))).toBe("TW010");
    const overview = await as("owner_a").rpc("sms_credit_overview", { p_studio_id: A });
    expect((overview.data as { legal_business: boolean }).legal_business).toBe(false);
  });

  it("only a platform administrator creates the founding record, once", async () => {
    expect(await code(createEntity(A, U.owner_a))).toBe("42501");
    expect(await code(as("owner_a").rpc("tw4_entity_create_for_studio", { p_studio_id: A, p_actor: U.padmin, p_verification_note: "Synthetic registry entry checked" }))).toBe("42501");
    expect(await code(createEntity(A, U.padmin))).toBe("ok");
    expect(await code(createEntity(A, U.padmin))).toBe("23505");
    const overview = await as("owner_a").rpc("sms_credit_overview", { p_studio_id: A });
    expect((overview.data as { legal_business: boolean }).legal_business).toBe(true);
  });

  it("another studio cannot register the same business again, and an unrelated owner cannot attach to it", async () => {
    expect((await press("owner_b", B, "submit", { ...FIELDS, ein: "98-7654321", ...ATTEST })).ok).toBe(true);
    expect(await code(createEntity(B, U.padmin))).toBe("23505");
    const attest = await as("owner_b").rpc("sms_location_attest", { p_studio_id: B, p_claimed_legal_name: FIELDS.legal_name, p_claimed_ein_last4: "4321", p_attestation_version: "tw4a-v1" });
    const entity = psql(`select legal_entity_id from public.studio_sms_entity_studios where studio_id = '${A}'`);
    if (!attest.error) {
      const request = (attest.data as { request_id: string }).request_id;
      expect(await code(service().rpc("tw4_entity_decide_link", { p_request_id: request, p_entity_id: entity, p_actor: U.padmin, p_approve: true, p_note: "Synthetic verification attempt" }))).toBe("22023");
    }
    expect(psql(`select count(*) from public.studio_sms_entity_studios where studio_id = '${B}'`)).toBe("0");
  });

  it("a second location saves its details, the owner attests, and an administrator links it", async () => {
    expect((await press("owner_a", D, "save", { ...FIELDS, ein: "98-7654321" })).ok).toBe(true);
    expect(await code(as("owner_b").rpc("sms_location_attest", { p_studio_id: D, p_claimed_legal_name: FIELDS.legal_name, p_claimed_ein_last4: "4321", p_attestation_version: "tw4a-v1" }))).toBe("42501");
    const attest = await as("owner_a").rpc("sms_location_attest", { p_studio_id: D, p_claimed_legal_name: FIELDS.legal_name, p_claimed_ein_last4: "4321", p_attestation_version: "tw4a-v1" });
    expect(attest.error).toBeNull();
    const request = (attest.data as { request_id: string }).request_id;
    const entity = psql(`select legal_entity_id from public.studio_sms_entity_studios where studio_id = '${A}'`);
    const decide = (actor: string) => service().rpc("tw4_entity_decide_link", { p_request_id: request, p_entity_id: entity, p_actor: actor, p_approve: true, p_note: "Synthetic franchise record checked" });
    expect(await code(decide(U.owner_a))).toBe("42501");
    expect(await code(decide(U.padmin))).toBe("ok");
    expect(psql(`select link_kind from public.studio_sms_entity_studios where studio_id = '${D}'`)).not.toBe("founding");
    expect(psql("select count(*) from public.studio_sms_legal_entities")).toBe("1");
  });
});
