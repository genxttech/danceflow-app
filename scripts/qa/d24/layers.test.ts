import { beforeAll, describe, expect, it } from "vitest";
import { q, rpc, runSql, as, stackLayers } from "./pgBridge";

/**
 * D24 M2-D: sibling-layer acceptance at the SQL boundary (M2-B operator authorization, M2-C drain/recovery), against the real
 * migrations of the sibling draft PRs loaded by scripts/qa/d24-stack.sh --m2b/--m2c. Without the layer these are BLOCKED (skipped),
 * never passed.
 */

const LAYERS = stackLayers();
const has = (l: string) => LAYERS?.includes(l) ?? false;
const RUN = Math.random().toString(36).slice(2, 7).replace(/[^a-z0-9]/g, "x");
let seq = 0;
const nid = () => `${RUN}${(++seq).toString(36)}`;
const SA = "00000000-0000-0000-0000-0000000d255a";
const SB = "00000000-0000-0000-0000-0000000d255b";
const PLAT = "00000000-0000-0000-0000-0000000d25c1";
const OWA = "00000000-0000-0000-0000-0000000d25a1";
const OWB = "00000000-0000-0000-0000-0000000d25b1";
const FDA = "00000000-0000-0000-0000-0000000d25a3";
const OWNER = "00000000-0000-0000-0000-0000000d25e1";
const NOT_PLAT = "00000000-0000-0000-0000-0000000d25f0";

const asUser = (uid: string | null, aal: string, sql: string) => {
  const claims = uid ? `{"sub":"${uid}","role":"authenticated","aal":"${aal}"}` : "{}";
  return runSql(`select set_config('request.jwt.claims','${claims}',false) is not null; ${sql}`, "authenticated").then((r) => (r.error ? `ERR ${r.error.code} ${r.error.message}` : r.out.replace(/^t\n?/, "")));
};
const claim = (id: string) => q(`select (public.claim_payment_provider_event('stripe','${id}','x','h','${OWNER}'))->>'outcome'`);
const invObj = (inv: string, status = "void") => ({ invoice_id: inv, status, total: 100, amount_due: 100, amount_paid: 0, amount_remaining: 100, currency: "usd" });
const payObj = (inv: string, pay: string, n: number) => ({ invoice_id: inv, object_id: pay, status: "paid", amount_requested: n, amount_paid: n, currency: "usd" });
async function apply(id: string, type: string, created: number, kind: string, obj: Record<string, unknown>, account: string | null = null) {
  await claim(id);
  const r = await rpc("d24_apply_event", { p_provider_event_id: id, p_owner: OWNER, p_event_type: type, p_event_created: created, p_account: account, p_livemode: false, p_payload_hash: "h", p_kind: kind, p_object: obj });
  if (r.error) throw new Error(`apply ${id}: ${r.error.message}`);
}
async function defer(id: string, type: string, created: number, kind: string, obj: Record<string, unknown>) {
  await claim(id);
  const r = await rpc("d24_defer_event", { p_provider_event_id: id, p_owner: OWNER, p_event_type: type, p_event_created: created, p_account: null, p_livemode: false, p_payload_hash: "h", p_kind: kind, p_object: obj });
  if (r.error) throw new Error(`defer ${id}: ${r.error.message}`);
}
const register = (studio: string, inv: string) => rpc("d24_register_invoice", { p_studio_id: studio, p_stripe_account_id: null, p_stripe_invoice_id: inv, p_livemode: false, p_business_object_type: "event_fee", p_business_object_id: `bo-${inv}` });
const rowId = (inv: string) => q(`select id from public.hosted_invoices where stripe_invoice_id='${inv}' and account_key=''`);
/** an attributed invoice that is anomalous (registered void => unverified_void_origin) */
async function anomalous(studio: string) {
  const inv = `in_${nid()}`;
  await register(studio, inv);
  await apply(`evt_${nid()}`, "invoice.voided", 1_800_500_000 + seq, "invoice", invObj(inv));
  return { inv, id: await rowId(inv) };
}

const B = describe.skipIf(!has("m2b"));
B("M2B. operator authorization (M2-B)", () => {
  beforeAll(async () => {
    await q(`insert into public.studios (id,name) values ('${SA}','A'),('${SB}','B') on conflict do nothing;
             insert into public.profiles (id, platform_role) values ('${PLAT}','platform_admin'),('${NOT_PLAT}',null) on conflict do nothing;
             insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${OWA}','${SA}','studio_owner',true),('${OWB}','${SB}','studio_owner',true),('${FDA}','${SA}','front_desk',true);`);
  });
  const ack = (uid: string | null, aal: string, id: string, code = "unverified_void_origin", reason = "reviewed by operator") =>
    asUser(uid, aal, `select public.d24_op_acknowledge_anomalies('${id}','{${code}}','${reason}')::text`);

  it("M2B1 service_role (no end user) cannot acknowledge, even with the old actor-trusting function", async () => {
    const a = await anomalous(SA);
    expect(await as("service_role", `select public.d24_op_acknowledge_anomalies('${a.id}','{unverified_void_origin}','reviewed by operator')`)).toMatch(/permission denied/);
    expect(await as("service_role", `select public.d24_acknowledge_anomalies('${a.id}','{unverified_void_origin}','${PLAT}','x')`)).toMatch(/permission denied/);
    expect(await q(`select reconciliation_state from public.hosted_invoices where id='${a.id}'`)).toBe("anomalous");
  });
  it("M2B2 an authenticated session with no JWT subject or only aal1 is refused", async () => {
    const a = await anomalous(SA);
    expect(await ack(null, "aal2", a.id)).toMatch(/d24_op_authentication_required/);
    expect(await ack(OWA, "aal1", a.id)).toMatch(/d24_op_aal2_required/);
  });
  it("M2B3 a studio operator at aal2 can acknowledge an invoice of their own studio, audited with actor and reason", async () => {
    const a = await anomalous(SA);
    expect(await ack(OWA, "aal2", a.id)).toMatch(/acknowledged/);
    expect(await q(`select actor_user_id::text||'/'||reason from public.hosted_invoice_recon_audit where invoice_row_id='${a.id}' and trigger_kind='acknowledgement'`)).toBe(`${OWA}/reviewed by operator`);
  });
  it("M2B4 a studio owner cannot acknowledge or read ANOTHER studio's invoice and gets no existence oracle", async () => {
    const a = await anomalous(SA);
    const missing = await ack(OWB, "aal2", "00000000-0000-0000-0000-00000000dead");
    const foreign = await ack(OWB, "aal2", a.id);
    expect(foreign).toMatch(/d24_invoice_not_found/);
    expect(missing).toMatch(/d24_invoice_not_found/);
    expect(await asUser(OWB, "aal2", `select public.d24_op_get_invoice('${a.id}')::text`)).toMatch(/d24_invoice_not_found/);
    const own = await anomalous(SB);
    const list = await asUser(OWB, "aal2", `select string_agg(distinct r->>'studio_id', ',') from jsonb_array_elements((public.d24_op_list_invoices(null,null,false,200,0))->'rows') r`);
    expect(list).toContain(SB);
    expect(list).not.toContain(SA);
    expect(own.id).toBeTruthy();
    expect(await q(`select reconciliation_state from public.hosted_invoices where id='${a.id}'`)).toBe("anomalous");
  });
  it("M2B5 front_desk and non-roles are refused; a reason under 10 characters is refused", async () => {
    const a = await anomalous(SA);
    expect(await ack(FDA, "aal2", a.id)).toMatch(/d24_invoice_not_found/);
    expect(await ack(NOT_PLAT, "aal2", a.id)).toMatch(/d24_invoice_not_found/);
    expect(await ack(OWA, "aal2", a.id, "unverified_void_origin", "short")).toMatch(/d24_op_reason_required/);
  });
  it("M2B6 an unmatched invoice cannot be acknowledged by anyone, and only a platform admin can dismiss it (dismissal keeps all facts)", async () => {
    const inv = `in_${nid()}`;
    await apply(`evt_${nid()}`, "invoice.voided", 1_800_500_100, "invoice", invObj(inv));
    const id = await rowId(inv);
    expect(await ack(PLAT, "aal2", id)).toMatch(/d24_unmatched_invoice_cannot_be_acknowledged/);
    expect(await asUser(OWA, "aal2", `select public.d24_op_dismiss_unmatched('${id}','not ours, reviewed')`)).toMatch(/d24_op_platform_admin_required/);
    expect(await asUser(PLAT, "aal2", `select public.d24_op_dismiss_unmatched('${id}','not ours, reviewed')::text`)).not.toMatch(/^ERR/);
    expect(await q(`select coalesce(studio_id::text,'NULL')||'/'||reconciliation_state||'/'||(select count(*) from public.hosted_invoice_source_events where invoice_row_id='${id}') from public.hosted_invoices where id='${id}'`)).toBe("NULL/unmatched/1");
  });
  it("M2B7 a platform-only anomaly code (invoice_payment_conflict) is refused to a studio operator and accepted from a platform admin", async () => {
    const inv = `in_${nid()}`;
    const pay = `inpay_${nid()}`;
    await register(SA, inv);
    await apply(`evt_${nid()}`, "invoice_payment.paid", 1_800_500_200, "invoice_payment", payObj(inv, pay, 10));
    await apply(`evt_${nid()}`, "invoice_payment.paid", 1_800_500_201, "invoice_payment", payObj(inv, pay, 99));
    const id = await rowId(inv);
    expect(await q(`select anomaly_codes @> array['invoice_payment_conflict'] from public.hosted_invoices where id='${id}'`)).toBe("t");
    expect(await ack(OWA, "aal2", id, "invoice_payment_conflict")).toMatch(/d24_op_code_requires_platform_admin/);
    expect(await ack(PLAT, "aal2", id, "invoice_payment_conflict")).toMatch(/acknowledged/);
  });
  it("M2B8 operator tables are service-private: authenticated users cannot select or write them", async () => {
    expect(await as("authenticated", "select count(*) from public.hosted_invoice_dismissals")).toMatch(/permission denied/);
    expect(await as("authenticated", "select count(*) from public.hosted_invoices")).toMatch(/permission denied/);
    expect(await as("anon", "select public.d24_op_list_invoices()")).toMatch(/permission denied/);
  });
});

// With M2-B loaded the direct requeue function is closed to service_role, so requeue goes THROUGH M2-B's wrapper as a platform admin at aal2
// (the owner-approved policy); without M2-B it uses M2-C's direct function. Either way the checks run, they are never skipped.
const requeue = async (event: string, reason: string): Promise<string> =>
  has("m2b")
    ? asUser(PLAT, "aal2", `select (public.d24_op_requeue_deferred('${event}','${reason}'))->>'outcome'`)
    : as("service_role", `select (public.d24_requeue_deferred_event('${event}','${PLAT}','${reason}'))->>'outcome'`);
const C = describe.skipIf(!has("m2c"));
C(`M2C. drain job (M2-C${has("m2b") ? ", full stack, requeue through the M2-B wrapper" : ", direct requeue"})`, () => {
  beforeAll(async () => {
    await q(`insert into public.studios (id,name) values ('${SA}','A'),('${SB}','B') on conflict do nothing`);
    if (has("m2b")) await q(`insert into public.profiles (id, platform_role) values ('${PLAT}','platform_admin') on conflict do nothing`);
  });
  it("M2C1 service_role may run d24_run_drain but not the unbounded d24_drain_deferred; anon/authenticated may run neither", async () => {
    expect(await as("service_role", "select (public.d24_run_drain(5,'manual'))->>'outcome'")).toBe("completed");
    expect(await as("service_role", "select public.d24_drain_deferred(5)")).toMatch(/permission denied/);
    expect(await as("anon", "select public.d24_run_drain(5,'manual')")).toMatch(/permission denied/);
    expect(await as("authenticated", "select public.d24_run_drain(5,'manual')")).toMatch(/permission denied/);
    expect(await as("service_role", "select public.d24_run_drain(5,'cron-spoof')")).toMatch(/trigger must be scheduled or manual/);
  });
  it("M2C2 concurrent runs never double-apply: each deferred event is applied exactly once and every run is audited", async () => {
    const ids: string[] = [];
    const pays: string[] = [];
    for (let i = 0; i < 12; i++) {
      const inv = `in_${nid()}`;
      const p = `inpay_${nid()}`;
      pays.push(p);
      const e = `evt_${nid()}`;
      ids.push(e);
      await defer(e, "invoice_payment.paid", 1_800_600_000 + i, "invoice_payment", payObj(inv, p, 10 + i));
    }
    const runsBefore = Number(await q("select count(*) from public.hosted_invoice_drain_runs"));
    const results = await Promise.all(Array.from({ length: 4 }, () => rpc("d24_run_drain", { p_batch_size: 5, p_trigger: "scheduled" })));
    for (const r of results) expect(r.error).toBeNull();
    for (let i = 0; i < 5; i++) await rpc("d24_run_drain", { p_batch_size: 100, p_trigger: "scheduled" });
    const list = ids.map((i) => `'${i}'`).join(",");
    expect(await q(`select count(*) filter (where state='applied')||'/'||count(*) from public.hosted_invoice_deferred_events where provider_event_id in (${list})`)).toBe("12/12");
    expect(await q(`select count(*) from public.hosted_invoice_payments where stripe_invoice_payment_id in (${pays.map((p) => `'${p}'`).join(",")})`)).toBe("12");
    expect(await q(`select count(*) from public.hosted_invoice_source_events where provider_event_id in (${list})`)).toBe("12");
    const completed = results.filter((r) => (r.data as { outcome: string }).outcome === "completed").length;
    expect(Number(await q("select count(*) from public.hosted_invoice_drain_runs")) - runsBefore).toBeGreaterThanOrEqual(completed);
    expect(completed).toBeGreaterThanOrEqual(1);
  });
  it("M2C3 a poison event is rejected after repeated failures without starving newer events, and recovers through the audited requeue", async () => {
    const poisonInv = `in_${nid()}`;
    const poison = `evt_${nid()}`;
    await defer(poison, "invoice_payment.paid", 1_800_700_000, "invoice_payment", payObj(poisonInv, `inpay_${nid()}`, 77));
    await q(`create or replace function public._m2d_boom() returns trigger language plpgsql as $$ begin if new.provider_event_id = '${poison}' then raise exception 'm2d poison' using errcode='55000'; end if; return new; end $$;
             create trigger m2d_boom before insert on public.hosted_invoice_source_events for each row execute function public._m2d_boom();`);
    try {
      const later = `evt_${nid()}`;
      await defer(later, "invoice_payment.paid", 1_800_700_100, "invoice_payment", payObj(`in_${nid()}`, `inpay_${nid()}`, 5));
      for (let i = 0; i < 6; i++) await rpc("d24_run_drain", { p_batch_size: 10, p_trigger: "scheduled" });
      expect(await q(`select state from public.hosted_invoice_deferred_events where provider_event_id='${poison}'`)).toBe("rejected");
      expect(await q(`select state from public.hosted_invoice_deferred_events where provider_event_id='${later}'`)).toBe("applied");
      expect(await q(`select last_error_code from public.hosted_invoice_deferred_events where provider_event_id='${poison}'`)).toBe("55000");
    } finally {
      await q("drop trigger if exists m2d_boom on public.hosted_invoice_source_events; drop function if exists public._m2d_boom();");
    }
    expect(await requeue(poison, "")).toMatch(/ERR/);
    expect(await requeue(poison, "poison fixed, replaying")).toBe("requeued");
    await rpc("d24_run_drain", { p_batch_size: 10, p_trigger: "manual" });
    expect(await q(`select state from public.hosted_invoice_deferred_events where provider_event_id='${poison}'`)).toBe("applied");
    expect(await q(`select count(*) from public.hosted_invoice_source_events where provider_event_id='${poison}'`)).toBe("1");
    expect(await q(`select count(*) from public.hosted_invoice_deferred_requeues where provider_event_id='${poison}'`)).toBe("1");
  });
  it("M2C4 only a rejected event can be requeued; evidence of a deferred event stays immutable", async () => {
    const e = `evt_${nid()}`;
    await defer(e, "invoice_payment.paid", 1_800_800_000, "invoice_payment", payObj(`in_${nid()}`, `inpay_${nid()}`, 9));
    // M2-C's function refuses a non-rejected event; M2-B's wrapper answers an idempotent already_pending for a pending one. Either way nothing changes.
    expect(await requeue(e, "not rejected, must refuse")).toMatch(/d24_requeue_requires_rejected_event|d24_op_not_recoverable|already_pending/);
    expect(await q(`select state||'/'||requeue_count from public.hosted_invoice_deferred_events where provider_event_id='${e}'`)).toBe("pending/0");
    expect(await q(`select count(*) from public.hosted_invoice_deferred_requeues where provider_event_id='${e}'`)).toBe("0");
    expect(await as("postgres", `select set_config('d24.writer','on',false); update public.hosted_invoice_deferred_events set payload_hash='x' where provider_event_id='${e}'`)).toMatch(/immutable/);
  });
  it("M2C5 drain health reports counts and codes only", async () => {
    const h = await as("service_role", "select public.d24_drain_health()::text");
    expect(h).not.toMatch(/^ERR/);
    expect(h).not.toMatch(/pii|@example|object_snapshot/);
  });
});

describe("M2X. layers together", () => {
  if (!(has("m2b") && has("m2c"))) it.skip("BLOCKED: M2-B and M2-C are not loaded together on one database (see D24-M2D-ACCEPTANCE.md findings)", () => undefined);
  else it("M2X1 M2-B requeue wrapper and M2-C drain coexist: a poison event is rejected, only a platform admin at aal2 can requeue it, and the next drain applies it once", async () => {
    await q(`insert into public.studios (id,name) values ('${SA}','A') on conflict do nothing;
             insert into public.profiles (id, platform_role) values ('${PLAT}','platform_admin'),('${NOT_PLAT}',null) on conflict do nothing;
             insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${OWA}','${SA}','studio_owner',true)`);
    const poison = `evt_${nid()}`;
    await defer(poison, "invoice_payment.paid", 1_800_950_000, "invoice_payment", payObj(`in_${nid()}`, `inpay_${nid()}`, 41));
    await q(`create or replace function public._m2d_boom() returns trigger language plpgsql as $$ begin if new.provider_event_id = '${poison}' then raise exception 'm2d poison' using errcode='55000'; end if; return new; end $$;
             create trigger m2d_boom before insert on public.hosted_invoice_source_events for each row execute function public._m2d_boom();`);
    try {
      for (let i = 0; i < 6; i++) await rpc("d24_run_drain", { p_batch_size: 10, p_trigger: "scheduled" });
    } finally {
      await q("drop trigger if exists m2d_boom on public.hosted_invoice_source_events; drop function if exists public._m2d_boom();");
    }
    expect(await q(`select state from public.hosted_invoice_deferred_events where provider_event_id='${poison}'`)).toBe("rejected");
    const reason = "poison fixed, replaying";
    expect(await as("service_role", `select public.d24_requeue_deferred_event('${poison}','${PLAT}','${reason}')`)).toMatch(/permission denied/);
    expect(await asUser(OWA, "aal2", `select public.d24_op_requeue_deferred('${poison}','${reason}')`)).toMatch(/d24_op_platform_admin_required/);
    expect(await asUser(PLAT, "aal1", `select public.d24_op_requeue_deferred('${poison}','${reason}')`)).toMatch(/d24_op_aal2_required/);
    expect(await asUser(PLAT, "aal2", `select public.d24_op_requeue_deferred('${poison}','${reason}')::text`)).toMatch(/requeued/);
    expect(await q(`select state from public.hosted_invoice_deferred_events where provider_event_id='${poison}'`)).toBe("pending");
    await rpc("d24_run_drain", { p_batch_size: 10, p_trigger: "manual" });
    expect(await q(`select state from public.hosted_invoice_deferred_events where provider_event_id='${poison}'`)).toBe("applied");
    expect(await q(`select count(*) from public.hosted_invoice_source_events where provider_event_id='${poison}'`)).toBe("1");
    expect(await q(`select actor_user_id::text from public.hosted_invoice_deferred_requeues where provider_event_id='${poison}'`)).toBe(PLAT);
  });
});
