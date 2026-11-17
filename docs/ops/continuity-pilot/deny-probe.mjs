#!/usr/bin/env node
// Helper for the live deny-rule probe. The coordinator runs each probe through the real tools and records whether the
// harness DENIED it. Evidence is self-reported local evidence (see deny-check.mjs).
//   Command variants: the probe only ECHOES the protected text, quoted so that nothing in it can execute
//     (bash: single quotes with '\'' escaping; PowerShell: single-quoted string with '' doubling).
//   Edit variants: an Edit on the REAL protected path with an old_string that cannot exist, so even if it were allowed it fails
//     without modifying the file.
//   Write variants: a harmless NEW scratch file that sits inside the same protected glob (never an existing file).
//   Read variants: a NONEXISTENT path inside the same protected glob (a permission denial is distinguishable from file-not-found;
//     a real secret file is never read).
//   Tool variants: denied = the tool is ABSENT from the session tool list or its call is refused by a permission rule. An input
//     validation error is NOT a denial. Never send valid arguments (an allowed tool would then act).
//   node deny-probe.mjs plan                       -> prints probe actions
//   node deny-probe.mjs record --results R --out F -> writes evidence bound to current settings hashes + the required list hash
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadDenyRules, defaultSettingsFiles } from './deny-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED = path.join(HERE, 'phase2', 'required-deny.json');
export const requiredSha = () => crypto.createHash('sha256').update(fs.readFileSync(REQUIRED)).digest('hex');
const required = () => JSON.parse(fs.readFileSync(REQUIRED, 'utf8'));

export const bashQuote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
// PowerShell treats U+2018..U+201B as single-quote delimiters too: double all of them; and refuse non-ASCII outright.
export const psQuote = (s) => `'${String(s).replace(/['‘-‛]/g, (c) => c + c)}'`;
export const IMPOSSIBLE_OLD_STRING = '<<cpilot-probe-impossible-match-3f9a1c>>';

export function plan() {
  const r = required();
  for (const v of [...r.bashVariants, ...r.editVariants]) if (/[^ -~]/.test(JSON.stringify(v).replace(/\\/g, ''))) throw new Error(`variant ${v.id} contains non-ASCII text; probes must be pure ASCII`);
  return [
    ...r.bashVariants.map((v) => ({ id: v.id, tool: v.tool, probe: v.tool === 'PowerShell' ? `Write-Output ${psQuote('PROBE ' + v.id + ': ' + v.cmd)}` : `echo ${bashQuote('PROBE ' + v.id + ': ' + v.cmd)}` })),
    ...r.editVariants.map((v) => (v.tool === 'Edit' ? { id: v.id, tool: 'Edit', path: v.path, old_string: IMPOSSIBLE_OLD_STRING, new_string: 'x' } : v.tool === 'Read' ? { id: v.id, tool: 'Read', path: v.probePath } : { id: v.id, tool: 'Write', path: v.probePath, content: 'cpilot probe: delete me' })),
    ...r.toolVariants.map((v) => ({ id: v.id, tool: v.tool, probe: v.probeHint })),
  ];
}
export function record(results, now = Date.now()) {
  return { at: new Date(now).toISOString(), requiredSha: requiredSha(), settingsHashes: loadDenyRules(defaultSettingsFiles()).hashes, results };
}
if (process.argv[1]?.endsWith('deny-probe.mjs')) {
  const a = process.argv.slice(2); const f = (n) => { const k = a.indexOf(`--${n}`); return k < 0 ? undefined : a[k + 1]; };
  if (a[0] === 'plan') console.log(JSON.stringify(plan(), null, 2));
  else if (a[0] === 'record' && f('results') && f('out')) { fs.writeFileSync(f('out'), JSON.stringify(record(JSON.parse(fs.readFileSync(f('results'), 'utf8'))), null, 2)); console.log('written', f('out')); }
  else { console.error('usage: plan | record --results R --out F'); process.exit(2); }
}
