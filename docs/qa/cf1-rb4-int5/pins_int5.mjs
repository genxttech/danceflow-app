// Pin coverage on integration-5: every 32-hex literal in the CF1 migrations / rollbacks / suites must be the md5 of some applied function
// (full definition raw or normalised, or prosrc raw or normalised) in one of the snapshots taken during rb4_int5.sh.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const E = process.env.E, M = process.env.M;
const snaps = readdirSync(E + "/snaps").filter(f => f.endsWith(".tsv")).sort();
const kinds = ["fn_norm", "fn_raw", "prosrc", "prosrc_norm"];
const idx = new Map();
for (const s of snaps) for (const l of readFileSync(`${E}/snaps/${s}`, "utf8").split("\n").filter(Boolean)) {
  const p = l.split("\t");
  for (let k = 0; k < 4; k++) { const key = p[k + 1]; if (!idx.has(key)) idx.set(key, new Set()); idx.get(key).add(`${s.replace(".tsv", "")}:${p[0]}:${kinds[k]}`); }
}
const files = [];
for (const d of [M, M + "/rollback"]) for (const f of readdirSync(d)) if (/^2027\d+_.*\.sql$/.test(f)) files.push(join(d, f));
for (const f of readdirSync(M + "/sql-tests")) if (/^test_T_competition_(hl1|cf1|k1|ns1|cx1|ss1|f2|e2)/.test(f) && f.endsWith(".sql")) files.push(join(M, "sql-tests", f));
const out = [], miss = [];
let tot = 0, hit = 0;
for (const f of files) {
  readFileSync(f, "utf8").split("\n").forEach((ln, i) => {
    for (const m of ln.matchAll(/\b[0-9a-f]{32}\b/g)) {
      tot++;
      const h = idx.get(m[0]);
      const base = f.replace(M, "").replace(/^[\\/]+/, "").replace(/\\/g, "/");
      if (h) {
        hit++;
        const stages = [...new Set([...h].map(x => x.split(":")[0].slice(0, 2)))].join(",");
        const u = [...h].slice(0, 3).map(x => x.split(":").slice(1).join(":")).join(" | ");
        out.push(`${base}:${i + 1}\t${m[0]}\tAPPLIED\tstages=${stages}\t${u}`);
      } else miss.push(`${base}:${i + 1}\t${m[0]}\tNOT_FOUND_IN_ANY_APPLIED_SNAPSHOT\t${ln.trim().slice(0, 120)}`);
    }
  });
}
writeFileSync(E + "/pin_coverage.tsv", out.concat(miss).join("\n") + "\n");
console.log(`C pin coverage: literals=${tot} found_in_applied=${hit} not_found=${miss.length}`);
console.log(miss.map(x => "C   NOT FOUND " + x).join("\n"));
