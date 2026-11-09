#!/usr/bin/env node
// TW-4F H1: derives the machine-checkable part of docs/twilio/TW-4F_Hosted_Apply_Manifest.md from the committed migration files.
// Reads Git blobs only (git show <ref>:<path>); touches no database, no hosted project, no network.
//   node scripts/hosted/tw4f/gen_manifest_data.mjs [--ref main] [--from 20261119090000] [--to 20261217090000] [--json]
// Output: markdown (default) or JSON with, per forward migration: sha256 of the LF-normalized blob, raw sha256, CR count,
// the rollback file's sha256, objects created vs replaced (a function/table is "replaced" when an earlier file in the chain, or an
// earlier migration on the ref, already defines it), client-exposed grants (anon/authenticated/PUBLIC), one-off data statements,
// and the rollback script's refusal messages.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const REF = opt('--ref', 'main');
const FROM = opt('--from', '20261119090000');
const TO = opt('--to', '20261217090000');
const AS_JSON = args.includes('--json');
const DIR = 'src/lib/supabase/migrations';

const git = (...a) => execFileSync('git', a, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
const blob = (path) => git('show', `${REF}:${path}`).toString('utf8');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const lf = (s) => s.replace(/\r\n/g, '\n');

const allFiles = git('ls-tree', '-r', '--name-only', REF, DIR).toString('utf8').split('\n').filter(Boolean);
const forward = allFiles.filter((f) => /\/\d{14}_[^/]+\.sql$/.test(f) && !f.includes('/rollback/')).sort();
const rollbackByStamp = new Map(allFiles.filter((f) => f.includes('/rollback/')).map((f) => [f.split('/').pop().slice(0, 14), f]));

// Drop dollar-quoted bodies so that statement splitting and keyword scans only see top-level DDL.
const stripBodies = (sql) => sql.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, '$$$$');
const stmts = (sql) => stripBodies(sql.replace(/--[^\n]*/g, '')).split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
const fnName = (s) => (s.match(/^create (?:or replace )?function ([\w.]+)\s*\(/i) || [])[1]?.replace(/^public\./, '');

const seenFn = new Set();
const seenTable = new Set();
const seenOther = new Set();
// Everything older than FROM on the ref also counts as "already defined".
for (const f of forward.filter((x) => x.split('/').pop().slice(0, 14) < FROM)) {
  for (const s of stmts(blob(f))) {
    const n = fnName(s); if (n) seenFn.add(n);
    const t = (s.match(/^create table (?:if not exists )?(?:public\.)?(\w+)/i) || [])[1]; if (t) seenTable.add(t);
  }
}

const out = [];
for (const f of forward) {
  const base = f.split('/').pop();
  const stamp = base.slice(0, 14);
  if (stamp < FROM || stamp > TO) continue;
  const raw = blob(f);
  const text = lf(raw);
  const crs = (raw.match(/\r/g) || []).length;
  const ss = stmts(text);
  const created = { tables: [], functions: [], views: [], other: [] };
  const replaced = { functions: [], tables: [] };
  const grants = [];
  const data = [];
  const events = [];
  const dropped = [];
  for (const s of ss) {
    const dm = s.match(/^drop function (?:if exists )?(?:public\.)?(\w+)/i);
    if (dm) { dropped.push(dm[1]); events.push(['drop', dm[1]]); continue; }
    const n = fnName(s);
    if (n) events.push(['create', n]);
    if (n) { (seenFn.has(n) ? replaced.functions : created.functions).push(n); seenFn.add(n); continue; }
    const t = (s.match(/^create table (?:if not exists )?(?:public\.)?(\w+)/i) || [])[1];
    if (t) { (seenTable.has(t) ? replaced.tables : created.tables).push(t); seenTable.add(t); continue; }
    const v = (s.match(/^create (?:or replace )?view (?:public\.)?(\w+)/i) || [])[1];
    if (v) { created.views.push(v); continue; }
    if (/^(create (unique )?index|create trigger|create policy|create type|alter table .* (add column|add constraint))/i.test(s)) created.other.push(s.slice(0, 90));
    if (/^grant /i.test(s) && /\b(anon|authenticated|public)\b/i.test(s.split(/ to /i).pop())) grants.push(s.replace(/^grant execute on function /i, 'GRANT EXECUTE ').slice(0, 500));
    if (/^(insert into|update|delete from) /i.test(s) && !/^(insert into|update|delete from) (pg_|\w+\.)?\w*\s*$/i.test(s)) data.push(s.slice(0, 120));
  }
  // top-level DML only matters as a one-off data change; DO-block bodies were stripped, so scan them separately for backfills.
  const doBodies = [...text.matchAll(/\bdo\s+\$([A-Za-z_]*)\$([\s\S]*?)\$\1\$/gi)].map((m) => m[2]);
  const doDml = doBodies.flatMap((b) => [...b.matchAll(/^\s*(insert into|update|delete from)\s+([\w.]+)/gim)].map((m) => `${m[1].toLowerCase()} ${m[2]} (inside DO block)`));
  const header = text.split('\n').filter((l) => l.startsWith('--')).slice(0, 40).join('\n');
  const requires = [...new Set((header.match(/[Rr]equires\s+\d{8}[^\n]*?(?=\.(?:\s|$)|$)/gm) || []).map((x) => x.trim()))];
  const rb = rollbackByStamp.get(stamp);
  let rbInfo = null;
  if (rb) {
    const rbRaw = blob(rb); const rbText = lf(rbRaw);
    const refusals = [...rbText.matchAll(/raise exception\s+'([^']*(?:''[^']*)*)'(?:\s+using errcode\s*=\s*'(\w+)')?/gi)]
      .filter((m) => /rollback/i.test(m[1]))
      .map((m) => `${m[1].replace(/''/g, "'")}${m[2] ? ` [${m[2]}]` : ''}`);
    rbInfo = { path: rb.replace(`${DIR}/`, ''), sha256: sha(rbText), crlf: (rbRaw.match(/\r/g) || []).length, refusals: [...new Set(refusals)] };
  }
  out.push({
    stamp, file: base, sha256: sha(text), rawSha256: sha(raw), crCount: crs, lines: text.split('\n').length,
    summary: (text.split('\n')[1] || '').replace(/^--\s*/, '').slice(0, 200),
    requires, created, replaced, events, dropped: [...new Set(dropped)], grants: [...new Set(grants)], dataStatements: [...new Set([...data, ...doDml])], rollback: rbInfo,
  });
}

if (args.includes('--sync-probes')) {
  // Rewrite the generated expected-object block of the probes (between the BEGIN/END markers) from the migration chain.
  const fns = new Map(); const tbs = new Map();
  for (const m of out) {
    for (const [op, n] of m.events) { if (op === 'create') { if (!fns.has(n)) fns.set(n, m.stamp); } else fns.delete(n); }
    for (const n of m.created.tables) if (!tbs.has(n)) tbs.set(n, m.stamp);
  }
  const rows = (map) => [...map].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0])).map(([n, st]) => `    ('${n}', '${st}')`).join(',\n');
  const gen = [
    `  -- BEGIN GENERATED expected objects (gen_manifest_data.mjs --sync-probes; chain through ${TO})`,
    `  exp_fn(name, since) as (values\n${rows(fns)}\n  ),`,
    `  exp_tbl(name, since) as (values\n${rows(tbs)}\n  ),`,
    `  -- END GENERATED expected objects`,
  ].join('\n');
  for (const f of ['probe_objects.sql', 'probe_fingerprint.sql']) {
    const path = new URL('./' + f, import.meta.url);
    const t = readFileSync(path, 'utf8');
    const re = /  -- BEGIN GENERATED expected objects[\s\S]*?  -- END GENERATED expected objects/;
    if (!re.test(t)) throw new Error(f + ': generated-block markers missing');
    writeFileSync(path, t.replace(re, () => gen));
  }
  console.error(`probes synced: ${fns.size} functions, ${tbs.size} tables`);
  process.exit(0);
}
if (args.includes('--table')) {
  // Rows for the manifest's hash table (read by verify_manifest_hashes.sh).
  const rows = out.map((m) => `| ${m.stamp} | ${m.file} | ${m.sha256} | ${m.rollback ? m.rollback.sha256 : 'MISSING'} | ${m.crCount || (m.rollback && m.rollback.crlf) ? 'CR in blob (raw ' + m.rawSha256.slice(0, 12) + ')' : 'LF'} |`);
  process.stdout.write(rows.join('\n') + '\n');
  process.exit(0);
}
if (AS_JSON) { process.stdout.write(JSON.stringify({ ref: REF, commit: git('rev-parse', REF).toString().trim(), migrations: out }, null, 2) + '\n'); process.exit(0); }

const L = [];
L.push(`<!-- generated by scripts/hosted/tw4f/gen_manifest_data.mjs --ref ${REF} (${git('rev-parse', REF).toString().trim().slice(0, 8)}); regenerate, do not hand-edit -->`);
for (const m of out) {
  L.push('', `#### ${m.file}`, '');
  L.push(`- sha256 (LF-normalized): \`${m.sha256}\`${m.crCount ? ` — **raw blob has ${m.crCount} CR bytes; raw sha256 \`${m.rawSha256}\`**` : ''}  (${m.lines} lines)`);
  if (m.summary) L.push(`- header: ${m.summary}`);
  if (m.requires.length) L.push(`- header dependencies: ${m.requires.join(' / ')}`);
  const c = m.created;
  L.push(`- created: ${c.tables.length} tables${c.tables.length ? ` (${c.tables.map((x) => '`' + x + '`').join(', ')})` : ''}, ${c.functions.length} functions, ${c.views.length} views, ${c.other.length} indexes/triggers/constraints`);
  if (c.functions.length) L.push(`  - new functions: ${c.functions.map((x) => '`' + x + '`').join(', ')}`);
  if (m.dropped.length) L.push('- dropped functions: ' + m.dropped.map((x) => '`' + x + '`').join(', '));
  if (m.replaced.functions.length) L.push(`- replaced (CREATE OR REPLACE / re-created): ${m.replaced.functions.map((x) => '`' + x + '`').join(', ')}`);
  L.push(`- client-exposed grants (anon/authenticated/PUBLIC): ${m.grants.length ? '' : 'none'}`);
  for (const g of m.grants) L.push(`  - \`${g}\``);
  L.push(`- one-off data statements: ${m.dataStatements.length ? '' : 'none at top level'}`);
  for (const d of m.dataStatements.slice(0, 8)) L.push(`  - \`${d}\``);
  if (m.rollback) {
    L.push(`- rollback: \`rollback/${m.rollback.path.replace('rollback/', '')}\` sha256 \`${m.rollback.sha256}\`${m.rollback.crlf ? ` (raw has ${m.rollback.crlf} CR bytes)` : ''}`);
    L.push(`  - refusal conditions: ${m.rollback.refusals.length ? m.rollback.refusals.map((x) => `"${x}"`).join('; ') : 'none declared (no raise exception mentioning "rollback")'}`);
  } else L.push('- rollback: **MISSING**');
}
process.stdout.write(L.join('\n') + '\n');
