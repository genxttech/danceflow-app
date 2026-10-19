/**
 * Prepaid-credit payment-integrity hardening against a REAL schema, the REAL webhook route and the REAL checkout route, with SYNTHETIC Stripe objects only.
 * Nothing reaches Stripe: events are built and signed here with a test secret; Stripe's checkout API is replaced by a fake. LOCAL QA STACK ONLY (skipped unless
 * the variables below point at a loopback Supabase stack with the migrations through 20261125090000 applied).
 *
 *   TW4A_LOCAL_URL=http://127.0.0.1:55321  TW4A_LOCAL_JWT_SECRET=<the stack's JWT secret>  TW4A_LOCAL_DB_CONTAINER=supabase_db_danceflow-e2e-qa
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

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

const PA1 = "a6d00000-0000-4000-8000-00000000000a"; // location 1 of business A
const PA2 = "a6d00000-0000-4000-8000-00000000000b"; // location 2 of business A
const PB1 = "a6d00000-0000-4000-8000-00000000000c"; // the only location of business B
const PX = "a6d00000-0000-4000-8000-00000000000d"; // a studio with no verified legal business
const EA = "e6d00000-0000-4000-8000-0000000000e1";
const EB = "e6d00000-0000-4000-8000-0000000000e2";
const U = {
  owner_a: "a6d00000-0000-4000-8000-000000000101",
  fd_a: "a6d00000-0000-4000-8000-000000000102",
  admin_a: "a6d00000-0000-4000-8000-000000000103",
  owner_b: "a6d00000-0000-4000-8000-000000000201",
  owner_x: "a6d00000-0000-4000-8000-000000000301",
  padmin: "a6d00000-0000-4000-8000-000000000401",
};
const RUN = randomBytes(3).toString("hex");
const WEBHOOK_SECRET = "whsec_tw4hard_platform_test";
const CONNECT_SECRET = "whsec_tw4hard_connect_test";
const realStripe = new Stripe("sk_test_tw4hard_not_a_real_key");

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload: Record<string, unknown>) {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`;
}
const serviceKey = () => (enabled ? sign({ iss: "supabase-demo", role: "service_role", exp: 1983812996 }) : "");
const psql = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
const psqlFile = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-q", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });
const psqlError = (sql: string): string => {
  try {
    execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return "";
  } catch (error) {
    return String((error as { stderr?: Buffer | string }).stderr ?? error);
  }
};
const count = (sql: string) => Number(psql(sql));

// the route reads the signature through next/headers and the Stripe client through getStripe(): both are replaced; the signature check itself is the real one
let signatureHeader: string | null = null;
vi.mock("next/headers", () => ({ headers: async () => ({ get: (name: string) => (name === "stripe-signature" ? signatureHeader : null) }) }));
const stripeFake = vi.hoisted(() => ({ created: [] as { id: string; params: Record<string, unknown> }[], expired: [] as string[], seq: 0 }));
vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({
    webhooks: realStripe.webhooks,
    checkout: {
      sessions: {
        list: async () => ({ data: [] }),
        create: async (params: Record<string, unknown>) => {
          const id = `cs_hard_${stripeFake.seq++}_${Date.now().toString(36)}`;
          stripeFake.created.push({ id, params });
          return { id, url: `https://checkout.stripe.test/c/pay/${id}` };
        },
        expire: async (id: string) => {
          stripeFake.expired.push(id);
          return { id };
        },
      },
    },
  }),
}));
let signedInUser: string | null = null;
let studioContext: { studioId: string; userId: string } | null = null;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: signedInUser ? { id: signedInUser } : null } }) } }) }));
vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioContext: async () => studioContext }));

const CLEANUP = `
begin;
set local session_replication_role = replica;
delete from public.studio_sms_credit_ledger where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_credit_reservations where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_credit_disputes where topup_id in (select id from public.studio_sms_credit_topups where legal_entity_id in ('${EA}', '${EB}'));
delete from public.studio_sms_credit_disputes where topup_id not in (select id from public.studio_sms_credit_topups);
delete from public.studio_sms_credit_topups where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_provider_charges where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_credit_accounts where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_entity_studios where legal_entity_id in ('${EA}', '${EB}');
delete from public.studio_sms_legal_entities where id in ('${EA}', '${EB}');
delete from public.user_studio_roles where studio_id in ('${PA1}', '${PA2}', '${PB1}', '${PX}');
delete from public.studio_sms_onboarding_audit where studio_id in ('${PA1}', '${PA2}', '${PB1}', '${PX}');
delete from public.studios where id in ('${PA1}', '${PA2}', '${PB1}', '${PX}');
delete from public.profiles where id in ('${U.owner_a}', '${U.fd_a}', '${U.admin_a}', '${U.owner_b}', '${U.owner_x}', '${U.padmin}');
delete from auth.users where email like '%@tw4hard-e2e.test';
commit;`;
const FIXTURES = `${CLEANUP}
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.n || '@tw4hard-e2e.test', now(), now()
    from (values ('${U.owner_a}'::uuid, 'owner_a'), ('${U.fd_a}', 'fd_a'), ('${U.admin_a}', 'admin_a'), ('${U.owner_b}', 'owner_b'), ('${U.owner_x}', 'owner_x'), ('${U.padmin}', 'padmin')) u(id, n);
insert into public.profiles (id, platform_role) values ('${U.owner_a}', null), ('${U.fd_a}', null), ('${U.admin_a}', null), ('${U.owner_b}', null), ('${U.owner_x}', null), ('${U.padmin}', 'platform_admin')
  on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name) values
  ('${PA1}', 'TW4HARD Location A1', 'tw4hard-a1', null), ('${PA2}', 'TW4HARD Location A2', 'tw4hard-a2', null),
  ('${PB1}', 'TW4HARD Location B1', 'tw4hard-b1', null), ('${PX}', 'TW4HARD Location X', 'tw4hard-x', null);
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('${U.owner_a}', '${PA1}', 'studio_owner', true), ('${U.owner_a}', '${PA2}', 'studio_owner', true), ('${U.fd_a}', '${PA1}', 'front_desk', true),
  ('${U.admin_a}', '${PA1}', 'studio_admin', true), ('${U.owner_b}', '${PB1}', 'studio_owner', true), ('${U.owner_x}', '${PX}', 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values
  ('${EA}', 'H6P Alpha LLC', '7771', 15000, '${U.padmin}'), ('${EB}', 'H6P Beta LLC', '7772', 15000, '${U.padmin}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note) values
  ('${PA1}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A, location one'),
  ('${PA2}', '${EA}', 'founding', '${U.padmin}', 'fixture: verified business A, location two'),
  ('${PB1}', '${EB}', 'founding', '${U.padmin}', 'fixture: verified business B');
commit;`;

describe.skipIf(!enabled)("prepaid credit integrity: hold enforcement, refund/dispute accounting, replays (real schema, real routes, synthetic Stripe)", () => {
  let admin: SupabaseClient;
  let credits: SupabaseCreditStore;
  const code = async (promise: PromiseLike<unknown>) => {
    try {
      await promise;
      return "ok";
    } catch (error) {
      return error instanceof RunnerStoreError ? error.code : `other:${String(error)}`;
    }
  };
  const rpc = async (fn: string, args: Record<string, unknown>) => (await admin.rpc(fn, args)) as { data: unknown; error: { code?: string } | null };
  const balance = (entity: string) => Number(psql(`select coalesce((select balance_cents from public.studio_sms_credit_accounts where legal_entity_id = '${entity}'), 0)`));
  const hold = (entity: string) => psql(`select coalesce((select hold::text from public.studio_sms_credit_accounts where legal_entity_id = '${entity}'), 'none')`);
  const topupRow = (ref: string) => psql(`select status || ':' || amount_cents || ':' || refunded_cents || ':' || disputed_cents || ':' || reversed_cents from public.studio_sms_credit_topups where provider_ref = '${ref}'`);
  const pendingCount = (entity: string) => Number(psql(`select count(*) from public.studio_sms_credit_topups where legal_entity_id = '${entity}' and status = 'pending'`));
  const future = (ms: number) => new Date(Date.now() + ms).toISOString();
  const setHold = async (entity: string, on: boolean) => {
    const result = await rpc("tw4_credit_set_hold", { p_entity_id: entity, p_hold: on, p_reason: "fixture: payment-integrity test hold", p_actor: U.padmin });
    expect(result.error).toBeNull();
  };
  const invariants = (entity: string) =>
    psql(`select coalesce(bool_and(reversed_cents = refunded_cents + disputed_cents and reversed_cents <= amount_cents and disputed_cents >= 0 and refunded_cents <= amount_cents), true) from public.studio_sms_credit_topups where legal_entity_id = '${entity}'`);
  let n = 0;
  const settled = async (entity: string, studio: string, pack: number) => {
    n += 1;
    const ref = `cs_h_${RUN}_${n}`;
    const pi = `pi_h_${RUN}_${n}`;
    // keep the business inside the $500 ceiling across the many payments of this suite (a fixture adjustment, not a purchase)
    const live = Number(psql(`select coalesce(sum(amount_cents), 0) from public.studio_sms_credit_topups where legal_entity_id = '${entity}' and status = 'pending' and (expires_at is null or expires_at > now())`));
    if (balance(entity) + live + pack > 50_000 && balance(entity) > 0) await credits.adjust(entity, -balance(entity), `h-drain-${RUN}-${n}`, "fixture: stay inside the ceiling between scenarios", U.padmin);
    await credits.topupPending(entity, studio, ref, pack, future(20 * 60_000));
    await credits.settleTopup(entity, studio, ref, pack, `evt_h_s_${RUN}_${n}`, pi, true);
    return { ref, pi };
  };

  beforeAll(() => {
    admin = createClient(URL_, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    credits = new SupabaseCreditStore(admin);
    psqlFile(FIXTURES);
  });
  afterAll(() => {
    try {
      psqlFile(CLEANUP);
    } catch {
      /* best effort */
    }
  });

  describe("account hold is enforced at the database and the route", () => {
    it("a held business is sold nothing: context and registration refuse with the spending hold's own error; replays and settlement of money already taken still work", async () => {
      await credits.topupPending(EA, PA1, `cs_h_pre_${RUN}`, 2_500, future(20 * 60_000)); // creates the account row; registered BEFORE the hold
      const free = await rpc("tw4_credit_checkout_context", { p_studio_id: PA1, p_user_id: U.owner_a });
      expect(free.data).toEqual({ legal_entity_id: EA, hold: false });

      await setHold(EA, true);
      try {
        for (const [studio, user] of [[PA1, U.owner_a], [PA2, U.owner_a], [PA1, U.admin_a]] as const) {
          expect((await rpc("tw4_credit_checkout_context", { p_studio_id: studio, p_user_id: user })).error?.code).toBe("TW007"); // the hold belongs to the legal business, every location
        }
        expect((await rpc("tw4_credit_checkout_context", { p_studio_id: PA1, p_user_id: U.fd_a })).error?.code).toBe("42501"); // authorization is decided first
        expect(await code(credits.topupPending(EA, PA1, `cs_h_held_${RUN}`, 5_000, future(20 * 60_000)))).toBe("TW007");
        expect(psql(`select count(*) from public.studio_sms_credit_topups where provider_ref = 'cs_h_held_${RUN}'`)).toBe("0");
        expect(await code(credits.topupPending(EA, PA1, `cs_h_pre_${RUN}`, 2_500, future(20 * 60_000)))).toBe("ok"); // the same registration again is a replay
        const before = balance(EA);
        await credits.settleTopup(EA, PA1, `cs_h_pre_${RUN}`, 2_500, `evt_h_pre_${RUN}`, `pi_h_pre_${RUN}`, true); // the customer already paid: credited, though unspendable
        expect(balance(EA)).toBe(before + 2_500);
        expect(hold(EA)).toBe("true");
        const reserve = await rpc("tw4_credit_open_reservations", { p_entity_id: EA, p_actor: U.padmin });
        expect(reserve.error).toBeNull(); // read only; spending itself is covered by the 3b-0 suite: a held account cannot reserve
      } finally {
        await setHold(EA, false);
      }
      expect((await rpc("tw4_credit_checkout_context", { p_studio_id: PA1, p_user_id: U.owner_a })).data).toEqual({ legal_entity_id: EA, hold: false });
      expect(await code(credits.topupPending(EA, PA1, `cs_h_after_${RUN}`, 5_000, future(20 * 60_000)))).toBe("ok");
    });

    describe("the checkout route", () => {
      let POST: (request: import("next/server").NextRequest) => Promise<Response>;
      let ip = 0;
      beforeAll(async () => {
        process.env.NEXT_PUBLIC_SUPABASE_URL = URL_;
        process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey();
        process.env.SMS_CREDIT_PURCHASES = "on";
        ({ POST } = await import("@/app/api/billing/sms-credits/checkout/route"));
      });
      afterAll(() => {
        delete process.env.SMS_CREDIT_PURCHASES;
      });
      const call = async (user: string | null, studio: string | null, body: unknown) => {
        signedInUser = user;
        studioContext = user && studio ? { studioId: studio, userId: user } : null;
        const { NextRequest } = await import("next/server");
        const response = await POST(new NextRequest("https://example.test/api/billing/sms-credits/checkout", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${Math.floor(++ip / 250)}.${ip % 250}` } }));
        return { status: response.status, json: (await response.json().catch(() => ({}))) as Record<string, unknown> };
      };

      it("answers 423 while the business is on hold, before any Stripe session exists and without registering anything; releasing the hold restores purchases", async () => {
        const created0 = stripeFake.created.length;
        const pending0 = pendingCount(EA);
        await setHold(EA, true);
        try {
          for (const [user, studio] of [[U.owner_a, PA1], [U.owner_a, PA2], [U.admin_a, PA1]] as const) {
            const held = await call(user, studio, { packCents: 5_000 });
            expect(held.status).toBe(423);
            expect(held.json.code).toBe("on_hold");
          }
          expect(stripeFake.created.length).toBe(created0);
          expect(pendingCount(EA)).toBe(pending0);
          expect((await call(U.fd_a, PA1, { packCents: 5_000 })).status).toBe(403); // not an owner/administrator: refused as such, not as a hold
          expect((await call(U.owner_b, PB1, { packCents: 5_000 })).status).toBe(200); // another business is unaffected by A's hold
        } finally {
          await setHold(EA, false);
        }
        const ok = await call(U.owner_a, PA1, { packCents: 5_000 });
        expect(ok.status).toBe(200);
        expect(String(ok.json.url)).toMatch(/^https:\/\/checkout\.stripe\.test\//);
        expect(stripeFake.created.length).toBe(created0 + 2); // business B's, then A's
        expect(pendingCount(EA)).toBe(pending0 + 1);
      });

      it("rejects other amounts, bad bodies and a signed-out caller; the feature flag stays the outer gate", async () => {
        const created0 = stripeFake.created.length;
        for (const body of [{ packCents: 1 }, { packCents: 3_000 }, { packCents: "5000; drop" }, { packCents: -5_000 }, {}, null]) expect((await call(U.owner_a, PA1, body)).status).toBe(400);
        expect((await call(null, null, { packCents: 5_000 })).status).toBe(401);
        expect(stripeFake.created.length).toBe(created0);
        process.env.SMS_CREDIT_PURCHASES = "off";
        try {
          expect((await call(U.owner_a, PA1, { packCents: 5_000 })).status).toBe(404);
        } finally {
          process.env.SMS_CREDIT_PURCHASES = "on";
        }
        expect(stripeFake.created.length).toBe(created0);
      });

      it("a hold arriving while checkouts are being created never leaves a pending row behind a held account: every refused checkout's session is expired", async () => {
        const created0 = stripeFake.created.length;
        const expired0 = stripeFake.expired.length;
        const pending0 = pendingCount(EB);
        const results = await Promise.all([
          setHold(EB, true),
          ...Array.from({ length: 6 }, () => call(U.owner_b, PB1, { packCents: 2_500 })),
        ]);
        try {
          const statuses = (results.slice(1) as { status: number }[]).map((r) => r.status);
          for (const status of statuses) expect([200, 423, 409]).toContain(status); // sold before the hold, refused by it, or over the ceiling
          const sold = statuses.filter((s) => s === 200).length;
          expect(pendingCount(EB)).toBe(pending0 + sold);
          // Stripe sessions created for refused checkouts are expired again (a hold placed after the context read is caught at registration)
          const refusedAtRegistration = stripeFake.created.length - created0 - sold;
          expect(stripeFake.expired.length - expired0).toBe(refusedAtRegistration);
          expect((await call(U.owner_b, PB1, { packCents: 2_500 })).status).toBe(423); // and once the hold stands nothing more is sold
        } finally {
          await setHold(EB, false);
        }
        expect(invariants(EB)).toBe("t");
      });
    });
  });

  describe("refund and dispute accounting", () => {
    const dw = (pi: string, id: string, amount: number, event = `evt_${id}_w_${Math.random().toString(36).slice(2, 8)}`) => credits.applyDispute(pi, id, amount, "withdrawn", event);
    const dr = (pi: string, id: string, event = `evt_${id}_r_${Math.random().toString(36).slice(2, 8)}`) => credits.applyDispute(pi, id, 1, "reinstated", event);
    const rf = (pi: string, cumulative: number, event = `evt_rf_${Math.random().toString(36).slice(2, 8)}`) => credits.applyRefund(pi, cumulative, event, "synthetic refund");

    it("two disputes plus a late refund can never return more than the payment minus the refund, whichever dispute is won first", async () => {
      for (const order of [["a", "b"], ["b", "a"]] as const) {
        const { ref, pi } = await settled(EA, PA2, 5_000);
        const start = balance(EA);
        await dw(pi, `dp_${ref}_a`, 2_500);
        await dw(pi, `dp_${ref}_b`, 2_500);
        expect(balance(EA)).toBe(start - 5_000);
        await rf(pi, 2_500); // the refund arrives after the disputes took everything
        expect(balance(EA)).toBe(start - 5_000);
        expect(topupRow(ref)).toBe("settled:5000:2500:2500:5000");
        await dr(pi, `dp_${ref}_${order[0]}`); // won: but the other dispute still holds the rest of the payment
        expect(balance(EA)).toBe(start - 5_000);
        await dr(pi, `dp_${ref}_${order[1]}`);
        expect(balance(EA)).toBe(start - 2_500); // exactly payment - refund is kept
        expect(topupRow(ref)).toBe("settled:5000:2500:0:2500");
        for (const id of order) await dr(pi, `dp_${ref}_${id}`); // replays change nothing
        expect(balance(EA)).toBe(start - 2_500);
        expect(invariants(EA)).toBe("t");
        expect((await credits.verify(EA)).ok).toBe(true);
      }
    });

    it("one dispute won and the other lost: the refund and the lost dispute together take the whole payment", async () => {
      const { ref, pi } = await settled(EA, PA1, 5_000);
      const start = balance(EA);
      await dw(pi, `dp_${ref}_a`, 2_500);
      await dw(pi, `dp_${ref}_b`, 2_500);
      await rf(pi, 2_500);
      await dr(pi, `dp_${ref}_a`); // a won; b is never won
      expect(balance(EA)).toBe(start - 5_000);
      expect(topupRow(ref)).toBe("settled:5000:2500:2500:5000");
      expect(invariants(EA)).toBe("t");
    });

    it("a dispute whose withdrawal was capped to nothing still counts while open: winning the other dispute cannot restore what the first one lost", async () => {
      const { ref, pi } = await settled(EA, PA1, 5_000);
      const start = balance(EA);
      await dw(pi, `dp_${ref}_big`, 5_000); // takes the whole payment
      await dw(pi, `dp_${ref}_late`, 3_000); // nothing is left to take: recorded, no debit
      expect(balance(EA)).toBe(start - 5_000);
      await dr(pi, `dp_${ref}_big`); // won, but the other dispute (3000) is still open
      expect(balance(EA)).toBe(start - 3_000); // payment - the open claim
      expect(topupRow(ref)).toBe("settled:5000:0:3000:3000");
      await dr(pi, `dp_${ref}_late`); // the second dispute is won too, but it took nothing: nothing comes back. The first stays short by the 3000 it was held back for (a safe under-credit, corrected by an administrator adjustment)
      expect(balance(EA)).toBe(start - 3_000);
      expect(invariants(EA)).toBe("t");
    });

    it("duplicates and reordering: a reinstatement before its withdrawal is refused (and works afterwards); replays under new event ids credit nothing; replay after other state moved does not error", async () => {
      const { ref, pi } = await settled(EA, PA1, 5_000);
      const start = balance(EA);
      expect(await code(dr(pi, `dp_${ref}_x`))).toBe("22023"); // no withdrawal yet: the webhook answers 500 and Stripe retries
      await dw(pi, `dp_${ref}_x`, 2_000);
      await dw(pi, `dp_${ref}_x`, 2_000); // created then funds_withdrawn: one withdrawal
      await dw(pi, `dp_${ref}_x`, 4_000); // a different amount for the same dispute id changes nothing
      expect(balance(EA)).toBe(start - 2_000);
      await dw(pi, `dp_${ref}_y`, 1_000);
      await dr(pi, `dp_${ref}_x`);
      expect(balance(EA)).toBe(start - 1_000);
      await rf(pi, 1_500); // a refund after the reinstatement
      expect(balance(EA)).toBe(start - 2_500);
      for (let i = 0; i < 3; i += 1) await dr(pi, `dp_${ref}_x`); // replays of an old reinstatement after the state has moved: no error, no second credit
      expect(balance(EA)).toBe(start - 2_500);
      await rf(pi, 1_500); // the same cumulative figure again
      await rf(pi, 1_000); // an older, lower figure arriving late
      expect(balance(EA)).toBe(start - 2_500);
      await rf(pi, 5_000); // everything refunded: the rest of the credit goes, the open dispute's share moves to the refund
      expect(balance(EA)).toBe(start - 5_000);
      await dr(pi, `dp_${ref}_y`); // the open dispute is won, but the whole payment was refunded: nothing comes back
      expect(balance(EA)).toBe(start - 5_000);
      expect(topupRow(ref)).toBe("settled:5000:5000:0:5000");
      expect(invariants(EA)).toBe("t");
      expect((await credits.verify(EA)).ok).toBe(true);
    });

    it("unexpected events: unknown payments, unsettled payments, bad amounts and absurd values are refused, and move nothing", async () => {
      expect(await code(dw("pi_does_not_exist", "dp_none", 100))).toBe("22023");
      expect(await code(rf("pi_does_not_exist", 100))).toBe("22023");
      const pending = `cs_h_unsettled_${RUN}`;
      await credits.topupPending(EA, PA1, pending, 2_500, future(20 * 60_000));
      expect(await code(dw(pending, "dp_unsettled", 100))).toBe("22023");
      expect(await code(rf(pending, 100))).toBe("22023");
      const { ref, pi } = await settled(EA, PA1, 2_500);
      const start = balance(EA);
      expect(await code(dw(pi, `dp_${ref}_neg`, -5))).toBe("22023");
      expect(await code(dw(pi, `dp_${ref}_zero`, 0))).toBe("22023");
      expect(await code(rf(pi, 0))).toBe("22023");
      expect(await code(rf(pi, 2_501))).toBe("22023"); // above what was paid
      expect(await code(rf(pi, 100, ""))).toBe("22023");
      expect(await code(credits.applyDispute(pi, `dp_${ref}_bogus`, 100, "bogus" as never, "evt_bogus_xyz"))).toBe("22023");
      await dw(pi, `dp_${ref}_big`, 2_000_000_000); // absurdly large: capped to the payment
      expect(balance(EA)).toBe(start - 2_500);
      expect(topupRow(ref)).toBe("settled:2500:0:2500:2500");
      expect(invariants(EA)).toBe("t");
    });

    it("concurrency: simultaneous disputes, refunds, reinstatements and replays of one payment keep every invariant and never over-credit", async () => {
      for (let round = 0; round < 3; round += 1) {
        const { ref, pi } = await settled(EA, PA2, 10_000);
        const start = balance(EA);
        const ops: Promise<unknown>[] = [];
        for (const id of ["a", "b", "c"]) {
          ops.push(code(dw(pi, `dp_${ref}_${id}`, 4_000)), code(dw(pi, `dp_${ref}_${id}`, 4_000)));
        }
        ops.push(code(rf(pi, 3_000)), code(rf(pi, 3_000)), code(rf(pi, 6_000)));
        await Promise.all(ops);
        expect(invariants(EA)).toBe("t");
        const after = balance(EA);
        expect(after).toBeGreaterThanOrEqual(start - 10_000);
        await Promise.all(["a", "b", "c"].flatMap((id) => [code(dr(pi, `dp_${ref}_${id}`)), code(dr(pi, `dp_${ref}_${id}`))]));
        expect(invariants(EA)).toBe("t");
        const kept = 10_000 + (balance(EA) - start); // credit still retained from this payment
        const row = topupRow(ref).split(":").map(Number);
        expect(kept).toBeLessThanOrEqual(10_000 - 6_000); // the refund (6000) is gone whatever the interleaving
        expect(kept).toBeGreaterThanOrEqual(0);
        expect(row[2]).toBe(6_000);
        expect((await credits.verify(EA)).ok).toBe(true);
      }
    });

    it("property: for 60 random orders of refunds, disputes, wins, duplicates and retries, the credit retained never exceeds the payment minus refunds minus the disputes that were not won", async () => {
      const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
      for (let run = 0; run < 60; run += 1) {
        const rand = rng(1000 + run * 7919);
        const amount = [2_500, 5_000, 10_000][Math.floor(rand() * 3)];
        const { ref, pi } = await settled(EA, PA2, amount);
        const disputes = Array.from({ length: 1 + Math.floor(rand() * 3) }, (_, i) => ({ id: `dp_${ref}_${i}`, claim: 500 * (1 + Math.floor(rand() * (amount / 500))), won: rand() < 0.5 }));
        let refund = 0;
        type Op = () => Promise<unknown>;
        const pool: Op[] = [];
        for (const d of disputes) {
          pool.push(() => dw(pi, d.id, d.claim), () => dw(pi, d.id, d.claim));
          if (d.won) pool.push(() => dr(pi, d.id), () => dr(pi, d.id));
        }
        const steps = Math.floor(rand() * 3);
        const refunds: number[] = [];
        for (let i = 0; i < steps; i += 1) refunds.push(Math.min(amount, (refunds[i - 1] ?? 0) + 500 * (1 + Math.floor(rand() * (amount / 500)))));
        for (const cumulative of refunds) pool.push(() => rf(pi, cumulative));
        // random order, random duplicates; a reinstatement that arrives before its withdrawal is refused and retried at the end (as Stripe would)
        const sequence = pool.map((op) => ({ op, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.op);
        const failed: Op[] = [];
        for (const op of sequence) {
          try {
            await op();
          } catch {
            failed.push(op);
          }
        }
        for (const op of failed) {
          try {
            await op();
          } catch {
            /* still refused: the event stays unprocessed, which can only under-credit */
          }
        }
        refund = refunds.length ? refunds[refunds.length - 1] : 0;
        const row = topupRow(ref).split(":").map(Number);
        const retained = amount - row[4];
        const lostClaims = disputes.filter((d) => !d.won).reduce((s, d) => s + d.claim, 0);
        const ceilingOnRetained = Math.max(0, amount - refund - lostClaims);
        expect(row[4]).toBe(row[2] + row[3]);
        expect(row[4]).toBeLessThanOrEqual(amount);
        expect(retained).toBeLessThanOrEqual(Math.max(0, amount - refund));
        expect(retained, `run ${run}: amount ${amount}, refund ${refund}, disputes ${JSON.stringify(disputes)}, row ${row.join(":")}`).toBeLessThanOrEqual(ceilingOnRetained + wonButRefundedSlack(disputes, amount, refund));
        expect(invariants(EA)).toBe("t");
      }
      expect((await credits.verify(EA)).ok).toBe(true);
    });
  });

  describe("webhook replay through the real route", () => {
    let POST: (request: Request) => Promise<Response>;
    beforeAll(async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = URL_;
      process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey();
      process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
      ({ POST } = await import("@/app/api/payments/webhook/route"));
    });
    let sequence = 0;
    const eventId = (label: string) => `evt_${RUN}_${label}_${++sequence}`;
    const envelope = (id: string, type: string, object: Record<string, unknown>) =>
      JSON.stringify({ id, object: "event", type, api_version: "2024-06-20", created: Math.floor(Date.now() / 1000), data: { object }, livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null } });
    async function deliver(body: string) {
      signatureHeader = realStripe.webhooks.generateTestHeaderString({ payload: body, secret: WEBHOOK_SECRET } as Parameters<typeof realStripe.webhooks.generateTestHeaderString>[0]) as string;
      const response = await POST(new Request("https://example.test/api/payments/webhook", { method: "POST", body }));
      return response.status;
    }

    it("a signed stream of duplicated, shuffled and replayed dispute and refund events ends at exactly payment minus refund, and every replay is acknowledged", async () => {
      const { ref, pi } = await settled(EA, PA1, 5_000);
      const start = balance(EA);
      const dispute = (id: string, status: string) => ({ id, object: "dispute", payment_intent: pi, amount: 2_500, status });
      const charge = (refunded: number) => ({ id: `ch_${ref}`, object: "charge", payment_intent: pi, amount: 5_000, amount_refunded: refunded, metadata: { df_purpose: "sms_credit_topup" } });
      const events = [
        envelope(eventId("c1"), "charge.dispute.created", dispute(`dp_${ref}_1`, "needs_response")),
        envelope(eventId("w1"), "charge.dispute.funds_withdrawn", dispute(`dp_${ref}_1`, "needs_response")),
        envelope(eventId("c2"), "charge.dispute.created", dispute(`dp_${ref}_2`, "needs_response")),
        envelope(eventId("rf"), "charge.refunded", charge(2_500)),
        envelope(eventId("rf2"), "charge.updated", charge(2_500)),
        envelope(eventId("won1"), "charge.dispute.closed", dispute(`dp_${ref}_1`, "won")),
        envelope(eventId("fr1"), "charge.dispute.funds_reinstated", dispute(`dp_${ref}_1`, "won")),
        envelope(eventId("won2"), "charge.dispute.closed", dispute(`dp_${ref}_2`, "won")),
      ];
      const results: number[] = [];
      const retry: string[] = [];
      for (const body of events) {
        const status = await deliver(body);
        results.push(status);
        if (status !== 200) retry.push(body);
      }
      for (const body of retry) await deliver(body); // Stripe retries what was answered with a failure
      for (const body of [...events, ...events].sort(() => 0.5 - Math.random())) expect(await deliver(body)).toBe(200); // replays, shuffled, twice
      expect(balance(EA)).toBe(start - 2_500);
      expect(topupRow(ref)).toBe("settled:5000:2500:0:2500");
      expect(invariants(EA)).toBe("t");
      expect((await credits.verify(EA)).ok).toBe(true);
    });

    it("events for payments that are not credit purchases never touch credit", async () => {
      const start = balance(EA);
      const rows0 = psql(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${EA}'`);
      await deliver(envelope(eventId("o1"), "charge.dispute.created", { id: "dp_other", object: "dispute", payment_intent: "pi_not_ours", amount: 5_000, status: "needs_response" }));
      await deliver(envelope(eventId("o2"), "charge.refunded", { id: "ch_other", object: "charge", payment_intent: "pi_not_ours", amount: 5_000, amount_refunded: 5_000, metadata: {} }));
      expect(balance(EA)).toBe(start);
      expect(psql(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${EA}'`)).toBe(rows0);
    });
  });

  it("the rollback refuses while dispute records exist, and the new objects are service-role only", () => {
    expect(psql("select count(*) from public.studio_sms_credit_disputes")).not.toBe("0");
    const rollback = readFileSync(join(process.cwd(), "src/lib/supabase/migrations/rollback/20261125090000_twilio_pay_integrity_hardening_rollback.sql"), "utf8");
    expect(psqlError(rollback)).toContain("rollback refused");
    expect(psql("select has_table_privilege('authenticated', 'public.studio_sms_credit_disputes', 'select,insert,update,delete') or has_table_privilege('anon', 'public.studio_sms_credit_disputes', 'select,insert,update,delete') or has_table_privilege('service_role', 'public.studio_sms_credit_disputes', 'select,insert,update,delete')")).toBe("f");
    for (const fn of ["tw4_credit_checkout_context(uuid, uuid)", "tw4_credit_apply_dispute(text, text, int, text, text)", "tw4_credit_topup_pending(uuid, uuid, text, int, timestamptz)"]) {
      expect(psql(`select has_function_privilege('anon', 'public.${fn}', 'execute') or has_function_privilege('authenticated', 'public.${fn}', 'execute')`)).toBe("f");
      expect(psql(`select has_function_privilege('service_role', 'public.${fn}', 'execute')`)).toBe("t");
    }
  });

  it("the pilot ceiling stays separate: none of these paths created, read or moved it", () => {
    expect(psql(`select count(*) from public.studio_sms_credit_ledger l where l.legal_entity_id in ('${EA}', '${EB}') and l.kind = 'adjustment' and l.note ilike '%pilot%'`)).toBe("0");
    expect(psql(`select count(*) from public.studio_sms_credit_reservations where legal_entity_id in ('${EA}', '${EB}') and funding = 'pilot'`)).toBe("0");
    expect(psql(`select count(*) from public.studio_sms_pilot_exceptions where legal_entity_id in ('${EA}', '${EB}')`)).toBe("0");
  });
});

/**
 * Won disputes are returned only up to payment - refunds - what the other still-open disputes hold, in the order the events actually arrived; a won dispute
 * whose other disputes were open at that moment can legitimately stay under-credited, never over. The ceiling above is for disputes that were not won, so the
 * slack is zero: a retained credit above it is over-credit.
 */
function wonButRefundedSlack(_disputes: unknown, _amount: number, _refund: number): number {
  return 0;
}
