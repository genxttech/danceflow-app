#!/usr/bin/env node
/**
 * main-vs-live inventory and superset proof (read-only, Git objects only).
 *
 * Usage:
 *   node scripts/release/main-vs-live-inventory.mjs --live <ref> [--main origin/main] [--rec HEAD] [--out <dir>]
 *
 * --live  the commit www serves (e.g. origin/release/cf1-hotfix-heat-schedulepush or a deployment's source sha)
 * --main  the main line to compare against (default origin/main)
 * --rec   the reconciled candidate (default HEAD); pass the same value as --main to inventory before merging
 *
 * For every file the live line changed since merge-base(main, live) it reports, by blob identity (content, not ancestry):
 *   main side:  SAME (main already has live's bytes) | MISSING_ON_MAIN (main untouched) | BOTH_CHANGED
 *   rec side:   REC=LIVE | REC=MAIN (main's copy; must be justified as a newer descendant) | REC=HAND (neither; must be documented)
 * plus: live files absent from rec, migration files whose bytes differ between live and rec (must be empty: an applied
 * migration's bytes never change), migration timestamps present on both lines under different file names, and the
 * production-surface summary (webhook, refunds, check-in/desk balance, H1/AAL2, SMS/TW-4F, crons, migrations).
 * Exit code 1 when a live file is missing from rec, a migration's bytes differ, or a timestamp collides.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const live = args.live;
if (!live) {
  console.error("--live <ref> is required");
  process.exit(2);
}
const main = args.main ?? "origin/main";
const rec = args.rec ?? "HEAD";
const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 1 << 28 }).trim();
const base = git("merge-base", main, live);
const tree = (ref) => {
  const m = new Map();
  for (const line of git("ls-tree", "-r", ref).split("\n")) {
    if (!line) continue;
    const [meta, p] = line.split("\t");
    m.set(p, meta.split(" ")[2]);
  }
  return m;
};
const B = tree(base), L = tree(live), M = tree(main), R = tree(rec);
const rows = [];
const count = (o, k) => (o[k] = (o[k] ?? 0) + 1);
const mainSide = {}, recSide = {};
for (const p of new Set([...B.keys(), ...L.keys()])) {
  const b = B.get(p) ?? "-", l = L.get(p) ?? "-", m = M.get(p) ?? "-", r = R.get(p) ?? "-";
  if (b === l) continue;
  const ms = m === l ? "SAME" : m === b ? "MISSING_ON_MAIN" : "BOTH_CHANGED";
  const rs = r === l ? "REC=LIVE" : r === m ? "REC=MAIN" : "REC=HAND";
  count(mainSide, ms);
  count(recSide, rs);
  rows.push(`${ms}\t${rs}\t${p}`);
}
const missing = [...L.keys()].filter((p) => !R.has(p));
const MIG = /^src\/lib\/supabase\/migrations\//;
const migDrift = [...L.keys()].filter((p) => MIG.test(p) && R.has(p) && R.get(p) !== L.get(p));
const ts = (keys) => {
  const m = new Map();
  for (const p of keys) {
    const hit = /^src\/lib\/supabase\/migrations\/(rollback\/)?(\d{14})_/.exec(p);
    if (hit) m.set(`${hit[1] ?? ""}${hit[2]}`, [...(m.get(`${hit[1] ?? ""}${hit[2]}`) ?? []), p]);
  }
  return m;
};
const tsL = ts(L.keys()), tsR = ts(R.keys());
const collisions = [];
for (const [t, files] of tsR) if (files.length > 1 || (tsL.has(t) && tsL.get(t).join() !== files.join())) collisions.push(`${t}: ${files.join(", ")}`);
const SURFACE =
  /(payments\/webhook|competitionRefund|refund|checkin|checkinBalance|deskBalance|platform-admin|platformAdmin|support-?context|aal2|\/sms\/|twilio|tw4|cron\/sms|vercel\.json|migrations\/)/i;
const surface = {};
const surfaceNonLive = [];
for (const [p, l] of L) {
  if (!SURFACE.test(p)) continue;
  const r = R.get(p);
  const k = r === l ? "EQ_LIVE" : r === M.get(p) ? "MAIN" : r ? "HAND" : "MISSING";
  count(surface, k);
  if (k !== "EQ_LIVE") surfaceNonLive.push(`${k}\t${p}`);
}
const report = {
  refs: { main: git("rev-parse", main), live: git("rev-parse", live), rec: git("rev-parse", rec), base },
  liveOnlyCommits: git("rev-list", "--count", `${main}..${live}`),
  mainSide,
  recSide,
  liveFilesMissingFromRec: missing,
  migrationByteDrift: migDrift,
  migrationTimestampCollisions: collisions,
  surface,
  surfaceNonLive,
};
if (args.out) {
  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(path.join(args.out, "files.tsv"), rows.sort().join("\n") + "\n");
  fs.writeFileSync(path.join(args.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify(report, null, 2));
process.exit(missing.length || migDrift.length || collisions.length ? 1 : 0);
