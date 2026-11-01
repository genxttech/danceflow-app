const cp = require("child_process"), fs = require("fs"), crypto = require("crypto"), path = require("path");
const REF = "e749427ce5eaea3316752729f565e11254ac45af";
const WD = fs.readFileSync(process.env.TEMP + "/tw4f_wd.txt", "utf8").trim();
const git = (a) => cp.execFileSync("git", ["-C", "C:/Dev/studioapp", ...a], { encoding: "utf8", maxBuffer: 1 << 28 });
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
if (git(["rev-parse", REF]).trim() !== REF) throw new Error("ref mismatch");
const man = git(["show", `${REF}:docs/twilio/TW-4F_Hosted_Apply_Manifest.md`]).replace(/\r/g, "");
const sec = (a, b) => { const i = man.indexOf(a), j = man.indexOf(b, i + 1); return man.slice(i, j); };
const s3 = sec("## 3. Migration hash table", "## 4. Apply order"), s41 = sec("### 4.1 DEV pending list", "## 5. Dependencies");
const h = {}; for (const m of s3.matchAll(/^\| (2026\d{10}) \| (\S+\.sql) \| ([0-9a-f]{64}) \| ([0-9a-f]{64}) \|/gm)) h[m[1]] = { file: m[2], fwd: m[3] };
const list = [...s41.matchAll(/^\| (\d+) \| (2026\d{10}_\S+\.sql) \|/gm)].map((m) => ({ n: +m[1], file: m[2], ts: m[2].slice(0, 14) }));
if (list.length !== 41) throw new Error("41 expected");
fs.mkdirSync(WD + "/sql", { recursive: true }); fs.mkdirSync(WD + "/probes", { recursive: true });
const plan = []; let bad = 0;
for (const l of list) {
  const t = git(["show", `${REF}:src/lib/supabase/migrations/${l.file}`]).replace(/\r\n/g, "\n");
  const ok = h[l.ts] && h[l.ts].file === l.file && sha(t) === h[l.ts].fwd;
  if (!ok) { bad++; console.log("HASH/NAME MISMATCH", l.file); }
  const out = `${WD}/sql/${String(l.n).padStart(2, "0")}_${l.file}`; fs.writeFileSync(out, t, "utf8");
  plan.push({ n: l.n, ts: l.ts, file: l.file, sql: out, sha256: sha(t), manifest: h[l.ts] ? h[l.ts].fwd : null, ok });
}
const asc = plan.every((p, i) => i === 0 || p.ts > plan[i - 1].ts);
const i5 = plan.findIndex((p) => p.ts === "20261205090000"), i6 = plan.findIndex((p) => p.ts === "20261206090000"), i7 = plan.findIndex((p) => p.ts === "20261207090000");
console.log("files", plan.length, "| hash+name mismatches", bad, "| ascending", asc, "| 1205,1206,1207 positions", i5 + 1, i6 + 1, i7 + 1);
for (const f of ["probe_objects.sql", "probe_fingerprint.sql"]) { const t = git(["show", `${REF}:scripts/hosted/tw4f/${f}`]).replace(/\r\n/g, "\n"); fs.writeFileSync(`${WD}/probes/${f}`, t); console.log(f, sha(t).slice(0, 16), t.length, "bytes"); }
fs.writeFileSync(WD + "/plan.json", JSON.stringify(plan, null, 1));
console.log("workdir", WD);
if (bad || !asc) process.exit(3);
