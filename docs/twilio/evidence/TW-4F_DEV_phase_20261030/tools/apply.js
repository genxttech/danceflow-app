// Controlled forward apply of the 41 TW-4F files to DEV, one at a time, halting on the first deviation. No rollback logic exists in this script by design.
const fs = require("fs"), cp = require("child_process");
const WD = fs.readFileSync(process.env.TEMP + "/tw4f_wd.txt", "utf8").trim();
const REF = "epdrtzcydvnoidwrepqz";
process.chdir(WD);
fs.mkdirSync("hosted", { recursive: true });
const plan = JSON.parse(fs.readFileSync("plan.json", "utf8"));
const exp = JSON.parse(fs.readFileSync("expected_local.json", "utf8"));
const linked = fs.readFileSync("supabase/.temp/project-ref", "utf8").trim();
if (linked !== REF) { console.log("STOP: linked ref is not DEV"); process.exit(2); }
const log = (s) => { console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`); };
const run = (file, tag) => {
  const r = cp.spawnSync("supabase", ["db", "query", "--linked", "-f", file, "-o", "json"], { encoding: "utf8", maxBuffer: 1 << 28, shell: true });
  if (tag) fs.writeFileSync(`hosted/${tag}.out.txt`, (r.stdout || "") + "\n---stderr---\n" + (r.stderr || ""));
  return r;
};
const rowsOf = (r) => { try { return JSON.parse(r.stdout).rows; } catch { return null; } };
const fpLines = (rows) => rows.map((x) => `${x.scope}\t${x.object}\t${x.fp}`);
const objLines = (rows) => rows.filter((x) => x.section !== "00_env" && x.section !== "60_migration_history").map((x) => `${x.section}\t${x.object}\t${x.status}\t${x.detail ?? ""}`);
const localObj = (a) => a.filter((l) => !l.startsWith("00_env\t") && !l.startsWith("60_migration_history\t"));
const eq = (a, b) => { const A = new Set(a), B = new Set(b); return { same: a.length === b.length && [...A].every((x) => B.has(x)), onlyA: [...A].filter((x) => !B.has(x)), onlyB: [...B].filter((x) => !A.has(x)) }; };
const probeFp = () => { const r = run("probes/ro_fingerprint.sql"); const rows = rowsOf(r); if (r.status || !rows) throw new Error("fingerprint probe failed: " + (r.stderr || "").slice(0, 300)); return fpLines(rows); };
const probeObj = () => { const r = run("probes/ro_objects.sql"); const rows = rowsOf(r); if (r.status || !rows) throw new Error("objects probe failed: " + (r.stderr || "").slice(0, 300)); return { lines: objLines(rows), env: rows.filter((x) => x.section === "00_env") }; };
const rowCounts = () => { const r = run("probes/q_rows.sql"); const rows = rowsOf(r); if (r.status || !rows) throw new Error("row count failed"); return rows; };
const stop = (n, why, extra) => { log(`STOP at step ${n}: ${why}`); fs.writeFileSync("hosted/STOPPED.json", JSON.stringify({ step: n, why, extra }, null, 1)); process.exit(1); };

(async () => {
  // CP0 from the preflight files already saved, compared with local S0, then re-read to prove no drift since.
  const cp0Fp = fpLines(JSON.parse(fs.readFileSync("cp0/fp.json", "utf8")).rows);
  const cp0Obj = objLines(JSON.parse(fs.readFileSync("cp0/obj.json", "utf8")).rows);
  const s0f = eq(cp0Fp, exp.s0.fp), s0o = eq(cp0Obj, localObj(exp.s0.obj));
  log(`CP0 vs local DEV-equivalent S0: fingerprint rows equal=${s0f.same} (hosted-only ${s0f.onlyA.length}, local-only ${s0f.onlyB.length}); objects equal=${s0o.same} (hosted-only ${s0o.onlyA.length}, local-only ${s0o.onlyB.length})`);
  if (!s0f.same || !s0o.same) { fs.writeFileSync("hosted/S0_diff.json", JSON.stringify({ fp: s0f, obj: s0o }, null, 1)); stop(0, "hosted CP0 differs from the local DEV-equivalent S0; strict lockstep not possible"); }
  let prev = cp0Fp;
  const others = (lines) => lines.filter((l) => /other_sms_functions/.test(l));
  const othersCp0 = others(cp0Fp).sort().join("\n");
  const first = probeFp(); const d0 = eq(first, cp0Fp); log(`re-read immediately before step 1: drift vs CP0 = ${!d0.same}`); if (!d0.same) stop(0, "drift since CP0");
  if (process.env.DRYRUN) { log("DRYRUN: S0 comparison and drift re-read passed; no apply performed"); process.exit(0); }
  for (const p of plan) {
    const tag = String(p.n).padStart(2, "0");
    // 1 before (drift sentinel; step 1 uses the re-read above)
    if (p.n > 1) { const b = probeFp(); const d = eq(b, prev); if (!d.same) stop(p.n, "fingerprint drift while idle between steps", { onlyBefore: d.onlyB.slice(0, 20), onlyNow: d.onlyA.slice(0, 20) }); }
    const rc0 = rowCounts(); if (rc0.some((x) => x.row_count !== 0)) stop(p.n, "non-zero row count before apply", rc0.filter((x) => x.row_count !== 0));
    // 2 apply
    const t0 = Date.now();
    const r = run(p.sql, `${tag}_apply`);
    const text = (r.stdout || "") + (r.stderr || "");
    if (r.status !== 0 || /(^|\n)\s*(ERROR|FATAL|PANIC)\b|precondition failed|"error"|SQLSTATE/i.test(text.replace(/"rows":\s*\[\]/g, ""))) stop(p.n, `apply failed or reported an error (rc=${r.status})`, { head: text.slice(0, 700) });
    // 3 after
    const a = probeFp(), o = probeObj();
    if (o.env.find((e) => e.object === "read_only_txn")?.status !== "on") stop(p.n, "objects probe did not run read-only");
    const rc1 = rowCounts();
    const want = exp.steps[p.n - 1];
    const fpd = eq(a, want.fp), obd = eq(o.lines, localObj(want.obj));
    const oth = others(a).sort().join("\n") === othersCp0;
    const zero = rc1.every((x) => x.row_count === 0);
    const all = a.find((l) => l.startsWith("rollup:ALL\t")).split("\t")[2];
    const res = { n: p.n, file: p.file, ms: Date.now() - t0, rollupALL: all, fpEqualsLocalExpected: fpd.same, objectsEqualLocalExpected: obd.same, otherSmsUnchanged: oth, allTablesZeroRows: zero, tables: rc1.length };
    fs.writeFileSync(`hosted/${tag}_result.json`, JSON.stringify({ ...res, fpDiff: { hostedOnly: fpd.onlyA.slice(0, 30), localOnly: fpd.onlyB.slice(0, 30) }, objDiff: { hostedOnly: obd.onlyA.slice(0, 30), localOnly: obd.onlyB.slice(0, 30) } }, null, 1));
    fs.writeFileSync(`hosted/${tag}_after_fp.txt`, a.join("\n")); fs.writeFileSync(`hosted/${tag}_after_obj.txt`, o.lines.join("\n"));
    log(`step ${p.n}/41 ${p.file} ok=${fpd.same && obd.same && oth && zero} ALL=${all} fp=${fpd.same} obj=${obd.same} other_sms=${oth} zero_rows=${zero} tables=${rc1.length} ${res.ms}ms`);
    if (!fpd.same || !obd.same || !oth || !zero) stop(p.n, "post-apply verification mismatch", { fpHostedOnly: fpd.onlyA.slice(0, 10), fpLocalOnly: fpd.onlyB.slice(0, 10), objHostedOnly: obd.onlyA.slice(0, 10), objLocalOnly: obd.onlyB.slice(0, 10), oth, zero });
    prev = a;
    // special gate after 1231 (step 40): aal2 body + policies, before 1231b
    if (p.n === 40) {
      const r5 = run("probes/at5.sql", "40_at5"), r6 = run("probes/at6.sql", "40_at6");
      const a5 = rowsOf(r5), a6 = rowsOf(r6);
      const ok5 = a5 && a5[0] && a5[0].has_aal2 === true;
      const ok6 = a6 && a6.length === 3 && a6.every((x) => x.has_aal2 === true);
      log(`CP7 special: AT-5 aal2 body=${ok5}; AT-6 policies=${a6 ? a6.length : "?"} all aal2=${ok6}`);
      if (!ok5 || !ok6) stop(p.n, "CP7 aal2 verification failed", { a5, a6 });
    }
  }
  log("ALL 41 FILES APPLIED AND VERIFIED STEP BY STEP");
  fs.writeFileSync("hosted/DONE.json", JSON.stringify({ at: new Date().toISOString(), finalAll: prev.find((l) => l.startsWith("rollup:ALL\t")) }));
})().catch((e) => stop(-1, "script error: " + e.message));
