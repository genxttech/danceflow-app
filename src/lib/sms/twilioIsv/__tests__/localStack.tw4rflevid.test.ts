/**
 * TW-4F pilot approval evidence (20261229090000) against a REAL schema: tw4_rfl_pilot_cover records the owner's dated written authorization (date, role, scope, amount equal to the
 * published price, period, retained-document reference, sha256 of the retained text) WITH the cover in an append-only evidence table, and the approval reference is 10..200
 * characters in the database, the action and the form. The old four-argument function is gone. Synthetic fixtures with fresh ids; nothing reaches Twilio, Stripe or any SMS path.
 *
 * LOCAL QA ONLY: a DEDICATED Postgres with migrations 20261207090000 .. 20261217090000, 20261225090000 and 20261229090000 applied and the local-QA marker table (public.tw4_local_qa_only):
 *
 *   TW4A_LOCAL_DB_CONTAINER=<container>  TW4RFL_DB=<database>
 *   npx vitest run --no-file-parallelism src/lib/sms/twilioIsv/__tests__/localStack.tw4rflevid.test.ts
 *
 * Run it SERIALLY with the other RFL suites (one pilot business, one shared switch state); never against a shared stack. NOT RUN when authored (the heavy-database slot was
 * not available): the PR says so.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { seedPriceIfMissing } from "./priceFixture";
import { evidenceDay, evidenceFields, pilotCoverArgs, spendEvidenceApplied, priceOfResource, type EvidenceOverride, pilotExceptionArgs } from "./rflEvidenceHelper";


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
const keyAdd = (key: string, n: number) => psql(`select to_char((${lit(key + "-01")}::date + make_interval(months => ${n})), 'YYYY-MM')`);

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

/** A pilot-funded reservation for a resource's fee, made `ageDays` ago (a fixture row: the real reservation paths are exercised elsewhere). */
const resv = (w: World, o: { ageDays?: number; status?: "reserved" | "captured" | "released"; kind?: string; funding?: "pilot" | "credit" } = {}): string => {
  const id = randomUUID();
  const status = o.status ?? "captured";
  replica(`insert into public.studio_sms_credit_reservations (id, legal_entity_id, studio_id, kind, amount_cents, funding, status, reservation_key, closed_at, created_at)
    values ('${id}', '${w.entity}', '${w.studio}', '${o.kind ?? "number"}', 100, '${o.funding ?? "pilot"}', '${status}', 'init:${id}', ${status === "reserved" ? "null" : "now()"}, now() - interval '${o.ageDays ?? 0} days');`);
  return id;
};
const registerNumber = (w: World, reservation: string | null = null) => {
  const providerSid = sid("PN");
  const out = call<{ resource_id: string; replayed: boolean; fee_kind: string; initial_cover_skipped?: string }>(
    "tw4_rfl_register", w.studio, P, "number", providerSid, w.account, e164(), "admin", null, reservation);
  return { ...out, sid: providerSid };
};
const coverOf = (resourceId: string, key = cur()) => psql(`select public._tw4rfl_cover(r, '${key}') from public.studio_sms_provider_resources r where r.id = '${resourceId}'`);
type CoverRow = { id: string; basis: string; period: string; reservation: string; sup: boolean; reason: string | null; by: string | null; by_cover: string | null; ref: string | null };
const rows = (resourceId: string) =>
  JSON.parse(psql(`select coalesce(json_agg(json_build_object('id', id, 'basis', basis, 'period', period_key, 'reservation', reservation_id, 'sup', superseded_at is not null, 'reason', superseded_reason,
    'by', superseded_by, 'by_cover', superseded_by_cover_id, 'ref', approval_ref) order by created_at), '[]'::json)::text from public.studio_sms_provider_cover where resource_id = '${resourceId}'`)) as CoverRow[];
const audit = (w: World, action: string) => Number(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${w.studio}' and action = '${action}'`));
/** Makes a registration-time cover that no longer counts, the two ways the rule defines: released reservation (bound while valid), or a cross-month row left by the old rule. */
const releasedBound = (w: World) => {
  const rv = resv(w);
  const num = registerNumber(w, rv);
  expect(coverOf(num.resource_id)).toBe("covered:initial_reservation");
  replica(`update public.studio_sms_credit_reservations set status = 'released' where id = '${rv}';`);
  return { num, rv };
};
const legacyCrossMonth = (w: World) => {
  const num = registerNumber(w, null);
  const rv = resv(w, { ageDays: 40 });
  replica(`insert into public.studio_sms_provider_cover (resource_id, legal_entity_id, studio_id, period_key, basis, reservation_id, recorded_by)
    values ('${num.resource_id}', '${w.entity}', '${w.studio}', '${cur()}', 'initial_reservation', '${rv}', '${P}');`);
  return { num, rv };
};

// ---------------------------------------------------------------------------------------------------------------
// helpers specific to the evidence function
// ---------------------------------------------------------------------------------------------------------------
type Cover = { cover_id: string; evidence_id: string; amount_cents: number; replayed: boolean };
const cover = (resourceId: string, key: string, approval: string, over: EvidenceOverride = {}, actor = P) => call<Cover>("tw4_rfl_pilot_cover", ...pilotCoverArgs(psql, resourceId, key, approval, actor, over));
const coverErr = (resourceId: string, key: string, approval: string, over: EvidenceOverride = {}, actor = P) => callErr("tw4_rfl_pilot_cover", ...pilotCoverArgs(psql, resourceId, key, approval, actor, over));
const evCount = (resourceId: string) => Number(psql(`select count(*) from public.studio_sms_provider_cover_evidence where resource_id = '${resourceId}'`));
const coverCount = (resourceId: string, basis = "pilot_approval") => Number(psql(`select count(*) from public.studio_sms_provider_cover where resource_id = '${resourceId}' and basis = '${basis}'`));
const spendCount = (w: World) => Number(psql(`select count(*) from public.studio_sms_spend_events where legal_entity_id = '${w.entity}' and studio_id = '${w.studio}'`));
/** A reference of EXACTLY n characters, unique per call. */
const exactRef = (n: number) => (n <= 16 ? hex(8).slice(0, n) : `B${RUN}${hex(6)}`.padEnd(n, "x").slice(0, n));
type EvRow = { cover: string; resource: string; period: string; on: string; role: string; scope: string; cents: number; doc: string; sha: string; by: string };
const evRow = (coverId: string): EvRow =>
  JSON.parse(psql(`select json_build_object('cover', cover_id, 'resource', resource_id, 'period', period_key, 'on', authorized_on::text, 'role', authorized_by_role, 'scope', scope, 'cents', amount_cents,
    'doc', document_ref, 'sha', document_sha256, 'by', recorded_by)::text from public.studio_sms_provider_cover_evidence where cover_id = '${coverId}'`)) as EvRow;
const OLD_SIG = "public.tw4_rfl_pilot_cover(uuid,text,text,uuid)";
const NEW_SIG = "public.tw4_rfl_pilot_cover(uuid,text,text,uuid,date,text,text,integer,text,text,text)";

describe.skipIf(!enabled)("TW-4F pilot approval evidence and reference length (real schema)", () => {
  beforeAll(() => {
    expect(psql(`select to_regclass('public.tw4_local_qa_only') is not null`)).toBe("t");
    expect(psql(`select to_regclass('public.studio_sms_provider_cover_evidence') is not null`)).toBe("t");
    expect(psql(`select to_regprocedure('${NEW_SIG}') is not null`)).toBe("t");
    psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  values ('${P}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin-${RUN}@ev-e2e.test', now(), now(), now()),
         ('${P2}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin2-${RUN}@ev-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${P}', 'platform_admin'), ('${P2}', 'platform_admin') on conflict (id) do update set platform_role = 'platform_admin';
commit;`);
    for (const [kind, customer, provider] of [["number", 200, 115], ["monthly", 1000, 150]] as const) {
      seedPriceIfMissing(psql, { kind, customer, provider, description: `fixture ${kind} price`, approver: P });
    }
    PRICE.number = Number(psql(`select customer_price_cents from public.studio_sms_price_list where kind = 'number' and active`));
  });

  describe("approval reference length: one limit (10..200) in the database", () => {
    it("the table check is widened to 3..200 (floor unchanged, exactly one length check), and the old 3..120 check is gone", () => {
      const defs = psql(`select string_agg(pg_get_constraintdef(c.oid), ' | ') from pg_constraint c where c.conrelid = 'public.studio_sms_spend_events'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%char_length(btrim(approval_ref))%'`);
      expect(defs).toContain("<= 200");
      expect(defs).toContain(">= 3");
      expect(defs).not.toContain("<= 120");
      expect(Number(psql(`select count(*) from pg_constraint c where c.conrelid = 'public.studio_sms_spend_events'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%char_length(btrim(approval_ref))%'`))).toBe(1);
    });

    it("9 and 201 characters are refused by the function with 22023 and a clear message (never a raw check violation), before anything is recorded", () => {
      const w = pilotWorld();
      const num = registerNumber(w, null);
      for (const n of [9, 201]) {
        const err = coverErr(num.resource_id, cur(), exactRef(n));
        expect(hasCode(err, "22023"), `${n}: ${err}`).toBe(true);
        expect(err).toContain("10 to 200 characters");
        expect(err).not.toMatch(/violates check constraint/);
      }
      expect(coverCount(num.resource_id)).toBe(0);
      expect(evCount(num.resource_id)).toBe(0);
      expect(spendCount(w)).toBe(0);
    });

    it("10, 120, 121 and 200 characters are accepted (121..200 used to hit the 3..120 table check) and stored whole", () => {
      for (const n of [10, 120, 121, 200]) {
        const w = pilotWorld();
        const num = registerNumber(w, null);
        const approval = exactRef(n);
        expect(approval.length).toBe(n);
        const out = cover(num.resource_id, cur(), approval);
        expect(out.replayed).toBe(false);
        expect(psql(`select char_length(approval_ref) from public.studio_sms_provider_cover where id = '${out.cover_id}'`)).toBe(String(n));
        expect(psql(`select char_length(approval_ref) from public.studio_sms_spend_events where legal_entity_id = '${w.entity}' and studio_id = '${w.studio}'`)).toBe(String(n));
        expect(evCount(num.resource_id)).toBe(1);
      }
    });

    it("the reference is counted after trimming (spaces around a 9-character reference do not make it 10)", () => {
      const w = pilotWorld();
      const num = registerNumber(w, null);
      expect(hasCode(coverErr(num.resource_id, cur(), `   ${exactRef(9)}   `), "22023")).toBe(true);
    });
  });

  describe("evidence recorded with the cover (happy path, replay, no text)", () => {
    it("records the cover, the spend approval, the reservation and ONE evidence row linked 1:1, with an audit row naming the evidence", () => {
      const w = pilotWorld();
      const num = registerNumber(w, null);
      const approval = ref("happy");
      const fields = evidenceFields(psql, num.resource_id, cur(), { authorizedOn: evidenceDay(-5), role: "founder_written", documentRef: "https://docs.example.com/auth/2026-10/confidance-1", sha256: "ab".repeat(32) });
      const out = call<Cover>("tw4_rfl_pilot_cover", num.resource_id, cur(), approval, P, ...fields);
      expect(out.replayed).toBe(false);
      expect(out.amount_cents).toBe(PRICE.number);
      const e = evRow(out.cover_id);
      expect(e).toEqual({
        cover: out.cover_id, resource: num.resource_id, period: cur(), on: evidenceDay(-5), role: "founder_written", scope: "pilot_period_cover", cents: PRICE.number,
        doc: "https://docs.example.com/auth/2026-10/confidance-1", sha: "ab".repeat(32), by: P,
      });
      expect(psql(`select id from public.studio_sms_provider_cover_evidence where cover_id = '${out.cover_id}'`)).toBe(out.evidence_id);
      expect(coverOf(num.resource_id)).toBe("covered:pilot_approval");
      expect(psql(`select count(*) from public.studio_sms_spend_events where id = (select spend_event_id from public.studio_sms_provider_cover where id = '${out.cover_id}') and status = 'reserved' and amount_cents = ${PRICE.number}`)).toBe("1");
      expect(audit(w, "rfl_cover_recorded")).toBe(1);
      const note = psql(`select note from public.studio_sms_onboarding_audit where studio_id = '${w.studio}' and action = 'rfl_cover_recorded'`);
      expect(note).toContain(`evidence=${out.evidence_id}`);
      expect(note).toContain("role=founder_written");
      expect(note).toContain("doc_sha=" + "ab".repeat(6));
      expect(note).not.toContain("ab".repeat(32));
    });

    it("stores no text: the evidence table has only the hash and the document reference (no free-text column)", () => {
      const cols = psql(`select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_schema = 'public' and table_name = 'studio_sms_provider_cover_evidence'`);
      expect(cols).toBe("amount_cents,authorized_by_role,authorized_on,cover_id,document_ref,document_sha256,id,legal_entity_id,period_key,recorded_at,recorded_by,resource_id,scope,studio_id");
      // a document reference that is not an id or a plain link cannot be stored, and neither can an oversized or non-hex digest
      const w = pilotWorld();
      const num = registerNumber(w, null);
      for (const over of [{ documentRef: "This is the whole authorization text with spaces" }, { sha256: "x".repeat(64) }] as EvidenceOverride[]) {
        expect(hasCode(coverErr(num.resource_id, cur(), ref("nottext"), over), "TW052")).toBe(true);
      }
    });

    it("an exact replay (same reference, actor and evidence) returns the same cover and evidence; different evidence for the same reference is refused (TW019); another admin is refused (TW043)", () => {
      const w = pilotWorld();
      const num = registerNumber(w, null);
      const approval = ref("replay");
      const fields = evidenceFields(psql, num.resource_id, cur());
      const first = call<Cover>("tw4_rfl_pilot_cover", num.resource_id, cur(), approval, P, ...fields);
      const again = call<Cover>("tw4_rfl_pilot_cover", num.resource_id, cur(), approval, P, ...fields);
      expect([again.replayed, again.cover_id, again.evidence_id]).toEqual([true, first.cover_id, first.evidence_id]);
      expect(evCount(num.resource_id)).toBe(1);
      expect(coverCount(num.resource_id)).toBe(1);
      expect(spendCount(w)).toBe(1);
      expect(audit(w, "rfl_cover_recorded")).toBe(1);
      expect(hasCode(coverErr(num.resource_id, cur(), approval, { sha256: "f".repeat(64) }), "TW019")).toBe(true);
      expect(hasCode(coverErr(num.resource_id, cur(), approval, { role: "founder_written" }), "TW019")).toBe(true);
      expect(hasCode(coverErr(num.resource_id, cur(), approval, {}, P2), "TW043")).toBe(true);
      expect(evCount(num.resource_id)).toBe(1);
    });
  });

  describe("every evidence refusal (nothing is recorded, the reference is not burned)", () => {
    const today = (n: number) => evidenceDay(n);
    const cases: [string, (period: string, price: number) => EvidenceOverride, string][] = [
      ["missing date", () => ({ authorizedOn: null }), "TW052"],
      ["future date (tomorrow, later than the UTC date)", () => ({ authorizedOn: today(1) }), "TW052"],
      ["future date (a week ahead)", () => ({ authorizedOn: today(7) }), "TW052"],
      ["authorization older than 400 days", () => ({ authorizedOn: today(-402) }), "TW052"],
      ["wrong role", () => ({ role: "policy_lapse" }), "TW052"],
      ["missing role", () => ({ role: null }), "TW052"],
      ["missing scope", () => ({ scope: null }), "TW052"],
      ["invalid scope", () => ({ scope: "standing_authorization" }), "TW052"],
      ["missing amount", () => ({ amountCents: null }), "TW052"],
      ["zero amount", () => ({ amountCents: 0 }), "TW052"],
      ["amount above the published price", (_p, price) => ({ amountCents: price + 1 }), "TW008"],
      ["amount below the published price", (_p, price) => ({ amountCents: price - 1 }), "TW008"],
      ["evidence period differs from the cover's period", (p) => ({ evidencePeriod: keyAdd(p, 1) }), "TW052"],
      ["missing evidence period", () => ({ evidencePeriod: null }), "TW052"],
      ["missing document reference", () => ({ documentRef: null }), "TW052"],
      ["document reference too short", () => ({ documentRef: "abc" }), "TW052"],
      ["document reference with spaces", () => ({ documentRef: "AUTH DOC 0001 TEXT" }), "TW052"],
      ["link that is not https", () => ({ documentRef: "http://docs.example.com/auth/1" }), "TW052"],
      ["https link with a query string", () => ({ documentRef: "https://docs.example.com/auth/1?token=abc" }), "TW052"],
      ["https link with credentials", () => ({ documentRef: "https://user:pw@docs.example.com/auth/1" }), "TW052"],
      ["https link with a semicolon", () => ({ documentRef: "https://docs.example.com/auth;1" }), "TW052"],
      ["https link with an ampersand", () => ({ documentRef: "https://docs.example.com/auth&1" }), "TW052"],
      ["https link with an equals sign", () => ({ documentRef: "https://docs.example.com/auth=1" }), "TW052"],
      ["https link with a percent escape", () => ({ documentRef: "https://docs.example.com/auth%201" }), "TW052"],
      ["https link with a fragment", () => ({ documentRef: "https://docs.example.com/auth1#frag" }), "TW052"],
      ["javascript-style document id", () => ({ documentRef: "javascript:alert1" }), "TW052"],
      ["document id with an equals sign", () => ({ documentRef: "AUTH=DOC-0001" }), "TW052"],
      ["document id with a colon", () => ({ documentRef: "AUTH:DOC-0001" }), "TW052"],
      ["short sha256", () => ({ sha256: "abc123" }), "TW052"],
      ["upper-case sha256", () => ({ sha256: "A".repeat(64) }), "TW052"],
      ["non-hex sha256", () => ({ sha256: "g".repeat(64) }), "TW052"],
      ["missing sha256", () => ({ sha256: null }), "TW052"],
    ];
    for (const [name, make, code] of cases) {
      it(`${name}: ${code}`, () => {
        const w = pilotWorld();
        const num = registerNumber(w, null);
        const approval = ref("refusal");
        const err = coverErr(num.resource_id, cur(), approval, make(cur(), PRICE.number));
        expect(hasCode(err, code), err).toBe(true);
        expect(coverCount(num.resource_id)).toBe(0);
        expect(evCount(num.resource_id)).toBe(0);
        expect(spendCount(w)).toBe(0);
        expect(audit(w, "rfl_cover_recorded")).toBe(0);
        // the refusal burned nothing: the same reference then works with valid evidence
        expect(cover(num.resource_id, cur(), approval).replayed).toBe(false);
      });
    }

    it("the date window accepts today (UTC) and 399 days ago", () => {
      for (const day of [today(0), today(-399)]) {
        const w = pilotWorld();
        const num = registerNumber(w, null);
        expect(cover(num.resource_id, cur(), ref("window"), { authorizedOn: day }).replayed).toBe(false);
      }
    });
  });

  describe("the rest of the cover contract is unchanged", () => {
    it("one reference authorizes one use (TW019): the same reference on another resource is refused and records nothing", () => {
      const w = pilotWorld();
      const a = registerNumber(w, null);
      const approval = ref("reuse");
      cover(a.resource_id, cur(), approval);
      const w2 = pilotWorld();
      const b = registerNumber(w2, null);
      expect(hasCode(coverErr(b.resource_id, cur(), approval), "TW019")).toBe(true);
      expect(coverCount(b.resource_id)).toBe(0);
      expect(evCount(b.resource_id)).toBe(0);
    });

    it("the cumulative ceiling (TW007): an approval that would exceed it is refused with no evidence; one that exactly fits is recorded", () => {
      const w = pilotWorld({ ceiling: PRICE.number - 1 });
      const num = registerNumber(w, null);
      expect(hasCode(coverErr(num.resource_id, cur(), ref("over")), "TW007")).toBe(true);
      expect(evCount(num.resource_id)).toBe(0);
      const w2 = pilotWorld({ ceiling: PRICE.number });
      const n2 = registerNumber(w2, null);
      expect(cover(n2.resource_id, cur(), ref("fits")).replayed).toBe(false);
      expect(hasCode(coverErr(n2.resource_id, keyAdd(cur(), 1), ref("second")), "TW007")).toBe(true);
      expect(evCount(n2.resource_id)).toBe(1);
    });

    it("current or next period only (TW042); retroactive and far-future approvals record nothing; the next period takes evidence for the NEXT period", () => {
      const w = pilotWorld();
      const num = registerNumber(w, null);
      expect(hasCode(coverErr(num.resource_id, keyAdd(cur(), -1), ref("retro")), "TW042")).toBe(true);
      expect(hasCode(coverErr(num.resource_id, keyAdd(cur(), 2), ref("far")), "TW042")).toBe(true);
      expect(evCount(num.resource_id)).toBe(0);
      const out = cover(num.resource_id, keyAdd(cur(), 1), ref("next"));
      expect(evRow(out.cover_id).period).toBe(keyAdd(cur(), 1));
      // evidence for the CURRENT period cannot cover the next one
      expect(hasCode(coverErr(num.resource_id, keyAdd(cur(), 1), ref("mismatch"), { evidencePeriod: cur() }), "TW052")).toBe(true);
    });

    it("hold and negative balance are refused (TW007) with no evidence", () => {
      const w = pilotWorld();
      const num = registerNumber(w, null);
      replica(`update public.studio_sms_credit_accounts set hold = true, hold_reason = 'fixture hold for the evidence suite' where legal_entity_id = '${w.entity}';`);
      expect(hasCode(coverErr(num.resource_id, cur(), ref("held")), "TW007")).toBe(true);
      replica(`update public.studio_sms_credit_accounts set hold = false, hold_reason = null, balance_cents = -1 where legal_entity_id = '${w.entity}';`);
      expect(hasCode(coverErr(num.resource_id, cur(), ref("negative")), "TW007")).toBe(true);
      expect(evCount(num.resource_id)).toBe(0);
      replica(`update public.studio_sms_credit_accounts set balance_cents = 100000 where legal_entity_id = '${w.entity}';`);
    });

    it("platform administrators only: a studio owner is refused (42501) and nothing is recorded", () => {
      const w = pilotWorld();
      const num = registerNumber(w, null);
      expect(hasCode(coverErr(num.resource_id, cur(), ref("owner"), {}, w.owner), "42501")).toBe(true);
      expect(evCount(num.resource_id)).toBe(0);
      expect(coverCount(num.resource_id)).toBe(0);
    });

    it("a cancelled resource is refused (TW041)", () => {
      const w = pilotWorld();
      const num = registerNumber(w, null);
      replica(`update public.studio_sms_provider_resources set provider_state = 'cancelled', cancelled_at = now(), cancel_evidence_digest = '${hex(32)}' where id = '${num.resource_id}';`);
      expect(hasCode(coverErr(num.resource_id, cur(), ref("cancelled")), "TW041")).toBe(true);
      expect(evCount(num.resource_id)).toBe(0);
    });
  });

  describe("no evidence-free path remains", () => {
    it("the four-argument signature is gone and exactly one tw4_rfl_pilot_cover exists", () => {
      expect(psql(`select to_regprocedure('${OLD_SIG}') is null`)).toBe("t");
      expect(psql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'tw4_rfl_pilot_cover'`)).toBe("1");
      const w = pilotWorld();
      const num = registerNumber(w, null);
      const err = psqlError(`select public.tw4_rfl_pilot_cover(${lit(num.resource_id)}, ${lit(cur())}, ${lit(ref("legacy"))}, ${lit(P)})::text;`);
      expect(err).toMatch(/42883|does not exist/);
      expect(coverCount(num.resource_id)).toBe(0);
    });

    it("grants: service_role only, like the function it replaced", () => {
      for (const role of ["anon", "authenticated"]) expect(psql(`select has_function_privilege('${role}', '${NEW_SIG}', 'execute')`)).toBe("f");
      expect(psql(`select has_function_privilege('service_role', '${NEW_SIG}', 'execute')`)).toBe("t");
      expect(psql(`select has_function_privilege('public', '${NEW_SIG}', 'execute')`)).toBe("f");
      for (const role of ["anon", "authenticated", "service_role"]) expect(psql(`select has_function_privilege('${role}', 'public._tw4rfl_evid_guard()', 'execute')`)).toBe("f");
    });
  });

  describe("apply precondition and rollback fingerprint (on a schema-only scratch copy)", () => {
    const mdir = join(process.cwd(), "src/lib/supabase/migrations");
    const forward = readFileSync(join(mdir, "20261229090000_twilio_rfl_pilot_evidence.sql"), "utf8");
    const back = readFileSync(join(mdir, "rollback/20261229090000_twilio_rfl_pilot_evidence_rollback.sql"), "utf8");
    /** A scratch database holding this database's SCHEMA only (no rows): `run` throws on SQL error, `fail` returns the error text. */
    const withScratch = (label: string, body: (run: (sql: string) => string, fail: (sql: string) => string) => void) => {
      const scratch = `${DB}_${label}_${RUN}`;
      const sh = (cmd: string) => execFileSync("docker", ["exec", PG, "sh", "-c", cmd], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      try {
        sh(`psql -U postgres -q -c 'create database ${scratch}'`);
        sh(`pg_dump -U postgres -s --no-owner ${DB} | psql -U postgres -d ${scratch} -q > /dev/null 2>&1; true`);
        const args = ["exec", "-i", PG, "psql", "-U", "postgres", "-d", scratch, "-q", "-At", "-v", "ON_ERROR_STOP=1"];
        const spendBack = join(mdir, "rollback/20261230090000_twilio_rfl_pilot_spend_evidence_rollback.sql");
        const run = (sql: string) => execFileSync("docker", args, { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
        const fail = (sql: string) => {
          try {
            run(sql);
            return "";
          } catch (error) {
            return String((error as { stderr?: Buffer | string }).stderr ?? error);
          }
        };
        // 20261231100000 (pilot spend hardening) sits on top of 20261230: strict reverse order, it goes first
        if (run(`select to_regprocedure('public._tw4psh_spend_authorize(uuid,text,integer,text,uuid,text,uuid,date,text,text,integer,text,text,text)') is not null`) === "t") run(readFileSync(join(mdir, "rollback/20261231100000_twilio_pilot_spend_hardening_rollback.sql"), "utf8"));
        if (spendEvidenceApplied(psql)) run(readFileSync(spendBack, "utf8"));
        body(run, fail);
      } finally {
        sh(`psql -U postgres -q -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '${scratch}'" -c 'drop database if exists ${scratch}' > /dev/null 2>&1; true`);
      }
    };

    it("20261229 refuses to apply while a live pilot_approval cover without evidence exists, and applies once it is gone", () => {
      withScratch("pre", (run, fail) => {
        run(back); // the copy is back at the 20261225 shape (it has no evidence rows)
        expect(run(`select to_regprocedure('${OLD_SIG}') is not null`)).toBe("t");
        // a cover recorded through the four-argument function (foreign keys are not enforced under the replica role; the row only has to look like one)
        run(`begin; set local session_replication_role = replica;
          insert into public.studio_sms_provider_cover (resource_id, legal_entity_id, studio_id, period_key, basis, reservation_id, spend_event_id, approval_ref, recorded_by)
          values ('${randomUUID()}', '${randomUUID()}', '${randomUUID()}', '2026-10', 'pilot_approval', '${randomUUID()}', '${randomUUID()}', 'Written approval legacy ${RUN} 0001', '${P}'); commit;`);
        const err = fail(forward);
        expect(err).toMatch(/pilot-evidence precondition failed: live pilot_approval covers recorded without evidence exist/);
        // nothing was applied: the transaction rolled back whole
        expect(run(`select to_regprocedure('${OLD_SIG}') is not null and to_regclass('public.studio_sms_provider_cover_evidence') is null`)).toBe("t");
        expect(run(`select count(*) from pg_constraint where conname = 'studio_sms_spend_events_approval_ref_len'`)).toBe("0");
        run(`begin; set local session_replication_role = replica; delete from public.studio_sms_provider_cover where approval_ref = 'Written approval legacy ${RUN} 0001'; commit;`);
        run(forward);
        expect(run(`select to_regprocedure('${NEW_SIG}') is not null and to_regprocedure('${OLD_SIG}') is null`)).toBe("t");
      });
    });

    it("20261229's rollback refuses when the live eleven-argument body is not the one it created, and keeps everything", () => {
      withScratch("fp", (run, fail) => {
        const def = run(`select pg_get_functiondef('${NEW_SIG}'::regprocedure)`);
        expect(def).toContain("p_amount_cents <> p.customer_price_cents");
        run(`${def.replace("p_amount_cents <> p.customer_price_cents", "p_amount_cents < p.customer_price_cents")};`);
        const err = fail(back);
        expect(err).toMatch(/differs from its 20261229 definition/);
        expect(run(`select to_regprocedure('${NEW_SIG}') is not null and to_regclass('public.studio_sms_provider_cover_evidence') is not null and to_regprocedure('${OLD_SIG}') is null`)).toBe("t");
        expect(run(`select count(*) from pg_constraint where conname = 'studio_sms_spend_events_approval_ref_len'`)).toBe("1");
      });
    });
  });

  describe("the evidence is append-only, private and tied to its cover", () => {
    it("update, delete and truncate are refused; a direct insert is refused without the flag and for a cover it does not describe", () => {
      const w = pilotWorld();
      const num = registerNumber(w, null);
      const out = cover(num.resource_id, cur(), ref("append-only"));
      expect(psqlError(`update public.studio_sms_provider_cover_evidence set scope = 'pilot_period_cover' where cover_id = '${out.cover_id}';`)).toMatch(/42501/);
      expect(psqlError(`update public.studio_sms_provider_cover_evidence set document_sha256 = '${"0".repeat(64)}' where cover_id = '${out.cover_id}';`)).toMatch(/42501/);
      expect(psqlError(`begin; select set_config('tw4.rflevid_write', 'on', true); update public.studio_sms_provider_cover_evidence set amount_cents = 1 where cover_id = '${out.cover_id}'; commit;`)).toMatch(/42501/);
      expect(psqlError(`delete from public.studio_sms_provider_cover_evidence where cover_id = '${out.cover_id}';`)).toMatch(/42501/);
      expect(psqlError(`truncate public.studio_sms_provider_cover_evidence;`)).toMatch(/./);
      const e = evRow(out.cover_id);
      const insert = (flag: boolean, coverId: string, resourceId: string, period: string) => psqlError(`begin; ${flag ? "select set_config('tw4.rflevid_write', 'on', true);" : ""}
        insert into public.studio_sms_provider_cover_evidence (cover_id, resource_id, legal_entity_id, studio_id, period_key, authorized_on, authorized_by_role, scope, amount_cents, document_ref, document_sha256, recorded_by)
        values ('${coverId}', '${resourceId}', '${w.entity}', '${w.studio}', '${period}', current_date, 'owner_written', 'pilot_period_cover', ${PRICE.number}, 'AUTH-DOC-X1234', '${"1".repeat(64)}', '${P}'); commit;`);
      expect(insert(false, randomUUID(), e.resource, e.period)).toMatch(/42501/);
      // with the flag: a second row for the same cover (23505), an unknown cover, or a cover with a different period are all refused
      expect(insert(true, out.cover_id, e.resource, e.period)).toMatch(/23505|duplicate key|42501/);
      expect(insert(true, randomUUID(), e.resource, e.period)).toMatch(/42501|23503/);
      expect(evCount(num.resource_id)).toBe(1);
      expect(evRow(out.cover_id)).toEqual(e);
    });

    it("an initial_reservation cover can never have evidence (the evidence describes a pilot_approval cover only)", () => {
      const w = pilotWorld();
      const num = registerNumber(w, resv(w));
      const [c] = rows(num.resource_id);
      expect(c.basis).toBe("initial_reservation");
      expect(psqlError(`begin; select set_config('tw4.rflevid_write', 'on', true);
        insert into public.studio_sms_provider_cover_evidence (cover_id, resource_id, legal_entity_id, studio_id, period_key, authorized_on, authorized_by_role, scope, amount_cents, document_ref, document_sha256, recorded_by)
        values ('${c.id}', '${num.resource_id}', '${w.entity}', '${w.studio}', '${c.period}', current_date, 'owner_written', 'pilot_period_cover', ${PRICE.number}, 'AUTH-DOC-X1234', '${"1".repeat(64)}', '${P}'); commit;`)).toMatch(/42501/);
    });

    it("RLS is on and no API role can read or write the table", () => {
      expect(psql(`select relrowsecurity from pg_class where oid = 'public.studio_sms_provider_cover_evidence'::regclass`)).toBe("t");
      for (const role of ["anon", "authenticated", "service_role"]) {
        const script = `begin; set local role ${role}; select count(*) from public.studio_sms_provider_cover_evidence; rollback;\nbegin; set local role ${role}; delete from public.studio_sms_provider_cover_evidence; rollback;\n`;
        const res = spawnSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-q", "-At", "-v", "ON_ERROR_STOP=0"], { input: script, encoding: "utf8" });
        expect(res.stdout.trim()).toBe("");
        expect((res.stderr.match(/permission denied/g) ?? []).length).toBe(2);
      }
    });

    it("the evidence amount always equals the spend approval's amount and the published price at recording time", () => {
      const w = pilotWorld();
      const num = registerNumber(w, null);
      const out = cover(num.resource_id, cur(), ref("amounts"));
      expect(psql(`select e.amount_cents = s.amount_cents and e.amount_cents = ${priceOfResource(psql, num.resource_id)} from public.studio_sms_provider_cover_evidence e join public.studio_sms_provider_cover c on c.id = e.cover_id join public.studio_sms_spend_events s on s.id = c.spend_event_id where e.cover_id = '${out.cover_id}'`)).toBe("t");
    });
  });

  describe("concurrency", () => {
    it("two identical calls racing: one records, the other replays; exactly one cover, one evidence row, one spend approval", async () => {
      const w = pilotWorld();
      const num = registerNumber(w, null);
      const approval = ref("race-same");
      const fields = evidenceFields(psql, num.resource_id, cur());
      const results = await Promise.all([1, 2].map(() => psqlAsync(callSql("tw4_rfl_pilot_cover", num.resource_id, cur(), approval, P, ...fields))));
      expect(results.every((r) => r.err === ""), JSON.stringify(results)).toBe(true);
      const outs = results.map((r) => JSON.parse(r.out) as Cover);
      expect(outs.filter((o) => !o.replayed)).toHaveLength(1);
      expect(outs[0].cover_id).toBe(outs[1].cover_id);
      expect(coverCount(num.resource_id)).toBe(1);
      expect(evCount(num.resource_id)).toBe(1);
      expect(spendCount(w)).toBe(1);
    });

    it("racing approvals with different references and administrators: exactly one wins, the others are refused (TW043 or TW019), one evidence row", async () => {
      const w = pilotWorld();
      const num = registerNumber(w, null);
      const calls = [1, 2, 3].map((i) => callSql("tw4_rfl_pilot_cover", ...pilotCoverArgs(psql, num.resource_id, cur(), ref(`race-${i}`), i % 2 ? P : P2)));
      const results = await Promise.all(calls.map((c) => psqlAsync(c)));
      expect(results.filter((r) => r.err === "")).toHaveLength(1);
      expect(results.filter((r) => r.err !== "").every((r) => hasCode(r.err, "TW043") || hasCode(r.err, "TW019"))).toBe(true);
      expect(coverCount(num.resource_id)).toBe(1);
      expect(evCount(num.resource_id)).toBe(1);
      expect(spendCount(w)).toBe(1);
    });
  });

  describe("D5 supersede semantics are unchanged and carry evidence", () => {
    it("a written approval supersedes a non-counting initial_reservation cover; the NEW cover has the evidence, the old row has none and is kept", () => {
      const w = pilotWorld();
      const { num } = releasedBound(w);
      const out = cover(num.resource_id, cur(), ref("supersede"));
      const [old, fresh] = rows(num.resource_id);
      expect([old.sup, old.reason, old.by_cover, fresh.id, fresh.basis]).toEqual([true, "reservation_not_counting", out.cover_id, out.cover_id, "pilot_approval"]);
      expect(evCount(num.resource_id)).toBe(1);
      expect(evRow(out.cover_id).cover).toBe(fresh.id);
      expect(psql(`select count(*) from public.studio_sms_provider_cover_evidence where cover_id = '${old.id}'`)).toBe("0");
      expect(audit(w, "rfl_cover_superseded")).toBe(1);
      expect(audit(w, "rfl_cover_recorded")).toBe(1);
      expect(coverOf(num.resource_id)).toBe("covered:pilot_approval");
    });

    it("an old-rule cross-month row is superseded with evidence too", () => {
      const w = pilotWorld();
      const { num } = legacyCrossMonth(w);
      const out = cover(num.resource_id, cur(), ref("supersede-cross"));
      const [old] = rows(num.resource_id);
      expect([old.sup, old.reason, old.by_cover]).toEqual([true, "reservation_month_differs", out.cover_id]);
      expect(evCount(num.resource_id)).toBe(1);
    });

    it("refused evidence never supersedes: the old row stays live and unmarked", () => {
      const w = pilotWorld();
      const { num } = releasedBound(w);
      expect(hasCode(coverErr(num.resource_id, cur(), ref("bad-ev"), { sha256: "nothex" }), "TW052")).toBe(true);
      expect(hasCode(coverErr(num.resource_id, cur(), ref("bad-price"), { amountCents: PRICE.number + 5 }), "TW008")).toBe(true);
      expect(rows(num.resource_id).filter((r) => r.sup)).toHaveLength(0);
      expect(rows(num.resource_id)).toHaveLength(1);
      expect(evCount(num.resource_id)).toBe(0);
      expect(audit(w, "rfl_cover_superseded")).toBe(0);
    });

    it("a counting cover is never superseded (TW043) and records no evidence; an approval is never superseded either", () => {
      const w = pilotWorld();
      const num = registerNumber(w, resv(w));
      expect(hasCode(coverErr(num.resource_id, cur(), ref("counting")), "TW043")).toBe(true);
      expect(evCount(num.resource_id)).toBe(0);
      const w2 = pilotWorld();
      const n2 = registerNumber(w2, null);
      cover(n2.resource_id, cur(), ref("first-approval"));
      expect(hasCode(coverErr(n2.resource_id, cur(), ref("other-approval")), "TW043")).toBe(true);
      expect(evCount(n2.resource_id)).toBe(1);
    });
  });
});
