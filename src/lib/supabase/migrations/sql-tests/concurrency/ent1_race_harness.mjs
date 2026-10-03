#!/usr/bin/env node
// ENT-1 -- real concurrency verification of the campaign-level allowance reservation (DEV ONLY).
//
//   ENT1_BAND=<n> node ent1_race_harness.mjs
//
// Every competing request is its own PostgREST RPC (own backend connection, own transaction), fired at the same instant
// with Promise.all. The per-workspace advisory lock must serialize them so that, however they interleave:
//   A. the sum of admitted campaigns never exceeds the allowance, and each is admitted whole (no partial admission);
//   B. settling concurrently with new admissions records only successes and never lets used + committed pass the allowance;
//   C. MULTI-BATCH: a campaign admitted for 600 recipients (more than one 500-recipient batch) keeps its capacity for the
//      later batch while 20 other campaigns race for it, and its second batch is never refused;
//   D. a double submit of the same campaign admits it once (the second is 'in_progress');
//   E. capacity of an unsettled batch is never released.
//
// Safety: refuses unless the linked project AND the API URL are DEV (epdrtzcydvnoidwrepqz). Never reads a PROD credential.
// It creates one synthetic studio (slug t-ent1-race-<band>) and deletes it, with all of its usage rows, at the end of the run.
// Use a new ENT1_BAND for every run.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEV_REF = "epdrtzcydvnoidwrepqz";
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../../..");

const linked = readFileSync(join(ROOT, "supabase/.temp/project-ref"), "utf8").trim();
if (linked !== DEV_REF) { console.error(`REFUSING: repo linked to ${linked}, not DEV`); process.exit(2); }
const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env.local"), "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]),
);
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !URL_.includes(DEV_REF)) { console.error("REFUSING: API URL is not the DEV project"); process.exit(2); }
if (!KEY) { console.error("REFUSING: no service key"); process.exit(2); }

const band = process.env.ENT1_BAND;
if (!band) { console.error("ENT1_BAND is required"); process.exit(2); }
const slug = `t-ent1-race-${band}`;

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "return=representation" };
async function rest(path, init = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const now = new Date();
const period = {
  start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10),
  end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10),
};
const uuids = (n) => Array.from({ length: n }, () => randomUUID());
const reserve = (studioId, pending, allowance, key, batch = Math.min(pending, 500)) =>
  rest("rpc/reserve_usage_allowance", {
    method: "POST",
    body: JSON.stringify({
      p_workspace_type: "studio", p_studio_id: studioId, p_organizer_id: null, p_feature_key: "email_campaign_recipient",
      p_quantity: pending, p_allowance: allowance, p_period_start: period.start, p_period_end: period.end,
      p_idempotency_key: key, p_source: "ent1_race", p_related_table: null, p_related_id: null, p_created_by: null,
      p_batch_recipient_ids: uuids(batch), p_stale_seconds: 900,
    }),
  });
const settle = (id, sent, pending) =>
  rest("rpc/settle_usage_reservation", { method: "POST", body: JSON.stringify({ p_reservation_id: id, p_batch_sent: sent, p_pending_remaining: pending }) });

let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); if (!ok) failures += 1; };

async function used(studioId) {
  const rows = await rest(`usage_monthly_summaries?studio_id=eq.${studioId}&feature_key=eq.email_campaign_recipient&period_start=eq.${period.start}&select=quantity_used`);
  return rows[0]?.quantity_used ?? 0;
}
async function committed(studioId) {
  const rows = await rest(`usage_reservations?studio_id=eq.${studioId}&status=eq.reserved&select=quantity_reserved,quantity_consumed`);
  return rows.reduce((s, r) => s + r.quantity_reserved - r.quantity_consumed, 0);
}

const [studio] = await rest("studios", { method: "POST", body: JSON.stringify({ name: `ENT-1 race ${band}`, slug }) });
try {
  // A. 30 concurrent admissions of 100 against 1000: exactly 10, each whole.
  const a = await Promise.all(Array.from({ length: 30 }, (_, i) => reserve(studio.id, 100, 1000, `a-${i}`)));
  const admitted = a.filter((r) => r.ok);
  check("A1 exactly 10 of 30 concurrent 100-recipient campaigns admitted", admitted.length === 10, `admitted=${admitted.length}`);
  check("A2 refusals are limit_reached and commit nothing", a.filter((r) => !r.ok).every((r) => r.reason === "limit_reached") && (await committed(studio.id)) === 1000);

  // B. settle (successes only) while 8 new campaigns race for the freed capacity.
  const racing = Array.from({ length: 8 }, (_, i) => reserve(studio.id, 100, 1000, `b-${i}`));
  const settles = admitted.map((r, i) => settle(r.reservation_id, i < 6 ? 100 : 40, 0)); // 6 fully delivered, 4 with 60 failures
  const [afterB, ...fin] = [await Promise.all(racing), ...(await Promise.all(settles))];
  check("B1 all settles ok", fin.every((f) => f.ok));
  const usedB = await used(studio.id);
  check("B2 usage equals successful recipients only", usedB === 6 * 100 + 4 * 40, `used=${usedB}`);
  const commB = await committed(studio.id);
  check("B3 used + committed never exceeds the allowance", usedB + commB <= 1000, `used=${usedB} committed=${commB}`);

  // clean slate for C: settle every open campaign with nothing more pending, then use a fresh workspace state
  for (const r of afterB.filter((x) => x.ok)) await settle(r.reservation_id, 0, 0);
  const base = await used(studio.id); // 760
  const allowanceC = base + 1000; // 1000 free for the multi-batch scenario

  // C. MULTI-BATCH under contention.
  const m = await reserve(studio.id, 600, allowanceC, "c-multi", 500); // admitted for all 600, mails a 500 batch
  check("C1 the 600-recipient campaign is admitted whole", m.ok && m.committed === 600, JSON.stringify(m));
  const m1 = await settle(m.reservation_id, 500, 100); // 500 delivered, 100 still pending
  check("C2 first batch settled: commitment shrinks to the 100 still pending", m1.ok && m1.quantity_still_committed === 100, JSON.stringify(m1));
  // 20 other campaigns of 100 race with the campaign's own second batch
  const thieves = Array.from({ length: 20 }, (_, i) => reserve(studio.id, 100, allowanceC, `c-thief-${i}`));
  const second = reserve(studio.id, 100, allowanceC, "c-multi", 100);
  const [secondResult, ...thiefResults] = await Promise.all([second, ...thieves]);
  check("C3 the campaign's second batch is NEVER refused (it continues under its commitment)", secondResult.ok && secondResult.continued === true, JSON.stringify(secondResult));
  const grantedThieves = thiefResults.filter((r) => r.ok).length;
  // 1000 free: 500 used by the campaign + 100 committed to it => 400 free => exactly 4 thieves of 100
  check("C4 other campaigns got exactly the uncommitted capacity (4 of 20)", grantedThieves === 4, `granted=${grantedThieves}`);
  const m2 = await settle(m.reservation_id, 100, 0);
  check("C5 the campaign finishes: all 600 recorded, reservation finalized", m2.ok && m2.status === "finalized" && (await used(studio.id)) === base + 600, JSON.stringify(m2));
  for (const r of thiefResults.filter((x) => x.ok)) await settle(r.reservation_id, 0, 0);

  // D. double submit of one campaign: admitted once.
  const key = "d-double";
  const d = await Promise.all(Array.from({ length: 10 }, () => reserve(studio.id, 50, allowanceC + 5000, key, 50)));
  check("D1 one campaign key fired 10 times concurrently admits exactly once", d.filter((r) => r.ok).length === 1 && d.filter((r) => r.reason === "in_progress").length === 9, JSON.stringify(d.map((r) => r.ok ? "ok" : r.reason)));

  // E. an unsettled batch keeps its capacity.
  const free = allowanceC + 5000 - base - 600 - 50 + 0; // remaining after D's open batch (50) and usage so far
  const e = await reserve(studio.id, free + 1, allowanceC + 5000, "e-over");
  check("E1 capacity of an open (unsettled) batch is never released", !e.ok && e.reason === "limit_reached", JSON.stringify(e));
  await settle(d.find((r) => r.ok).reservation_id, 0, 0);
} finally {
  await rest(`studios?id=eq.${studio.id}`, { method: "DELETE" });
  console.log(`cleanup: deleted synthetic studio ${slug}`);
}
console.log(failures === 0 ? "ENT-1 RACE HARNESS: ALL PASSED" : `ENT-1 RACE HARNESS: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
