#!/usr/bin/env node
// OWNER/REVIEW-ONLY helper (never in the loop's command allowlist). It only PRINTS authorization entries for a
// queue + policy pair. They take effect solely when merged into the protected ref (CODEOWNERS-gated).
// Each entry carries template, params and deps VERBATIM next to the hash so the reviewer can read what is approved,
// and the orchestrator checks both the fields and the hash.
// usage: node owner-tool.mjs entries --queue queue.json --policy policy.json [--ids Q1,Q2] [--not-after ISO]
import fs from 'node:fs';
import { scopeSha } from './orchestrator.mjs';

export function entries(queue, policy, { ids, notAfter } = {}) {
  return queue.items.filter((i) => !ids || ids.includes(i.id))
    .filter((i) => Object.hasOwn(policy.templates, i.template) && policy.templates[i.template].class === 'A')
    .map((i) => ({ id: i.id, template: i.template, params: i.params || {}, deps: i.deps || [], scope_sha: scopeSha(i, policy), by: 'owner', ...(notAfter ? { not_after: notAfter } : {}) }));
}

if (process.argv[1]?.endsWith('owner-tool.mjs')) {
  const a = process.argv.slice(2); const f = (n) => { const k = a.indexOf(`--${n}`); return k < 0 ? undefined : a[k + 1]; };
  if (a[0] !== 'entries') { console.error('usage: entries --queue q.json --policy p.json [--ids a,b] [--not-after ISO]'); process.exit(2); }
  console.log(JSON.stringify(entries(JSON.parse(fs.readFileSync(f('queue'), 'utf8')), JSON.parse(fs.readFileSync(f('policy'), 'utf8')), { ids: f('ids')?.split(','), notAfter: f('not-after') }), null, 2));
}
