/**
 * TW-4F F5: tw4_rfl_cancel_target (20261224090000) against a REAL schema. Read-only by design: privileges (service_role only; checked with has_function_privilege,
 * never by calling the function as an API role), platform-admin refusal, unknown / foreign operation refusal (NULL), the number path's dual-control binding
 * (consumed, same resource, same approval reference, consumed by the authorizing administrator no later than the authorization, two different administrators),
 * the campaign's Messaging Service and the service's live dependents, and that the function writes nothing (it runs inside a READ ONLY transaction).
 *
 * LOCAL QA DATABASE ONLY. Skipped unless both variables are set; requires the local-QA marker table and migrations through 20261224090000. Fixtures are inserted
 * with session_replication_role = replica (no triggers) into fresh synthetic rows; nothing reaches Twilio. Use a DEDICATED container:
 *
 *   TW4A_LOCAL_DB_CONTAINER=f5-rfl-pg  TW4RFL_DB=postgres
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const DB = process.env.TW4RFL_DB ?? "";
const enabled = Boolean(PG && DB);

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
const replica = (sql: string) => psql(`begin; set local session_replication_role = replica; ${sql} commit;`);
const sid = (prefix: string) => `${prefix}${randomBytes(16).toString("hex")}`;
const hex64 = () => randomBytes(32).toString("hex");
const RUN = randomBytes(3).toString("hex");

/** The function's reply, read inside a READ ONLY transaction: a write anywhere in it would fail the transaction. */
const target = (op: string, actor: string): Record<string, unknown> | null =>
  JSON.parse(psql(`begin transaction read only; select coalesce(public.tw4_rfl_cancel_target('${op}'::uuid, '${actor}'::uuid)::text, 'null'); commit;`)) as Record<string, unknown> | null;

const admin = () => {
  const id = randomUUID();
  replica(`insert into public.profiles (id, platform_role) values ('${id}', 'platform_admin');`);
  return id;
};

type World = { entity: string; studio: string; account: string };
function world(): World {
  const w = { entity: randomUUID(), studio: randomUUID(), account: sid("AC") };
  replica(`
insert into public.studios (id, name, slug, public_name, timezone) values ('${w.studio}', 'F5 ${RUN}', 'f5-${RUN}-${w.studio.slice(0, 8)}', null, 'UTC');
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${w.entity}', 'F5 World ${RUN} ${w.entity.slice(0, 8)} LLC', '7777', 500000, '${randomUUID()}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values ('${w.studio}', '${w.entity}', 'founding', '${randomUUID()}', 'fixture: f5', now());`);
  return w;
}
function resource(w: World, kind: "number" | "campaign" | "messaging_service", state: "active" | "cancelled" = "active"): { id: string; sid: string } {
  const id = randomUUID();
  const providerSid = sid(kind === "number" ? "PN" : kind === "campaign" ? "QE" : "MG");
  const fee = kind === "number" ? "'number'" : kind === "campaign" ? "'monthly'" : "null";
  const e164 = kind === "number" ? `'+1202555${String(Math.floor(Math.random() * 9000) + 1000)}'` : "null";
  replica(`insert into public.studio_sms_provider_resources (id, legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, e164, fee_kind, source, registered_by, provider_state, cancelled_at, cancel_evidence_digest)
    values ('${id}', '${w.entity}', '${w.studio}', '${w.account}', '${kind}', '${providerSid}', ${e164}, ${fee}, 'admin', '${randomUUID()}', '${state}', ${state === "cancelled" ? "now()" : "null"}, ${state === "cancelled" ? `'${hex64()}'` : "null"});`);
  return { id, sid: providerSid };
}
function operation(w: World, resourceId: string, authorizedBy: string, opts: { status?: string; ref?: string } = {}): { id: string; ref: string } {
  const id = randomUUID();
  const ref = opts.ref ?? `Written approval ${RUN} ${randomBytes(4).toString("hex")}`;
  const status = opts.status ?? "authorized";
  const started = status === "authorized" || status === "withdrawn" ? "null, null" : `'${authorizedBy}', now()`;
  replica(`insert into public.studio_sms_provider_cancel_ops (id, resource_id, legal_entity_id, studio_id, status, decided_by, approval_ref, ref_norm, reason, irreversible_ack, authorized_by, authorized_at, started_by, started_at)
    values ('${id}', '${resourceId}', '${w.entity}', '${w.studio}', '${status}', 'owner_written', '${ref}', public._tw4fi_ref_norm('${ref}'), 'the owner asked in writing to retire it', true, '${authorizedBy}', now(), ${started});`);
  return { id, ref };
}
function dual(w: World, resourceId: string, o: { ref: string; requestedBy: string; decidedBy: string; consumedBy: string; status?: string; consumedAt?: string }): string {
  const id = randomUUID();
  const status = o.status ?? "consumed";
  const consumed = status === "consumed" ? `${o.consumedAt ?? "now() - interval '1 minute'"}, '${o.consumedBy}'` : "null, null";
  replica(`insert into public.studio_sms_rfl_dual_requests (id, action, legal_entity_id, studio_id, resource_id, reason, approval_ref, approval_ref_norm, cancel_decided_by, facts_hash, status,
      requested_by, requested_at, expires_at, decided_by, decided_at, decision_note, consumed_at, consumed_by)
    values ('${id}', 'cancel_number', '${w.entity}', '${w.studio}', '${resourceId}', 'the owner asked in writing to retire it', '${o.ref}', public._tw4fi_ref_norm('${o.ref}'), 'owner_written', '${hex64()}', '${status}',
      '${o.requestedBy}', now() - interval '1 hour', now() + interval '23 hours', '${o.decidedBy}', now() - interval '30 minutes', 'a second administrator approves this', ${consumed});`);
  return id;
}

describe.skipIf(!enabled)("TW-4F F5 tw4_rfl_cancel_target (real schema)", () => {
  let A: string;
  let B: string;
  let C: string;
  beforeAll(() => {
    expect(psql(`select to_regclass('public.tw4_local_qa_only') is not null`)).toBe("t");
    expect(psql(`select to_regprocedure('public.tw4_rfl_cancel_target(uuid,uuid)') is not null`)).toBe("t");
    A = admin();
    B = admin();
    C = admin();
  });

  it("is STABLE, security definer, search_path pinned, and executable by service_role only", () => {
    const fn = "'public.tw4_rfl_cancel_target(uuid,uuid)'::regprocedure";
    expect(psql(`select provolatile::text || ',' || prosecdef::text || ',' || array_to_string(proconfig, ';') from pg_proc where oid = ${fn}`)).toBe("s,true,search_path=pg_catalog, public, pg_temp");
    expect(psql(`select string_agg(r || '=' || has_function_privilege(r, ${fn}, 'execute')::text, ',' order by r) from unnest(array['anon', 'authenticated', 'service_role']) r`))
      .toBe("anon=false,authenticated=false,service_role=true");
    expect(psql(`select count(*) from information_schema.routine_privileges where specific_name like 'tw4_rfl_cancel_target%' and grantee = 'PUBLIC'`)).toBe("0");
  });

  it("refuses a non-administrator (42501) and answers NULL for an unknown operation", () => {
    const w = world();
    const r = resource(w, "campaign");
    const op = operation(w, r.id, A);
    expect(psqlError(`select public.tw4_rfl_cancel_target('${op.id}'::uuid, '${randomUUID()}'::uuid);`)).toMatch(/ERROR:\s+42501:/);
    expect(target(randomUUID(), A)).toBeNull();
  });

  it("number: returns the target only with the consumed approval bound to THIS operation by two different administrators", () => {
    const w = world();
    const n = resource(w, "number");
    const op = operation(w, n.id, A);
    expect(target(op.id, A)).toBeNull();   // no approval at all (e.g. authorized before 20261211)
    const reqId = dual(w, n.id, { ref: op.ref, requestedBy: B, decidedBy: C, consumedBy: A });
    const t = target(op.id, B) as Record<string, unknown>;
    expect(t).toMatchObject({
      operation_id: op.id, resource_id: n.id, operation_status: "authorized", kind: "number", provider_state: "active", provider_sid: n.sid, account_sid: w.account,
      messaging_service_sid: null, live_dependents: 0, dual_control: { request_id: reqId, resource_id: n.id, requested_by: B, decided_by: C, status: "consumed" },
    });
  });

  it("number: fails closed for every approval that is not bound to the operation", () => {
    const cases: [string, (w: World, n: { id: string }, op: { id: string; ref: string }) => void][] = [
      ["another approval reference", (w, n) => void dual(w, n.id, { ref: `Other approval ${RUN} ${randomBytes(3).toString("hex")}`, requestedBy: B, decidedBy: C, consumedBy: A })],
      ["approved, not consumed", (w, n, op) => void dual(w, n.id, { ref: op.ref, requestedBy: B, decidedBy: C, consumedBy: A, status: "approved" })],
      ["consumed by someone other than the authorizer", (w, n, op) => void dual(w, n.id, { ref: op.ref, requestedBy: B, decidedBy: C, consumedBy: B })],
      ["consumed after the authorization", (w, n, op) => void dual(w, n.id, { ref: op.ref, requestedBy: B, decidedBy: C, consumedBy: A, consumedAt: "now() + interval '1 hour'" })],
      ["approval for another resource", (w, _n, op) => void dual(w, resource(world(), "number").id, { ref: op.ref, requestedBy: B, decidedBy: C, consumedBy: A })],
    ];
    for (const [name, arrange] of cases) {
      const w = world();
      const n = resource(w, "number");
      const op = operation(w, n.id, A);
      arrange(w, n, op);
      expect(target(op.id, A), name).toBeNull();
    }
    // one administrator requesting AND approving cannot even be stored as consumed
    const w = world();
    const n = resource(w, "number");
    const op = operation(w, n.id, A);
    expect(() => dual(w, n.id, { ref: op.ref, requestedBy: B, decidedBy: B, consumedBy: A })).toThrow(/studio_sms_rfl_dual_requests_distinct/);
  });

  it("campaign: carries the location's live Messaging Service in the same subaccount; service: counts its live campaign", () => {
    const w = world();
    const ms = resource(w, "messaging_service");
    const qe = resource(w, "campaign");
    const campaignOp = operation(w, qe.id, A);
    expect(target(campaignOp.id, A)).toMatchObject({ kind: "campaign", provider_sid: qe.sid, messaging_service_sid: ms.sid, dual_control: null });
    const serviceOp = operation(w, ms.id, A, {});
    // (one OPEN operation per resource: the service's is separate from the campaign's)
    expect(target(serviceOp.id, A)).toMatchObject({ kind: "messaging_service", provider_sid: ms.sid, live_dependents: 1, messaging_service_sid: null });
    const lone = world();
    const loneMs = resource(lone, "messaging_service");
    expect(target(operation(lone, loneMs.id, A).id, A)).toMatchObject({ live_dependents: 0 });
    const noService = world();
    const loneQe = resource(noService, "campaign");
    expect(target(operation(noService, loneQe.id, A).id, A)).toMatchObject({ messaging_service_sid: null });   // the runner refuses this
  });

  it("reports the operation's real status (the runner refuses anything but authorized)", () => {
    const w = world();
    const r = resource(w, "campaign");
    expect(target(operation(w, r.id, A, { status: "unknown_outcome" }).id, A)).toMatchObject({ operation_status: "unknown_outcome" });
    // the runner's post-claim re-read depends on seeing in_flight
    const w2 = world();
    const r2 = resource(w2, "campaign");
    expect(target(operation(w2, r2.id, A, { status: "in_flight" }).id, A)).toMatchObject({ operation_status: "in_flight", provider_sid: r2.sid });
  });

  it("a campaign never borrows a Messaging Service from another subaccount", () => {
    const w = world();
    const qe = resource(w, "campaign");
    // a live service row of the same location but recorded in a different subaccount
    resource({ ...w, account: sid("AC") }, "messaging_service");
    expect(target(operation(w, qe.id, A).id, A)).toMatchObject({ kind: "campaign", messaging_service_sid: null });
  });

  it("writes nothing: table contents and the audit trail are unchanged by a call", () => {
    const w = world();
    const n = resource(w, "number");
    const op = operation(w, n.id, A);
    dual(w, n.id, { ref: op.ref, requestedBy: B, decidedBy: C, consumedBy: A });
    const snapshot = () => psql(`select md5(string_agg(t, '|' order by t)) from (
      select x::text t from public.studio_sms_provider_cancel_ops x union all select x::text from public.studio_sms_provider_resources x
      union all select x::text from public.studio_sms_rfl_dual_requests x union all select x::text from public.studio_sms_onboarding_audit x) s`);
    const before = snapshot();
    expect(target(op.id, A)).not.toBeNull();
    expect(target(randomUUID(), A)).toBeNull();
    expect(snapshot()).toBe(before);
  });
});
