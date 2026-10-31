/**
 * D7 expiry job integration helper (local QA only): applies the SHARED TS boundary rule (organizerSuiteEntitlement.ts) to row
 * dumps produced by d7_expiry_job_integration.sql, to show (a) the read-only dry-run rule agrees with the SQL expiry boundary and
 * (b) after expiry, the paid Stripe row keeps access current while the expired grant does not.
 * Run: npx tsx scripts/qa/d7_expiry_ts_boundary_check.ts <before.json> <after.json>
 */
import { readFileSync } from "node:fs";
import { entitlementEndInstant, isEntitlementCurrent } from "../../src/lib/billing/organizerSuiteEntitlement";

type Row = { id: string; source: string; status: string; period_start: string | null; period_end: string | null; timezone: string | null };

const [beforePath, afterPath] = process.argv.slice(2);
const before = JSON.parse(readFileSync(beforePath, "utf8")) as Row[];
const after = JSON.parse(readFileSync(afterPath, "utf8")) as Row[];
let failed = false;
const check = (cond: boolean, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"} ts: ${label}`);
  if (!cond) failed = true;
};

// Same selection as countDueOrganizerSuiteGrants: active manual grants with a period_end whose end instant <= as_of.
const wouldExpire = (asOf: string) =>
  before.filter((r) => r.source === "manual_grant" && r.status === "active" && r.period_end)
    .filter((r) => (entitlementEndInstant(r.period_end as string, r.timezone)?.getTime() ?? Infinity) <= Date.parse(asOf)).length;

check(wouldExpire("2027-07-09T03:59:59Z") === 0, "dry-run rule at 03:59:59Z would expire 0 (SQL expired 0)");
check(wouldExpire("2027-07-09T04:00:00Z") === 1, "dry-run rule at 04:00:00Z would expire 1 (SQL expired 1)");
check(wouldExpire("2027-07-09T07:00:00Z") === 2, "dry-run rule at 07:00:00Z would also include the LA grant");

const at = new Date("2027-07-09T04:00:00Z");
const row = (suffix: string) => after.find((r) => r.id.endsWith(suffix)) as Row;
check(row("0a").status === "expired" && !isEntitlementCurrent(row("0a"), row("0a").timezone, at), "expired grant does not grant access");
check(isEntitlementCurrent(row("0b"), row("0b").timezone, at), "paid Stripe row keeps access current");
check(isEntitlementCurrent(row("0c"), row("0c").timezone, at), "open-ended grant still current");
check(row("0b").status === "active" && row("0c").status === "active" && row("0d").status === "active", "Stripe, open-ended and LA rows still active");
const studioHasAccess = after.filter((r) => r.timezone === "America/New_York" && (r.id.endsWith("0a") || r.id.endsWith("0b")))
  .some((r) => isEntitlementCurrent(r, r.timezone, at));
check(studioHasAccess, "NY studio access after expiry comes only from the paid row");

if (failed) process.exit(1);
console.log("TS BOUNDARY CHECK PASSED");
