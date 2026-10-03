#!/usr/bin/env node
// ENT-1 -- real concurrency verification of reserve_usage_allowance (DEV ONLY).
//
//   ENT1_BAND=<n> node ent1_race_harness.mjs run
//
// Every competing request is its own PostgREST RPC (own backend connection, own
// transaction), fired at the same instant with Promise.all. The per-workspace
// advisory lock must serialize them so that, however they interleave:
//   - the sum of granted reservations never exceeds the allowance;
//   - concurrent campaigns that cannot all fit are granted all-or-nothing each
//     (no partial reservation);
//   - finalizing concurrently with new reservations never double counts.
//
// Safety: refuses unless the linked project AND the API URL are DEV
// (epdrtzcydvnoidwrepqz). Never reads a PROD credential. It creates one synthetic
// studio (slug t-ent1-race-<band>) and deletes it, with all of its usage rows,
// at the end of the run. Use a new ENT1_BAND for every run.

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
const period = {
  start: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString().slice(0, 10),
  end: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toISOString().slice(0, 10),
};
const reserve = (studioId, qty, allowance, key) =>
  rest("rpc/reserve_usage_allowance", {
    method: "POST",
    body: JSON.stringify({
      p_workspace_type: "studio", p_studio_id: studioId, p_organizer_id: null, p_feature_key: "email_campaign_recipient",
      p_quantity: qty, p_allowance: allowance, p_period_start: period.start, p_period_end: period.end,
      p_idempotency_key: key, p_source: "ent1_race", p_related_table: null, p_related_id: null, p_created_by: null,
    }),
  });
const finalize = (id, consumed) => rest("rpc/finalize_usage_reservation", { method: "POST", body: JSON.stringify({ p_reservation_id: id, p_quantity_consumed: consumed }) });

let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); if (!ok) failures += 1; };

async function used(studioId) {
  const rows = await rest(`usage_monthly_summaries?studio_id=eq.${studioId}&feature_key=eq.email_campaign_recipient&period_start=eq.${period.start}&select=quantity_used`);
  return rows[0]?.quantity_used ?? 0;
}

const [studio] = await rest("studios", { method: "POST", body: JSON.stringify({ name: `ENT-1 race ${band}`, slug }) });
try {
  // A. 30 concurrent requests of 100 against an allowance of 1000: exactly 10 may be granted.
  let results = await Promise.all(Array.from({ length: 30 }, (_, i) => reserve(studio.id, 100, 1000, `a-${i}`)));
  let granted = results.filter((r) => r.ok);
  check("A1 exactly 10 of 30 concurrent 100-recipient reservations granted", granted.length === 10, `granted=${granted.length}`);
  check("A2 granted total never exceeds the allowance", granted.reduce((s, r) => s + r.quantity, 0) <= 1000);
  check("A3 refusals are limit_reached", results.filter((r) => !r.ok).every((r) => r.reason === "limit_reached"));

  // B. Finalize 6 of them with 100 successes, 4 with 40 (failures consume nothing) while 8 new requests race in.
  const live = granted.map((r) => r.reservation_id);
  const racing = Array.from({ length: 8 }, (_, i) => reserve(studio.id, 100, 1000, `b-${i}`));
  const finals = live.map((id, i) => finalize(id, i < 6 ? 100 : 40));
  const [afterB, ...fin] = [await Promise.all(racing), ...(await Promise.all(finals))];
  check("B1 all finalizations ok", fin.every((f) => f.ok));
  const usedNow = await used(studio.id);
  check("B2 usage equals successful recipients only", usedNow === 6 * 100 + 4 * 40, `used=${usedNow}`);
  const grantedB = afterB.filter((r) => r.ok).length;
  check("B3 racing reservations never pushed used + reserved over 1000", usedNow + grantedB * 100 <= 1000, `used=${usedNow} grantedB=${grantedB}`);

  // C. Two campaigns of 600 against 1000 (fresh key space, after releasing B reservations): all or nothing each.
  const open = await rest(`usage_reservations?studio_id=eq.${studio.id}&status=eq.reserved&select=id`);
  await Promise.all(open.map((o) => rest("rpc/release_usage_reservation", { method: "POST", body: JSON.stringify({ p_reservation_id: o.id }) })));
  const remaining = 1000 - (await used(studio.id));
  const pair = await Promise.all([reserve(studio.id, remaining - 10, 1000, "c-1"), reserve(studio.id, remaining - 10, 1000, "c-2")]);
  check("C1 two campaigns that cannot both fit: exactly one is granted", pair.filter((r) => r.ok).length === 1, JSON.stringify(pair.map((r) => r.ok)));
  check("C2 the refused one reserved nothing", (await rest(`usage_reservations?studio_id=eq.${studio.id}&idempotency_key=in.(c-1,c-2)&select=id`)).length === 1);

  // D. The same key fired 20 times concurrently returns one reservation.
  const same = await Promise.all(Array.from({ length: 20 }, () => reserve(studio.id, 1, 1000, "d-same")));
  check("D1 one key, 20 concurrent calls: one reservation", new Set(same.filter((r) => r.ok).map((r) => r.reservation_id)).size === 1);
} finally {
  await rest(`studios?id=eq.${studio.id}`, { method: "DELETE" });
  console.log(`cleanup: deleted synthetic studio ${slug}`);
}
console.log(failures === 0 ? "ENT-1 RACE HARNESS: ALL PASSED" : `ENT-1 RACE HARNESS: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
