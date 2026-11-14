import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as O from './orchestrator.mjs';
import { entries } from './owner-tool.mjs';
import { runPreflight, tempRemote, CAPS } from './preflight.mjs';
import { bashMatch, pathMatch, coverage } from './deny-check.mjs';
import { bashQuote, psQuote } from './deny-probe.mjs';
import { childConfigSha, loadRequired } from './child-config.mjs';

const __created = new Set(); const __orig = fs.mkdtempSync;
fs.mkdtempSync = (...a) => { const d = __orig(...a); __created.add(d); return d; };
after(() => { for (const d of __created) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const req = loadRequired();
const realPolicy = JSON.parse(fs.readFileSync(path.join(HERE, 'phase2', 'policy.json'), 'utf8'));
const realQueue = JSON.parse(fs.readFileSync(path.join(HERE, 'phase2', 'queue.json'), 'utf8'));
const NOW = Date.parse('2026-11-14T13:00:00Z');
const NA = '2026-11-17T00:00:00Z';
const asRules = (a) => a.map((r) => ({ r }));
const VERSION = '2.1.321 (Claude Code)';

const reportFor = (policy, now, over = {}) => ({ ok: true, versionOk: true, at: new Date(now).toISOString(), childConfigSha: childConfigSha(policy, req), templates: Object.fromEntries(Object.entries(policy.templates).filter(([, t]) => t.class === 'A').map(([n]) => [n, { ok: true, denied: 120, allowedControls: 4 }])), ...over });

function setup({ mutateCode, noCode = false, policyMut = (p) => p, authsMut = (a) => a, queueMut = (q) => q, reportMut = (r) => r, version = VERSION, now = NOW } = {}) {
  const policy = policyMut(structuredClone({ ...realPolicy, pilot: { ...realPolicy.pilot, enabled: true } }));
  const queue = queueMut(structuredClone(realQueue));
  const auths = authsMut(entries(queue, policy, { notAfter: NA }));
  const r = tempRemote(policy, auths, { code: !noCode, mutateCode });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpilot-pft-')); O.init(root);
  fs.writeFileSync(path.join(root, 'queue.json'), JSON.stringify(queue));
  const isolationReport = reportMut(reportFor(policy, now));
  const run = (extra = {}) => runPreflight({ root, source: r.source, expectPolicySha: r.policySha, expectAuthSha: r.authSha, isolationReport, claudeVersion: version, now, host: false, skipSuite: true, ...extra });
  return { root, r, run, policy, isolationReport };
}
const failed = (rep) => rep.checks.filter((c) => !c.ok).map((c) => c.id);
const att = (s) => fs.existsSync(path.join(s.root, O.ATTEST));

test('M1. deny matcher (used for the child deny layer): case-sensitive, absolute path forms, relative forms only under the cwd', () => {
  assert.equal(bashMatch('*PROD-APPLY*', 'bash sb.sh prod-apply f'), false);
  assert.ok(bashMatch('sb.sh prod-apply:*', 'sb.sh prod-apply f') && !bashMatch('sb.sh prod-apply:*', 'sb.sh prod-applyx'));
  assert.equal(pathMatch('**/.claude/settings*.json', 'C:/Users/mcurt/.claude/settings.json'), false);
  assert.ok(pathMatch('//c/Users/mcurt/.claude/settings*.json', 'C:\\Users\\mcurt\\.claude\\settings.json') && pathMatch('//c/Dev/**/CLAUDE.md', 'C:/Dev/a/b/CLAUDE.md') && !pathMatch('//c/Dev/**/CLAUDE.md', 'C:/Dev/a/CLAUDE.md.bak'));
  assert.deepEqual(coverage(req, asRules(req.recommendedRules)), { ok: true, uncovered: [] });
  assert.ok(coverage(req, asRules(['Bash(sb.sh prod-apply:*)'])).uncovered.length > 100, 'naive rules cover almost nothing');
});

test('M2. probes are inert by construction: hostile text with quotes, ;, $() and backticks executes nothing in real shells', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cpilot-inert-')); const mark = path.join(d, 'INJECTED').replaceAll(String.fromCharCode(92), '/');
  const hostile = `bash -c 'gh pr merge 5; touch ${mark}; true' ; touch ${mark} && echo $(touch ${mark}) \`touch ${mark}\` "$(touch ${mark})"`;
  const b = spawnSync('bash', ['-c', `echo ${bashQuote('PROBE x: ' + hostile)}`], { encoding: 'utf8' });
  assert.equal(b.status, 0); assert.equal(fs.existsSync(mark), false); assert.equal(b.stdout.trim(), 'PROBE x: ' + hostile);
  for (const q of [0x2018, 0x2019, 0x201A, 0x201B].map((c) => String.fromCharCode(c))) {
    const text = 'x' + q + '; New-Item ' + mark + ' -ItemType File | Out-Null; ' + q;
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output ' + psQuote(text)], { encoding: 'utf8' });
    if (!ps.error) assert.equal(fs.existsSync(mark), false, 'unicode quote ' + q.charCodeAt(0).toString(16));
  }
});

test('P1. happy path: ALL checks pass (host + fail-closed suite + isolation evidence) and the attestation lets a real claim run; temp dirs cleaned', { timeout: 900000 }, () => {
  const s = setup(); const before = fs.readdirSync(os.tmpdir()).filter((n) => /^cpilot-pf(root)?-/.test(n)).length;
  const rep = s.run({ skipSuite: false, host: true });
  assert.deepEqual(failed(rep), [], JSON.stringify(rep.checks.filter((c) => !c.ok)));
  assert.equal(rep.ok, true); assert.ok(att(s));
  for (const id of ['1.code-matches-main', '1.policy-integrity', '2.enabled', '2.window', '2.auth-expiry', '3.scope', '4.claims-work', '4.class-gate', '4.forged-owner-done', '4.auth-of-class-G-rejected', '4.stop-file', '4.resume', '4.unreachable-source', '4.wrong-worker', '4.no-attestation', '4.stale-attestation', '4.child-config-drift', '4.duplicate-ids', '4.remote-disable', '4.limit-enforced', '5.limits', '5.docker', '5.disk', '6.child-config', '6.claude-version', '6.isolation-report']) assert.ok(rep.checks.find((c) => c.id === id && c.ok), id);
  const a = JSON.parse(fs.readFileSync(path.join(s.root, O.ATTEST), 'utf8')); assert.equal(a.childConfigSha, childConfigSha(s.policy, req));
  const c = O.claim(s.root, { worker: 'COMPETITION', source: s.r.source, now: NOW }); assert.equal(c.status, 'CLAIMED'); assert.equal(c.item.id, 'Q1'); assert.ok(c.item.iso.allow.length > 10 && c.item.iso.addDirs.length === 3 && c.item.iso.cwd === 'q1');
  assert.ok(fs.readdirSync(os.tmpdir()).filter((n) => /^cpilot-pf(root)?-/.test(n)).length - before <= 0, 'preflight temp dirs are removed');
});

test('P2. each required condition failing blocks attestation and names the failing check', { timeout: 900000 }, () => {
  const cases = {
    'wrong approved policy hash': [{}, { expectPolicySha: 'bad' }, '1.policy-integrity'],
    'pilot disabled': [{ policyMut: (p) => { p.pilot.enabled = false; return p; } }, {}, '2.enabled'],
    'window too short': [{ now: Date.parse('2026-11-16T22:00:00Z') }, {}, '2.window'],
    'authorization without expiry': [{ authsMut: (a) => a.map(({ not_after, ...x }) => x) }, {}, '2.auth-expiry'],
    'queue item without authorization': [{ queueMut: (q) => { q.items.push({ id: 'Q9', template: 'u18-rollback-rehearsal', params: {}, deps: [] }); return q; } }, {}, '3.scope'],
    'class G item authorized': [{ authsMut: (a) => [...a, { id: 'Q5', template: 'prod-sql-apply', params: {}, deps: ['Q1', 'Q3'], scope_sha: 'x', by: 'owner', not_after: NA }] }, {}, '1.source+validity'],
    'limit above cap': [{ policyMut: (p) => { p.pilot.maxHours = CAPS.maxHours + 1; return p; } }, {}, '5.limits'],
    'not local-only (push in cmd)': [{ policyMut: (p) => { p.templates['u18-rollback-rehearsal'].cmd += '; git push origin x'; return p; } }, {}, '3.scope'],
    'not local-only (hosted vocabulary)': [{ policyMut: (p) => { p.templates['release-migration-inventory'].cmd += ' then sb.sh prod-read q.sql'; return p; } }, {}, '3.scope'],
    'class A touching protected path': [{ policyMut: (p) => { p.templates['u18-rollback-rehearsal'].touches = ['.github/workflows/x.yml']; return p; } }, {}, '3.scope'],
    'protected command in class A template': [{ policyMut: (p) => { p.templates['u18-tooling-residual-check'].cmd += ' vercel promote'; return p; } }, {}, '1.source+validity'],
    'allow rule outside the reviewed families': [{ policyMut: (p) => { p.templates['u18-rollback-rehearsal'].allow.push('Bash(bash *)'); return p; } }, {}, '1.source+validity'],
    'allow rule reaching a protected target': [{ policyMut: (p) => { p.templates['release-migration-inventory'].allow.push('Write(//c/Dev/df-u18pkg/docs/ops/continuity-pilot/**)'); return p; } }, {}, '1.source+validity'],
    'budget above cap': [{ policyMut: (p) => { p.templates['release-migration-inventory'].maxBudgetUsd = 99; return p; } }, {}, '1.source+validity'],
    'example blocked by the deny layer': [{ policyMut: (p) => { p.templates['u18-rollback-rehearsal'].examples.push('docker exec -i -e PGPASSWORD=postgres cf1pilot-q1 psql -U postgres -h localhost -d postgres -c "select 1; select 2"'); return p; } }, {}, '6.child-config'],
    'example not allowed by any allow rule': [{ policyMut: (p) => { p.templates['u18-rollback-rehearsal'].examples.push('docker ps'); return p; } }, {}, '6.child-config'],
    'isolation report missing': [{}, { isolationReport: null }, '6.isolation-report'],
    'isolation report failed': [{ reportMut: (r) => ({ ...r, ok: false }) }, {}, '6.isolation-report'],
    'isolation report for another configuration': [{ reportMut: (r) => ({ ...r, childConfigSha: 'other' }) }, {}, '6.isolation-report'],
    'isolation report stale': [{ reportMut: (r) => ({ ...r, at: new Date(NOW - 30 * 3600000).toISOString() }) }, {}, '6.isolation-report'],
    'isolation report proves no denials': [{ reportMut: (r) => ({ ...r, templates: Object.fromEntries(Object.entries(r.templates).map(([n, t]) => [n, { ...t, denied: 0 }])) }) }, {}, '6.isolation-report'],
    'untested claude version': [{ version: '2.2.0 (Claude Code)' }, {}, '6.claude-version'],
    'no claude version': [{ version: '' }, {}, '6.claude-version'],
    'host checks skipped': [{}, {}, '5.host-skipped'],
    'local code differs from reviewed main': [{ mutateCode: (f, c) => (f === 'orchestrator.mjs' ? c + String.fromCharCode(10) + '// tampered' : c) }, {}, '1.code-matches-main'],
    'driver differs from reviewed main': [{ mutateCode: (f, c) => (f === 'driver.mjs' ? c + String.fromCharCode(10) + '// tampered' : c) }, {}, '1.code-matches-main'],
    'no code pinned in source': [{ noCode: true }, {}, '1.code-matches-main'],
  };
  for (const [name, [setupOpts, runOpts, expectFail]] of Object.entries(cases)) {
    const s = setup(setupOpts); const rep = s.run(runOpts);
    assert.equal(rep.ok, false, name); assert.ok(failed(rep).includes(expectFail), `${name}: expected ${expectFail}, failed=${failed(rep)}`); assert.equal(att(s), false, `${name}: no attestation`);
  }
});

test('P3. a failing preflight deletes any earlier attestation; a skipped suite can never attest', () => {
  const s = setup(); O.writeAttestation(s.root, { policySha: 'a', authSha: 'b', expiresAt: Date.now() + 1e9 });
  const rep = s.run({ expectPolicySha: 'bad' }); assert.equal(rep.ok, false); assert.equal(att(s), false);
  const rep2 = s.run(); assert.ok(failed(rep2).includes('4.suite-skipped')); assert.equal(att(s), false);
});

test('P5. MUTATION: removing the class gate from claim makes the preflight FAIL (the check is not vacuous)', { timeout: 900000 }, async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cpilot-mut-'));
  for (const f of fs.readdirSync(HERE).filter((n) => n.endsWith('.mjs'))) fs.copyFileSync(path.join(HERE, f), path.join(d, f));
  fs.cpSync(path.join(HERE, 'phase2'), path.join(d, 'phase2'), { recursive: true });
  const o = path.join(d, 'orchestrator.mjs'); const src = fs.readFileSync(o, 'utf8');
  const gate = "if (!why && tpl.class !== 'A') why = `class ${tpl.class} (owner gate)`;"; assert.ok(src.includes(gate), 'gate line present in the original');
  fs.writeFileSync(o, src.replace(gate, ''));
  const mut = await import(pathToFileURL(path.join(d, 'preflight.mjs')).href);
  const s = setup(); const rep = mut.runPreflight({ root: s.root, source: s.r.source, expectPolicySha: s.r.policySha, expectAuthSha: s.r.authSha, isolationReport: s.isolationReport, claudeVersion: VERSION, now: NOW, host: false, skipSuite: false });
  assert.equal(rep.ok, false); assert.ok(failed(rep).includes('4.class-gate'), `failed: ${failed(rep)}`); assert.equal(att(s), false);
});

test('P6. claim refuses to run when the local code differs from the reviewed code on the protected ref', { timeout: 300000 }, () => {
  const s = setup({ mutateCode: (f, c) => (f === 'child-config.mjs' ? c + String.fromCharCode(10) + '// stale copy' : c) });
  const r = O.claim(s.root, { worker: 'COMPETITION', source: s.r.source, now: NOW });
  assert.equal(r.status, 'HALT'); assert.match(r.reason, /local code differs from the reviewed code/); assert.match(r.reason, /child-config\.mjs/);
  const ok = setup(); assert.match(O.claim(ok.root, { worker: 'COMPETITION', source: ok.r.source, now: NOW }).reason, /attestation/);
});
