// DEV-equivalent round trip: image at 1119_092100 + 1120..1122 = DEV level; then the 41 pending files forward, reverse rollback, re-apply.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
process.env.MSYS_NO_PATHCONV = "1";
const R = "C:/Dev/studioapp-manifest-order";
const OUT = process.env.TEMP + "/devx";
const NAME = "df-q1-devx";
const IMAGE = "df-isoqa/base:20261119092100";
const sh = (c, a, o = {}) => execFileSync(c, a, { encoding: "utf8", maxBuffer: 1 << 28, timeout: 600000, ...o }).trim();
const gitShow = (f) => execFileSync("git", ["-C", R, "show", `origin/main:${f}`], { encoding: "utf8", maxBuffer: 1 << 28 }).replace(/\r\n/g, "\n");
const src = readFileSync(R + "/scripts/qa/tw4f/run-chain.mjs", "utf8");
const body = src.slice(src.indexOf("const FP_SQL = `") + "const FP_SQL = `".length, src.indexOf("`;", src.indexOf("const FP_SQL = `")));
const FP_SQL = new Function("return `" + body + "`")();
const psql = (sql, tuples = false) => {
  const r = spawnSync("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", NAME, "psql", "-U", "postgres", "-d", "postgres", "-q", "-v", "ON_ERROR_STOP=1", ...(tuples ? ["-At"] : [])], { input: sql, encoding: "utf8", maxBuffer: 1 << 28 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const fp = () => { const r = psql(FP_SQL, true); if (r.code) throw new Error("fp " + r.out.slice(0, 300)); return r.out.split("\n").filter(Boolean); };
const diff = (a, b) => { const A = new Set(a), B = new Set(b); return { onlyBefore: a.filter((x) => !B.has(x)), onlyAfter: b.filter((x) => !A.has(x)) }; };
const apply = (label, sql) => { const r = psql(sql); if (r.code || /(^|\n)(psql:[^\n]*?: )?(ERROR|FATAL|PANIC):/.test(r.out)) throw new Error(`${label}: ${r.out.slice(0, 500)}`); };
const ls = sh("git", ["-C", R, "ls-tree", "--name-only", "origin/main", "src/lib/supabase/migrations/"]).split("\n");
const mig = (ts) => { const f = ls.find((x) => x.includes("/" + ts + "_")); if (!f) throw new Error("no file " + ts); return f; };
const rbOf = (f) => f.replace("migrations/", "migrations/rollback/").replace(/\.sql$/, "_rollback.sql");
const manifest = gitShow("docs/twilio/TW-4F_Hosted_Apply_Manifest.md");
const all = [...manifest.matchAll(/^\| (2026\d{10}) \| (\S+\.sql) \|/gm)].map((m) => m[1]);
const dev0 = all.filter((t) => t > "20261119092100" && t <= "20261122090000");
const pending = all.filter((t) => t > "20261122090000");
console.error("dev0", dev0.join(","), "pending", pending.length);
try {
  try { sh("docker", ["rm", "-f", NAME]); } catch {}
  sh("docker", ["run", "-d", "--name", NAME, "--label", "df.tw4fq1=1", "--memory", "1500m", "--cpus", "2", "-e", "POSTGRES_PASSWORD=postgres", IMAGE, "postgres", "-D", "/etc/postgresql", "-c", "supautils.hint_roles="]);
  for (let i = 0, ok = 0; i < 120 && ok < 3; i++) { try { sh("docker", ["exec", NAME, "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", "select 1"]); ok++; } catch { ok = 0; } await new Promise((r) => setTimeout(r, 2500)); }
  for (const t of dev0) apply(t, gitShow(mig(t)));
  const fp0 = fp();
  console.error("S0 fp entries", fp0.length);
  const before = [fp0];
  for (const t of pending) { apply("fwd " + t, gitShow(mig(t))); before.push(fp()); }
  const top = before[before.length - 1];
  const steps = [];
  let cur = top;
  for (let i = pending.length - 1; i >= 0; i--) {
    const t = pending[i];
    apply("rb " + t, gitShow(rbOf(mig(t))));
    cur = fp();
    const d = diff(before[i], cur); // before[i] = state before pending[i] was applied
    steps.push({ ts: t, nOnlyBefore: d.onlyBefore.length, nOnlyAfter: d.onlyAfter.length, onlyBefore: d.onlyBefore, onlyAfter: d.onlyAfter });
  }
  const fin = diff(fp0, cur);
  for (const t of pending) apply("re " + t, gitShow(mig(t)));
  const re = diff(top, fp());
  writeFileSync(OUT + ".json", JSON.stringify({ dev0, pending, steps, final: fin, reapplyDiff: { b: re.onlyBefore.length, a: re.onlyAfter.length } }, null, 1));
  console.error("DONE steps", steps.length, "final diff", fin.onlyBefore.length, fin.onlyAfter.length, "reapply", re.onlyBefore.length, re.onlyAfter.length);
} catch (e) { console.error("ERR", e.message.slice(0, 800)); process.exitCode = 3; }
finally { try { sh("docker", ["rm", "-f", NAME]); } catch {} }
