import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as O from './orchestrator.mjs';
import { entries } from './owner-tool.mjs';
import { runPreflight, tempRemote, CAPS } from './preflight.mjs';
import { bashMatch, pathMatch, coverage, loadDenyRules, checkProbe, allVariantIds, posture, allowedConflicts } from './deny-check.mjs';
import { record, plan, bashQuote, psQuote } from './deny-probe.mjs';

// Track every temp dir created by THIS test process (including by the code under test) and remove them at the end.
const __created = new Set(); const __orig = fs.mkdtempSync;
fs.mkdtempSync = (...a) => { const d = __orig(...a); __created.add(d); return d; };
after(() => { for (const d of __created) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const reqRaw = fs.readFileSync(path.join(HERE, 'phase2', 'required-deny.json'));
const req = JSON.parse(reqRaw);
const REQ_SHA = crypto.createHash('sha256').update(reqRaw).digest('hex');
const realPolicy = JSON.parse(fs.readFileSync(path.join(HERE, 'phase2', 'policy.json'), 'utf8'));
const realQueue = JSON.parse(fs.readFileSync(path.join(HERE, 'phase2', 'queue.json'), 'utf8'));
const NOW = Date.parse('2026-11-14T13:00:00Z');
const NA = '2026-11-17T00:00:00Z';
const asRules = (a) => a.map((r) => ({ r }));

function setup({ mutateCode, noCode = false, policyMut = (p) => p, authsMut = (a) => a, queueMut = (q) => q, rules = req.recommendedRules, probeMut = (p) => p, settingsExtra = {}, now = NOW } = {}) {
  const policy = policyMut(structuredClone({ ...realPolicy, pilot: { ...realPolicy.pilot, enabled: true } }));
  const queue = queueMut(structuredClone(realQueue));
  const auths = authsMut(entries(queue, policy, { notAfter: NA }));
  const r = tempRemote(policy, auths, { code: !noCode, mutateCode });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpilot-pft-')); O.init(root);
  fs.writeFileSync(path.join(root, 'queue.json'), JSON.stringify(queue));
  const settings = path.join(root, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ permissions: { deny: rules }, ...settingsExtra }));
  const { hashes } = loadDenyRules([settings]);
  const probe = probeMut({ at: new Date(now).toISOString(), requiredSha: REQ_SHA, settingsHashes: hashes, results: allVariantIds(req).map((id) => ({ id, denied: true })) });
  const run = (extra = {}) => runPreflight({ root, source: r.source, expectPolicySha: r.policySha, expectAuthSha: r.authSha, requiredDeny: req, settingsFiles: [settings], probe, now, host: false, skipSuite: true, ...extra });
  return { root, r, run, settings, probe, hashes };
}
const failed = (rep) => rep.checks.filter((c) => !c.ok).map((c) => c.id);
const att = (s) => fs.existsSync(path.join(s.root, O.ATTEST));

test('M1. matcher: recommended rules cover every variant (shell, edit, non-shell tools); naive rules do not', () => {
  assert.deepEqual(coverage(req, asRules(req.recommendedRules)), { ok: true, uncovered: [] });
  const naive = coverage(req, asRules(['Bash(sb.sh prod-apply:*)', 'Bash(gh pr merge:*)']));
  for (const id of ['prod-bash-winpath', 'prod-bash-c', 'prod-powershell-call', 'merge-api', 'merge-graphql', 'push-trailing-f', 'push-plain', 'pr-create-gh', 'vercel-vc', 'supabase-query', 'edit-user-settings', 'terminal-run', 'chrome-navigate', 'artifact-publish']) assert.ok(naive.uncovered.includes(id), id);
  assert.equal(coverage(req, []).uncovered.length, allVariantIds(req).length);
});

test('M2. matcher fidelity: case-sensitive; relative path rules only protect the session cwd; absolute forms work; tool rules by name/server', () => {
  assert.equal(bashMatch('*PROD-APPLY*', 'bash sb.sh prod-apply f'), false);
  assert.ok(bashMatch('sb.sh prod-apply:*', 'sb.sh prod-apply f') && !bashMatch('sb.sh prod-apply:*', 'sb.sh prod-applyx'));
  assert.equal(pathMatch('**/.claude/settings*.json', 'C:/Users/mcurt/.claude/settings.json'), false, 'relative rule must not claim paths outside the cwd');
  assert.ok(pathMatch('**/.claude/settings*.json', 'C:/Dev/studioapp/.claude/settings.local.json'));
  assert.ok(pathMatch('//c/Users/mcurt/.claude/settings*.json', 'C:\\Users\\mcurt\\.claude\\settings.json') && pathMatch('//c/Dev/**/CLAUDE.md', 'C:/Dev/a/b/CLAUDE.md') && pathMatch('//c/Dev/**/CLAUDE.md', 'C:/Dev/CLAUDE.md'));
  assert.equal(pathMatch('//c/Dev/**/CLAUDE.md', 'C:/Dev/a/CLAUDE.md.bak'), false);
  const onlyRelative = coverage(req, asRules(['Edit(**/.claude/settings*.json)', 'Write(**/.claude/settings*.json)']));
  assert.ok(onlyRelative.uncovered.includes('edit-user-settings') && onlyRelative.uncovered.includes('write-user-settings'));
  assert.equal(coverage({ bashVariants: [], editVariants: [], toolVariants: [{ id: 't', tool: 'mcp__terminal__run_in_terminal' }] }, asRules(['mcp__terminal'])).ok, true);
  assert.equal(coverage({ bashVariants: [], editVariants: [], toolVariants: [{ id: 't', tool: 'mcp__terminal__run_in_terminal' }] }, asRules(['mcp__terminal_x'])).ok, false);
});

test('M3. required list is faithful: write probes sit inside real rule globs; edit probes use real paths; hostile variants are covered', () => {
  const writeRules = req.recommendedRules.filter((r) => r.startsWith('Write(')).map((r) => r.slice(6, -1));
  for (const v of req.editVariants.filter((x) => x.tool === 'Write')) assert.ok(writeRules.some((s) => pathMatch(s, v.probePath)), `${v.id} probe path is inside a Write rule`);
  const readRules = req.recommendedRules.filter((r) => r.startsWith('Read(')).map((r) => r.slice(5, -1));
  for (const v of req.editVariants.filter((x) => x.tool === 'Read')) { assert.ok(readRules.some((s) => pathMatch(s, v.probePath)), `${v.id} read probe path is inside a Read rule`); assert.ok(/nonexistent|cpilot-probe/.test(v.probePath), `${v.id} never reads a real file`); }
  for (const v of req.editVariants.filter((x) => x.tool === 'Edit')) assert.equal(v.probePath, undefined, `${v.id} probes the real path`);
  for (const must of ['push-dash-C', 'push-no-pager', 'push-git-exe', 'push-subtree', 'push-send-pack', 'push-alias-define', 'merge-gh-double-space', 'merge-gh-repo-flag', 'gh-release-create', 'gh-workflow-run', 'supabase-link', 'psql-pooler', 'pgrestore-env-url', 'read-ops-secrets', 'read-app-key', 'edit-user-claude-md', 'edit-user-plugin', 'edit-gitconfig', 'session-send-message', 'artifact-data', 'monitor', 'push-trailing-f', 'push-fu', 'push-mirror', 'push-delete-colon', 'push-head-main', 'pr-create-gh', 'pr-create-ghapp', 'merge-graphql', 'pr-review-approve', 'vercel-vc', 'vercel-rollback', 'vercel-env-rm', 'supabase-query', 'psql-env-url', 'prod-read-sb', 'test-seam', 'edit-live-attestation', 'edit-sb-sh', 'terminal-run', 'pr-auto-merge', 'set-permission-mode', 'artifact-publish', 'scheduled-create']) assert.ok(allVariantIds(req).includes(must), must);
});

test('M4. probe evidence: complete, all-denied, fresh (not future-dated), bound to settings AND the required list', () => {
  const s = setup(); assert.equal(checkProbe(req, s.probe, s.hashes, NOW, undefined, REQ_SHA).ok, true);
  const bad = (probe, hashes = s.hashes, now = NOW, sha = REQ_SHA) => checkProbe(req, probe, hashes, now, undefined, sha).problems.join();
  assert.match(bad({ ...s.probe, results: s.probe.results.slice(1) }), /no probe result/);
  assert.match(bad({ ...s.probe, results: s.probe.results.map((r, i) => (i === 0 ? { ...r, denied: false } : r)) }), /NOT denied/);
  assert.match(bad(s.probe, { x: 'changed' }), /settings changed/);
  assert.match(bad(s.probe, s.hashes, NOW + 25 * 3600000), /older than 24h/);
  assert.match(bad({ ...s.probe, at: new Date(NOW + 3 * 3600000).toISOString() }), /future-dated/);
  assert.match(bad(s.probe, s.hashes, NOW, 'otherlist'), /different required-deny list/);
  assert.equal(checkProbe(req, null, s.hashes, NOW).ok, false);
});

test('M5. posture: bypass mode or configured hooks fail', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cpilot-post-')); const f = path.join(d, 's.json');
  fs.writeFileSync(f, JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } })); assert.match(posture([f]).problems.join(), /bypassPermissions/);
  fs.writeFileSync(f, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [] }] } })); assert.match(posture([f]).problems.join(), /hooks/);
  fs.writeFileSync(f, JSON.stringify({ hooks: [], permissions: {} })); assert.equal(posture([f]).ok, true);
});

test('M6. probes are inert by construction: hostile text with quotes, ;, $() and backticks executes nothing in real shells', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cpilot-inert-')); const mark = path.join(d, 'INJECTED').replaceAll('\\', '/');
  const hostile = `bash -c 'gh pr merge 5; touch ${mark}; true' ; touch ${mark} && echo $(touch ${mark}) \`touch ${mark}\` "$(touch ${mark})"`;
  const b = spawnSync('bash', ['-c', `echo ${bashQuote('PROBE x: ' + hostile)}`], { encoding: 'utf8' });
  assert.equal(b.status, 0); assert.equal(fs.existsSync(mark), false, 'bash probe executed injected text'); assert.equal(b.stdout.trim(), 'PROBE x: ' + hostile, 'echo reproduces the text exactly');
  const psText = `gh pr merge 5; New-Item ${mark} ; $(New-Item ${mark}) 'quote' \`$x`;
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Write-Output ${psQuote('PROBE x: ' + psText)}`], { encoding: 'utf8' });
  if (!ps.error) { assert.equal(fs.existsSync(mark), false, 'PowerShell probe executed injected text'); assert.equal(ps.stdout.trim(), 'PROBE x: ' + psText); }
  for (const p of plan().filter((x) => x.probe && /^(echo|Write-Output) /.test(x.probe))) assert.ok(!/^(echo|Write-Output) [^'"]/.test(p.probe), 'command probes always pass a quoted string');
  assert.ok(plan().filter((p) => p.tool === 'Edit').every((p) => p.old_string.includes('impossible-match')), 'edit probes cannot match any real content');
});

test('P1. happy path: ALL checks pass (host + fail-closed suite included) and the attestation lets a real claim run; temp dirs cleaned', { timeout: 900000 }, () => {
  const s = setup(); const before = fs.readdirSync(os.tmpdir()).filter((n) => /^cpilot-pf(root)?-/.test(n)).length;
  const rep = s.run({ skipSuite: false, host: true });
  assert.deepEqual(failed(rep), [], JSON.stringify(rep.checks.filter((c) => !c.ok)));
  assert.equal(rep.ok, true); assert.ok(att(s));
  for (const id of ['1.code-matches-main', '1.policy-integrity', '2.enabled', '2.window', '2.auth-expiry', '3.scope', '4.claims-work', '4.class-gate', '4.forged-owner-done', '4.auth-of-class-G-rejected', '4.stop-file', '4.resume', '4.unreachable-source', '4.wrong-worker', '4.no-attestation', '4.stale-attestation', '4.settings-drift', '4.duplicate-ids', '4.remote-disable', '4.limit-enforced', '5.limits', '5.docker', '5.disk', '6.deny-static', '6.pilot-work-not-denied', '6.posture', '6.deny-probe']) assert.ok(rep.checks.find((c) => c.id === id && c.ok), id);
  const c = O.claim(s.root, { worker: 'COMPETITION', source: s.r.source, now: NOW, settingsFiles: [s.settings] }); assert.equal(c.status, 'CLAIMED'); assert.equal(c.item.id, 'Q1');
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
    'deny rules narrow': [{ rules: ['Bash(sb.sh prod-apply:*)'] }, {}, '6.deny-static'],
    'deny rules missing': [{ rules: [] }, {}, '6.deny-static'],
    'deny rules only relative paths': [{ rules: req.recommendedRules.filter((r) => !r.startsWith('Edit(') && !r.startsWith('Write(')).concat(['Edit(**/.claude/settings*.json)', 'Write(**/.claude/settings*.json)']) }, {}, '6.deny-static'],
    'non-shell tools not denied': [{ rules: req.recommendedRules.filter((r) => /[(]/.test(r)) }, {}, '6.deny-static'],
    'bypass mode configured': [{ settingsExtra: { permissions: { deny: req.recommendedRules, defaultMode: 'bypassPermissions' } } }, {}, '6.posture'],
    'hooks configured': [{ settingsExtra: { hooks: { Stop: [{ hooks: [] }] } } }, {}, '6.posture'],
    'probe missing': [{}, { probe: null }, '6.deny-probe'],
    'probe shows a variant not denied': [{ probeMut: (p) => { p.results[3].denied = false; return p; } }, {}, '6.deny-probe'],
    'probe for another required list': [{ probeMut: (p) => ({ ...p, requiredSha: 'other' }) }, {}, '6.deny-probe'],
    'protected command in class A template': [{ policyMut: (p) => { p.templates['u18-tooling-residual-check'].cmd += ' vercel promote'; return p; } }, {}, '1.source+validity'],
    'host checks skipped': [{}, {}, '5.host-skipped'],
    'local code differs from reviewed main': [{ mutateCode: (f, c) => (f === 'orchestrator.mjs' ? c + String.fromCharCode(10) + '// tampered' : c) }, {}, '1.code-matches-main'],
    'no code pinned in source': [{ noCode: true }, {}, '1.code-matches-main'],
    'deny rules block the pilots own work': [{ rules: [...req.recommendedRules, 'Bash(*psql*)'] }, {}, '6.pilot-work-not-denied'],
    'plugins enabled': [{ settingsExtra: { enabledPlugins: { 'x@y': true } } }, {}, '6.posture'],
  };
  for (const [name, [setupOpts, runOpts, expectFail]] of Object.entries(cases)) {
    const s = setup(setupOpts); const rep = s.run(runOpts);
    assert.equal(rep.ok, false, name); assert.ok(failed(rep).includes(expectFail), `${name}: expected ${expectFail}, failed=${failed(rep)}`); assert.equal(att(s), false, `${name}: no attestation`);
  }
});

test('P3. a failing preflight deletes any earlier attestation; a skipped suite can never attest', () => {
  const s = setup(); O.writeAttestation(s.root, { policySha: 'a', authSha: 'b', expiresAt: Date.now() + 1e9 });
  const rep = s.run({ expectPolicySha: 'bad' }); assert.equal(rep.ok, false); assert.equal(att(s), false);
  const rep2 = s.run(); assert.ok(failed(rep2).includes('4.suite-skipped'), JSON.stringify(rep2.checks.slice(0, 6))); assert.equal(att(s), false);
});

test('P4. probe recorder binds evidence to current settings hashes and the required list hash', () => {
  const rec = record([{ id: 'x', denied: true }], NOW); assert.equal(rec.at, new Date(NOW).toISOString()); assert.equal(rec.requiredSha, REQ_SHA); assert.ok(rec.settingsHashes && typeof rec.settingsHashes === 'object');
});

test('P5. MUTATION: removing the class gate from claim makes the preflight FAIL (the check is not vacuous)', { timeout: 900000 }, async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cpilot-mut-'));
  for (const f of fs.readdirSync(HERE).filter((n) => n.endsWith('.mjs'))) fs.copyFileSync(path.join(HERE, f), path.join(d, f));
  fs.cpSync(path.join(HERE, 'phase2'), path.join(d, 'phase2'), { recursive: true });
  const o = path.join(d, 'orchestrator.mjs'); let src = fs.readFileSync(o, 'utf8');
  const gate = "if (!why && tpl.class !== 'A') why = `class ${tpl.class} (owner gate)`;"; assert.ok(src.includes(gate), 'gate line present in the original');
  fs.writeFileSync(o, src.replace(gate, ''));
  const mut = await import(pathToFileURL(path.join(d, 'preflight.mjs')).href);
  const s = setup(); const rep = mut.runPreflight({ root: s.root, source: s.r.source, expectPolicySha: s.r.policySha, expectAuthSha: s.r.authSha, requiredDeny: req, settingsFiles: [s.settings], probe: s.probe, now: NOW, host: false, skipSuite: false });
  assert.equal(rep.ok, false); assert.ok(failed(rep).includes('4.class-gate'), `failed: ${failed(rep)}`); assert.equal(att(s), false);
});

test('M7. deny set does not block the pilot own work; over-broad rules are detected', () => {
  assert.deepEqual(allowedConflicts(req, asRules(req.recommendedRules)), []);
  const broad = allowedConflicts(req, asRules(['Bash(*psql*)', 'Bash(*supabase*)']));
  assert.ok(broad.some((h) => /psql/.test(h.cmd)) && broad.some((h) => /supabase/.test(h.cmd)), JSON.stringify(broad));
  assert.ok(req.allowedCommands.length >= 15);
});

test('M8. PowerShell probe is inert against Unicode single quotes (U+2018..U+201B) and non-ASCII variants are refused', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cpilot-uni-')); const mark = path.join(d, 'PWNED_PS1').replaceAll(String.fromCharCode(92), '/');
  for (const q of [0x2018, 0x2019, 0x201A, 0x201B].map((c) => String.fromCharCode(c))) {
    const text = 'x' + q + '; New-Item ' + mark + ' -ItemType File | Out-Null; ' + q;
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output ' + psQuote(text)], { encoding: 'utf8' });
    if (!ps.error) assert.equal(fs.existsSync(mark), false, 'unicode quote ' + q.charCodeAt(0).toString(16) + ' broke out of the PowerShell string');
  }
});

test('P6. claim refuses to run when the local code differs from the reviewed code on the protected ref', { timeout: 300000 }, () => {
  const s = setup({ mutateCode: (f, c) => (f === 'deny-check.mjs' ? c + String.fromCharCode(10) + '// stale copy' : c) });
  const r = O.claim(s.root, { worker: 'COMPETITION', source: s.r.source, now: NOW, settingsFiles: [] });
  assert.equal(r.status, 'HALT'); assert.match(r.reason, /local code differs from the reviewed code/); assert.match(r.reason, /deny-check.mjs/);
  const ok = setup(); assert.equal(O.claim(ok.root, { worker: 'COMPETITION', source: ok.r.source, now: NOW, settingsFiles: [] }).status, 'HALT'); // matches, but no attestation yet
  assert.match(O.claim(ok.root, { worker: 'COMPETITION', source: ok.r.source, now: NOW, settingsFiles: [] }).reason, /attestation/);
});
