// Read-only RPC compatibility checks against DEV. Only STABLE/IMMUTABLE functions, only HTTP GET (PostgREST runs GET in a READ ONLY transaction). Response bodies are never printed or stored.
const fs = require("fs");
const WD = fs.readFileSync(process.env.TEMP + "/tw4f_it_wd.txt", "utf8").trim();
const DEV = "epdrtzcydvnoidwrepqz", BASE = `https://${DEV}.supabase.co`;
const lines = fs.readFileSync("C:/Dev/studioapp/.env.local", "utf8").split(/\r?\n/);
const pick = (k) => { for (const l of lines) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && m[1] === k) return m[2].trim().replace(/^["']|["']$/g, ""); } };
const URLV = pick("NEXT_PUBLIC_SUPABASE_URL"), ANON = pick("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SVC = pick("SUPABASE_SERVICE_ROLE_KEY");
if (new URL(URLV).host !== `${DEV}.supabase.co`) { console.log("STOP: not DEV"); process.exit(2); }
const fns = JSON.parse(fs.readFileSync(WD + "/pre/fns.json", "utf8")).rows;
const Z = "00000000-0000-0000-0000-000000000000";
const get = async (path, key) => { const r = await fetch(BASE + path, { method: "GET", headers: { apikey: key, Authorization: "Bearer " + key, Accept: "application/json" }, signal: AbortSignal.timeout(30000) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, text: t, json: j, ro: r.headers.get("content-range") }; };
(async () => {
  // fixtures: one platform-admin id and one studio (ids/slug used only as call arguments; not printed in full)
  const prof = await get("/rest/v1/profiles?select=id&platform_role=not.is.null&limit=2", SVC);
  const st = await get("/rest/v1/studios?select=id,slug&limit=1", SVC);
  const admin = prof.json && prof.json[0] && prof.json[0].id, studio = st.json && st.json[0] && st.json[0].id, slug = st.json && st.json[0] && st.json[0].slug;
  console.log(`fixtures: platform admins found=${prof.json ? prof.json.length : "?"} (HTTP ${prof.status}); studio found=${!!studio} slug=${slug ? "yes" : "no"} (HTTP ${st.status}); ids printed as prefixes: admin=${(admin || "").slice(0, 8)} studio=${(studio || "").slice(0, 8)}`);
  fs.writeFileSync(WD + "/fixture_slug.txt", slug || "");
  const splitTop = (s) => { const o = []; let d = 0, c = ""; for (const ch of s) { if (ch === "(" ) d++; if (ch === ")") d--; if (ch === "," && !d) { o.push(c.trim()); c = ""; } else c += ch; } if (c.trim()) o.push(c.trim()); return o; };
  const val = (name, type) => {
    if (name === "p_actor" || name === "p_user_id") return admin; if (name === "p_studio_id") return studio; if (name === "p_studio_slug") return slug || "no-such-studio";
    if (/uuid$/.test(type)) return Z; if (/^(integer|bigint)$/.test(type)) return name === "p_max_age_seconds" ? 60 : 5; if (type === "boolean") return false;
    return { p_switch: "scan", p_payment_ref: "smoke-none", p_job: "smoke", p_kind: "smoke", p_event_key: "smoke", p_account_sid: "ACsmoke", p_messaging_service_sid: "MGsmoke", p_to_e164: "+15550000000", p_approval_ref: "smoke" }[name] ?? "smoke";
  };
  const cands = fns.filter((f) => f.vol !== "v" && f.svc && !f.proname.startsWith("_"));
  const results = [], skipped = [];
  for (const f of cands) {
    const parts = f.args ? splitTop(f.args) : [];
    const params = parts.map((p) => { const m = p.match(/^(\w+)\s+(.*)$/); return { name: m[1], type: m[2] }; });
    if (params.some((p) => /\[\]|jsonb|studio_sms_|timestamp/.test(p.type))) { skipped.push(f.proname + " (array/composite/time arg)"); continue; }
    const need = params.slice(0, params.length - f.ndefaults);
    if (need.some((p) => (p.name === "p_actor" && !admin) || (p.name === "p_studio_id" && !studio))) { skipped.push(f.proname + " (no fixture)"); continue; }
    const qs = need.map((p) => `${p.name}=${encodeURIComponent(val(p.name, p.type))}`).join("&");
    const r = await get(`/rest/v1/rpc/${f.proname}${qs ? "?" + qs : ""}`, SVC);
    let cls, note = "";
    if (r.status === 200 || r.status === 206) { cls = "OK"; note = Array.isArray(r.json) ? `array(${r.json.length})` : r.json && typeof r.json === "object" ? `object(${Object.keys(r.json).length} keys)` : typeof r.json; }
    else { const c = r.json && r.json.code; note = `HTTP ${r.status} code=${c || "-"}`; cls = /^PGRST20[23]$/.test(c) ? "SIGNATURE" : /^(42883|42P01|42703|42P02|XX000|42804|22P02)$/.test(c) || r.status >= 500 ? "ERROR" : "REFUSED"; if (cls === "REFUSED") note += ` msg=${String((r.json && r.json.message) || "").slice(0, 70)}`; }
    results.push({ fn: f.proname, vol: f.vol, cls, note, asActor: need.some((p) => p.name === "p_actor") });
  }
  // negative controls: a random actor on the admin functions must be refused (authorization failure handling)
  const neg = [];
  for (const f of cands.filter((x) => /^(tw4_panel_overview|tw4_rfl_admin_overview|tw4_sender_overview|tw4_usage_reconcile_overview|sms_usage_admin_overview|tw4_admin_registration_gaps|tw4_rfl_health|tw4_num_registration_gaps)$/.test(x.proname))) {
    const parts = splitTop(f.args).map((p) => { const m = p.match(/^(\w+)\s+(.*)$/); return { name: m[1], type: m[2] }; });
    const need = parts.slice(0, parts.length - f.ndefaults);
    const qs = need.map((p) => `${p.name}=${encodeURIComponent(p.name === "p_actor" ? Z : val(p.name, p.type))}`).join("&");
    const r = await get(`/rest/v1/rpc/${f.proname}?${qs}`, SVC);
    neg.push({ fn: f.proname, status: r.status, code: r.json && r.json.code, refused: r.status >= 400 && r.status < 500 });
  }
  // anon-key controls: functions not granted to anon must be denied at the database
  const anonTests = ["get_studio_sms_status?p_studio_id=" + (studio || Z), "tw4_panel_overview?p_actor=" + (admin || Z), "sms_price_list", "tw4_rfl_scan_entities"];
  const anon = [];
  for (const t of anonTests) { const r = await get("/rest/v1/rpc/" + t, ANON); anon.push({ fn: t.split("?")[0], status: r.status, code: r.json && r.json.code }); }
  const by = {}; results.forEach((r) => by[r.cls] = (by[r.cls] || 0) + 1);
  console.log("RPC GET results by class:", JSON.stringify(by), "| called:", results.length, "| skipped:", skipped.length);
  console.log("SIGNATURE/ERROR cases:", JSON.stringify(results.filter((r) => r.cls === "SIGNATURE" || r.cls === "ERROR")));
  console.log("REFUSED with real admin/studio fixtures (expected only where data is required):", JSON.stringify(results.filter((r) => r.cls === "REFUSED").map((r) => `${r.fn}:${r.note}`)).slice(0, 2500));
  console.log("negative controls (random actor):", JSON.stringify(neg));
  console.log("anon-key controls:", JSON.stringify(anon));
  console.log("skipped:", skipped.join("; ").slice(0, 600));
  fs.writeFileSync(WD + "/rpc_results.json", JSON.stringify({ results, neg, anon, skipped }, null, 1));
})();
