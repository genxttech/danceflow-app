// Read-only PROD pricing check. Modes: auto (default) | pre | post.
// auto: pre-signing GO/BLOCKED while price_rows is 0, post-signing verification once rows exist.
import { execFileSync } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const dir = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] || "auto";
const SB = process.env.DF_SB_SH || "C:/Users/mcurt/danceflow-ops/sb.sh"; // read-only prod helper; set DF_SB_SH on another machine
const bash = "C:/Program Files/Git/bin/bash.exe";
function read(f) {
  const out = execFileSync(bash, [SB, "prod-read", path.join(dir, f).split(path.sep).join("/")], { encoding: "utf8", timeout: 120000 });
  let r;
  const jl = out.indexOf("\"rows\"") >= 0 ? null : out.split(String.fromCharCode(10)).find((l) => l.includes("{\"now\""));
  if (jl) r = jl.slice(jl.indexOf("{"), jl.lastIndexOf("}") + 1);
  else { const s = out.indexOf("{"), e = out.lastIndexOf("}"); const j = JSON.parse(out.slice(s, e + 1)); if (!j.rows) throw new Error("no rows"); r = j.rows[0].r; }
  return JSON.parse(r);
}
function tryRead(f) { try { return read(f); } catch (e) { return { error: String(e.message).slice(0, 200) }; } }
const now = Date.now();
const fails = [];
let kind, res;
const pre = tryRead("pricing_signing_preflight.sql");
if (pre.error) { kind = "ERROR"; fails.push("read failed: " + pre.error); res = pre; }
else if (mode === "post" || (mode === "auto" && pre.price_rows > 0)) {
  kind = "POST"; res = tryRead("pricing_post_signing_verify.sql");
  if (res.error) fails.push(res.error);
  else {
    if (res.pending !== 0) fails.push("pending=" + res.pending);
    if (res.price_rows !== 6) fails.push("price_rows=" + res.price_rows);
    if (!res.verify?.ok || res.verify?.anomalies?.length) fails.push("verify not ok");
    if (res.frozen) fails.push("frozen");
    if (res.monitor_findings_2h !== 0) fails.push("monitor findings=" + res.monitor_findings_2h);
    if (!res.monitor_last || now - Date.parse(res.monitor_last) > 20 * 60e3) fails.push("monitor stale");
    const want = { sms_usage: [17000, 12695], sms_inbound: [15500, 10205] };
    const cents = { brand_low_volume: [700, 450], campaign_vetting: [2100, 1500], monthly_low_volume: [225, 150], number: [165, 115] };
    for (const [k, [p, c]] of Object.entries(want)) { const r = res.prices.find((x) => x.kind === k && x.active); if (!r || Number(r.unit_price_micros) !== p || Number(r.unit_cost_micros) !== c) fails.push("price mismatch " + k); }
    for (const [k, [p, c]] of Object.entries(cents)) { const r = res.prices.find((x) => x.kind === k && x.active); if (!r || Number(r.customer_price_cents) !== p || Number(r.provider_cost_cents) !== c) fails.push("price mismatch " + k); }
  }
} else {
  kind = "PRE"; res = pre;
  const tIn = (t) => t ? Date.parse(t) : NaN;
  if (pre.pending_total !== 6) fails.push("pending_total=" + pre.pending_total);
  if (pre.matched !== 6) fails.push("matched=" + pre.matched);
  const coolDone = tIn(pre.min_cooling_until) <= now;
  if (pre.signable_now !== 6 && coolDone) fails.push("signable_now=" + pre.signable_now);
  if (pre.price_rows !== 0) fails.push("price_rows=" + pre.price_rows);
  if (!pre.verify?.ok || pre.verify?.anomalies?.length) fails.push("verify not ok");
  if (pre.frozen) fails.push("frozen");
  if (pre.recovery_hold) fails.push("recovery_hold");
  if (pre.mode !== "single_owner") fails.push("mode=" + pre.mode);
  if (pre.primary_keys < 1) fails.push("no primary key");
  if (!pre.monitor_last || now - Date.parse(pre.monitor_last) > 20 * 60e3) fails.push("monitor stale");
  if (pre.monitor_findings_since_filing !== 0) fails.push("monitor findings=" + pre.monitor_findings_since_filing);
  if (pre.min_minutes_left <= 60) fails.push("min_minutes_left=" + pre.min_minutes_left);
}
const verdict = fails.length ? "BLOCKED" : "GO";
const line = `${new Date().toISOString()} ${kind} ${verdict}${fails.length ? " " + fails.join("; ") : ""}`;
writeFileSync(path.join(dir, "pricing_check_latest.txt"), line + "\n" + JSON.stringify(res, null, 1) + "\n");
appendFileSync(path.join(dir, "pricing_check_log.txt"), line + "\n");
if (verdict === "BLOCKED") {
  writeFileSync(path.join(dir, "PRICING_BLOCKED.txt"), line + "\n");
  try { execFileSync("powershell", ["-NoProfile", "-Command", `msg * "TW-4F pricing check BLOCKED: ${fails.join("; ").replace(/"/g, "")}"`], { timeout: 15000 }); } catch {}
}
console.log(line);
process.exit(fails.length ? 1 : 0);
