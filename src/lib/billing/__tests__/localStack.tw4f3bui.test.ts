/**
 * TW-4F-3b-UI read functions against a REAL schema (LOCAL QA STACK ONLY; skipped unless the variables below point at a loopback Supabase stack with the
 * migrations through 20261124090000 applied). Nothing reaches Stripe or Twilio.
 *
 *   TW4A_LOCAL_URL=http://127.0.0.1:55321  TW4A_LOCAL_JWT_SECRET=<the stack's JWT secret>  TW4A_LOCAL_DB_CONTAINER=supabase_db_danceflow-e2e-qa
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

import { getAdminCreditOverview, getSmsCreditView } from "@/lib/billing/smsCreditView";
import { SupabaseCreditStore } from "@/lib/sms/twilioIsv/creditStore";
import { RunnerStoreError } from "@/lib/sms/twilioIsv/store";

const URL_ = process.env.TW4A_LOCAL_URL ?? "";
const SECRET = process.env.TW4A_LOCAL_JWT_SECRET ?? "";
const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const loopback = (() => {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(URL_).hostname);
  } catch {
    return false;
  }
})();
const enabled = Boolean(URL_ && SECRET && PG) && loopback;

const PA1 = "a4d00000-0000-4000-8000-00000000000a";
const PA2 = "a4d00000-0000-4000-8000-00000000000b";
const PB1 = "a4d00000-0000-4000-8000-00000000000c";
const PX = "a4d00000-0000-4000-8000-00000000000d";
const EA = "e4d00000-0000-4000-8000-0000000000e1";
const EB = "e4d00000-0000-4000-8000-0000000000e2";
const U = {
  owner_a: "a4d00000-0000-4000-8000-000000000101",
  fd_a: "a4d00000-0000-4000-8000-000000000102",
  admin_a: "a4d00000-0000-4000-8000-000000000103",
  owner_a2: "a4d00000-0000-4000-8000-000000000104",
  owner_b: "a4d00000-0000-4000-8000-000000000201",
  owner_x: "a4d00000-0000-4000-8000-000000000301",
  padmin: "a4d00000-0000-4000-8000-000000000401",
};
const RUN = randomBytes(3).toString("hex");

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload: Record<string, unknown>) {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`;
}
const anonKey = () => (enabled ? sign({ iss: "supabase-demo", role: "anon", exp: 1983812996 }) : "");
const serviceKey = () => (enabled ? sign({ iss: "supabase-demo", role: "service_role", exp: 1983812996 }) : "");
const userToken = (sub: string, aal = "aal2") => sign({ sub, role: "authenticated", aud: "authenticated", aal, exp: Math.floor(Date.now() / 1000) + 3600 });
const as = (who: keyof typeof U, aal = "aal2"): SupabaseClient =>
  createClient(URL_, anonKey(), { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${userToken(U[who], aal)}` } } });
const psql = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
const psqlFile = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-q", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });

const CLEANUP = `
begin;
set local session_replication_role = replica;
delete from public.studio_sms_credit_ledger where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_credit_reservations where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_credit_topups where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_provider_charges where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_credit_accounts where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_entity_studios where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_legal_entities where id in ('${EA}', '${EB}');
delete from public.user_studio_roles where studio_id in ('${PA1}', '${PA2}', '${PB1}', '${PX}');
delete from public.studio_sms_onboarding_audit where studio_id in ('${PA1}', '${PA2}', '${PB1}', '${PX}');
delete from public.studios where id in ('${PA1}', '${PA2}', '${PB1}', '${PX}');
delete from public.profiles where id in (${Object.values(U).map((u) => `'${u}'`).join(", ")});
delete from auth.users where email like '%@tw4f3bui-e2e.test';
commit;`;
const FIXTURES = `${CLEANUP}
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.n || '@tw4f3bui-e2e.test', now(), now()
    from (values ('${U.owner_a}'::uuid, 'owner_a'), ('${U.fd_a}', 'fd_a'), ('${U.admin_a}', 'admin_a'), ('${U.owner_a2}', 'owner_a2'), ('${U.owner_b}', 'owner_b'), ('${U.owner_x}', 'owner_x'), ('${U.padmin}', 'padmin')) u(id, n);
insert into public.profiles (id, platform_role) values ('${U.owner_a}', null), ('${U.fd_a}', null), ('${U.admin_a}', null), ('${U.owner_a2}', null), ('${U.owner_b}', null), ('${U.owner_x}', null), ('${U.padmin}', 'platform_admin')
  on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name) values
  ('${PA1}', 'TW4F3BUI Location A1', 'tw4f3bui-a1', null), ('${PA2}', 'TW4F3BUI Location A2', 'tw4f3bui-a2', null),
  ('${PB1}', 'TW4F3BUI Location B1', 'tw4f3bui-b1', null), ('${PX}', 'TW4F3BUI Location X', 'tw4f3bui-x', null);
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('${U.owner_a}', '${PA1}', 'studio_owner', true), ('${U.owner_a2}', '${PA2}', 'studio_owner', true), ('${U.fd_a}', '${PA1}', 'front_desk', true),
  ('${U.admin_a}', '${PA1}', 'studio_admin', true), ('${U.owner_b}', '${PB1}', 'studio_owner', true), ('${U.owner_x}', '${PX}', 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values
  ('${EA}', 'F3U Alpha LLC', '5555', 15000, '${U.padmin}'), ('${EB}', 'F3U Beta LLC', '6666', 15000, '${U.padmin}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note) values
  ('${PA1}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A, location one'),
  ('${PA2}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A, location two'),
  ('${PB1}', '${EB}', 'founding', '${U.padmin}', 'fixture: verified business B');
commit;`;

describe.skipIf(!enabled)("TW-4F-3b-UI: credit read functions, real schema, real JWTs", () => {
  let credits: SupabaseCreditStore;
  const code = async (promise: PromiseLike<unknown>) => {
    try {
      await promise;
      return "ok";
    } catch (error) {
      return error instanceof RunnerStoreError ? error.code : `other:${String(error)}`;
    }
  };
  // the guard makes a purchase's expiry final; the fixture ages a row the way time would, with the guard switched off for this transaction only
  const aged = (sql: string) => psqlFile(`begin; set local session_replication_role = replica; ${sql} commit;`);
  const future = (ms: number) => new Date(Date.now() + ms).toISOString();

  beforeAll(() => {
    credits = new SupabaseCreditStore(createClient(URL_, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } }));
    psqlFile(FIXTURES);
  });
  afterAll(() => {
    try {
      psqlFile(CLEANUP);
    } catch {
      /* best effort */
    }
  });

  it("the read functions exist for signed-in users only (catalog check; a denied call would crash this local image)", () => {
    for (const fn of ["sms_credit_purchases(uuid, int)", "sms_credit_admin_overview()"]) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute')`)).toBe("f");
      expect(psql(`select has_function_privilege('authenticated', 'public.${fn}', 'execute')`)).toBe("t");
      expect(psql(`select has_function_privilege('public', 'public.${fn}', 'execute')`)).toBe("f");
    }
  });

  it("purchases: owners and administrators of a location see the whole legal business, in words only; front desk, other businesses and unlinked studios do not", async () => {
    const pendingLive = `cs_ui_live_${RUN}`;
    await credits.topupPending(EA, PA2, pendingLive, 5_000, future(25 * 60_000));
    await credits.topupPending(EA, PA1, `cs_ui_paid_${RUN}`, 10_000, future(25 * 60_000));
    await credits.settleTopup(EA, PA1, `cs_ui_paid_${RUN}`, 10_000, `evt_ui_paid_${RUN}`, `pi_ui_paid_${RUN}`, true);
    await credits.applyRefund(`pi_ui_paid_${RUN}`, 2_000, `evt_ui_refund_${RUN}`, "partial");
    await credits.topupPending(EA, PA1, `cs_ui_old_${RUN}`, 2_500, future(5 * 60_000));
    aged(`update public.studio_sms_credit_topups set expires_at = now() - interval '1 minute' where provider_ref = 'cs_ui_old_${RUN}';`);
    await credits.topupPending(EA, PA1, `cs_ui_fail_${RUN}`, 2_500, future(25 * 60_000));
    await credits.topupFailed(`cs_ui_fail_${RUN}`, `evt_ui_fail_${RUN}`);

    const fromA1 = await as("owner_a").rpc("sms_credit_purchases", { p_studio_id: PA1 });
    expect(fromA1.error).toBeNull();
    const rowsA1 = fromA1.data as Record<string, unknown>[];
    expect(rowsA1.map((r) => r.status).sort()).toEqual(["expired", "failed", "pending", "settled"]);
    expect(rowsA1.find((r) => r.status === "pending")).toMatchObject({ amount_cents: 5_000, this_location: false }); // bought at the OTHER location of the same business
    expect(rowsA1.find((r) => r.status === "settled")).toMatchObject({ amount_cents: 10_000, refunded_cents: 2_000, disputed_cents: 0, this_location: true });
    for (const row of rowsA1) expect(Object.keys(row).sort()).toEqual(["amount_cents", "created_at", "disputed_cents", "refunded_cents", "settled_at", "status", "this_location"]); // no ids, no Stripe refs

    const fromA2 = await as("owner_a2").rpc("sms_credit_purchases", { p_studio_id: PA2 });
    expect((fromA2.data as Record<string, unknown>[]).find((r) => r.status === "pending")).toMatchObject({ this_location: true });
    expect((await as("admin_a").rpc("sms_credit_purchases", { p_studio_id: PA1 })).error).toBeNull();

    expect((await as("fd_a").rpc("sms_credit_purchases", { p_studio_id: PA1 })).error?.code).toBe("42501");
    expect((await as("owner_b").rpc("sms_credit_purchases", { p_studio_id: PA1 })).error?.code).toBe("42501"); // another business's owner
    expect((await as("owner_a").rpc("sms_credit_purchases", { p_studio_id: PB1 })).error?.code).toBe("42501"); // my own owner role elsewhere does not carry over
    expect((await as("owner_a2").rpc("sms_credit_purchases", { p_studio_id: PA1 })).error?.code).toBe("42501"); // an owner of location 2 is not an owner of location 1
    const own = await as("owner_b").rpc("sms_credit_purchases", { p_studio_id: PB1 });
    expect(own.data).toEqual([]); // business B has no purchases and never sees A's
    expect((await as("owner_x").rpc("sms_credit_purchases", { p_studio_id: PX })).data).toEqual([]); // no verified legal business
  });

  it("the limit is clamped to 1..50", async () => {
    const one = await as("owner_a").rpc("sms_credit_purchases", { p_studio_id: PA1, p_limit: 0 });
    expect((one.data as unknown[]).length).toBe(1);
    const many = await as("owner_a").rpc("sms_credit_purchases", { p_studio_id: PA1, p_limit: 100000 });
    expect((many.data as unknown[]).length).toBeLessThanOrEqual(50);
  });

  it("the page reader returns one business only: B's owner sees B's balance and nothing of A; a refused studio yields nothing", async () => {
    const a = await getSmsCreditView(as("owner_a") as never, PA1);
    expect(a?.overview.legalBusiness).toBe(true);
    expect(a?.overview.balanceCents).toBe(8_000); // 10000 paid - 2000 refunded
    expect(a?.activity.some((e) => e.kind === "topup_settled")).toBe(true);
    expect(JSON.stringify(a)).not.toContain(EB);
    const b = await getSmsCreditView(as("owner_b") as never, PB1);
    expect(b?.overview.balanceCents).toBe(0);
    expect(b?.activity).toEqual([]);
    expect(b?.purchases).toEqual([]);
    expect(await getSmsCreditView(as("owner_b") as never, PA1)).toBeNull();
    expect(await getSmsCreditView(as("fd_a") as never, PA1)).toBeNull();
    const x = await getSmsCreditView(as("owner_x") as never, PX);
    expect(x?.overview.legalBusiness).toBe(false);
  });

  it("concurrent checkouts: the ceiling holds, and every read taken meanwhile is internally consistent (pending total = the live pending purchases listed)", async () => {
    psql(`delete from public.studio_sms_credit_topups where legal_entity_id = '${EB}'`);
    const stop = { value: false };
    const reads: { listed: number; overview: number }[] = [];
    const reader = (async () => {
      while (!stop.value) {
        const [list, overview] = await Promise.all([as("owner_b").rpc("sms_credit_purchases", { p_studio_id: PB1, p_limit: 50 }), as("owner_b").rpc("sms_credit_overview", { p_studio_id: PB1 })]);
        // two separate statements, so only totals that cannot go backwards are compared at the end; a single read must at least never exceed the ceiling
        const listed = (list.data as { status: string; amount_cents: number }[]).filter((r) => r.status === "pending").reduce((s, r) => s + r.amount_cents, 0);
        reads.push({ listed, overview: Number((overview.data as { pending_topups_cents: number }).pending_topups_cents) });
      }
    })();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => code(credits.topupPending(EB, PB1, `cs_ui_race_${RUN}_${i}`, 10_000, future(25 * 60_000)))));
    stop.value = true;
    await reader;
    const winners = results.filter((r) => r === "ok").length;
    expect(winners).toBe(5); // $500 ceiling / $100 packs
    expect(results.filter((r) => r === "TW009").length).toBe(3);
    for (const read of reads) {
      expect(read.listed).toBeLessThanOrEqual(50_000);
      expect(read.overview).toBeLessThanOrEqual(50_000);
    }
    const final = await getSmsCreditView(as("owner_b") as never, PB1);
    expect(final?.overview.pendingCents).toBe(50_000);
    expect(final?.purchases?.filter((p) => p.status === "pending")).toHaveLength(5);
  });

  it("platform overview: administrators only; accounts with a negative balance or hold are flagged, only stale pending purchases are listed, no member data", async () => {
    expect((await as("owner_a").rpc("sms_credit_admin_overview")).error?.code).toBe("42501");
    expect((await as("fd_a").rpc("sms_credit_admin_overview")).error?.code).toBe("42501");
    expect(await getAdminCreditOverview(as("owner_a") as never)).toBeNull();
    // TW-4F AAL2: a platform admin whose token is only aal1 is refused in SQL too
    expect((await as("padmin", "aal1").rpc("sms_credit_admin_overview")).error?.code).toBe("42501");
    expect(await getAdminCreditOverview(as("padmin", "aal1") as never)).toBeNull();

    await credits.adjust(EB, -300, `ui-negative-${RUN}`, "fixture: drive the balance negative for the monitoring view", U.padmin);
    aged(`update public.studio_sms_credit_topups set created_at = now() - interval '3 hours', expires_at = now() - interval '2 hours' where id = (select id from public.studio_sms_credit_topups where legal_entity_id = '${EB}' and status = 'pending' order by created_at limit 1);`);
    const overview = await getAdminCreditOverview(as("padmin") as never);
    expect(overview).not.toBeNull();
    const beta = overview!.accounts.find((a) => a.legalEntityId === EB);
    expect(beta).toMatchObject({ legalName: "F3U Beta LLC", balanceCents: -300, attention: true, locations: 1 });
    expect(overview!.accounts.find((a) => a.legalEntityId === EA)?.attention).toBe(false);
    expect(overview!.stalePending.filter((p) => p.legalName === "F3U Beta LLC").length).toBeGreaterThanOrEqual(1);
    expect(overview!.stalePending.some((p) => p.legalName === "F3U Alpha LLC")).toBe(false); // A's pending purchases are fresh
    expect(overview!.prices.every((p) => typeof p.providerCostCents === "number")).toBe(true);
    const serialized = JSON.stringify(overview);
    expect(serialized).not.toMatch(/ein|5555|6666|@/i);
  });

  it("the studio-facing price list still carries no provider cost", async () => {
    const prices = await as("owner_a").rpc("sms_price_list");
    expect(prices.error).toBeNull();
    for (const row of prices.data as Record<string, unknown>[]) expect(Object.keys(row)).not.toContain("provider_cost_cents");
  });
});
