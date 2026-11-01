/**
 * D4-2 price monitor against a REAL schema: migration 20270205090000 (evidence chain, security events, digest) together with D4-1's 20270204090000 (tw4_price_verify), with
 * the monitor running AS service_role (set local role) through the real db contract. Synthetic fixtures; fake transports (no network, no Resend, no Twilio, no Stripe).
 * LOCAL QA ONLY: a DEDICATED Postgres with the chain through 20270205090000 and public.tw4_local_qa_only:
 *
 *   node scripts/qa/tw4f/run-chain.mjs suites --suite localStack.d42monitor --extra-branch origin/claude/d4-1-price-dual-control --extra-branch claude/d4-2-price-monitoring --env ISO_QA_MARKER=1 --env TW4RFL_DB=postgres
 *
 * Re-runnable: the evidence table is append-only by design, so the suite continues the chain wherever it stands; forged price rows are removed again by the owner at the end.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GENESIS_HASH, entryHash, parseEvidenceList, verifyChain } from "../evidence";
import { runPriceMonitor, runPriceWatchdog } from "../monitor";
import { FakeTransport, type MonitorConfig } from "../transport";
import type { EvidenceRow, PriceMonitorDb } from "../types";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const DB = process.env.TW4RFL_DB ?? "";
const enabled = Boolean(PG && DB);

const sqlArgs = ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-q", "-At", "-v", "ON_ERROR_STOP=1"];
const psql = (sql: string): string => execFileSync("docker", sqlArgs, { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const tryPsql = (sql: string): { ok: boolean; out: string } => {
  try { return { ok: true, out: psql(sql) }; } catch (e) { return { ok: false, out: String((e as { stderr?: string }).stderr ?? e) }; }
};
const lit = (v: unknown): string => (v === null || v === undefined ? "null" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
/** One RPC as service_role, exactly like the app's admin client. */
const asService = (fn: string, ...args: unknown[]): unknown => JSON.parse(psql(`begin; set local role service_role; select public.${fn}(${args.join(", ")})::text; commit;`).split("\n").filter((l) => l.startsWith("{") || l.startsWith("[") || l === "null").pop() ?? "null");

const realDb: PriceMonitorDb = {
  verify: async (since) => asService("tw4_price_verify", since ? `${lit(since)}::timestamptz` : "null::timestamptz"),
  digest: async () => asService("tw4_price_monitor_digest"),
  events: async (after) => asService("tw4_price_monitor_events", `${after}::bigint`),
  evidenceList: async (limit, before = null) => asService("tw4_price_monitor_evidence_list", `${limit}::int`, before === null ? "null::bigint" : `${before}::bigint`),
  evidenceAppend: async (r: EvidenceRow) => asService("tw4_price_monitor_evidence_append", `${r.seq}::bigint`, lit(r.prev_hash), lit(r.entry_hash), `${lit(r.run_id)}::uuid`, lit(r.kind), `${lit(r.recorded_at)}::timestamptz`, lit(r.payload)),
};

const MARKER = `if to_regclass('public.tw4_local_qa_only') is null then raise exception 'not a local QA database'; end if;`;
const FORGED_KIND = "number";
let since = "";
/** Rows up to this seq are an acknowledged, deliberate break (earlier runs of this suite on the same database leave their forged appends behind: append-only). */
let trusted = 0;
const forgedIds: string[] = [];
let clockMs = Date.now();
const clock = () => new Date(clockMs);

function config(transports: FakeTransport[], over: Partial<MonitorConfig> = {}): MonitorConfig {
  return { transports, chainKey: null, since, repeatMs: 6 * 3600_000, maxAgeMs: 45 * 60_000, trustedFromSeq: trusted, expectHead: null, ...over };
}
const run = (transports: FakeTransport[], over: Partial<MonitorConfig> = {}) => runPriceMonitor({ db: realDb, config: config(transports, over), now: clock, sleep: async () => undefined });
const dbHead = () => parseEvidenceList(asService("tw4_price_monitor_evidence_list", "1::int", "null::bigint"))!.rows[0] ?? null;

describe.skipIf(!enabled)("D4-2 price monitor on a real database", () => {
  beforeAll(() => {
    psql(`do $d$ begin ${MARKER} end $d$;`);
    if (psql("select to_regprocedure('public.tw4_price_verify(timestamptz)') is not null and to_regprocedure('public.tw4_price_monitor_digest()') is not null") !== "t") {
      throw new Error("chain must include D4-1 (20270204090000) and D4-2 (20270205090000)");
    }
    since = psql("select clock_timestamp()::text");
    trusted = scanBreaks();
  });

  afterAll(() => {
    if (!forgedIds.length) return;
    psql(`begin; do $d$ begin ${MARKER} end $d$;
      alter table public.studio_sms_price_list disable trigger studio_sms_price_list_00_activation;
      set local session_replication_role = replica;
      delete from public.studio_sms_price_list where id in (${forgedIds.map((i) => lit(i)).join(",")});
      alter table public.studio_sms_price_list enable always trigger studio_sms_price_list_00_activation;
      commit;`);
  });

  it("grants: service_role only; no table privilege; anon and authenticated cannot call anything", () => {
    for (const fn of ["tw4_price_monitor_digest()", "tw4_price_monitor_events(bigint)", "tw4_price_monitor_evidence_list(integer,bigint)", "tw4_price_monitor_evidence_append(bigint,text,text,uuid,text,timestamptz,text)"]) {
      expect(psql(`select has_function_privilege('anon','public.${fn}','execute'), has_function_privilege('authenticated','public.${fn}','execute'), has_function_privilege('service_role','public.${fn}','execute')`)).toBe("f|f|t");
    }
    expect(psql("select has_table_privilege('service_role','public.studio_sms_price_monitor_evidence','select,insert,update,delete'), has_table_privilege('service_role','public.studio_sms_price_security_events','insert')")).toBe("f|f");
    expect(tryPsql("begin; set local role service_role; insert into public.studio_sms_price_monitor_evidence (seq, run_id, kind, recorded_at, payload, prev_hash, entry_hash) values (999999, gen_random_uuid(), 'run', now(), '{}', repeat('0',64), repeat('1',64));").ok).toBe(false);
    expect(tryPsql("begin; set local role authenticated; select public.tw4_price_monitor_digest();").ok).toBe(false);
  });

  it("clean database: a run records evidence, sends no alert and the chain verifies", async () => {
    const t = new FakeTransport();
    const out = await run([t]);
    expect(out.findings.filter((f) => f.severity !== "info")).toEqual([]);
    expect(out.evidenceRecorded).toBe(true);
    expect(t.sent).toHaveLength(0);
    expect(t.heartbeats).toHaveLength(1);
    const rows = parseEvidenceList(asService("tw4_price_monitor_evidence_list", "200::int", "null::bigint"))!.rows;
    expect(verifyChain(rows, { trustedFromSeq: trusted }).ok).toBe(true);
    expect(rows[rows.length - 1].entry_hash).toBe(out.chain.headHash);
  });

  it("forged price-row injection: unauthorized_price_change alert with the chain head, then recovery after the owner removes the row", async () => {
    const id = randomUUID();
    forgedIds.push(id);
    psql(`begin; do $d$ begin ${MARKER} end $d$;
      alter table public.studio_sms_price_list disable trigger studio_sms_price_list_00_activation;
      set local session_replication_role = replica;
      insert into public.studio_sms_price_list (id, kind, customer_price_cents, provider_cost_cents, description, active, created_by) values ('${id}', '${FORGED_KIND}', 777, 100, 'forged by the d42 suite', false, gen_random_uuid());
      alter table public.studio_sms_price_list enable always trigger studio_sms_price_list_00_activation;
      commit;`);
    clockMs += 60_000;
    const t = new FakeTransport();
    const out = await run([t]);
    expect(out.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["unauthorized_price_change", "price_changed"]));
    expect(out.ok).toBe(false);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].findings.find((f) => f.code === "unauthorized_price_change")!.refs.join()).toContain(id);
    const rows = parseEvidenceList(asService("tw4_price_monitor_evidence_list", "200::int", "null::bigint"))!.rows;
    const runRow = rows.find((r) => r.entry_hash === t.sent[0].chainHeadHash);
    expect(runRow?.seq).toBe(t.sent[0].chainHeadSeq);
    // the monitor changed nothing: the forged row is still exactly there
    expect(psql(`select customer_price_cents from public.studio_sms_price_list where id = '${id}'`)).toBe("777");
  });

  it("missing approval: a request-table anomaly is reported as missing_approval", async () => {
    // an 'approved' request that was never applied for more than a minute is an anomaly of the verifier; built with owner-level SQL on the local database
    const rid = randomUUID();
    const reqExists = psql("select to_regclass('public.studio_sms_price_change_requests') is not null");
    expect(reqExists).toBe("t");
    psql(`begin; do $d$ begin ${MARKER} end $d$;
      alter table public.studio_sms_price_change_requests disable trigger studio_sms_price_change_requests_guard;
      insert into public.studio_sms_price_change_requests (id, kind, customer_price_cents, provider_cost_cents, description, reason, status, requested_by, requested_at, expires_at, decided_by, decided_at, decision_note)
        values ('${rid}', 'brand', 4242, 100, 'd42 missing approval', 'd42 suite synthetic request without a valid approval', 'approved', gen_random_uuid(), now() - interval '10 minutes', now() + interval '20 hours', gen_random_uuid(), now() - interval '5 minutes', 'd42 synthetic approval record');
      alter table public.studio_sms_price_change_requests enable always trigger studio_sms_price_change_requests_guard;
      commit;`);
    clockMs += 60_000;
    const t = new FakeTransport();
    const out = await run([t]);
    expect(out.findings.map((f) => f.code)).toContain("missing_approval");
    expect(t.sent).toHaveLength(1);
    psql(`begin; do $d$ begin ${MARKER} end $d$;
      alter table public.studio_sms_price_change_requests disable trigger studio_sms_price_change_requests_guard;
      delete from public.studio_sms_price_change_requests where id = '${rid}';
      alter table public.studio_sms_price_change_requests enable always trigger studio_sms_price_change_requests_guard;
      commit;`);
  });

  it("security-event feed is consumed generically from the real table", async () => {
    psql(`begin; do $d$ begin ${MARKER} end $d$;
      insert into public.studio_sms_price_security_events (kind, detail) values ('credential_compromise_reported', '{"note":"d42 synthetic"}'), ('pricing_suspended', '{}'), ('d42_unrecognized_kind', '{}');
      commit;`);
    clockMs += 60_000;
    const t = new FakeTransport();
    const out = await run([t]);
    const codes = out.findings.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(["credential_compromise", "pricing_suspended", "unknown_security_event"]));
    expect(t.sent).toHaveLength(1);
    // lift the suspension (append-only: a resume event, no edit)
    psql("insert into public.studio_sms_price_security_events (kind, detail) values ('pricing_resumed', '{}');");
  });

  it("evidence rows are immutable even for the owner and under replica mode; linkage is enforced", () => {
    psql("insert into public.studio_sms_price_security_events (kind, detail) values ('d42_probe_event', '{}');");
    const head = dbHead();
    const seq = head ? head.seq : 0;
    // a row that does not extend the head is refused (returned, not raised)
    const r = asService("tw4_price_monitor_evidence_append", `${seq + 5}::bigint`, lit(head?.entry_hash ?? GENESIS_HASH), lit("a".repeat(64)), `${lit(randomUUID())}::uuid`, lit("run"), "now()", lit("{}")) as { appended: boolean; reason: string };
    expect(r).toMatchObject({ appended: false, reason: "chain_mismatch" });
    for (const stmt of [
      "update public.studio_sms_price_monitor_evidence set payload = 'x'",
      "delete from public.studio_sms_price_monitor_evidence",
      "truncate public.studio_sms_price_monitor_evidence",
      "update public.studio_sms_price_security_events set kind = 'x_y_z'",
      "delete from public.studio_sms_price_security_events",
      "truncate public.studio_sms_price_security_events",
    ]) {
      const a = tryPsql(`${stmt};`), b = tryPsql(`begin; set local session_replication_role = replica; ${stmt}; commit;`);
      // an empty table makes UPDATE/DELETE no-ops (no row trigger fires); TRUNCATE always fires its statement trigger
      if (stmt.startsWith("truncate")) { expect(a.ok).toBe(false); expect(b.ok).toBe(false); expect(a.out).toContain("append-only"); }
      else if (psql(`select count(*) from ${stmt.split(" ")[stmt.startsWith("update") ? 1 : 2]}`) !== "0") { expect(a.ok).toBe(false); expect(b.ok).toBe(false); }
    }
  });

  it("tampered evidence chain: a forged append (valid link, wrong hash) and a published-head mismatch are detected", async () => {
    const head = dbHead()!;
    // the owner (a database writer) appends a row that links correctly but carries a made-up hash: the database accepts the linkage, the application hash check does not
    psql(`insert into public.studio_sms_price_monitor_evidence (seq, run_id, kind, recorded_at, payload, prev_hash, entry_hash) values (${head.seq + 1}, gen_random_uuid(), 'run', now(), '{"v":1,"findings":[]}', '${head.entry_hash}', '${"e".repeat(64)}');`);
    clockMs += 60_000;
    const t = new FakeTransport();
    const out = await run([t]);
    expect(out.findings.map((f) => f.code)).toContain("evidence_chain_broken");
    expect(out.chain.status).toBe("broken");
    expect(t.sent[0].chainStatus).toBe("broken");
    // recovery without a permanent bypass: the owner acknowledges rows up to the break for ONE configuration (visible in every alert), the chain then extends normally
    const brokenSeq = head.seq + 1;
    const t2 = new FakeTransport();
    clockMs += 60_000;
    trusted = brokenSeq;
    const out2 = await run([t2]);
    expect(out2.findings.map((f) => f.code)).not.toContain("evidence_chain_broken");
    expect(out2.evidenceRecorded).toBe(true);
    // a wrong published head (as if history was rewritten) is detected
    clockMs += 60_000;
    const out3 = await run([new FakeTransport()], { expectHead: { seq: out2.chain.headSeq, hash: "d".repeat(64) } });
    expect(out3.findings.map((f) => f.code)).toContain("evidence_chain_broken");
  });

  it("transport failure is recorded in the database chain and re-delivered once the destination works", async () => {
    // new critical finding so that an alert is required: another forged row
    const id = randomUUID();
    forgedIds.push(id);
    psql(`begin; do $d$ begin ${MARKER} end $d$;
      alter table public.studio_sms_price_list disable trigger studio_sms_price_list_00_activation;
      set local session_replication_role = replica;
      insert into public.studio_sms_price_list (id, kind, customer_price_cents, provider_cost_cents, description, active, created_by) values ('${id}', 'campaign_vetting', 888, 100, 'forged two by the d42 suite', false, gen_random_uuid());
      alter table public.studio_sms_price_list enable always trigger studio_sms_price_list_00_activation;
      commit;`);
    clockMs += 60_000;
    const bad = new FakeTransport();
    bad.failSends = 99;
    const out = await run([bad]);
    expect(out.alertDelivered).toBe(false);
    expect(out.errors).toContain("alert_delivery_failed");
    const rows = parseEvidenceList(asService("tw4_price_monitor_evidence_list", "20::int", "null::bigint"))!.rows;
    expect(rows.some((r) => r.kind === "delivery" && JSON.parse(r.payload).alert_ok === false)).toBe(true);
    clockMs += 60_000;
    const good = new FakeTransport();
    const out2 = await run([good]);
    expect(out2.redelivered).toBeGreaterThanOrEqual(1);
    expect(good.sent.some((m) => m.redeliveryOfSeq !== undefined)).toBe(true);
  });

  it("monitor-down heartbeat: the watchdog alerts on the real chain when no run is recent", async () => {
    clockMs += 3 * 3600_000;
    const t = new FakeTransport();
    const out = await runPriceWatchdog({ db: realDb, config: config([t]), now: clock, sleep: async () => undefined });
    expect(out.findings.map((f) => f.code)).toContain("monitor_stale");
    expect(t.sent.length).toBeGreaterThanOrEqual(1);
    expect(out.evidenceRecorded).toBe(true);
  });
});

/** Highest seq whose hash or link does not verify (0 when the chain is intact): breaks left behind by this suite's own earlier runs. */
function scanBreaks(): number {
  const rows = parseEvidenceList(asService("tw4_price_monitor_evidence_list", "1000::int", "null::bigint"))!.rows;
  let worst = 0;
  rows.forEach((r, i) => {
    const { entry_hash: _h, ...rest } = r;
    void _h;
    if (entryHash(rest) !== r.entry_hash || (i > 0 && r.prev_hash !== rows[i - 1].entry_hash)) worst = r.seq;
  });
  return worst;
}
