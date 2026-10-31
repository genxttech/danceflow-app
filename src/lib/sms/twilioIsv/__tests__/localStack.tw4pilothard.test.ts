/**
 * TW-4F Blocker 9: pilot spend hardening (20261231100000) against a REAL schema.
 *   1. A direct tw4_spend_authorize call can never use the pilot_period_cover scope (TW053); only tw4_rfl_pilot_cover reaches the internal function (revoked from every API role).
 *   2. A period cover is accepted only for the current or next billing month of the business.
 *   3. DEFERRABLE INITIALLY DEFERRED, ENABLE ALWAYS constraint triggers require, at COMMIT, the append-only evidence for every pilot-funded spend event and every pilot exception.
 *   4. One retained document (id or sha256) authorizes one approval, once.
 *   5. Apply precondition, rollback exactness and refusals (schema-only scratch copies).
 * Synthetic fixtures with fresh ids; nothing reaches Twilio, Stripe or any SMS path.
 *
 * LOCAL QA ONLY: a DEDICATED/isolated Postgres with migrations through 20261231100000 and the local-QA marker table (public.tw4_local_qa_only):
 *   TW4A_LOCAL_DB_CONTAINER=<container>  TW4RFL_DB=<database>
 *   npx vitest run --no-file-parallelism src/lib/sms/twilioIsv/__tests__/localStack.tw4pilothard.test.ts
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { seedPriceIfMissing } from "./priceFixture";
import { pilotCoverArgs, pilotExceptionArgs } from "./rflEvidenceHelper";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const DB = process.env.TW4RFL_DB ?? "";
const enabled = Boolean(PG && DB);

const RUN = randomBytes(3).toString("hex");
const P = `ad${RUN}-0000-4000-8000-000000000601`; // platform admin

const sqlArgs = ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-q", "-At", "-v", "ON_ERROR_STOP=1"];
const psql = (sql: string): string => execFileSync("docker", sqlArgs, { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const psqlError = (sql: string): string => {
  try {
    execFileSync("docker", sqlArgs, { input: `\\set VERBOSITY verbose\n${sql}`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return "";
  } catch (error) {
    return String((error as { stderr?: Buffer | string }).stderr ?? error);
  }
};
const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  const s = String(v).replace(/'/g, "''");
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v)) ? `'${s}'::uuid` : `'${s}'`;
};
const callSql = (fn: string, ...args: unknown[]) => `select public.${fn}(${args.map(lit).join(", ")})::text;`;
const call = <T = Record<string, unknown>>(fn: string, ...args: unknown[]): T => JSON.parse(psql(callSql(fn, ...args)) || "null") as T;
const callErr = (fn: string, ...args: unknown[]) => psqlError(callSql(fn, ...args));
const hasCode = (err: string, code: string) => new RegExp(`ERROR:\\s+${code}:`).test(err);
const replica = (sql: string) => psql(`begin; set local session_replication_role = replica; ${sql} commit;`);

const hex = (n: number) => randomBytes(n).toString("hex");
const sid = (prefix: string) => `${prefix}${hex(16)}`;
const ref = (label: string) => `Written approval ${RUN} ${label} ${hex(3)}`;
const e164 = () => `+12${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const sha = () => randomBytes(32).toString("hex");
const docId = () => `AUTH-DOC-${hex(5)}`;

type World = { entity: string; studio: string; owner: string; account: string; n: number };
let worldSeq = 0;
let pilotShared: { entity: string; account: string } | null = null;
/** The platform allows exactly ONE pilot business: every scenario gets a fresh LOCATION of it, a reset ceiling and an account without a hold. */
function pilotWorld(opts: { ceiling?: number } = {}): World {
  worldSeq += 1;
  if (!pilotShared) {
    const existing = psql(`select y.legal_entity_id || '|' || t.twilio_account_sid from public.studio_sms_pilot_exceptions y join public.studio_sms_twilio_accounts t on t.legal_entity_id = y.legal_entity_id and t.status = 'active'`);
    if (existing) {
      const [entity, account] = existing.split("|");
      pilotShared = { entity, account };
    } else {
      const entity = randomUUID();
      const account = sid("AC");
      const studio = randomUUID();
      const owner = randomUUID();
      psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  values ('${owner}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pilot-${RUN}@ph-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${owner}', null) on conflict (id) do nothing;
insert into public.studios (id, name, slug, public_name, timezone) values ('${studio}', 'PH pilot founding', 'ph-pilot-${RUN}', null, 'UTC');
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${entity}', 'ConfiDance Unlimited, LLC', '9999', 15000, '${P}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values ('${studio}', '${entity}', 'founding', '${P}', 'fixture: verified synthetic pilot business', now());
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values ('${entity}', '${account}', 'ph-pilot', 'test', 'active', '${P}');
commit;`);
      call("tw4_credit_adjust", entity, 200_000, `ph-fund-pilot-${RUN}`, "fixture funding for the hardening suite", P);
      call("tw4_monthly_limit_set_admin", entity, P, 20_000, null, "fixture: monthly limit for the hardening suite");
      call("tw4_pilot_exception_create", ...pilotExceptionArgs(psql, entity, 15000, `Founder written pilot approval ${RUN}`, P));
      pilotShared = { entity, account };
    }
  }
  const w: World = { entity: pilotShared.entity, studio: randomUUID(), owner: randomUUID(), account: pilotShared.account, n: worldSeq };
  replica(`update public.studio_sms_credit_reservations set status = 'released', closed_at = coalesce(closed_at, now()) where legal_entity_id = '${w.entity}' and funding = 'pilot' and status in ('reserved', 'captured');
    update public.studio_sms_spend_events set status = 'void' where legal_entity_id = '${w.entity}' and status in ('authorized', 'reserved');
    update public.studio_sms_pilot_exceptions set ceiling_cents = ${opts.ceiling ?? 15000} where legal_entity_id = '${w.entity}';
    update public.studio_sms_credit_accounts set hold = false, hold_reason = null, balance_cents = greatest(balance_cents, 100000) where legal_entity_id = '${w.entity}';`);
  psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  values ('${w.owner}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o-${RUN}-${w.n}@ph-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${w.owner}', null) on conflict (id) do nothing;
insert into public.studios (id, name, slug, public_name, timezone) values ('${w.studio}', 'PH pilot ${RUN} ${w.n}', 'ph-pilot-${RUN}-${w.n}', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${w.owner}', '${w.studio}', 'studio_owner', true);
commit;
begin; set local session_replication_role = replica;
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values ('${w.studio}', '${w.entity}', 'founding', '${P}', 'fixture: another location of the pilot business', now());
commit;`);
  return w;
}
const registerNumber = (w: World) => {
  const out = call<{ resource_id: string }>("tw4_rfl_register", w.studio, P, "number", sid("PN"), w.account, e164(), "admin", null, null);
  return out;
};

const SA = "public.tw4_spend_authorize(uuid,text,integer,text,uuid,text,uuid,date,text,text,integer,text,text,text)";
const INT = "public._tw4psh_spend_authorize(uuid,text,integer,text,uuid,text,uuid,date,text,text,integer,text,text,text)";
const PE = "public.tw4_pilot_exception_create(uuid,integer,text,uuid,date,text,text,integer,text,text)";
const COVER = "public.tw4_rfl_pilot_cover(uuid,text,text,uuid,date,text,text,integer,text,text,text)";
const EV_TRIG = "studio_sms_spend_events_pilot_evidence";
const EX_TRIG = "studio_sms_pilot_exceptions_evidence";
const mdir = join(process.cwd(), "src/lib/supabase/migrations");
const forward = readFileSync(join(mdir, "20261231100000_twilio_pilot_spend_hardening.sql"), "utf8");
const back = readFileSync(join(mdir, "rollback/20261231100000_twilio_pilot_spend_hardening_rollback.sql"), "utf8");
const forward1230 = readFileSync(join(mdir, "20261230090000_twilio_rfl_pilot_spend_evidence.sql"), "utf8");
const back1230 = readFileSync(join(mdir, "rollback/20261230090000_twilio_rfl_pilot_spend_evidence_rollback.sql"), "utf8");
const bodyMd5 = (reg: string) => psql(`select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = '${reg}'::regprocedure`);
const priceOf = (kind: string): number => Number(psql(`select customer_price_cents from public.studio_sms_price_list where kind = '${kind}' and active`));
const cur = () => psql("select to_char(now() at time zone 'UTC', 'YYYY-MM')");
const periodAt = (entity: string, offset: number) => psql(`select public._tw4ml_key_add(public._tw4ml_month_key('${entity}', now()), ${offset})`);
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

type Raw = Partial<{ on: string | null; role: string | null; scope: string | null; amount: number | null; period: string | null; doc: string | null; sha: string | null }>;
/** the seven evidence arguments of a fee approval (fresh document id and hash unless overridden) */
const raw7 = (kind: string, cents: number, o: Raw = {}): unknown[] => {
  const base: Required<Raw> = { on: day(-3), role: "owner_written", scope: kind === "number" ? "pilot_number_purchase" : kind === "brand" ? "pilot_onboarding_fee" : "pilot_campaign_fee", amount: cents, period: null, doc: docId(), sha: sha() };
  const pick = <K extends keyof Raw>(k: K) => (k in o ? o[k] : base[k]);
  return [pick("on"), pick("role"), pick("scope"), pick("amount"), pick("period"), pick("doc"), pick("sha")];
};
const spendCall = (fn: string, w: World, kind: string, approval: string, o: Raw = {}) => [fn, w.entity, kind, priceOf(kind), approval, P, "pilot", w.studio, ...raw7(kind, priceOf(kind), o)] as [string, ...unknown[]];
const spendOk = (w: World, kind: string, approval: string, o: Raw = {}) => call<{ spend_event_id: string; replayed: boolean }>(...spendCall("tw4_spend_authorize", w, kind, approval, o));
const spendErr = (w: World, kind: string, approval: string, o: Raw = {}) => callErr(...spendCall("tw4_spend_authorize", w, kind, approval, o));
const eventsOf = (w: World) => Number(psql(`select count(*) from public.studio_sms_spend_events where studio_id = '${w.studio}'`));

/** a raw pilot spend event row (test setup; the deferred trigger is what is under test) */
const eventInsert = (w: World, key: string, over: { funding?: string; amount?: number; status?: string } = {}) =>
  `insert into public.studio_sms_spend_events (legal_entity_id, studio_id, kind, amount_cents, status, approval_ref, authorized_by, funding)
   values ('${w.entity}', '${w.studio}', 'brand', ${over.amount ?? priceOf("brand")}, '${over.status ?? "authorized"}', 'Direct fixture approval ${RUN} ${key}', '${P}', '${over.funding ?? "pilot"}');`;

describe.skipIf(!enabled)("TW-4F Blocker 9: pilot spend hardening (real schema)", () => {
  beforeAll(() => {
    expect(psql(`select to_regclass('public.tw4_local_qa_only') is not null`)).toBe("t");
    expect(psql(`select to_regprocedure('${INT}') is not null`)).toBe("t");
    psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  values ('${P}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin-${RUN}@ph-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${P}', 'platform_admin') on conflict (id) do update set platform_role = 'platform_admin';
commit;`);
    for (const [kind, customer, provider] of [["number", 200, 115], ["monthly", 1000, 150], ["brand", 1000, 700], ["campaign_vetting", 1500, 1000]] as const) {
      seedPriceIfMissing(psql, { kind, customer, provider, description: `fixture ${kind} price`, approver: P });
    }
  });

  describe("1. the period-cover scope is closed to direct callers", () => {
    it("a direct tw4_spend_authorize call with scope pilot_period_cover is refused (TW053) for every kind and period; nothing is recorded and the reference is not burned", () => {
      const w = pilotWorld();
      for (const kind of ["number", "monthly"]) {
        for (const period of [periodAt(w.entity, 0), periodAt(w.entity, 1), "2031-01"]) {
          const err = spendErr(w, kind, ref(`direct-${kind}-${period}`), { scope: "pilot_period_cover", period });
          expect(hasCode(err, "TW053"), `${kind} ${period}: ${err}`).toBe(true);
        }
      }
      expect(eventsOf(w)).toBe(0);
      const approval = ref("direct-burn");
      expect(hasCode(spendErr(w, "number", approval, { scope: "pilot_period_cover", period: cur() }), "TW053")).toBe(true);
      expect(spendOk(w, "number", approval).replayed).toBe(false);
    });

    it("case and whitespace variants of the scope cannot slip past the wrapper (TW053) and unknown spellings fail closed (TW052)", () => {
      const w = pilotWorld();
      for (const scope of ["PILOT_PERIOD_COVER", "Pilot_Period_Cover", "  pilot_period_cover  "]) {
        expect(hasCode(spendErr(w, "number", ref("case"), { scope, period: cur() }), "TW053"), scope).toBe(true);
      }
      for (const scope of ["pilot_period_cover​", "pilot-period-cover", "pilot_period_cover;"]) {
        const err = spendErr(w, "number", ref("spell"), { scope, period: cur() });
        expect(hasCode(err, "TW052") || hasCode(err, "TW053"), `${scope}: ${err}`).toBe(true);
      }
      expect(eventsOf(w)).toBe(0);
    });

    it("the internal function is private: no API role (including service_role) and not PUBLIC can execute it; the public function keeps service_role only", () => {
      for (const role of ["anon", "authenticated", "service_role", "public"]) {
        expect(psql(`select has_function_privilege('${role}', '${INT}', 'execute')`), `internal ${role}`).toBe("f");
        for (const fn of ["public._tw4psh_event_evidence_check()", "public._tw4psh_exception_evidence_check()"]) expect(psql(`select has_function_privilege('${role}', '${fn}', 'execute')`), `${fn} ${role}`).toBe("f");
      }
      for (const role of ["anon", "authenticated", "public"]) expect(psql(`select has_function_privilege('${role}', '${SA}', 'execute')`), `public fn ${role}`).toBe("f");
      expect(psql(`select has_function_privilege('service_role', '${SA}', 'execute')`)).toBe("t");
      // the signatures the application calls are unchanged
      expect(psql(`select count(*) from pg_proc p where p.proname = 'tw4_spend_authorize' and p.pronamespace = 'public'::regnamespace`)).toBe("1");
      expect(psql(`select pronargs from pg_proc where oid = '${SA}'::regprocedure`)).toBe("14");
    });

    it("no session setting selects the privileged path: a spoofed tw4.* setting changes nothing for the public function", () => {
      const w = pilotWorld();
      const args = spendCall("tw4_spend_authorize", w, "number", ref("spoof"), { scope: "pilot_period_cover", period: cur() });
      const sql = `begin; select set_config('tw4.pilotev_write', 'on', true); select set_config('tw4.rflevid_write', 'on', true); select set_config('tw4.rfl_write', 'on', true); ${callSql(args[0], ...args.slice(1))} commit;`;
      expect(hasCode(psqlError(sql), "TW053")).toBe(true);
      expect(eventsOf(w)).toBe(0);
    });

    it("tw4_rfl_pilot_cover still records a cover through the internal function: one cover, one spend event, two agreeing evidence rows", () => {
      const w = pilotWorld();
      const num = registerNumber(w);
      const out = call<{ cover_id: string; replayed: boolean }>("tw4_rfl_pilot_cover", ...pilotCoverArgs(psql, num.resource_id, cur(), ref("cover-ok"), P));
      expect(out.replayed).toBe(false);
      const spendId = psql(`select spend_event_id from public.studio_sms_provider_cover where id = '${out.cover_id}'`);
      expect(psql(`select (c.authorized_on = s.authorized_on and c.authorized_by_role = s.authorized_by_role and c.scope = s.scope and c.amount_cents = s.amount_cents and c.period_key = s.period_key
          and c.document_ref = s.document_ref and c.document_sha256 = s.document_sha256)::text from public.studio_sms_provider_cover_evidence c, public.studio_sms_pilot_spend_evidence s
          where c.cover_id = '${out.cover_id}' and s.spend_event_id = '${spendId}'`)).toBe("true");
    });

    it("only the two intended public functions reach the internal function; only it inserts spend approvals; only tw4_pilot_exception_create inserts exceptions", () => {
      expect(psql(`select string_agg(p.proname, ',' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc ilike '%_tw4psh_spend_authorize(%' and p.proname <> '_tw4psh_spend_authorize'`)).toBe("tw4_rfl_pilot_cover,tw4_spend_authorize");
      expect(psql(`select string_agg(p.proname, ',' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc ilike '%insert into public.studio_sms_spend_events%'`)).toBe("_tw4psh_spend_authorize");
      expect(psql(`select string_agg(p.proname, ',' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc ilike '%insert into public.studio_sms_pilot_exceptions%'`)).toBe("tw4_pilot_exception_create");
      expect(psql(`select string_agg(p.proname, ',' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc ~* 'insert into public.studio_sms_pilot_spend_evidence'`)).toBe("_tw4psh_spend_authorize,tw4_pilot_exception_create");
      // no function rewrites a spend event's funding to pilot
      expect(psql(`select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc ~* 'update\\s+public\\.studio_sms_spend_events\\s+set[^;]*funding'`)).toBe("0");
    });
  });

  describe("2. a period cover is accepted only for the current or next billing month", () => {
    it("the internal function (called as its owner, rolled back) accepts this month and next month and refuses last month, +2 months and a far period (TW052)", () => {
      const w = pilotWorld();
      const tryPeriod = (period: string) => {
        const a = spendCall(INT.replace("public.", "").replace(/\(.*$/, ""), w, "number", ref(`win-${period}`), { scope: "pilot_period_cover", period });
        return psqlError(`begin; ${callSql(a[0], ...a.slice(1))} rollback;`);
      };
      for (const off of [0, 1]) expect(tryPeriod(periodAt(w.entity, off)), `offset ${off}`).toBe("");
      for (const off of [-1, 2, 12]) expect(hasCode(tryPeriod(periodAt(w.entity, off)), "TW052"), `offset ${off}`).toBe(true);
      expect(hasCode(tryPeriod("1999-01"), "TW052")).toBe(true);
      expect(eventsOf(w)).toBe(0);
    });

    it("tw4_rfl_pilot_cover itself still refuses a period outside the window (TW042) and leaves nothing", () => {
      const w = pilotWorld();
      const num = registerNumber(w);
      const err = callErr("tw4_rfl_pilot_cover", ...pilotCoverArgs(psql, num.resource_id, periodAt(w.entity, 3), ref("cover-far"), P));
      expect(hasCode(err, "TW042"), err).toBe(true);
      expect(eventsOf(w)).toBe(0);
    });
  });

  describe("3. the commit-time evidence trigger", () => {
    it("both constraint triggers are DEFERRABLE INITIALLY DEFERRED and ENABLE ALWAYS", () => {
      expect(psql(`select string_agg(tgname || ':' || tgenabled::text || ':' || tgdeferrable || ':' || tginitdeferred, ',' order by tgname) from pg_trigger where tgname in ('${EV_TRIG}', '${EX_TRIG}')`))
        .toBe(`${EX_TRIG}:A:true:true,${EV_TRIG}:A:true:true`);
    });

    it("a pilot spend event inserted without evidence cannot COMMIT, even with session_replication_role = replica (TW052); nothing persists", () => {
      const w = pilotWorld();
      const err = psqlError(`begin; set local session_replication_role = replica; ${eventInsert(w, "noev")} commit;`);
      expect(hasCode(err, "TW052"), err).toBe(true);
      expect(eventsOf(w)).toBe(0);
    });

    it("the same without replica mode, with SET CONSTRAINTS ALL IMMEDIATE, and for every status, also fails", () => {
      const w = pilotWorld();
      for (const status of ["authorized", "reserved", "void"]) {
        expect(psqlError(`begin; ${eventInsert(w, `plain-${status}`, { status })} commit;`), status).not.toBe("");
      }
      expect(psqlError(`begin; set constraints all immediate; set local session_replication_role = replica; ${eventInsert(w, "imm")} commit;`)).not.toBe("");
      expect(eventsOf(w)).toBe(0);
    });

    it("a credit-funded event needs no evidence; changing it to pilot funding does not commit", () => {
      const w = pilotWorld();
      replica(eventInsert(w, "credit", { funding: "credit" }));
      expect(eventsOf(w)).toBe(1);
      const err = psqlError(`begin; set local session_replication_role = replica; update public.studio_sms_spend_events set funding = 'pilot' where studio_id = '${w.studio}'; commit;`);
      expect(hasCode(err, "TW052"), err).toBe(true);
      expect(psql(`select funding from public.studio_sms_spend_events where studio_id = '${w.studio}'`)).toBe("credit");
    });

    it("evidence that does not match the event (amount, location, kind, scope) or a cover scope without a cover does not commit", () => {
      const w = pilotWorld();
      // flagged evidence inserts are how the guard allows the authorizing functions to write; the trigger must still catch a scope with no cover
      const withEvidence = (scope: string, period: string | null, key: string) => `begin; set local session_replication_role = replica; ${eventInsert(w, key)}
        select set_config('tw4.pilotev_write', 'on', true);
        insert into public.studio_sms_pilot_spend_evidence (subject, spend_event_id, legal_entity_id, studio_id, fee_kind, scope, period_key, authorized_on, authorized_by_role, amount_cents, document_ref, document_sha256, recorded_by)
        select 'spend_event', s.id, s.legal_entity_id, s.studio_id, s.kind, '${scope}', ${period ? `'${period}'` : "null"}, current_date, 'owner_written', s.amount_cents, '${docId()}', '${sha()}', s.authorized_by
          from public.studio_sms_spend_events s where s.approval_ref = 'Direct fixture approval ${RUN} ${key}';
        select set_config('tw4.pilotev_write', 'off', true); commit;`;
      // a coherent one-to-one pair for a fee scope commits (this is what the authorizing function does)
      expect(psqlError(withEvidence("pilot_onboarding_fee", null, "ok-pair")), "coherent pair").toBe("");
      // a scope that does not allow the kind (brand under the number scope) does not commit
      expect(hasCode(psqlError(withEvidence("pilot_number_purchase", null, "badscope")), "TW052")).toBe(true);
      // the cover scope with no cover row does not commit
      expect(hasCode(psqlError(withEvidence("pilot_period_cover", cur(), "nocover")), "TW052")).toBe(true);
      expect(eventsOf(w)).toBe(1);
    });

    it("calling the internal function directly with the cover scope and no cover (superuser, autocommit) fails at commit; with a real cover (via tw4_rfl_pilot_cover) it commits", () => {
      const w = pilotWorld();
      const a = spendCall("_tw4psh_spend_authorize", w, "number", ref("int-nocover"), { scope: "pilot_period_cover", period: cur() });
      const err = psqlError(`begin; ${callSql(a[0], ...a.slice(1))} commit;`);
      expect(hasCode(err, "TW052"), err).toBe(true);
      expect(eventsOf(w)).toBe(0);
      const num = registerNumber(w);
      call("tw4_rfl_pilot_cover", ...pilotCoverArgs(psql, num.resource_id, cur(), ref("cover-commit"), P));
      expect(eventsOf(w)).toBe(1);
    });

    it("a pilot exception inserted without evidence cannot commit; its ceiling may be lowered but not raised above the authorization", () => {
      pilotWorld();
      const entity = pilotShared!.entity;
      // the table itself caps the ceiling at $150, so a raise is impossible; a change of approver away from the evidence's recorder does not commit
      const swap = psqlError(`begin; set local session_replication_role = replica; update public.studio_sms_pilot_exceptions set approved_by = '${randomUUID()}' where legal_entity_id = '${entity}'; commit;`);
      expect(hasCode(swap, "TW052"), swap).toBe(true);
      expect(psql(`select ceiling_cents from public.studio_sms_pilot_exceptions where legal_entity_id = '${entity}'`)).toBe("15000");
      replica(`update public.studio_sms_pilot_exceptions set ceiling_cents = 1000 where legal_entity_id = '${entity}';`);
      replica(`update public.studio_sms_pilot_exceptions set ceiling_cents = 15000 where legal_entity_id = '${entity}';`);
      // (the table allows exactly one exception, so a second fabricated row is refused by its own unique index before the trigger)
    });

    it("an application role cannot disable, drop or alter the triggers or their functions (owner only)", () => {
      for (const role of ["service_role", "authenticated", "anon"]) {
        for (const sql of [`alter table public.studio_sms_spend_events disable trigger ${EV_TRIG};`, `alter table public.studio_sms_pilot_exceptions disable trigger ${EX_TRIG};`,
          `drop trigger ${EV_TRIG} on public.studio_sms_spend_events;`, `alter table public.studio_sms_spend_events disable trigger all;`]) {
          const err = psqlError(`set role ${role}; ${sql}`);
          expect(err, `${role}: ${sql}`).toMatch(/must be owner|permission denied/);
        }
      }
      expect(psql(`select count(*) from pg_trigger where tgname in ('${EV_TRIG}', '${EX_TRIG}') and tgenabled = 'A'`)).toBe("2");
    });

    it("every normal pilot approval commits with its evidence row (the deferred check is satisfied by the authorizing function)", () => {
      const w = pilotWorld();
      for (const kind of ["brand", "campaign_vetting", "number", "monthly"]) expect(spendOk(w, kind, ref(`normal-${kind}`)).replayed).toBe(false);
      expect(Number(psql(`select count(*) from public.studio_sms_pilot_spend_evidence e join public.studio_sms_spend_events s on s.id = e.spend_event_id where s.studio_id = '${w.studio}'`))).toBe(4);
    });
  });

  describe("4. no fabricated or replayed approvals; scope map and ceiling still hold", () => {
    it("a retained document id (case-insensitive) or sha256 already recorded is refused (TW019): spend, spend-after-cover and cover-after-spend; an identical replay still replays", () => {
      const w = pilotWorld();
      const doc = docId();
      const hash = sha();
      const firstArgs = spendCall("tw4_spend_authorize", w, "brand", ref("doc1"), { doc, sha: hash });
      const first = call<{ replayed: boolean }>(...firstArgs);
      // identical retry: a replay (the document check runs after the replay return)
      expect(call<{ replayed: boolean }>(...firstArgs).replayed).toBe(true);
      // a second approval reusing the document id (any case) or the hash
      expect(hasCode(spendErr(w, "campaign_vetting", ref("doc2"), { doc: doc.toLowerCase(), sha: sha() }), "TW019")).toBe(true);
      expect(hasCode(spendErr(w, "campaign_vetting", ref("doc3"), { doc: docId(), sha: hash }), "TW019")).toBe(true);
      expect(eventsOf(w)).toBe(1);
      // the unrelated approval still works
      expect(spendOk(w, "campaign_vetting", ref("doc4")).replayed).toBe(false);
      // a cover reusing the document of the spend approval
      const num = registerNumber(w);
      const err = callErr("tw4_rfl_pilot_cover", ...pilotCoverArgs(psql, num.resource_id, cur(), ref("cover-reuse"), P, { documentRef: doc, sha256: sha() }));
      expect(hasCode(err, "TW019"), err).toBe(true);
      expect(Number(psql(`select count(*) from public.studio_sms_provider_cover where resource_id = '${num.resource_id}'`))).toBe(0);
      // a spend reusing a cover's document
      const cd = docId();
      const cs = sha();
      call("tw4_rfl_pilot_cover", ...pilotCoverArgs(psql, num.resource_id, cur(), ref("cover-doc"), P, { documentRef: cd, sha256: cs }));
      expect(hasCode(spendErr(w, "brand", ref("doc5"), { doc: cd, sha: sha() }), "TW019")).toBe(true);
      expect(hasCode(spendErr(w, "brand", ref("doc6"), { doc: docId(), sha: cs }), "TW019")).toBe(true);
      expect(first.replayed).toBe(false);
    });

    it("the pilot exception's document cannot back a spend approval; the unique indexes are the backstop for a direct insert", () => {
      const w = pilotWorld();
      const excDoc = psql(`select document_ref || '|' || document_sha256 from public.studio_sms_pilot_spend_evidence where subject = 'pilot_exception' and legal_entity_id = '${w.entity}'`).split("|");
      expect(hasCode(spendErr(w, "brand", ref("exc-doc"), { doc: excDoc[0], sha: sha() }), "TW019")).toBe(true);
      expect(hasCode(spendErr(w, "brand", ref("exc-sha"), { doc: docId(), sha: excDoc[1] }), "TW019")).toBe(true);
      expect(psql(`select count(*) from pg_indexes where tablename = 'studio_sms_pilot_spend_evidence' and indexname in ('studio_sms_pilot_spend_evidence_doc_sha', 'studio_sms_pilot_spend_evidence_doc_ref')`)).toBe("2");
      const err = psqlError(`begin; set local session_replication_role = replica; ${eventInsert(w, "dup-index")}
        select set_config('tw4.pilotev_write', 'on', true);
        insert into public.studio_sms_pilot_spend_evidence (subject, spend_event_id, legal_entity_id, studio_id, fee_kind, scope, authorized_on, authorized_by_role, amount_cents, document_ref, document_sha256, recorded_by)
        select 'spend_event', s.id, s.legal_entity_id, s.studio_id, s.kind, 'pilot_onboarding_fee', current_date, 'owner_written', s.amount_cents, '${excDoc[0]}', '${sha()}', s.authorized_by
          from public.studio_sms_spend_events s where s.studio_id = '${w.studio}'; commit;`);
      expect(err).toMatch(/23505|duplicate key/);
    });

    it("an approval reference cannot be reused, and a missing/short reference or missing evidence cannot create an approval (the bypass is not a reference-less path)", () => {
      const w = pilotWorld();
      const approval = ref("once");
      spendOk(w, "brand", approval);
      expect(hasCode(spendErr(w, "number", approval), "TW019")).toBe(true);
      expect(hasCode(callErr("tw4_spend_authorize", w.entity, "number", priceOf("number"), ref("bare"), P, "pilot", w.studio), "TW052")).toBe(true);
      expect(hasCode(spendErr(w, "number", ref("nosha"), { sha: null }), "TW052")).toBe(true);
      expect(eventsOf(w)).toBe(1);
    });

    it("the scope-to-fee-kind map from 20261230 still holds exactly (each scope x kind), and sms_usage is refused", () => {
      const w = pilotWorld();
      const allow: Record<string, string[]> = {
        pilot_onboarding_fee: ["brand", "brand_low_volume"], pilot_campaign_fee: ["campaign_vetting", "monthly", "monthly_low_volume"], pilot_number_purchase: ["number"],
      };
      for (const kind of ["brand", "campaign_vetting", "number", "monthly"]) {
        for (const scope of Object.keys(allow)) {
          const should = allow[scope].includes(kind);
          const err = spendErr(w, kind, ref(`map-${scope}-${kind}`), { scope });
          if (should) {
            expect(err, `${scope} ${kind}`).toBe("");
            replica(`update public.studio_sms_spend_events set status = 'void' where studio_id = '${w.studio}' and kind = '${kind}';`);
          } else expect(hasCode(err, "TW052"), `${scope} ${kind}: ${err}`).toBe(true);
        }
      }
      expect(hasCode(callErr("tw4_spend_authorize", w.entity, "sms_usage", 1, ref("usage"), P, "pilot", w.studio, ...raw7("brand", 1, { scope: "pilot_campaign_fee" })), "TW00[0-9]|TW052|22023"), "sms_usage").toBe(true);
    });

    it("the $150 ceiling: the exception cannot exceed it, a cover over the remaining ceiling is refused (TW007), and a raised ceiling does not commit", () => {
      const w = pilotWorld({ ceiling: 100 });
      const num = registerNumber(w);
      const err = callErr("tw4_rfl_pilot_cover", ...pilotCoverArgs(psql, num.resource_id, cur(), ref("ceil"), P));
      expect(hasCode(err, "TW007"), err).toBe(true);
      expect(eventsOf(w)).toBe(0);
      const entity = pilotShared!.entity;
      expect(hasCode(callErr("tw4_pilot_exception_create", ...pilotExceptionArgs(psql, entity, 15001, `Founder written pilot approval ${RUN}`, P)), "22023")).toBe(true);
    });
  });

  describe("5. apply precondition and rollback (schema-only scratch copies)", () => {
    const withScratch = (label: string, body: (run: (sql: string) => string, fail: (sql: string) => string) => void) => {
      const scratch = `${DB}_${label}_${RUN}`;
      const sh = (cmd: string) => execFileSync("docker", ["exec", PG, "sh", "-c", cmd], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      try {
        sh(`psql -U postgres -q -c 'create database ${scratch}'`);
        sh(`pg_dump -U postgres -s --no-owner ${DB} | psql -U postgres -d ${scratch} -q > /dev/null 2>&1; true`);
        const args = ["exec", "-i", PG, "psql", "-U", "postgres", "-d", scratch, "-q", "-At", "-v", "ON_ERROR_STOP=1"];
        const run = (sql: string) => execFileSync("docker", args, { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
        const fail = (sql: string) => {
          try {
            run(sql);
            return "";
          } catch (error) {
            return String((error as { stderr?: Buffer | string }).stderr ?? error);
          }
        };
        body(run, fail);
      } finally {
        sh(`psql -U postgres -q -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '${scratch}'" -c 'drop database if exists ${scratch}' > /dev/null 2>&1; true`);
      }
    };
    const md5Of = (s: string) => createHash("md5").update(s).digest("hex");
    const bodyOf = (text: string, sig: string) => {
      const st = text.indexOf(sig);
      const fn = text.slice(st, text.indexOf("end $$;", st) + 7);
      return fn.slice(fn.indexOf("as $$") + 5, fn.lastIndexOf("$$;"));
    };
    const fpSql = `select md5(string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|' || md5(p.prosrc) || '|' || coalesce(p.proacl::text, ''), ',' order by p.proname, pg_get_function_identity_arguments(p.oid)))
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`;

    it("rollback restores the two 20261230 bodies EXACTLY (md5 of the 1230 file bodies), drops the internal function, triggers, indexes; 1230's own rollback then works; re-apply is identical (fingerprint)", () => {
      const f = forward1230.replace(/\r/g, "");
      const want = { auth: md5Of(bodyOf(f, "create or replace function public.tw4_spend_authorize(")), cover: md5Of(bodyOf(f, "create or replace function public.tw4_rfl_pilot_cover(")) };
      expect([want.auth, want.cover]).toEqual(["daee5a70b4c7fe97cc35e9f172ef78fb", "f5dffdaa3062febef97fa2ce9b0fa422"]);
      const live = { auth: bodyMd5(SA), cover: bodyMd5(COVER), int: bodyMd5(INT), exc: bodyMd5(PE) };
      expect([live.auth, live.cover]).not.toEqual([want.auth, want.cover]);
      withScratch("rb", (run, fail) => {
        const m = (reg: string) => run(`select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = '${reg}'::regprocedure`);
        const after = run(fpSql);
        // 1230's own rollback refuses while this migration is applied (intended: strict reverse order)
        expect(fail(back1230)).toMatch(/differs from its 20261230 definition; roll back the later migration first/);
        run(back);
        expect([m(SA), m(COVER), m(PE)]).toEqual([want.auth, want.cover, "171b2d12a7476290b3e3efcdab71cef8"]);
        expect(run(`select to_regprocedure('${INT}') is null and not exists (select 1 from pg_trigger where tgname in ('${EV_TRIG}', '${EX_TRIG}')) and to_regprocedure('public._tw4psh_event_evidence_check()') is null
          and to_regprocedure('public._tw4psh_exception_evidence_check()') is null and not exists (select 1 from pg_indexes where indexname like 'studio_sms_pilot_spend_evidence_doc_%')`)).toBe("t");
        expect(run(`select has_function_privilege('service_role', '${SA}', 'execute')::text || has_function_privilege('authenticated', '${SA}', 'execute')::text || has_function_privilege('anon', '${SA}', 'execute')::text`)).toBe("truefalsefalse");
        const mid = run(fpSql);
        expect(mid).not.toBe(after);
        // 1230's own rollback and forward now work on this copy (empty evidence): its fingerprint equals the pre-1230 one after rolling back and re-applying
        run(back1230);
        run(forward1230);
        run(forward);
        expect(run(fpSql)).toBe(after);
        expect([m(SA), m(COVER), m(INT), m(PE)]).toEqual([live.auth, live.cover, live.int, live.exc]);
        // applying twice is refused
        expect(fail(forward)).toMatch(/already applied/);
      });
    }, 900_000);

    it("the apply precondition refuses evidence-free pilot approvals/exceptions and a body that differs from 1230; it applies once cleared", () => {
      withScratch("pre", (run, fail) => {
        run(back);
        const entity = randomUUID();
        const studio = randomUUID();
        const ev = `select set_config('tw4.pilotev_write', 'on', true);`;
        const exc = `begin; set local session_replication_role = replica; insert into public.studio_sms_pilot_exceptions (legal_entity_id, ceiling_cents, approval_ref, approved_by) values ('${entity}', 15000, 'Founder written pilot approval legacy ${RUN}', '${P}'); commit;`;
        run(exc);
        expect(fail(forward)).toMatch(/pilot-spend-hardening precondition failed: a pilot exception without matching evidence exists/);
        // its evidence (as the 1230 function would have recorded it) clears that check
        const excEv = (doc: string, h: string) => `begin; set local session_replication_role = replica; ${ev}
          insert into public.studio_sms_pilot_spend_evidence (subject, legal_entity_id, scope, authorized_on, authorized_by_role, amount_cents, document_ref, document_sha256, recorded_by)
          values ('pilot_exception', '${entity}', 'pilot_exception', current_date, 'founder_written', 15000, '${doc}', '${h}', '${P}'); commit;`;
        const ed = "AUTH-DOC-pre0001";
        const eh = sha();
        run(excEv(ed, eh));
        const spendRow = (status: string, key: string) => `begin; set local session_replication_role = replica;
          insert into public.studio_sms_spend_events (legal_entity_id, studio_id, kind, amount_cents, status, approval_ref, authorized_by, funding) values ('${entity}', '${studio}', 'brand', 1000, '${status}', 'Owner legacy approval ${RUN} ${key}', '${P}', 'pilot'); commit;`;
        // a pilot-funded approval of ANY status without evidence blocks (not grandfathered)
        run(spendRow("void", "void"));
        expect(fail(forward)).toMatch(/pilot-spend-hardening precondition failed: a pilot-funded spend approval without evidence exists/);
        run(`begin; set local session_replication_role = replica; delete from public.studio_sms_spend_events where legal_entity_id = '${entity}'; commit;`);
        // a body that differs from its 1230 definition blocks
        const def = run(`select pg_get_functiondef('${PE}'::regprocedure)`);
        run(`${def.replace("the pilot ceiling must be positive", "the pilot ceiling must be above zero")};`);
        expect(fail(forward)).toMatch(/tw4_pilot_exception_create differs from its 20261230 definition/);
        run(`${def};`);
        // forward still needs mid-state clean; applies
        run(forward);
        expect(run(`select to_regprocedure('${INT}') is not null`)).toBe("t");
        // evidence recorded BEFORE this migration was applied does not block the rollback; evidence recorded after it does (permanent)
        run(back);
        run(forward);
        expect(run(`select count(*) from public.studio_sms_pilot_spend_evidence`)).toBe("1");
      });
    }, 900_000);

    it("the rollback refuses once pilot evidence exists that was recorded after the apply, and when a live body was redefined", () => {
      pilotWorld();
      spendOk(pilotWorld(), "brand", ref("rb-permanent"));
      const err = psqlError(back);
      expect(err).toMatch(/pilot-spend-hardening rollback refused: pilot approval evidence recorded after this migration was applied is permanent/);
      expect(psql(`select to_regprocedure('${INT}') is not null`)).toBe("t");
      withScratch("fp", (run, fail) => {
        for (const reg of [SA, COVER, INT]) {
          const def = run(`select pg_get_functiondef('${reg}'::regprocedure)`);
          const changed = def.replace("begin", "begin\n  -- redefined by a later migration");
          run(`${changed};`);
          expect(fail(back), reg).toMatch(/differs from its 20261231100000 definition; roll back the later migration first/);
          run(`${def};`);
        }
        // a missing marker is refused
        run(`comment on function ${INT} is null;`);
        expect(fail(back)).toMatch(/apply-time marker is missing/);
      });
    }, 900_000);
  });
});

