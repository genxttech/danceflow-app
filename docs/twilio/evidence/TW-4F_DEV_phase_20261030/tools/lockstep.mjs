// Local lockstep expectations: DEV-equivalent Docker DB; apply the same 41 exported files; record both hosted probes after each step.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
process.env.MSYS_NO_PATHCONV = "1";
const WD = readFileSync(process.env.TEMP + "/tw4f_wd.txt", "utf8").trim();
const R = "C:/Dev/studioapp";
const NAME = "df-q1-lockstep", IMAGE = "df-isoqa/base:20261119092100", REF = "e749427ce5eaea3316752729f565e11254ac45af";
const sh = (c, a, o = {}) => execFileSync(c, a, { encoding: "utf8", maxBuffer: 1 << 28, timeout: 600000, ...o }).trim();
const gitShow = (f) => execFileSync("git", ["-C", R, "show", `${REF}:${f}`], { encoding: "utf8", maxBuffer: 1 << 28 }).replace(/\r\n/g, "\n");
const psql = (sql, flags = []) => spawnSync("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", NAME, "psql", "-U", "postgres", "-d", "postgres", "-q", "-v", "ON_ERROR_STOP=1", ...flags], { input: sql, encoding: "utf8", maxBuffer: 1 << 28 });
const probeFp = readFileSync(WD + "/probes/probe_fingerprint.sql", "utf8"), probeObj = readFileSync(WD + "/probes/probe_objects.sql", "utf8");
const rows = (sql) => { const r = psql(sql, ["-At", "-F", "\t"]); if (r.status) throw new Error("probe " + r.stderr.slice(0, 300)); return r.stdout.split("\n").filter(Boolean); };
const apply = (label, sql) => { const r = psql(sql); if (r.status || /(^|\n)(psql:[^\n]*?: )?(ERROR|FATAL|PANIC):/.test((r.stdout || "") + (r.stderr || ""))) throw new Error(label + ": " + ((r.stdout || "") + (r.stderr || "")).slice(0, 500)); };
const plan = JSON.parse(readFileSync(WD + "/plan.json", "utf8"));
const man = gitShow("docs/twilio/TW-4F_Hosted_Apply_Manifest.md");
const all = [...man.matchAll(/^\| (2026\d{10}) \| (\S+\.sql) \|/gm)].map((m) => [m[1], m[2]]);
const dev0 = all.filter(([t]) => t > "20261119092100" && t <= "20261122090000");
const out = { s0: null, steps: [] };
try {
  try { sh("docker", ["rm", "-f", NAME]); } catch {}
  sh("docker", ["run", "-d", "--name", NAME, "--label", "df.tw4fq1=1", "--memory", "1500m", "--cpus", "2", "-e", "POSTGRES_PASSWORD=postgres", IMAGE, "postgres", "-D", "/etc/postgresql", "-c", "supautils.hint_roles="]);
  for (let i = 0, ok = 0; i < 120 && ok < 3; i++) { try { sh("docker", ["exec", NAME, "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", "select 1"]); ok++; } catch { ok = 0; } await new Promise((r) => setTimeout(r, 2500)); }
  for (const [, f] of dev0) apply(f, gitShow("src/lib/supabase/migrations/" + f));
  out.s0 = { fp: rows(probeFp), obj: rows(probeObj) };
  console.error("S0 fp rows", out.s0.fp.length, "obj rows", out.s0.obj.length);
  for (const p of plan) {
    apply(p.file, readFileSync(p.sql, "utf8"));
    out.steps.push({ n: p.n, ts: p.ts, fp: rows(probeFp), obj: rows(probeObj) });
    console.error("step", p.n, p.ts, "ok");
  }
  writeFileSync(WD + "/expected_local.json", JSON.stringify(out));
  console.error("DONE");
} catch (e) { console.error("ERR", e.message.slice(0, 900)); process.exitCode = 3; }
finally { try { sh("docker", ["rm", "-f", NAME]); } catch {} }
