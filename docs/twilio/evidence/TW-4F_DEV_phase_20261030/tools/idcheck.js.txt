// Redacted DEV identity check. Reads three values from the owner's local env file in-process; prints no secret value.
const fs = require("fs");
const DEV = "epdrtzcydvnoidwrepqz", PROD = "hvsujyfbftfffxpfmlpb";
const SRC = "C:/Dev/studioapp/.env.local";
const NET = process.argv[2] === "net";
const lines = fs.readFileSync(SRC, "utf8").split(/\r?\n/);
const want = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const found = {}, counts = {};
for (const l of lines) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (!m || !want.includes(m[1])) continue;
  counts[m[1]] = (counts[m[1]] || 0) + 1;
  if (!(m[1] in found)) found[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const out = [];
const say = (s) => { out.push(s); console.log(s); };
say("source: owner local env file (3 names read; values never printed)");
say("names present/duplicates: " + want.map((k) => `${k}=${found[k] ? "present" : "MISSING"}x${counts[k] || 0}`).join(" "));
if (want.some((k) => !found[k])) { say("STOP: a required value is missing"); process.exit(2); }
const url = found.NEXT_PUBLIC_SUPABASE_URL;
let host; try { host = new URL(url).host; } catch { say("STOP: URL not parseable"); process.exit(2); }
const urlRef = host.split(".")[0];
say(`URL scheme/host shape: ${url.startsWith("https://") ? "https" : "non-https"} ${host.endsWith(".supabase.co") ? "<ref>.supabase.co" : "OTHER HOST"}; ref equals DEV: ${urlRef === DEV}; equals PROD: ${urlRef === PROD}; path/query present: ${new URL(url).pathname !== "/" || !!new URL(url).search}`);
if (urlRef !== DEV || !host.endsWith(".supabase.co")) { say("STOP: URL is not the DEV project"); process.exit(3); }
function claims(name) {
  const v = found[name]; const p = v.split(".");
  if (p.length !== 3) return { format: v.startsWith("sb_") ? "new-style (opaque) key, no decodable claims" : "unrecognized format" };
  try { const j = JSON.parse(Buffer.from(p[1], "base64url").toString("utf8")); return { format: "JWT", ref: j.ref, role: j.role, iss: j.iss, exp: j.exp ? new Date(j.exp * 1000).toISOString().slice(0, 10) : null, iat: j.iat ? new Date(j.iat * 1000).toISOString().slice(0, 10) : null }; } catch { return { format: "JWT, payload undecodable" }; }
}
const ca = claims("NEXT_PUBLIC_SUPABASE_ANON_KEY"), cs = claims("SUPABASE_SERVICE_ROLE_KEY");
say("anon key claims (unsigned decode, self-asserted): " + JSON.stringify(ca));
say("service key claims (unsigned decode, self-asserted): " + JSON.stringify(cs));
const okLocal = ca.ref === DEV && ca.role === "anon" && cs.ref === DEV && cs.role === "service_role";
say("local claim consistency (ref=DEV and expected roles): " + okLocal);
say("anon and service key are different strings: " + (found.NEXT_PUBLIC_SUPABASE_ANON_KEY !== found.SUPABASE_SERVICE_ROLE_KEY));
if (!okLocal) { say("STOP: claims do not match DEV / expected roles (no network call made)"); process.exit(4); }
if (!NET) process.exit(0);

// Network stage: read-only, DEV host only, one key per request, GET/HEAD only.
(async () => {
  const base = `https://${DEV}.supabase.co`;
  async function req(label, method, pathq, key, extraHeaders = {}) {
    const headers = { apikey: key, ...extraHeaders };
    if (label.includes("bearer")) headers.Authorization = `Bearer ${key}`;
    let r; try { r = await fetch(base + pathq, { method, headers, signal: AbortSignal.timeout(20000) }); } catch (e) { say(`${label}: ${method} ${pathq.split("?")[0]} -> network error ${e.code || e.message}`); return null; }
    const cr = r.headers.get("content-range");
    let note = ""; if (method === "GET") { const t = await r.text(); note = ` body-bytes=${t.length}`; try { const j = JSON.parse(t); note += ` json-keys=${Object.keys(j).slice(0, 6).join(",")}`; if (j.code || j.message) note += ` code=${j.code || ""} msg-class=${String(j.message || "").slice(0, 60)}`; } catch {} }
    say(`${label}: ${method} ${pathq.split("?")[0]} -> HTTP ${r.status}${cr ? " content-range=" + cr : ""}${note}`);
    return r.status;
  }
  const anon = found.NEXT_PUBLIC_SUPABASE_ANON_KEY, svc = found.SUPABASE_SERVICE_ROLE_KEY;
  if (process.argv[3] === "b") {
    // same-endpoint negative control and error-body discrimination (GET returns only an error body here; no rows can be returned)
    await req("bogus control same-endpoint", "GET", "/auth/v1/settings", "not-a-valid-key");
    await req("bogus control rest-table", "GET", "/rest/v1/studio_sms_legal_entities?select=id&limit=0", "not-a-valid-key");
    await req("anon  rest-table GET", "GET", "/rest/v1/studio_sms_legal_entities?select=id&limit=0", anon);
    await req("svc   rest-table GET", "GET", "/rest/v1/studio_sms_legal_entities?select=id&limit=0", svc);
    await req("svc   rest-root GET", "GET", "/rest/v1/", svc);
    await req("anon  rest-root GET", "GET", "/rest/v1/", anon);
    process.exit(0);
  }
  // 1 gateway accepts/rejects the key (signature check against this project's secret): auth settings are read-only metadata
  await req("anon  gateway", "GET", "/auth/v1/settings", anon);
  await req("svc   gateway", "GET", "/auth/v1/settings", svc);
  // 2 negative control: a deliberately invalid key must be rejected by the same endpoint (proves the endpoint really validates keys)
  await req("bogus control", "GET", "/rest/v1/", "not-a-valid-key");
  // 3 role difference without row data: HEAD with exact count on a table whose API privileges are empty for anon/authenticated (TW-4F design)
  await req("anon  role-probe (bearer)", "HEAD", "/rest/v1/studio_sms_legal_entities?select=id", anon, { Prefer: "count=exact" });
  await req("svc   role-probe (bearer)", "HEAD", "/rest/v1/studio_sms_legal_entities?select=id", svc, { Prefer: "count=exact" });
  process.exit(0);
})();
