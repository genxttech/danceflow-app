#!/usr/bin/env node
/**
 * Replay-omission audit (heuristic: regular expressions over SQL text, not a parser). The isolated baseline cannot replay the migrations listed in known-unreplayable.txt, so it is NOT production-equivalent. This script
 * quantifies and classifies what that means for the TW-4F conclusions:
 *
 *   1. for each skipped migration: the objects it creates / replaces and the reason it cannot replay;
 *   2. whether any TW-4F migration or function body references those objects (authorization, financial controls, tenant isolation, sender provisioning);
 *   3. a catalog comparison of the baseline against a reference database (read-only): objects present in only one, functions whose bodies differ;
 *   4. dangling references: public functions/tables that TW-4F function bodies call but that do not exist in the baseline (fail closed).
 *
 *   node scripts/qa/audit-omissions.mjs --baseline <df-isoqa container> [--reference <container>] [--ref origin/main]
 *
 * The reference defaults to the shared QA database and is only READ (catalog queries). Exit 1 when a TW-4F-relevant dependency on a skipped migration is found.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const BASELINE = flag("baseline", "");
const REFERENCE = flag("reference", "supabase_db_danceflow-e2e-qa");
const REF = flag("ref", "origin/main");
const MIG = "src/lib/supabase/migrations";
if (!BASELINE.startsWith("df-isoqa-")) { console.error("--baseline must be a df-isoqa-* container"); process.exit(2); }

const git = (...a) => execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8", maxBuffer: 1 << 28 });
const psql = (c, sql) => execFileSync("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", c, "psql", "-U", "postgres", "-d", "postgres", "-At", "-F", "|", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8", maxBuffer: 1 << 28 }).trim();

const known = readFileSync(path.join(here, "known-unreplayable.txt"), "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => { const [f, ...r] = l.trim().split(/\s+/); return { file: f, reason: r.join(" ") }; });
const tw4Files = git("ls-tree", "--name-only", `${REF}:${MIG}`).split("\n").filter((n) => n.endsWith(".sql") && n.slice(0, 8) >= "20261119" && /(twilio|tw4|sms)/i.test(n));
const extraScan = args.flatMap((a, i) => (a === "--scan" ? [args[i + 1]] : []));   // ref:version, e.g. origin/twilio-tw4f-sender-reverify:20261206
const extraTexts = extraScan.map((spec) => { const [r, v] = [spec.slice(0, spec.lastIndexOf(":")), spec.slice(spec.lastIndexOf(":") + 1)]; const f = git("ls-tree", "--name-only", `${r}:${MIG}`).split("\n").find((n) => n.startsWith(v) && n.endsWith(".sql")); if (!f) { console.error(`--scan ${spec}: no such migration`); process.exit(2); } return git("show", `${r}:${MIG}/${f}`); });
const tw4Text = [...tw4Files.map((n) => git("show", `${REF}:${MIG}/${n}`)), ...extraTexts].join("\n");

const created = (sql) => {
  const objs = new Set();
  for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?(?:function|table|view|type)\s+(?:if\s+not\s+exists\s+)?(?:public\.)?("?[a-z_0-9]+"?)/gi)) objs.add(m[1].replace(/"/g, "").toLowerCase());
  return [...objs];
};
/** Tables a migration alters, attaches policies / triggers to, grants on or enables RLS for (it may change their security surface without creating them). */
const touched = (sql) => {
  const t = new Set();
  for (const re of [/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?"?([a-z_0-9]+)"?/gi, /create\s+(?:or\s+replace\s+)?(?:policy|trigger)\s+[^;]*?\son\s+(?:public\.)?"?([a-z_0-9]+)"?/gi,
    /grant\s+[^;]*?\son\s+(?:table\s+)?(?:public\.)?"?([a-z_0-9]+)"?\s+to/gi, /drop\s+(?:policy|trigger)\s+(?:if\s+exists\s+)?[^;]*?\son\s+(?:public\.)?"?([a-z_0-9]+)"?/gi]) {
    for (const m of sql.matchAll(re)) t.add(m[1].toLowerCase());
  }
  return [...t];
};
const CORE_READ_BY_TW4F = new Set(["studios", "profiles", "user_studio_roles", "clients", "payments", "events"]);
const generic = new Set(["on", "if", "public", "table", "function", "policy", "index", "for", "as", "to", "set", "add", "drop"]);

console.log("# Replay omissions (generated)\n");
console.log(`Baseline ${BASELINE}; reference ${REFERENCE} (read-only); migrations from ${REF}; ${tw4Files.length} TW-4F migrations scanned.\n`);
console.log("| Migration | Why it cannot replay | Objects it creates / replaces | Core tables it touches | Referenced by TW-4F SQL |");
console.log("|---|---|---|---|---|");
let impact = 0;
const createdTables = [];
for (const { file, reason } of known) {
  const sql = git("show", `${REF}:${MIG}/${file}`);
  const objs = created(sql).filter((o) => !generic.has(o) && o.length > 3);
  const touches = touched(sql).filter((t) => !objs.includes(t));
  const coreTouches = touches.filter((t) => CORE_READ_BY_TW4F.has(t));
  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_0-9]+)"?/gi)) createdTables.push([file, m[1].toLowerCase()]);
  const hits = objs.filter((o) => new RegExp(`\\b${o}\\b`, "i").test(tw4Text));
  if (hits.length) impact += 1;
  console.log(`| ${file} | ${reason.replace(/\|/g, "/").slice(0, 100)} | ${objs.slice(0, 5).join(", ")}${objs.length > 5 ? ", ..." : ""} | ${touches.slice(0, 5).join(", ")}${touches.length > 5 ? ", ..." : ""}${coreTouches.length ? ` (**core, read by TW-4F: ${coreTouches.join(", ")}**)` : ""} | ${hits.length ? `**${hits.join(", ")}**` : "none"} |`);
}

// catalog comparison (functions by name+body hash; tables by name)
const fnSql = "select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' || '|' || md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'";
const tblSql = "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p')";
const toMap = (s) => new Map(s.split("\n").filter(Boolean).map((l) => { const i = l.lastIndexOf("|"); return [l.slice(0, i), l.slice(i + 1)]; }));
const bf = toMap(psql(BASELINE, fnSql)), rf = toMap(psql(REFERENCE, fnSql));
const bt = new Set(psql(BASELINE, tblSql).split("\n").filter(Boolean)), rt = new Set(psql(REFERENCE, tblSql).split("\n").filter(Boolean));
const onlyRefFn = [...rf.keys()].filter((k) => !bf.has(k));
const onlyBaseFn = [...bf.keys()].filter((k) => !rf.has(k));
const diffFn = [...bf.keys()].filter((k) => rf.has(k) && rf.get(k) !== bf.get(k));
const onlyRefT = [...rt].filter((t) => !bt.has(t));
const onlyBaseT = [...bt].filter((t) => !rt.has(t));
const restored = createdTables.filter(([, t]) => bt.has(t));
console.log(`\nTables CREATED by a skipped migration that exist in the baseline anyway: ${restored.length}${restored.length ? " (" + restored.map(([f, t]) => t + " <- " + f.slice(0, 24)).join(", ") + ")" : " (replay is all-or-nothing, so a skipped migration leaves nothing behind)"}`);
const isTw4 = (n) => /(tw4|sms_|twilio)/i.test(n);
console.log("\n## Baseline vs reference catalog\n");
console.log(`- functions: baseline ${bf.size}, reference ${rf.size}; only in reference ${onlyRefFn.length} (TW-4F-named: ${onlyRefFn.filter(isTw4).length}); only in baseline ${onlyBaseFn.length}; body differs ${diffFn.length} (TW-4F-named: ${diffFn.filter(isTw4).length})`);
console.log(`- tables: baseline ${bt.size}, reference ${rt.size}; only in reference ${onlyRefT.length} (TW-4F-named: ${onlyRefT.filter(isTw4).length}); only in baseline ${onlyBaseT.length}`);
const list = (title, items, max = 40) => { if (items.length) console.log(`\n${title} (${items.length})\n${items.slice(0, max).map((x) => `  - ${x}`).join("\n")}${items.length > max ? `\n  - ... ${items.length - max} more` : ""}`); };
list("Functions only in the reference (restored there by migrations the baseline skipped, or by later/unmerged work)", onlyRefFn.filter((k) => !isTw4(k)));
list("TW-4F-named functions only in the reference (unmerged or later work in the shared database)", onlyRefFn.filter(isTw4));
list("TW-4F-named functions whose body differs", diffFn.filter(isTw4).map((k) => k.slice(0, 110)));
list("Other functions whose body differs (application areas outside TW-4F; the 24 skipped migrations account for the payroll / accounting / commerce / competition / verified-email families)", diffFn.filter((k) => !isTw4(k)).map((k) => k.slice(0, 70)), 12);
{
  // the security surface of the core tables TW-4F reads (profiles.platform_role, user_studio_roles, studios): policies, triggers, grants
  const surfaceSql = `select 'policy ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || md5(coalesce(qual, '') || coalesce(with_check, '')) from pg_policies where schemaname = 'public' and tablename in ('profiles', 'user_studio_roles', 'studios', 'clients', 'payments', 'events')
    union all select 'trigger ' || tgrelid::regclass::text || ' ' || tgname from pg_trigger where not tgisinternal and tgrelid in ('public.profiles'::regclass, 'public.user_studio_roles'::regclass, 'public.studios'::regclass, 'public.clients'::regclass, 'public.payments'::regclass, 'public.events'::regclass)
    union all select 'acl ' || c.relname || ' ' || coalesce(c.relacl::text, '-') from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('profiles', 'user_studio_roles', 'studios', 'clients', 'payments', 'events')
    union all select 'rls ' || c.relname || ' ' || c.relrowsecurity from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('profiles', 'user_studio_roles', 'studios', 'clients', 'payments', 'events')`;
  const bs = new Set(psql(BASELINE, surfaceSql).split("\n").filter(Boolean)), rs = new Set(psql(REFERENCE, surfaceSql).split("\n").filter(Boolean));
  const missing = [...rs].filter((x) => !bs.has(x)), extra = [...bs].filter((x) => !rs.has(x));
  console.log(`\n## Security surface of profiles / user_studio_roles / studios / clients (policies, triggers, grants, RLS flag)\n\n- identical entries: ${[...bs].filter((x) => rs.has(x)).length}; only in the reference: ${missing.length}; only in the baseline: ${extra.length}`);
  for (const x of missing.slice(0, 20)) console.log(`  - reference only: ${x.slice(0, 160)}`);
  for (const x of extra.slice(0, 20)) console.log(`  + baseline only:  ${x.slice(0, 160)}`);
}
list("Tables only in the reference", onlyRefT);

// dangling references: TW-4F function bodies that call a public function / table the baseline does not have
const bodies = psql(BASELINE, "select p.proname, replace(p.prosrc, E'\\n', ' ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (p.proname ~ '^(_?tw4|_?sms)' )").split("\n").filter(Boolean);
const bfNames = new Set([...bf.keys()].map((k) => k.slice(0, k.indexOf("("))));
const dangling = new Set();
for (const row of bodies) {
  const i = row.indexOf("|");
  const body = row.slice(i + 1);
  for (const m of body.matchAll(/(?<!(?:into|from|join|update|table|on|only)\s+)(?<![a-z_.])public\.([a-z_][a-z_0-9]*)\s*\(/gi)) if (!bfNames.has(m[1]) && !bt.has(m[1])) dangling.add(`${row.slice(0, i)} -> ${m[1]}()`);
  for (const m of body.matchAll(/(?:from|join|into|update)\s+public\.([a-z_][a-z_0-9]*)/gi)) if (!bt.has(m[1]) && !bfNames.has(m[1])) dangling.add(`${row.slice(0, i)} -> table ${m[1]}`);
}
console.log(`\n## Dangling references from TW-4F function bodies (in the baseline): ${dangling.size}`);
for (const d of [...dangling].slice(0, 30)) console.log(`  - ${d}`);
console.log(`\n## Verdict\n`);
const failClosed = impact > 0 || dangling.size > 0 || restored.length > 0;
console.log(failClosed ? `FAIL CLOSED: ${impact} skipped migration(s) create objects referenced by TW-4F SQL, ${dangling.size} dangling reference(s), ${restored.length} table(s) of skipped migrations present in the baseline.` : "No skipped migration touches an object referenced by TW-4F SQL, and no TW-4F function body has a dangling reference in the baseline. The baseline is still NOT production-equivalent (see the table above).");
process.exit(failClosed ? 1 : 0);
