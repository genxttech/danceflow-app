/**
 * TW-4F pilot SPEND approval evidence (20261230090000, owner decision U-4 for every pilot spend approval) against a REAL schema: tw4_spend_authorize(..., 'pilot', location) and
 * tw4_pilot_exception_create carry the owner's / founder's dated written authorization as structured evidence (date, role, scope, amount, period where it applies, document
 * reference, sha256 of the retained text) in the append-only studio_sms_pilot_spend_evidence table; a bare reference is refused (TW052); credit approvals take none; the
 * #305 cover passes its evidence through so both evidence rows agree; the old signatures are gone. Synthetic fixtures with fresh ids; nothing reaches Twilio, Stripe or any SMS path.
 *
 * LOCAL QA ONLY: a DEDICATED Postgres with migrations 20261207090000 .. 20261230090000 applied and the local-QA marker table (public.tw4_local_qa_only):
 *
 *   TW4A_LOCAL_DB_CONTAINER=<container>  TW4RFL_DB=<database>
 *   npx vitest run --no-file-parallelism src/lib/sms/twilioIsv/__tests__/localStack.tw4rflspend.test.ts
 *
 * Run it SERIALLY with the other RFL suites (one pilot business, one shared switch state); never against a shared stack. NOT RUN when authored (no database slot).
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { seedPriceIfMissing } from "./priceFixture";
import { evidenceDay, pilotCoverArgs, pilotExceptionArgs, pilotExceptionEvidenceFor, pilotSpendArgs, pilotSpendEvidenceFor } from "./rflEvidenceHelper";
import type { PilotEvidence } from "@/lib/sms/pilotApprovalEvidence";


vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const DB = process.env.TW4RFL_DB ?? "";
const enabled = Boolean(PG && DB);

const RUN = randomBytes(3).toString("hex");
const P = `ad${RUN}-0000-4000-8000-000000000501`; // platform admin
const P2 = `ad${RUN}-0000-4000-8000-000000000502`;

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
const psqlAsync = (sql: string): Promise<{ out: string; err: string }> =>
  new Promise((resolve) => {
    const child = spawn("docker", sqlArgs, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("close", (code) => resolve({ out: out.trim(), err: code === 0 ? "" : err || "failed" }));
    child.stdin.end(`\\set VERBOSITY verbose\n${sql}`);
  });
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

type World = { entity: string; studio: string; owner: string; account: string; n: number };
let worldSeq = 0;
const PRICE = { number: 0 };
const cur = () => psql("select to_char(now() at time zone 'UTC', 'YYYY-MM')");

/** The platform allows exactly ONE pilot business: every scenario gets a fresh LOCATION of it, a reset ceiling and an account without a hold. */
let pilotShared: { entity: string; account: string } | null = null;
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
  values ('${owner}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pilot-${RUN}@d5-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${owner}', null) on conflict (id) do nothing;
insert into public.studios (id, name, slug, public_name, timezone) values ('${studio}', 'D5 pilot founding', 'd5-pilot-${RUN}', null, 'UTC');
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${entity}', 'ConfiDance Unlimited, LLC', '9999', 15000, '${P}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values ('${studio}', '${entity}', 'founding', '${P}', 'fixture: verified synthetic pilot business', now());
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values ('${entity}', '${account}', 'd5-pilot', 'test', 'active', '${P}');
commit;`);
      call("tw4_credit_adjust", entity, 200_000, `d5-fund-pilot-${RUN}`, "fixture funding for the D5 suite", P);
      call("tw4_monthly_limit_set_admin", entity, P, 20_000, null, "fixture: monthly limit for the D5 suite");
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
  values ('${w.owner}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o-${RUN}-${w.n}@d5-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${w.owner}', null) on conflict (id) do nothing;
insert into public.studios (id, name, slug, public_name, timezone) values ('${w.studio}', 'D5 pilot ${RUN} ${w.n}', 'd5-pilot-${RUN}-${w.n}', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${w.owner}', '${w.studio}', 'studio_owner', true);
commit;
begin; set local session_replication_role = replica;
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values ('${w.studio}', '${w.entity}', 'founding', '${P}', 'fixture: another location of the pilot business', now());
commit;`);
  return w;
}

const registerNumber = (w: World, reservation: string | null = null) => {
  const providerSid = sid("PN");
  const out = call<{ resource_id: string; replayed: boolean; fee_kind: string; initial_cover_skipped?: string }>(
    "tw4_rfl_register", w.studio, P, "number", providerSid, w.account, e164(), "admin", null, reservation);
  return { ...out, sid: providerSid };
};


// ---------------------------------------------------------------------------------------------------------------
// helpers specific to the pilot SPEND evidence functions
// ---------------------------------------------------------------------------------------------------------------
const SA_OLD = "public.tw4_spend_authorize(uuid,text,integer,text,uuid,text,uuid)";
const SA_NEW = "public.tw4_spend_authorize(uuid,text,integer,text,uuid,text,uuid,date,text,text,integer,text,text,text)";
const PE_OLD = "public.tw4_pilot_exception_create(uuid,integer,text,uuid)";
const PE_NEW = "public.tw4_pilot_exception_create(uuid,integer,text,uuid,date,text,text,integer,text,text)";
const COVER_SIG = "public.tw4_rfl_pilot_cover(uuid,text,text,uuid,date,text,text,integer,text,text,text)";
const mdir = join(process.cwd(), "src/lib/supabase/migrations");
const forward = readFileSync(join(mdir, "20261230090000_twilio_rfl_pilot_spend_evidence.sql"), "utf8");
const back = readFileSync(join(mdir, "rollback/20261230090000_twilio_rfl_pilot_spend_evidence_rollback.sql"), "utf8");
const back1231 = readFileSync(join(mdir, "rollback/20261231100000_twilio_pilot_spend_hardening_rollback.sql"), "utf8");
const bodyMd5 = (reg: string) => psql(`select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = '${reg}'::regprocedure`);

const PRICES: Record<string, number> = { brand: 1000, campaign_vetting: 1500, number: 200, monthly: 1000 };
const priceOf = (kind: string): number => Number(psql(`select customer_price_cents from public.studio_sms_price_list where kind = '${kind}' and active`));
type SpendOver = Parameters<typeof pilotSpendArgs>[8];
/** evidence for one pilot fee approval, with per-field overrides (null = a missing field) as the seven raw arguments */
type Raw = Partial<{ on: string | null; role: string | null; scope: string | null; amount: number | null; period: string | null; doc: string | null; sha: string | null }>;
const raw7 = (kind: string, w: World, cents: number, o: Raw = {}): unknown[] => {
  const e = pilotSpendEvidenceFor(kind, w.entity, w.studio, cents);
  const pick = <K extends keyof Raw>(k: K, d: Raw[K]) => (k in o ? o[k] : d);
  return [pick("on", e.authorizedOn), pick("role", e.authorizedByRole), pick("scope", e.scope), pick("amount", e.amountCents), pick("period", null), pick("doc", e.documentRef), pick("sha", e.documentSha256)];
};
const spend = (w: World, kind: string, approval: string, over: SpendOver = {}, actor = P) =>
  call<{ spend_event_id: string; replayed: boolean }>("tw4_spend_authorize", ...pilotSpendArgs(psql, w.entity, kind, priceOf(kind), approval, actor, "pilot", w.studio, over));
const spendErr = (w: World, kind: string, approval: string, o: Raw = {}, actor = P, cents = priceOf(kind)) =>
  callErr("tw4_spend_authorize", w.entity, kind, cents, approval, actor, "pilot", w.studio, ...raw7(kind, w, cents, o));
const spendEvCount = (w: World) => Number(psql(`select count(*) from public.studio_sms_pilot_spend_evidence e join public.studio_sms_spend_events s on s.id = e.spend_event_id where s.studio_id = '${w.studio}'`));
const spendRows = (w: World) => Number(psql(`select count(*) from public.studio_sms_spend_events where studio_id = '${w.studio}'`));
type EvRow = { subject: string; scope: string; kind: string | null; period: string | null; on: string; role: string; cents: number; doc: string; sha: string; by: string };
const evOfSpend = (spendId: string): EvRow =>
  JSON.parse(psql(`select json_build_object('subject', subject, 'scope', scope, 'kind', fee_kind, 'period', period_key, 'on', authorized_on::text, 'role', authorized_by_role, 'cents', amount_cents,
    'doc', document_ref, 'sha', document_sha256, 'by', recorded_by)::text from public.studio_sms_pilot_spend_evidence where spend_event_id = '${spendId}'`)) as EvRow;
const day = (n: number) => evidenceDay(n);

describe.skipIf(!enabled)("TW-4F pilot SPEND approval evidence (real schema)", () => {
  beforeAll(() => {
    expect(psql(`select to_regclass('public.tw4_local_qa_only') is not null`)).toBe("t");
    expect(psql(`select to_regclass('public.studio_sms_pilot_spend_evidence') is not null`)).toBe("t");
    expect(psql(`select to_regprocedure('${SA_NEW}') is not null and to_regprocedure('${PE_NEW}') is not null`)).toBe("t");
    psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  values ('${P}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin-${RUN}@sp-e2e.test', now(), now(), now()),
         ('${P2}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin2-${RUN}@sp-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${P}', 'platform_admin'), ('${P2}', 'platform_admin') on conflict (id) do update set platform_role = 'platform_admin';
commit;`);
    for (const [kind, customer, provider] of [["number", 200, 115], ["monthly", 1000, 150], ["brand", 1000, 700], ["campaign_vetting", 1500, 1000]] as const) {
      seedPriceIfMissing(psql, { kind, customer, provider, description: `fixture ${kind} price`, approver: P });
    }
    PRICE.number = priceOf("number");
    Object.assign(PRICES, { brand: priceOf("brand"), campaign_vetting: priceOf("campaign_vetting"), number: priceOf("number"), monthly: priceOf("monthly") });
  });

  describe("tw4_spend_authorize: a pilot approval carries the owner's dated written authorization", () => {
    for (const kind of ["brand", "campaign_vetting", "number", "monthly"]) {
      it(`${kind}: records the approval and ONE evidence row linked to it, with an audit row naming the evidence`, () => {
        const w = pilotWorld();
        const approval = ref(`happy-${kind}`);
        const out = spend(w, kind, approval);
        expect(out.replayed).toBe(false);
        // the helper derives the document from the approval reference as well (owner rule 2026-10-25: one document per approval)
        const sa = pilotSpendArgs(psql, w.entity, kind, priceOf(kind), approval, P, "pilot", w.studio);
        const e = pilotSpendEvidenceFor(kind, w.entity, w.studio, priceOf(kind), { documentRef: String(sa[12]), documentSha256: String(sa[13]) });
        expect(evOfSpend(out.spend_event_id)).toEqual({ subject: "spend_event", scope: e.scope, kind, period: null, on: e.authorizedOn, role: e.authorizedByRole, cents: priceOf(kind), doc: e.documentRef, sha: e.documentSha256, by: P });
        expect(psql(`select funding || ':' || status || ':' || amount_cents from public.studio_sms_spend_events where id = '${out.spend_event_id}'`)).toBe(`pilot:authorized:${priceOf(kind)}`);
        expect(spendEvCount(w)).toBe(1);
        // the audit row is attributed to ANY location of the business (_tw4c_any_location), so it is found by the evidence id it names
        const evidenceId = psql(`select id from public.studio_sms_pilot_spend_evidence where spend_event_id = '${out.spend_event_id}'`);
        const note = psql(`select note from public.studio_sms_onboarding_audit where action = 'spend_authorized' and note like '%evidence=${evidenceId}%'`);
        expect(note).toContain(`evidence=${evidenceId}`);
        expect(note).toContain(`scope=${e.scope}`);
        expect(note).toContain("doc_sha=" + e.documentSha256.slice(0, 12));
        expect(note).not.toContain(e.documentSha256);
      });
    }

    it("a bare reference (the old seven-argument call) is refused with TW052, records nothing and burns nothing", () => {
      const w = pilotWorld();
      const approval = ref("bare");
      const err = callErr("tw4_spend_authorize", w.entity, "brand", priceOf("brand"), approval, P, "pilot", w.studio);
      expect(hasCode(err, "TW052"), err).toBe(true);
      expect(spendRows(w)).toBe(0);
      expect(spendEvCount(w)).toBe(0);
      // the reference is not burned: the same reference then works with valid evidence
      expect(spend(w, "brand", approval).replayed).toBe(false);
    });

    const day2 = (n: number) => day(n);
    const refusals: [string, (kind: string, cents: number) => Raw, string][] = [
      ["missing date", () => ({ on: null }), "TW052"],
      ["tomorrow (later than the UTC date)", () => ({ on: day2(1) }), "TW052"],
      ["older than 400 days", () => ({ on: day2(-402) }), "TW052"],
      ["wrong role", () => ({ role: "policy_lapse" }), "TW052"],
      ["missing role", () => ({ role: null }), "TW052"],
      ["missing scope", () => ({ scope: null }), "TW052"],
      ["unknown scope", () => ({ scope: "standing_authorization" }), "TW052"],
      ["the exception scope on a fee", () => ({ scope: "pilot_exception" }), "TW052"],
      ["a scope that does not allow the fee kind", (kind) => ({ scope: kind === "brand" ? "pilot_number_purchase" : "pilot_onboarding_fee" }), "TW052"],
      ["the cover scope without a period (a direct call can never use the cover scope: TW053, 20261231100000)", () => ({ scope: "pilot_period_cover", period: null }), "TW053"],
      ["a non-cover scope that names a period", () => ({ period: "2026-10" }), "TW052"],
      ["missing evidence amount", () => ({ amount: null }), "TW052"],
      ["evidence amount differs from the amount approved", (_k, cents) => ({ amount: cents + 1 }), "TW052"],
      ["missing document reference", () => ({ doc: null }), "TW052"],
      ["document reference with spaces", () => ({ doc: "AUTH DOC TEXT 0001" }), "TW052"],
      ["document id with a colon (javascript-style)", () => ({ doc: "javascript:alert1" }), "TW052"],
      ["document id with an equals sign", () => ({ doc: "AUTH=DOC-0001" }), "TW052"],
      ["http link", () => ({ doc: "http://docs.example.com/a" }), "TW052"],
      ["https link with a query string", () => ({ doc: "https://docs.example.com/a?token=1" }), "TW052"],
      ["https link with credentials", () => ({ doc: "https://u:p@docs.example.com/a" }), "TW052"],
      ["https link with a semicolon", () => ({ doc: "https://docs.example.com/a;b" }), "TW052"],
      ["https link with an ampersand", () => ({ doc: "https://docs.example.com/a&b" }), "TW052"],
      ["https link with an equals sign", () => ({ doc: "https://docs.example.com/a=b" }), "TW052"],
      ["https link with a percent escape", () => ({ doc: "https://docs.example.com/a%20b" }), "TW052"],
      ["https link with a fragment", () => ({ doc: "https://docs.example.com/a#frag" }), "TW052"],
      ["short sha256", () => ({ sha: "abc" }), "TW052"],
      ["upper-case sha256", () => ({ sha: "A".repeat(64) }), "TW052"],
      ["non-hex sha256", () => ({ sha: "g".repeat(64) }), "TW052"],
      ["missing sha256", () => ({ sha: null }), "TW052"],
    ];
    for (const [name, make, code] of refusals) {
      it(`refuses ${name}: ${code}; nothing is recorded and the reference is not burned`, () => {
        const w = pilotWorld();
        const approval = ref("refusal");
        const cents = priceOf("brand");
        const err = spendErr(w, "brand", approval, make("brand", cents), P, cents);
        expect(hasCode(err, code), err).toBe(true);
        expect(spendRows(w)).toBe(0);
        expect(spendEvCount(w)).toBe(0);
        expect(spend(w, "brand", approval).replayed).toBe(false);
      });
    }

    it("a fee kind outside the scope map is refused (fail closed, never defaulted)", () => {
      const w = pilotWorld();
      for (const scope of ["pilot_onboarding_fee", "pilot_campaign_fee", "pilot_number_purchase", "pilot_period_cover"]) {
        const err = callErr("tw4_spend_authorize", w.entity, "sms_usage", 100, ref(`unmapped-${scope}`), P, "pilot", w.studio, day(-3), "owner_written", scope, 100, scope === "pilot_period_cover" ? cur() : null, "AUTH-DOC-UNMAPPED1", "e".repeat(64));
        // 20261231100000: the cover scope is refused earlier (TW053) for a direct call
        expect(hasCode(err, scope === "pilot_period_cover" ? "TW053" : "TW052"), `${scope}: ${err}`).toBe(true);
      }
      expect(spendRows(w)).toBe(0);
    });

    it("every kind is accepted only by the scopes that allow it, and the cover scope with its period", () => {
      const allowed: Record<string, string[]> = {
        brand: ["pilot_onboarding_fee"], campaign_vetting: ["pilot_campaign_fee"], number: ["pilot_number_purchase", "pilot_period_cover"], monthly: ["pilot_campaign_fee", "pilot_period_cover"],
      };
      for (const [kind, scopes] of Object.entries(allowed)) {
        for (const scope of ["pilot_onboarding_fee", "pilot_campaign_fee", "pilot_number_purchase", "pilot_period_cover"]) {
          const w = pilotWorld();
          const period = scope === "pilot_period_cover" ? cur() : null;
          const err = spendErr(w, kind, ref(`map-${kind}-${scope}`), { scope, period });
          // 20261231100000: a direct call can never use the cover scope (TW053); the cover itself is tested through tw4_rfl_pilot_cover
          if (scope === "pilot_period_cover") expect(hasCode(err, "TW053"), `${kind}/${scope}: ${err}`).toBe(true);
          else if (scopes.includes(scope)) expect(err, `${kind}/${scope}`).toBe("");
          else expect(hasCode(err, "TW052"), `${kind}/${scope}: ${err}`).toBe(true);
        }
      }
    });

    it("the amount approved must still equal the published price (TW008) even when the evidence agrees with it", () => {
      const w = pilotWorld();
      const cents = priceOf("brand") + 1;
      const err = spendErr(w, "brand", ref("price"), {}, P, cents);
      expect(hasCode(err, "TW008"), err).toBe(true);
      expect(spendRows(w)).toBe(0);
    });

    it("the existing pilot checks come first: a missing location or a short reference is 22023, unchanged", () => {
      const w = pilotWorld();
      const ok7 = raw7("brand", w, priceOf("brand"));
      expect(hasCode(callErr("tw4_spend_authorize", w.entity, "brand", priceOf("brand"), ref("noloc"), P, "pilot", null, ...ok7), "22023")).toBe(true);
      expect(hasCode(callErr("tw4_spend_authorize", w.entity, "brand", priceOf("brand"), "short", P, "pilot", w.studio, ...ok7), "22023")).toBe(true);
    });

    it("platform administrators only: a studio owner is refused (42501) and nothing is recorded", () => {
      const w = pilotWorld();
      expect(hasCode(spendErr(w, "brand", ref("owner"), {}, w.owner), "42501")).toBe(true);
      expect(spendRows(w)).toBe(0);
      expect(spendEvCount(w)).toBe(0);
    });
  });

  describe("credit-funded approvals are unchanged and take no evidence", () => {
    it("a credit approval without evidence still works and records no evidence row", () => {
      const w = pilotWorld();
      const out = call<{ spend_event_id: string; replayed: boolean }>("tw4_spend_authorize", w.entity, "brand", priceOf("brand"), ref("credit"), P, "credit", w.studio);
      expect(out.replayed).toBe(false);
      expect(psql(`select funding from public.studio_sms_spend_events where id = '${out.spend_event_id}'`)).toBe("credit");
      expect(Number(psql(`select count(*) from public.studio_sms_pilot_spend_evidence where spend_event_id = '${out.spend_event_id}'`))).toBe(0);
    });

    it("a credit approval WITH any evidence argument is refused (TW052): the default-null arguments cannot smuggle evidence into a credit path", () => {
      const w = pilotWorld();
      const cents = priceOf("brand");
      const full = raw7("brand", w, cents);
      expect(hasCode(callErr("tw4_spend_authorize", w.entity, "brand", cents, ref("credit-ev"), P, "credit", w.studio, ...full), "TW052")).toBe(true);
      for (let i = 0; i < 7; i += 1) {
        // the period is null in a fee-scope evidence set, so that one position is exercised with a period value
        const one = full.map((v, j) => (j === i ? (i === 4 ? cur() : v) : null));
        expect(hasCode(callErr("tw4_spend_authorize", w.entity, "brand", cents, ref(`credit-ev-${i}`), P, "credit", w.studio, ...one), "TW052"), `argument ${i}`).toBe(true);
      }
      expect(spendRows(w)).toBe(0);
    });

    it("the default-null evidence arguments are refused for a pilot approval, in every position", () => {
      const w = pilotWorld();
      const cents = priceOf("brand");
      const full = raw7("brand", w, cents);
      for (let i = 0; i < 7; i += 1) {
        if (i === 4) continue; // the period is null for a fee scope by design
        const missing = full.map((v, j) => (j === i ? null : v));
        expect(hasCode(callErr("tw4_spend_authorize", w.entity, "brand", cents, ref(`pilot-missing-${i}`), P, "pilot", w.studio, ...missing), "TW052"), `argument ${i}`).toBe(true);
      }
      expect(spendRows(w)).toBe(0);
    });
  });

  describe("replay, reuse, races", () => {
    it("an identical retry (the same evidence, even with a differently-spelled reference) replays the SAME approval; different evidence for the same reference is TW019", () => {
      const w = pilotWorld();
      const approval = `Owner approved the REAL ${RUN} brand fee ${hex(3)}`;
      const first = spend(w, "brand", approval);
      const again = spend(w, "brand", approval.toLowerCase());
      expect([again.replayed, again.spend_event_id]).toEqual([true, first.spend_event_id]);
      expect(spendEvCount(w)).toBe(1);
      expect(spendRows(w)).toBe(1);
      expect(hasCode(spendErr(w, "brand", approval, { sha: "f".repeat(64) }), "TW019")).toBe(true);
      expect(hasCode(spendErr(w, "brand", approval, { role: "founder_written" }), "TW019")).toBe(true);
      expect(hasCode(spendErr(w, "brand", approval, { on: day(-4) }), "TW019")).toBe(true);
      expect(spendEvCount(w)).toBe(1);
    });

    it("one reference authorizes one operation (TW019): another kind, another location or another admin may not reuse it", () => {
      const w = pilotWorld();
      const approval = ref("reuse");
      spend(w, "brand", approval);
      expect(hasCode(spendErr(w, "campaign_vetting", approval), "TW019")).toBe(true);
      expect(hasCode(spendErr(w, "brand", approval, {}, P2), "TW019")).toBe(true);
      const w2 = pilotWorld();
      expect(hasCode(spendErr(w2, "brand", approval), "TW019")).toBe(true);
      expect(spendRows(w2)).toBe(0);
    });

    it("two identical calls racing: one records, the other replays; one approval, one evidence row", async () => {
      const w = pilotWorld();
      const approval = ref("race-same");
      const cents = priceOf("brand");
      const args = pilotSpendArgs(psql, w.entity, "brand", cents, approval, P, "pilot", w.studio);
      const results = await Promise.all([1, 2].map(() => psqlAsync(callSql("tw4_spend_authorize", ...args))));
      expect(results.every((r) => r.err === ""), JSON.stringify(results)).toBe(true);
      const outs = results.map((r) => JSON.parse(r.out) as { replayed: boolean; spend_event_id: string });
      expect(outs.filter((o) => !o.replayed)).toHaveLength(1);
      expect(outs[0].spend_event_id).toBe(outs[1].spend_event_id);
      expect(spendRows(w)).toBe(1);
      expect(spendEvCount(w)).toBe(1);
    });

    it("the same reference racing with DIFFERENT evidence: exactly one wins, the other is TW019", async () => {
      const w = pilotWorld();
      const approval = ref("race-diff");
      const cents = priceOf("brand");
      const calls = [{}, { sha: "d".repeat(64) }].map((o) => callSql("tw4_spend_authorize", w.entity, "brand", cents, approval, P, "pilot", w.studio, ...raw7("brand", w, cents, o as Raw)));
      const results = await Promise.all(calls.map((c) => psqlAsync(c)));
      expect(results.filter((r) => r.err === "")).toHaveLength(1);
      expect(results.filter((r) => r.err !== "").every((r) => hasCode(r.err, "TW019"))).toBe(true);
      expect(spendRows(w)).toBe(1);
      expect(spendEvCount(w)).toBe(1);
    });
  });

  describe("tw4_pilot_exception_create: the founder's dated written authorization of the ceiling", () => {
    const entity = () => psql(`select legal_entity_id from public.studio_sms_pilot_exceptions limit 1`);
    const excArgs = (over: Partial<PilotEvidence> = {}, ceiling = 15000, approval = `Founder written pilot approval ${RUN}`, actor = P) => pilotExceptionArgs(psql, entity(), ceiling, approval, actor, over);
    const excErr = (over: Partial<PilotEvidence> = {}, ceiling = 15000, approval = `Founder written pilot approval ${RUN}`, actor = P) => callErr("tw4_pilot_exception_create", ...excArgs(over, ceiling, approval, actor));
    const raw6 = (o: Partial<{ on: string | null; role: string | null; scope: string | null; amount: number | null; doc: string | null; sha: string | null }> = {}, ceiling = 15000) => {
      const e = pilotExceptionEvidenceFor(entity(), ceiling);
      const pick = <K extends keyof typeof o>(k: K, d: (typeof o)[K]) => (k in o ? o[k] : d);
      return [pick("on", e.authorizedOn), pick("role", e.authorizedByRole), pick("scope", e.scope), pick("amount", e.amountCents), pick("doc", e.documentRef), pick("sha", e.documentSha256)];
    };
    const rawErr = (o: Parameters<typeof raw6>[0] = {}, ceiling = 15000, approval = `Founder written pilot approval ${RUN}`, actor = P) =>
      callErr("tw4_pilot_exception_create", entity(), ceiling, approval, actor, ...raw6(o, ceiling));

    it("the exception the fixture created carries its evidence row (subject pilot_exception, the ceiling as amount, founder role, no period or kind)", () => {
      pilotWorld();
      const row = JSON.parse(psql(`select json_build_object('subject', subject, 'scope', scope, 'kind', fee_kind, 'period', period_key, 'studio', studio_id, 'cents', amount_cents, 'role', authorized_by_role, 'spend', spend_event_id,
        'sha', document_sha256)::text from public.studio_sms_pilot_spend_evidence where subject = 'pilot_exception'`)) as Record<string, unknown>;
      expect(row).toMatchObject({ subject: "pilot_exception", scope: "pilot_exception", kind: null, period: null, studio: null, spend: null, cents: 15000, role: "founder_written" });
      expect(String(row.sha)).toMatch(/^[0-9a-f]{64}$/);
      expect(psql(`select count(*) from public.studio_sms_pilot_spend_evidence where subject = 'pilot_exception'`)).toBe("1");
      expect(psql(`select note from public.studio_sms_onboarding_audit where action = 'credit_pilot_exception' order by created_at desc limit 1`)).toContain("evidence=");
    });

    it("an exact replay is a replay; different evidence is TW019; another ceiling is 23505 (with its own consistent evidence)", () => {
      pilotWorld();
      const out = call<{ replayed: boolean; ceiling_cents: number }>("tw4_pilot_exception_create", ...excArgs());
      expect([out.replayed, out.ceiling_cents]).toEqual([true, 15000]);
      expect(hasCode(excErr({ documentSha256: "f".repeat(64) }), "TW019")).toBe(true);
      expect(hasCode(excErr({ authorizedByRole: "owner_written" }), "TW019")).toBe(true);
      expect(hasCode(excErr({}, 12000), "23505")).toBe(true);
      expect(psql(`select count(*) from public.studio_sms_pilot_spend_evidence where subject = 'pilot_exception'`)).toBe("1");
    });

    const cases: [string, Parameters<typeof raw6>[0], string][] = [
      ["a bare reference (the old four-argument call)", undefined, "ERR4"],
      ["missing date", { on: null }, "TW052"],
      ["tomorrow", { on: day(1) }, "TW052"],
      ["older than 400 days", { on: day(-402) }, "TW052"],
      ["wrong role", { role: "policy_lapse" }, "TW052"],
      ["missing role", { role: null }, "TW052"],
      ["a fee scope", { scope: "pilot_onboarding_fee" }, "TW052"],
      ["missing scope", { scope: null }, "TW052"],
      ["amount different from the ceiling", { amount: 14999 }, "TW052"],
      ["missing amount", { amount: null }, "TW052"],
      ["missing document", { doc: null }, "TW052"],
      ["https link with a query string", { doc: "https://docs.example.com/a?x=1" }, "TW052"],
      ["javascript-style id", { doc: "javascript:alert1" }, "TW052"],
      ["short sha", { sha: "abc" }, "TW052"],
      ["upper-case sha", { sha: "A".repeat(64) }, "TW052"],
      ["missing sha", { sha: null }, "TW052"],
    ];
    for (const [name, over, code] of cases) {
      it(`refuses ${name}`, () => {
        pilotWorld();
        const err = code === "ERR4" ? callErr("tw4_pilot_exception_create", entity(), 15000, `Founder written pilot approval ${RUN}`, P) : rawErr(over);
        if (code === "ERR4") expect(err).toMatch(/42883|does not exist/);
        else expect(hasCode(err, code), err).toBe(true);
        expect(psql(`select count(*) from public.studio_sms_pilot_spend_evidence where subject = 'pilot_exception'`)).toBe("1");
      });
    }

    it("the existing validations come first and are unchanged (22023 for a reference outside 10..200, 42501 for a non-administrator)", () => {
      const w = pilotWorld();
      expect(hasCode(rawErr({}, 15000, "short"), "22023")).toBe(true);
      expect(hasCode(rawErr({}, 15000, "x".repeat(201)), "22023")).toBe(true);
      expect(hasCode(rawErr({}, 15000, `Founder written pilot approval ${RUN}`, w.owner), "42501")).toBe(true);
      expect(hasCode(rawErr({}, 15001), "22023")).toBe(true);
    });
  });

  describe("the #305 cover passes its evidence through: the two evidence rows cannot disagree", () => {
    it("a pilot period cover creates the cover evidence row AND the spend evidence row with identical fields, in one transaction", () => {
      const w = pilotWorld();
      const num = registerNumber(w, null);
      const approval = ref("cover-through");
      const out = call<{ cover_id: string; evidence_id: string }>("tw4_rfl_pilot_cover", ...pilotCoverArgs(psql, num.resource_id, cur(), approval, P));
      const spendId = psql(`select spend_event_id from public.studio_sms_provider_cover where id = '${out.cover_id}'`);
      const both = psql(`select (c.authorized_on = s.authorized_on and c.authorized_by_role = s.authorized_by_role and c.scope = s.scope and c.amount_cents = s.amount_cents and c.period_key = s.period_key
          and c.document_ref = s.document_ref and c.document_sha256 = s.document_sha256 and c.recorded_by = s.recorded_by and c.legal_entity_id = s.legal_entity_id and c.studio_id = s.studio_id)::text
        from public.studio_sms_provider_cover_evidence c, public.studio_sms_pilot_spend_evidence s where c.cover_id = '${out.cover_id}' and s.spend_event_id = '${spendId}'`);
      expect(both).toBe("true");
      expect(psql(`select count(*) from public.studio_sms_pilot_spend_evidence where spend_event_id = '${spendId}' and scope = 'pilot_period_cover' and period_key = '${cur()}'`)).toBe("1");
    });

    it("a refused cover (evidence or price) leaves neither row; a replayed cover leaves exactly one of each", () => {
      const w = pilotWorld();
      const num = registerNumber(w, null);
      const approval = ref("cover-refused");
      expect(hasCode(callErr("tw4_rfl_pilot_cover", ...pilotCoverArgs(psql, num.resource_id, cur(), approval, P, { sha256: "nothex" })), "TW052")).toBe(true);
      expect(spendRows(w)).toBe(0);
      const args = pilotCoverArgs(psql, num.resource_id, cur(), approval, P);
      call("tw4_rfl_pilot_cover", ...args);
      call("tw4_rfl_pilot_cover", ...args);
      expect(spendEvCount(w)).toBe(1);
      expect(Number(psql(`select count(*) from public.studio_sms_provider_cover_evidence where resource_id = '${num.resource_id}'`))).toBe(1);
    });
  });

  describe("no evidence-free path remains", () => {
    it("both old signatures are gone, exactly one function of each name exists, and a 4/7-argument call cannot create a pilot approval", () => {
      expect(psql(`select to_regprocedure('${SA_OLD}') is null and to_regprocedure('${PE_OLD}') is null`)).toBe("t");
      expect(psql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('tw4_spend_authorize', 'tw4_pilot_exception_create')`)).toBe("2");
      const w = pilotWorld();
      expect(hasCode(callErr("tw4_spend_authorize", w.entity, "brand", priceOf("brand"), ref("seven"), P, "pilot", w.studio), "TW052")).toBe(true);
      expect(spendRows(w)).toBe(0);
    });

    it("tw4_spend_authorize is the ONLY function that inserts a spend approval, so no automated path can create a pilot approval (runners only reserve against an existing event)", () => {
      expect(psql(`select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosrc ilike '%insert into public.studio_sms_spend_events%'`)).toBe("_tw4psh_spend_authorize");
      // (20261231100000: the insert moved into the internal function behind the public tw4_spend_authorize wrapper)
      // and every reservation insert that takes a funding from a variable reads it from the authorized event
      expect(psql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosrc ilike '%insert into public.studio_sms_pilot_spend_evidence%'`)).toBe("2");
    });

    it("grants: service_role only for both functions, nothing for anon/authenticated/public, the guard function is private", () => {
      for (const sig of [SA_NEW, PE_NEW]) {
        for (const role of ["anon", "authenticated", "public"]) expect(psql(`select has_function_privilege('${role}', '${sig}', 'execute')`), `${role} ${sig}`).toBe("f");
        expect(psql(`select has_function_privilege('service_role', '${sig}', 'execute')`), sig).toBe("t");
      }
      for (const role of ["anon", "authenticated", "service_role"]) expect(psql(`select has_function_privilege('${role}', 'public._tw4pse_guard()', 'execute')`), role).toBe("f");
    });
  });

  describe("the evidence is append-only, private and tied to its record; it stores no text", () => {
    it("update, delete, truncate and a direct insert are all refused; a flagged insert for a record it does not describe is refused", () => {
      const w = pilotWorld();
      const out = spend(w, "brand", ref("append-only"));
      expect(psqlError(`update public.studio_sms_pilot_spend_evidence set scope = 'pilot_campaign_fee' where spend_event_id = '${out.spend_event_id}';`)).toMatch(/42501/);
      expect(psqlError(`begin; select set_config('tw4.pilotev_write', 'on', true); update public.studio_sms_pilot_spend_evidence set amount_cents = 1 where spend_event_id = '${out.spend_event_id}'; commit;`)).toMatch(/42501/);
      expect(psqlError(`delete from public.studio_sms_pilot_spend_evidence where spend_event_id = '${out.spend_event_id}';`)).toMatch(/42501/);
      expect(psqlError(`truncate public.studio_sms_pilot_spend_evidence;`)).toMatch(/./);
      const ins = (flag: boolean, spendId: string, cents: number) => psqlError(`begin; ${flag ? "select set_config('tw4.pilotev_write', 'on', true);" : ""}
        insert into public.studio_sms_pilot_spend_evidence (subject, spend_event_id, legal_entity_id, studio_id, fee_kind, scope, authorized_on, authorized_by_role, amount_cents, document_ref, document_sha256, recorded_by)
        values ('spend_event', '${spendId}', '${w.entity}', '${w.studio}', 'brand', 'pilot_onboarding_fee', current_date, 'owner_written', ${cents}, 'AUTH-DOC-X1234', '${"1".repeat(64)}', '${P}'); commit;`);
      expect(ins(false, randomUUID(), 1000)).toMatch(/42501/);
      expect(ins(true, out.spend_event_id, priceOf("brand"))).toMatch(/23505|duplicate key|42501/);
      expect(ins(true, randomUUID(), 1000)).toMatch(/42501|23503/);
      expect(spendEvCount(w)).toBe(1);
    });

    it("a credit-funded approval can never have evidence, and an evidence row's amount must be its approval's amount", () => {
      const w = pilotWorld();
      const credit = call<{ spend_event_id: string }>("tw4_spend_authorize", w.entity, "brand", priceOf("brand"), ref("credit-no-ev"), P, "credit", w.studio);
      const ins = (spendId: string, cents: number) => psqlError(`begin; select set_config('tw4.pilotev_write', 'on', true);
        insert into public.studio_sms_pilot_spend_evidence (subject, spend_event_id, legal_entity_id, studio_id, fee_kind, scope, authorized_on, authorized_by_role, amount_cents, document_ref, document_sha256, recorded_by)
        values ('spend_event', '${spendId}', '${w.entity}', '${w.studio}', 'brand', 'pilot_onboarding_fee', current_date, 'owner_written', ${cents}, 'AUTH-DOC-X1234', '${"1".repeat(64)}', '${P}'); commit;`);
      expect(ins(credit.spend_event_id, priceOf("brand"))).toMatch(/42501/);
      const pilot = spend(w, "campaign_vetting", ref("amount-guard"));
      expect(psql(`select count(*) from public.studio_sms_pilot_spend_evidence where spend_event_id = '${pilot.spend_event_id}'`)).toBe("1");
    });

    it("RLS is on and no API role can read or write the table; only hash and reference columns exist (no free text)", () => {
      expect(psql(`select relrowsecurity from pg_class where oid = 'public.studio_sms_pilot_spend_evidence'::regclass`)).toBe("t");
      for (const role of ["anon", "authenticated", "service_role"]) {
        const script = `begin; set local role ${role}; select count(*) from public.studio_sms_pilot_spend_evidence; rollback;\nbegin; set local role ${role}; delete from public.studio_sms_pilot_spend_evidence; rollback;\n`;
        const res = spawnSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-q", "-At", "-v", "ON_ERROR_STOP=0"], { input: script, encoding: "utf8" });
        expect(res.stdout.trim()).toBe("");
        expect((res.stderr.match(/permission denied/g) ?? []).length).toBe(2);
      }
      expect(psql(`select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_schema = 'public' and table_name = 'studio_sms_pilot_spend_evidence'`))
        .toBe("amount_cents,authorized_by_role,authorized_on,document_ref,document_sha256,fee_kind,id,legal_entity_id,period_key,recorded_at,recorded_by,scope,spend_event_id,studio_id,subject");
    });
  });

  describe("apply precondition and rollback (on schema-only scratch copies)", () => {
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
        // 20261231100000 (pilot spend hardening) sits on top of this migration: strict reverse order, it is rolled back first so this copy is at the 20261230 shape
        if (run(`select to_regprocedure('public._tw4psh_spend_authorize(uuid,text,integer,text,uuid,text,uuid,date,text,text,integer,text,text,text)') is not null`) === "t") run(back1231);
        body(run, fail);
      } finally {
        sh(`psql -U postgres -q -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '${scratch}'" -c 'drop database if exists ${scratch}' > /dev/null 2>&1; true`);
      }
    };

    it("refuses to apply while a live pilot exception, or a live pilot-funded approval, exists without evidence; a void one and a #305 cover's approval do not block", () => {
      withScratch("pre", (run, fail) => {
        run(back); // schema only: no evidence rows, so the rollback is allowed and the copy is at the 20261229 shape
        expect(run(`select to_regprocedure('${SA_OLD}') is not null and to_regprocedure('${PE_OLD}') is not null and to_regclass('public.studio_sms_pilot_spend_evidence') is null`)).toBe("t");
        const entityId = randomUUID();
        const studioId = randomUUID();
        const insertException = `begin; set local session_replication_role = replica;
          insert into public.studio_sms_pilot_exceptions (legal_entity_id, ceiling_cents, approval_ref, approved_by) values ('${entityId}', 15000, 'Founder written pilot approval legacy ${RUN}', '${P}'); commit;`;
        run(insertException);
        expect(fail(forward)).toMatch(/pilot-spend-evidence precondition failed: a pilot exception without evidence exists/);
        expect(run(`select to_regclass('public.studio_sms_pilot_spend_evidence') is null`)).toBe("t");
        run(`begin; set local session_replication_role = replica; delete from public.studio_sms_pilot_exceptions where legal_entity_id = '${entityId}'; commit;`);
        const spendRow = (status: string, key: string) => `begin; set local session_replication_role = replica;
          insert into public.studio_sms_spend_events (legal_entity_id, studio_id, kind, amount_cents, status, approval_ref, authorized_by, funding) values ('${entityId}', '${studioId}', 'brand', 1000, '${status}', 'Owner legacy approval ${RUN} ${key}', '${P}', 'pilot'); commit;`;
        run(spendRow("void", "void"));
        // a void pilot approval is history, not a live approval: it does not block
        run(spendRow("authorized", "live"));
        expect(fail(forward)).toMatch(/pilot-spend-evidence precondition failed: live pilot-funded spend approvals without evidence exist/);
        run(`begin; set local session_replication_role = replica; delete from public.studio_sms_spend_events where legal_entity_id = '${entityId}'; commit;`);
        run(spendRow("void", "void2"));
        run(forward);
        expect(run(`select to_regprocedure('${SA_NEW}') is not null and to_regprocedure('${PE_NEW}') is not null and to_regprocedure('${SA_OLD}') is null and to_regprocedure('${PE_OLD}') is null`)).toBe("t");
      });
    });

    it("the rollback restores the three predecessor bodies EXACTLY (old signatures back, md5 of the 20261202 / 20261122 / 20261229 bodies) and a re-apply is identical", () => {
      const md5Of = (s: string) => createHash("md5").update(s).digest("hex");
      const bodyOf = (text: string, sig: string) => {
        const st = text.indexOf(sig);
        const fn = text.slice(st, text.indexOf("end $$;", st) + 7);
        return fn.slice(fn.indexOf("as $$") + 5, fn.lastIndexOf("$$;"));
      };
      const m1202 = readFileSync(join(mdir, "20261202090000_twilio_tw4f_financial_integrity.sql"), "utf8").replace(/\r/g, "");
      const m1122 = readFileSync(join(mdir, "20261122090000_twilio_tw4f3b0_prepaid_credits.sql"), "utf8").replace(/\r/g, "");
      const m1229 = readFileSync(join(mdir, "20261229090000_twilio_rfl_pilot_evidence.sql"), "utf8").replace(/\r/g, "");
      const want = {
        auth: md5Of(bodyOf(m1202, "create or replace function public.tw4_spend_authorize(")), exc: md5Of(bodyOf(m1122, "create or replace function public.tw4_pilot_exception_create(")),
        cover: md5Of(bodyOf(m1229, "create or replace function public.tw4_rfl_pilot_cover(")),
      };
      expect(want.cover).toBe("deffc1b878778dced134334260d62512");
      // the 20261230 bodies (the live ones are 20261231100000's wrapper and cover)
      const nowMd5 = { auth: "daee5a70b4c7fe97cc35e9f172ef78fb", exc: "171b2d12a7476290b3e3efcdab71cef8", cover: "f5dffdaa3062febef97fa2ce9b0fa422" };
      withScratch("rb", (run) => {
        const fp = () => run(`select md5(string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|' || md5(p.prosrc), ',' order by p.proname, pg_get_function_identity_arguments(p.oid))) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`);
        const after = fp();
        run(back);
        const m = (reg: string) => run(`select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = '${reg}'::regprocedure`);
        expect([m(SA_OLD), m(PE_OLD), m(COVER_SIG)]).toEqual([want.auth, want.exc, want.cover]);
        expect(run(`select to_regprocedure('${SA_NEW}') is null and to_regprocedure('${PE_NEW}') is null and to_regclass('public.studio_sms_pilot_spend_evidence') is null and to_regprocedure('public._tw4pse_guard()') is null`)).toBe("t");
        // grants restored like the originals
        for (const reg of [SA_OLD, PE_OLD]) {
          expect(run(`select has_function_privilege('service_role', '${reg}', 'execute')`)).toBe("t");
          for (const role of ["anon", "authenticated"]) expect(run(`select has_function_privilege('${role}', '${reg}', 'execute')`)).toBe("f");
        }
        const before = fp();
        run(forward);
        expect(fp()).toBe(after);
        expect([m(SA_NEW), m(PE_NEW), m(COVER_SIG)]).toEqual([nowMd5.auth, nowMd5.exc, nowMd5.cover]);
        expect(before).not.toBe(after);
      });
    }, 900_000);

    it("the rollback refuses while 20261231100000 sits on top (strict reverse order), while evidence rows exist (nothing is dropped) and when a live new body was redefined", () => {
      pilotWorld();
      expect(Number(psql(`select count(*) from public.studio_sms_pilot_spend_evidence`))).toBeGreaterThan(0);
      const err = psqlError(back);
      expect(err).toMatch(/differs from its 20261230 definition; roll back the later migration first/);
      expect(psql(`select to_regprocedure('${SA_NEW}') is not null and to_regclass('public.studio_sms_pilot_spend_evidence') is not null and to_regprocedure('${SA_OLD}') is null`)).toBe("t");
      withScratch("ev", (run, fail) => {
        // the copy is at the 20261230 shape with no rows: give it one pilot exception WITH its evidence (as the function would write it) and the rollback must refuse
        const entityId = randomUUID();
        run(`begin; set local session_replication_role = replica;
          insert into public.studio_sms_pilot_exceptions (legal_entity_id, ceiling_cents, approval_ref, approved_by) values ('${entityId}', 15000, 'Founder written pilot approval ev ${RUN}', '${P}');
          select set_config('tw4.pilotev_write', 'on', true);
          insert into public.studio_sms_pilot_spend_evidence (subject, legal_entity_id, scope, authorized_on, authorized_by_role, amount_cents, document_ref, document_sha256, recorded_by)
          values ('pilot_exception', '${entityId}', 'pilot_exception', current_date, 'founder_written', 15000, 'AUTH-DOC-evx${RUN}', '${"a".repeat(64)}', '${P}'); commit;`);
        expect(fail(back)).toMatch(/pilot-spend-evidence rollback refused: approval evidence exists and is permanent/);
        expect(run(`select to_regprocedure('${SA_NEW}') is not null and to_regclass('public.studio_sms_pilot_spend_evidence') is not null`)).toBe("t");
      });
      withScratch("fp", (run, fail) => {
        const def = run(`select pg_get_functiondef('${SA_NEW}'::regprocedure)`);
        expect(def).toContain("this authorization would exceed the spend cap");
        run(`${def.replace("this authorization would exceed the spend cap", "this authorization would exceed the budget")};`);
        const redefined = fail(back);
        expect(redefined).toMatch(/differs from its 20261230 definition/);
        expect(run(`select to_regprocedure('${SA_NEW}') is not null and to_regclass('public.studio_sms_pilot_spend_evidence') is not null`)).toBe("t");
      });
    }, 900_000);
  });
});
