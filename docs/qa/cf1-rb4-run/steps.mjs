import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
// Local layout comes from the environment: QA_RUN = QA run directory (outside the repo), REPO_ROOT = checkout that holds the refs.
const E = process.env.QA_RUN + "/evidence/rb4", REPO = process.env.REPO_ROOT, REF = "origin/cf1/integration-3", M = "src/lib/supabase/migrations";
const files = readdirSync(E + "/snaps").filter(f => /^(00|2\d|3\d)_/.test(f) && f.endsWith(".tsv")).sort();
const ld = f => new Map(readFileSync(`${E}/snaps/${f}`, "utf8").split("\n").filter(Boolean).map(l => { const p = l.split("\t"); return [p[0], { n: p[1], raw: p[2], hascr: p[5] }]; }));
const mig = execFileSync("git", ["-C", REPO, "ls-tree", "--name-only", REF, M + "/"], { encoding: "utf8" }).split("\n").map(s => s.replace(/.*\//, ""));
const get = p => execFileSync("git", ["-C", REPO, "show", `${REF}:${M}/${p}`], { encoding: "utf8", maxBuffer: 1 << 28 });
let prev = ld(files[0]); const rows = [];
for (const f of files.slice(1)) {
  const cur = ld(f); const ver = f.slice(3, 17); const name = mig.find(x => x.startsWith(ver));
  if (!name) { prev = cur; continue; }
  const up = get(name), rb = get("rollback/" + name.replace(".sql", "_rollback.sql"));
  const ch = [];
  for (const [k, v] of cur) { const p = prev.get(k); if (!p) ch.push([k, "(new)", v]); else if (p.n !== v.n) ch.push([k, p, v]); }
  for (const [k, p] of prev) if (!cur.has(k)) ch.push([k, p, "(dropped)"]);
  const inf = ch.filter(c => c[2] !== "(dropped)" && c[1] !== "(new)");
  rows.push(`## ${name}  (new fns: ${ch.filter(c => c[1] === "(new)").length}, redefined: ${inf.length}, dropped: ${ch.filter(c => c[2] === "(dropped)").length})`);
  for (const [k, p, v] of inf) rows.push(`| ${k} | pre ${p.n} ${rb.includes(p.n) ? "[in rollback file]" : up.includes(p.n) ? "[in migration file]" : "[NOT in migration/rollback file]"} | post ${v.n} ${up.includes(v.n) ? "[in migration file]" : rb.includes(v.n) ? "[in rollback file]" : "[NOT in file]"} | CR in applied def: ${v.hascr} |`);
  rows.push("");
  prev = cur;
}
writeFileSync(E + "/step_pins.md", rows.join("\n"));
console.log(rows.join("\n"));
