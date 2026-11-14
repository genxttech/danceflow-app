const fs = require("fs"), cp = require("child_process");
const WD = fs.readFileSync(process.env.TEMP + "/tw4f_wd.txt", "utf8").trim();
process.chdir(WD);
const J = (f) => JSON.parse(fs.readFileSync(f, "utf8")).rows;
const obj = J("hosted/final_obj.json"), fp = J("hosted/final_fp.json"), rows = J("hosted/final_rows.json");
const out = {};
const say = (k, v) => { out[k] = v; console.log(k + ": " + (typeof v === "string" ? v : JSON.stringify(v))); };
const run = (f) => { const r = cp.spawnSync("supabase", ["db", "query", "--linked", "-f", f, "-o", "json"], { encoding: "utf8", shell: true, maxBuffer: 1 << 26 }); try { return JSON.parse(r.stdout).rows; } catch { return null; } };

// AT-1
const cnt = {}; obj.filter((r) => r.section !== "00_env").forEach((r) => { const k = r.section + "=" + r.status; cnt[k] = (cnt[k] || 0) + 1; });
const missing = obj.filter((r) => r.status === "MISSING"), unexpected = obj.filter((r) => r.status === "UNEXPECTED");
say("AT-1 counts", cnt); say("AT-1 MISSING", missing.length); say("AT-1 UNEXPECTED", unexpected.map((r) => r.section + " " + r.object + " :: " + r.detail));
say("AT-1 read_only_txn", obj.find((r) => r.object === "read_only_txn").status);
// AT-2
const allNow = fp.find((r) => r.scope === "rollup:ALL").fp;
const last = fs.readFileSync("hosted/41_after_fp.txt", "utf8").split("\n").find((l) => l.startsWith("rollup:ALL\t")).split("\t")[2];
const now = new Set(fp.map((r) => `${r.scope}\t${r.object}\t${r.fp}`)), then = new Set(fs.readFileSync("hosted/41_after_fp.txt", "utf8").split("\n").filter(Boolean));
const drift = [...now].filter((x) => !then.has(x)).length + [...then].filter((x) => !now.has(x)).length;
const cp0 = JSON.parse(fs.readFileSync("cp0/fp.json", "utf8")).rows.filter((r) => /other_sms_functions/.test(r.scope)).map((r) => `${r.scope}\t${r.object}\t${r.fp}`).sort().join("\n");
const oth = fp.filter((r) => /other_sms_functions/.test(r.scope)).map((r) => `${r.scope}\t${r.object}\t${r.fp}`).sort().join("\n");
say("AT-2 rollup:ALL now / after step 41", `${allNow} / ${last}`); say("AT-2 fingerprint rows differing from step-41 after (drift)", drift); say("AT-2 other_sms_functions equals CP0", oth === cp0);
const exp = JSON.parse(fs.readFileSync("expected_local.json", "utf8")).steps[40].fp; const lexp = new Set(exp);
say("AT-2 equals local DEV-equivalent expected final (all rows)", now.size === lexp.size && [...now].every((x) => lexp.has(x)));
// AT-3
const tbl = obj.filter((r) => r.section === "10_table" && r.status === "PRESENT");
const nz = tbl.filter((r) => !/rows=0 /.test(r.detail));
say("AT-3 tables (probe, exact counts)", tbl.length); say("AT-3 tables with non-zero rows", nz.map((r) => r.object));
say("AT-3 studio_sms_* count query", `${rows.length} tables, non-zero=${rows.filter((x) => x.row_count !== 0).length}`);
// AT-4
const badRls = tbl.filter((r) => !/rls=t /.test(r.detail) || !/api privs: anon:- authenticated:- service_role:- /.test(r.detail));
say("AT-4 tables lacking RLS or with API privileges", badRls.map((r) => r.object));
const fns = obj.filter((r) => r.section === "20_function" && r.status === "PRESENT");
const noPin = fns.filter((r) => !/search_path=\S/.test(r.detail) || /search_path=- /.test(r.detail) || /search_path=none/.test(r.detail));
const anonTrue = fns.filter((r) => /anon:true/.test(r.detail)), pubTrue = fns.filter((r) => /public:true/.test(r.detail));
const authTrue = fns.filter((r) => /authenticated:true/.test(r.detail)).map((r) => r.object.replace(/\(.*$/, "")).sort();
say("AT-4 functions", fns.length); say("AT-4 unpinned search_path (security definer)", noPin.filter((r) => /secdef=t/.test(r.detail)).map((r) => r.object));
say("AT-4 anon:true", anonTrue.map((r) => r.object)); say("AT-4 public:true", pubTrue.map((r) => r.object));
const man = cp.execFileSync("git", ["-C", "C:/Dev/studioapp", "show", "e749427ce5eaea3316752729f565e11254ac45af:docs/twilio/TW-4F_Hosted_Apply_Manifest.md"], { encoding: "utf8", maxBuffer: 1 << 26 }).replace(/\r/g, "");
const s5 = man.slice(man.indexOf("## 5. Dependencies"), man.indexOf("### 5.1"));
const expAuth = new Set(); for (const l of s5.split("\n")) { const c = l.split("|").map((x) => x.trim()); if (/^2026\d{10}$/.test(c[1] || "") && c[4] && !/^none/i.test(c[4])) for (const m of c[4].matchAll(/`([a-z_0-9]+)`/g)) expAuth.add(m[1]); }
const gotAuth = new Set(authTrue);
say("AT-4 authenticated:true set size (probe / manifest §5)", `${gotAuth.size} / ${expAuth.size}`);
say("AT-4 authenticated:true NOT in manifest", [...gotAuth].filter((x) => !expAuth.has(x))); say("AT-4 manifest-exposed NOT authenticated:true", [...expAuth].filter((x) => !gotAuth.has(x)));
// AT-5/6
const a5 = run("probes/at5.sql"), a6 = run("probes/at6.sql");
say("AT-5 _sms_onb_is_platform_admin() requires aal2", a5 && a5[0] && a5[0].has_aal2);
say("AT-6 registrations policies", a6 && a6.map((x) => `${x.policyname}=${x.has_aal2}`));
// AT-7
const top = fs.readFileSync("C:/Dev/studioapp/docs/twilio/TW-4F_Docker_Chain_Top_Fingerprint_e749427c.txt", "utf8").split("\n");
const topMap = {}; for (const l of top) { const m = l.match(/^fn (?:public\.)?([a-z_0-9]+)\(.*?\) ([0-9a-f]{32}) args=/i); if (m) (topMap[m[1]] = topMap[m[1]] || []).push(m[2].slice(0, 8)); }
const hostMap = {}; for (const r of fns) { const m = r.detail.match(/body_md5=([0-9a-f]{8})/); const n = r.object.replace(/\(.*$/, ""); if (m) (hostMap[n] = hostMap[n] || []).push(m[1]); }
const cmp = (n) => { const a = (topMap[n] || []).sort().join(","), b = (hostMap[n] || []).sort().join(","); return a && b ? a === b : null; };
say("AT-7 named functions body md5 equals Docker chain", Object.fromEntries(["tw4_spend_authorize", "tw4_pilot_exception_create", "tw4_rfl_pilot_cover"].map((n) => [n, cmp(n)])));
let eqN = 0, neN = [], skip = 0; for (const n of Object.keys(hostMap)) { const c = cmp(n); if (c === null) skip++; else if (c) eqN++; else neN.push(n); }
say("AT-7 all functions by name: equal / differing / not comparable", `${eqN} / ${neN.length} ${neN.slice(0, 8).join(",")} / ${skip}`);
// AT-8
const sw = ["studio_sms_recurring_switch_log", "studio_sms_usage_switch_log", "studio_sms_rfl_switch_log", "studio_sms_runner_windows", "studio_sms_onboarding_access", "studio_sms_billed_senders", "studio_sms_credit_accounts", "studio_sms_pilot_exceptions", "studio_sms_spend_events", "studio_sms_provider_charges", "studio_sms_provisioning_steps", "studio_sms_twilio_accounts"];
say("AT-8 switch/activation/pilot/provisioning tables rows", Object.fromEntries(sw.map((t) => [t, (rows.find((x) => x.relname === t) || {}).row_count])));
fs.writeFileSync("hosted/acceptance_summary.json", JSON.stringify(out, null, 1));
