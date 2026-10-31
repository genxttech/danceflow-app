// usage: node build.mjs --ref R --order FILE [--stop] [--skip a,b] [--crlf a,b] [--user postgres] --log LOG
import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
process.env.MSYS_NO_PATHCONV = "1";
const a = process.argv.slice(2); const f = {};
for (let i = 0; i < a.length; i++) { if (a[i].startsWith("--")) { const k = a[i].slice(2); f[k] = (a[i + 1] && !a[i + 1].startsWith("--")) ? a[++i] : true; } }
const C = process.env.CHAIN_CONTAINER || "cf1-chainprobe-db", M = "src/lib/supabase/migrations", REPO = "C:/Dev/studioapp";
const files = readFileSync(f.order, "utf8").split("\n").filter(Boolean);
const list = (s) => new Set((s || "").split(",").filter(Boolean));
const skip = list(f.skip), crlf = list(f.crlf);
const CR = String.fromCharCode(13), LF = String.fromCharCode(10);
const toCrlf = (s) => s.split(CR + LF).join(LF).split(LF).join(CR + LF);
const ERR = /(^|\n)(psql:[^\n]*?: )?(ERROR|FATAL|PANIC):/;
const log = (s) => { console.log(s); appendFileSync(f.log, s + "\n"); };
let ok = 0; const bad = [];
for (const n of files) {
  if (skip.has(n)) { log(`SKIP    ${n} (explicit)`); continue; }
  let sql = execFileSync("git", ["-C", REPO, "show", `${f.ref}:${M}/${n}`], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (crlf.has(n)) sql = toCrlf(sql);
  const r = spawnSync("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", C, "psql", "-U", f.user || "postgres", "-d", "postgres", "-q", "-v", "ON_ERROR_STOP=1", ...(/\bconcurrently\b/i.test(sql) ? [] : ["-1"])], { input: sql, encoding: "utf8", maxBuffer: 1 << 28 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0 || ERR.test(out)) {
    const e = (out.split("\n").find((l) => /ERROR|FATAL/.test(l)) ?? out).replace(/^.*?(ERROR|FATAL):\s*/, "").slice(0, 300);
    bad.push(n); log(`FAIL    ${n}${crlf.has(n) ? " [crlf]" : ""} :: ${e}`);
    if (f.stop) { log(`STOPPED at first failure after ${ok} applied`); process.exit(1); }
  } else { ok++; log(`OK      ${n}${crlf.has(n) ? " [crlf]" : ""}`); }
}
log(`DONE applied=${ok} failed=${bad.length}`); process.exit(bad.length ? 1 : 0);
