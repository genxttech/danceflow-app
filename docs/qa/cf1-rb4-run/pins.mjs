import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
// Local layout comes from the environment: QA_RUN = QA run directory (outside the repo), REPO_ROOT = checkout that holds the refs.
const E = process.env.QA_RUN + "/evidence/rb4", REPO = process.env.REPO_ROOT, REF = "origin/cf1/integration-3", M = "src/lib/supabase/migrations";
const snaps = readdirSync(E + "/snaps").filter(f => f.endsWith(".tsv")).sort();
const idx = new Map();
const kinds = ["fn_norm", "fn_raw", "prosrc", "prosrc_norm"];
for (const s of snaps) for (const l of readFileSync(`${E}/snaps/${s}`, "utf8").split("\n").filter(Boolean)) {
  const p = l.split("\t"); for (let k = 0; k < 4; k++) { const key = p[k + 1]; if (!idx.has(key)) idx.set(key, []); idx.get(key).push(`${s.replace(".tsv", "")}:${p[0]}:${kinds[k]}`); }
}
const files = execFileSync("git", ["-C", REPO, "ls-tree", "-r", "--name-only", REF, M], { encoding: "utf8" }).split("\n")
  .filter(f => /\/(rollback\/)?2027\d+_.*\.sql$/.test(f) || /sql-tests\/test_T_competition_(hl1|cf1|k1|ns1|cx1|ss1|f2|e2)/.test(f));
const out = []; let tot = 0, hit = 0; const miss = [];
for (const f of files) {
  const t = execFileSync("git", ["-C", REPO, "show", `${REF}:${f}`], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\n");
  t.forEach((ln, i) => { for (const m of ln.matchAll(/\b[0-9a-f]{32}\b/g)) {
    tot++; const h = idx.get(m[0]); const base = f.replace(M + "/", "");
    if (h) { hit++; const u = [...new Set(h.map(x => x.split(":").slice(1).join(":")))]; const stages = [...new Set(h.map(x => x.split(":")[0].slice(0, 2)))].join(","); out.push(`${base}:${i + 1}\t${m[0]}\tAPPLIED\tstages=${stages}\t${u.slice(0, 2).join(" | ")}`); }
    else { miss.push(`${base}:${i + 1}\t${m[0]}\tNOT_FOUND_IN_ANY_APPLIED_SNAPSHOT\t${ln.trim().slice(0, 120)}`); }
  } });
}
writeFileSync(E + "/pin_coverage.tsv", out.concat(miss).join("\n") + "\n");
console.log(`literals=${tot} found_in_applied=${hit} not_found=${miss.length}`);
console.log(miss.join("\n"));
