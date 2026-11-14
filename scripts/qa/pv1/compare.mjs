// PV-1 TS<->SQL equivalence runner. Loads the SQL engine functions into ONE rolled-back transaction on a local QA database container, runs every
// corpus case through public._comppv1_run and compares with the TypeScript engine's own result. Nothing persists (the transaction rolls back).
// Usage: node scripts/qa/pv1/compare.mjs <container> <engines.sql|installed> <out.json> <corpus1.jsonl> [corpus2.jsonl ...]
// "installed" runs the functions the migration installed (20270215090000), which is what ships; a file path loads that file first.
// A disagreement is: ok differs, or both ok and the RPC-shaped rows or the warnings differ. Failure-reason differences are reported separately.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const [container, enginesSql, outPath, ...corpora] = process.argv.slice(2);
if (!corpora.length) throw new Error("usage: compare.mjs <container> <engines.sql> <out.json> <corpus.jsonl>...");
if (!/^supabase_db_cf1c-qa$|^cf1q/.test(container)) throw new Error("refusing: only the dedicated local QA containers");

const toEvidence = (input) => {
  if (input === null || typeof input !== "object") return input;
  const c = input.context && typeof input.context === "object" ? input.context : {};
  return {
    engineKey: typeof input.engineKey === "string" ? `studio_${input.engineKey}` : input.engineKey ?? null,
    engineVersion: input.engineVersion ?? null,
    profile: input.profile ?? null,
    markScheme: input.markScheme ?? null,
    tieBreakChain: input.tieBreakChain ?? null,
    round: input.round ?? null,
    entries: input.entries ?? null,
    judges: input.judges ?? null,
    marks: input.marks ?? null,
    excludedEntries: c.excludedEntries ?? null,
    heats: c.heats ?? null,
    danceIds: c.danceIds ?? null,
    chiefJudgeTiebreak: c.chiefJudgeTiebreak ?? false,
    scoreRolesSeparately: c.scoreRolesSeparately ?? false,
    finalCapacity: c.finalCapacity ?? null,
  };
};
// The RPC row shape the app sends (calculate.ts rowToRpc).
const rpcRow = (r) => ({ entry_id: r.entryId, placement: r.placement ?? null, tie_group: r.tieGroup ?? null, advanced: r.advanced ?? null, rating_band: r.ratingBand ?? null, output: r.output ?? {} });
const expected = (run) =>
  run.ok
    ? { ok: true, rows: [...run.rows].map(rpcRow).sort((a, b) => (a.entry_id < b.entry_id ? -1 : a.entry_id > b.entry_id ? 1 : 0)), warnings: run.warnings }
    : { ok: false, reason: run.reason };

const cases = [];
for (const file of corpora) {
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const c = JSON.parse(line);
    cases.push({ source: file.split(/[\\/]/).pop(), engine: c.engine, ev: toEvidence(c.input), ts: expected(c.run) });
  }
}
const q = (v) => `$pv1$${JSON.stringify(v)}$pv1$::jsonb`;
const sql = [
  "\\set ON_ERROR_STOP 1",
  "begin;",
  enginesSql === "installed"
    ? "do $i$ begin if to_regprocedure('public._comppv1_run(text,jsonb)') is null then raise exception 'PV-1 is not installed'; end if; end $i$;"
    : fs.readFileSync(enginesSql, "utf8").replace(/\r/g, ""),
  "create temp table pv1_case (id integer, source text, engine text, ev jsonb, ts jsonb);",
  ...cases.map((c, i) => `insert into pv1_case values (${i}, '${c.source}', '${c.engine}', ${q(c.ev)}, ${q(c.ts)});`),
  "create temp table pv1_res as select c.*, public._comppv1_run(c.engine, c.ev) sq from pv1_case c;",
  `select json_build_object(
     'cases', count(*),
     'tsOk', count(*) filter (where (ts->>'ok')::boolean),
     'tsFail', count(*) filter (where not (ts->>'ok')::boolean),
     'okAgree', count(*) filter (where (ts->>'ok') = (sq->>'ok')),
     'successEqual', count(*) filter (where (ts->>'ok')::boolean and (sq->>'ok')::boolean and ts->'rows' = sq->'rows' and ts->'warnings' = sq->'warnings'),
     'disagreements', count(*) filter (where (ts->>'ok') <> (sq->>'ok') or ((ts->>'ok')::boolean and (ts->'rows' <> sq->'rows' or ts->'warnings' <> sq->'warnings'))),
     'failureReasonEqual', count(*) filter (where not (ts->>'ok')::boolean and not (sq->>'ok')::boolean and ts->>'reason' = sq->>'reason'),
     'bySource', (select json_object_agg(source, n) from (select source, count(*) n from pv1_res group by source) s),
     'firstDisagreements', (select coalesce(json_agg(json_build_object('id', id, 'source', source, 'engine', engine, 'ts', ts, 'sql', sq)), '[]'::json) from (
         select * from pv1_res where (ts->>'ok') <> (sq->>'ok') or ((ts->>'ok')::boolean and (ts->'rows' <> sq->'rows' or ts->'warnings' <> sq->'warnings')) order by id limit 5) d),
     'reasonDiffs', (select coalesce(json_agg(json_build_object('id', id, 'engine', engine, 'ts', ts->>'reason', 'sql', sq->>'reason')), '[]'::json) from (
         select * from pv1_res where not (ts->>'ok')::boolean and not (sq->>'ok')::boolean and ts->>'reason' <> sq->>'reason' order by id limit 20) r)
   ) from pv1_res;`,
  "rollback;",
].join("\n");
const out = execFileSync("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", container, "psql", "-U", "postgres", "-d", "postgres", "-At", "-q"], {
  input: sql,
  encoding: "utf8",
  maxBuffer: 256 << 20,
});
const line = out.split(/\r?\n/).find((l) => l.startsWith("{"));
fs.writeFileSync(outPath, `${JSON.stringify(JSON.parse(line), null, 2)}\n`);
const r = JSON.parse(line);
console.log(JSON.stringify({ cases: r.cases, tsOk: r.tsOk, tsFail: r.tsFail, okAgree: r.okAgree, successEqual: r.successEqual, disagreements: r.disagreements, failureReasonEqual: r.failureReasonEqual, bySource: r.bySource }));
