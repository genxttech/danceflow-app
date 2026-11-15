import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as O from './orchestrator.mjs';
import { CHILD_TOOLS, CHILD_FLAGS, EXTRA_DENY, CAPS, CODE_DIR, resolveCode, childSettings, childArgs, childEnv, childConfigSha, validateTemplateIsolation, checkExamples, loadRequired } from './child-config.mjs';
import { buildSuite, abuseVariants, evaluate, checkIsolationReport } from './isolation-test.mjs';
import { StreamParser } from './driver.mjs';
import { entries } from './owner-tool.mjs';
import { bashMatch } from './deny-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const policy = JSON.parse(fs.readFileSync(path.join(HERE, 'phase2', 'policy.json'), 'utf8'));
const required = loadRequired();
const A = Object.entries(policy.templates).filter(([, t]) => t.class === 'A');
const base = () => structuredClone(policy.templates['release-migration-inventory']);
const bad = (mut, re) => { const t = base(); mut(t); assert.throws(() => validateTemplateIsolation('x', t, required), re); };

test('C1. the shipped policy is valid, every template passes isolation validation, and every example is allowed and not denied', () => {
  O.validatePolicy(policy, []);
  for (const [n, t] of A) { validateTemplateIsolation(n, t, required); assert.deepEqual(checkExamples(t, required), [], n); }
});

test('C2. broad or dangerous allow rules are rejected (no interpreters, no wildcards outside the reviewed families, no shell metacharacters, nothing inside protected targets)', () => {
  for (const rule of ['Bash(*)', 'Bash(bash *)', 'Bash(sh *)', 'Bash(node *)', 'Bash(npx *)', 'Bash(docker *)', 'Bash(docker exec *)', 'Bash(git *)', 'Bash(git -C C:/Dev/df-u18pkg push *)', 'Bash(git -C C:/Dev/df-u18pkg config *)', 'Bash(git -C C:/Dev/df-u18pkg log *; echo x)', 'Bash(git -C C:/Dev/df-u18pkg status && rm x)', 'Bash(echo hello)', 'Bash(cat *)', 'Bash(docker exec cf1pilot-q1 sh *)', 'Bash(docker exec cf1c-qa-db psql *)', 'Bash(bash {CODE}/phase2/scripts/run_u18s2.sh *)', 'Bash(git -C C:/Dev/df-u18pkg add *)', 'Bash(git -C C:/Dev/df-u18pkg commit -m *)', 'Bash(bash C:/Dev/studioapp/docs/ops/continuity-pilot/phase2/scripts/apply_sql.sh cf1pilot-q1 postgres C:/Dev/df-u18/*)', 'Bash(bash {CODE}/phase2/scripts/apply_sql.sh cf1pilot-q1 postgres C:/Dev/studioapp/*)', 'Bash(KEEP=1 SUITES=none IMG=postgres:16 bash {CODE}/phase2/scripts/run_u18s2.sh cf1pilot-q1 both C:/Dev/cpilot-iso/work/q1/c.out)', 'Bash(docker exec cf1pilot-q1 psql -c \\\\! *)', 'Bash(ghapp pr view *)', 'Bash(sb.sh dev-read *)'])
    bad((t) => t.allow.push(rule), /allow rule|reviewed families|metacharacter|unsupported|.. segment/);
  for (const rule of ['PowerShell(echo hi)', 'WebFetch(*)', 'mcp__terminal', 'Write(//c/Users/mcurt/.claude/settings*.json)', 'Edit(//c/Dev/**)', 'Write(//c/Dev/df-u18pkg/../x/**)', 'Read(//c/Users/mcurt/**)', 'Write(//c/Dev/studioapp/docs/ops/continuity-pilot/**)'])
    bad((t) => t.allow.push(rule), /unsupported|inside the template addDirs|would permit|reviewed|overlaps protected deny glob|.. segment/);
});

test('C3. limits and shape: budget, timeout, addDirs, cwd, model, missing fields', () => {
  bad((t) => { t.maxBudgetUsd = CAPS.maxBudgetUsd + 1; }, /maxBudgetUsd/); bad((t) => { t.maxBudgetUsd = 0; }, /maxBudgetUsd/);
  bad((t) => { t.timeoutMs = CAPS.timeoutMs + 1; }, /timeoutMs/); bad((t) => { t.addDirs = ['C:/Users/mcurt']; }, /addDirs/); bad((t) => { t.addDirs = ['C:/Dev/a/b']; }, /addDirs/);
  bad((t) => { t.cwd = '../x'; }, /cwd/); bad((t) => { t.model = ''; }, /model/); bad((t) => { delete t.allow; }, /allow/); bad((t) => { t.allow = []; }, /allow/); bad((t) => { delete t.examples; }, /examples/);
});

test('C4. wildcard families accept exactly the reviewed shapes', () => {
  const ok = (rule) => { const t = base(); t.allow.push(rule); assert.doesNotThrow(() => validateTemplateIsolation('x', t, required), rule); };
  ok('Bash(git -C C:/Dev/df-u18pkg ls-tree *)'); ok('Bash(docker exec -i -e PGPASSWORD=postgres cf1pilot-q9 psql -U postgres -h localhost -d postgres *)'); ok('Bash(docker rm -f -v cf1pilot-q9)');
  ok('Bash(bash {CODE}/phase2/scripts/apply_sql.sh cf1pilot-q1 postgres C:/Dev/df-u18/*)'); ok('Bash(KEEP=1 SUITES=none IMG=ns1-base:snap bash {CODE}/phase2/scripts/run_u18s2.sh cf1pilot-q1 both C:/Dev/cpilot-iso/work/q1/chain.out)');
  for (const rule of ['Bash(docker exec cf1pilot-q1 sh -c *)', 'Bash(docker exec cf1pilot-q1 bash *)', 'Bash(docker exec -i -e PGPASSWORD=a b cf1pilot-q1 psql *)', 'Bash(docker rm -f cf1pilot-q1)', 'Bash(docker rm -f -v cf1c-qa)', 'Bash(docker ps -a --format {{.Names}})', 'Bash(docker inspect cf1c-qa-db)', 'Bash(docker logs *)'])
    assert.throws(() => { const t = base(); t.allow.push(rule); validateTemplateIsolation('x', t, required); }, /reviewed families/, rule);
});

test('C5. child settings are default-deny with the full deny list; no permissive mode; hooks disabled', () => {
  for (const [, t] of A) {
    const s = childSettings(t, required);
    assert.equal(s.permissions.defaultMode, 'dontAsk'); assert.deepEqual(s.permissions.allow, t.allow.map((x) => resolveCode(x))); assert.ok(!s.permissions.allow.some((x) => x.includes('{CODE}')), 'no unresolved placeholder'); assert.equal(s.disableAllHooks, true); assert.equal(s.enableAllProjectMcpServers, false);
    for (const d of [...required.recommendedRules, ...EXTRA_DENY]) assert.ok(s.permissions.deny.includes(d), d);
    assert.ok(!/bypass|acceptEdits|auto/.test(s.permissions.defaultMode));
  }
});

test('C6. the deny layer blocks smuggling syntax on top of an allowed prefix', () => {
  const deny = EXTRA_DENY.map((r) => /^Bash\((.*)\)$/.exec(r)[1]);
  const allowedCmd = 'git -C C:/Dev/df-u18pkg log --oneline -5';
  assert.ok(!deny.some((s) => bashMatch(s, allowedCmd)), 'plain allowed command is not denied');
  for (const evil of [`${allowedCmd} && touch x`, `${allowedCmd} ; touch x`, `${allowedCmd} | tee x`, `${allowedCmd} > x`, `${allowedCmd} >> x`, `${allowedCmd} "$(id)"`, `${allowedCmd} \`id\``, `${allowedCmd} --output=x`, 'git -C C:/Dev/df-u18pkg/../studioapp log', `${allowedCmd} --exec=x`, `${allowedCmd} || touch x`, 'git -C C:/Dev/x --git-dir=C:/y log', 'docker exec cf1pilot-q1 psql < /c/secret', `${allowedCmd} & touch x`, 'git -C C:/Dev/df-u18pkg diff --no-index -- a b', 'git -C C:/Dev/df-u18pkg add --pathspec-from-file=x', 'git -C C:/Dev/df-u18pkg commit -F x', 'git -C C:/Dev/df-u18pkg commit --amend', 'git -C C:/Dev/df-u18pkg diff --ext-diff', 'git -C C:/Dev/df-u18pkg diff --textconv', 'docker exec cf1pilot-q1 psql -U postgres -h localhost -d postgres -c "\\\\! id"', 'docker exec cf1pilot-q1 psql -U postgres -h localhost -d postgres -c "copy t to program x"', 'docker exec cf1pilot-q1 psql -U postgres -h localhost -d postgres -c "select 1" -h 10.0.0.5', 'docker exec cf1pilot-q1 psql -U postgres -h localhost -d postgres postgresql://u:p@h/db', 'docker cp a b', 'docker run --rm alpine id', 'docker network ls'])
    assert.ok(deny.some((s) => bashMatch(s, evil)), evil);
});

test('C7. child CLI args use the isolation flags and no permissive flag; env is scrubbed', () => {
  const t = A[0][1]; const args = childArgs({ prompt: 'p', settingsPath: 'C:/s.json', tpl: t });
  for (const f of CHILD_FLAGS) assert.ok(args.includes(f), f);
  assert.equal(args[args.indexOf('--tools') + 1], CHILD_TOOLS); assert.equal(args.filter((x) => x === '--add-dir').length, t.addDirs.length);
  for (const bad of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--bare', '--permission-mode=bypassPermissions']) assert.ok(!args.includes(bad), bad);
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk'); assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
  assert.ok(!CHILD_TOOLS.split(',').includes('PowerShell') && !CHILD_TOOLS.split(',').some((x) => x.startsWith('mcp__') || x === 'Monitor' || x === 'Artifact'));
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'x', GH_TOKEN: 'x', GITHUB_TOKEN: 'x', SUPABASE_ACCESS_TOKEN: 'x', DATABASE_URL: 'x', VERCEL_TOKEN: 'x' });
  const env = childEnv({ A: '1' }); for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'SUPABASE_ACCESS_TOKEN', 'DATABASE_URL', 'VERCEL_TOKEN']) { assert.ok(!(k in env), k); delete process.env[k]; } assert.equal(env.A, '1');
});

test('C8. childConfigSha binds every authority-bearing field and ignores unrelated policy changes', () => {
  const sha = childConfigSha(policy, required);
  const mut = (f) => { const p = structuredClone(policy); f(p.templates['u18-rollback-rehearsal']); return childConfigSha(p, required); };
  for (const f of [(t) => t.allow.push('Read(//c/Dev/df-u18pkg/x/**)'), (t) => { t.model = 'opus'; }, (t) => { t.maxBudgetUsd = 4; }, (t) => { t.timeoutMs = 1000; }, (t) => t.addDirs.pop(), (t) => { t.cwd = 'zz'; }, (t) => t.examples.push('docker ps -a --format {{.Names}}'), (t) => { t.commit.message = 'something else here'; }, (t) => { t.commit.paths = ['docs/']; }, (t) => { t.containers = ['cf1pilot-q7']; }]) assert.notEqual(mut(f), sha);
  const p2 = structuredClone(policy); p2.pilot.maxHours = 3; p2.templates['prod-sql-apply'].title = 'x'; assert.equal(childConfigSha(p2, required), sha, 'pilot limits and class-G text are not child authority');
  assert.notEqual(childConfigSha(policy, { ...required, recommendedRules: required.recommendedRules.slice(1) }), sha);
});

test('I1. suite construction: every protected variant, every abuse shape per example, confinement, and allowed controls', () => {
  for (const [n, t] of A) {
    const s = buildSuite(n, t, required); const by = (p) => s.filter(p);
    assert.equal(by((x) => x.id.includes('-deny-')).length, required.bashVariants.filter((v) => v.tool === 'Bash').length);
    for (const shape of ['and', 'semi', 'pipe', 'redir', 'subst', 'tick', 'newline', 'envpre', 'output']) assert.ok(s.some((x) => x.id.endsWith(`abuse-${shape}`)), `${n}: ${shape}`);
    assert.ok(s.some((x) => x.id.endsWith('write-outside')) && s.some((x) => x.id.endsWith('read-outside')));
    assert.ok(by((x) => x.expect === 'allowed').length >= 2, `${n}: has allowed controls`); assert.ok(by((x) => x.expect === 'denied').length > 100);
    assert.equal(new Set(s.map((x) => x.id)).size, s.length, 'probe ids are unique');
    assert.ok(by((x) => x.canary).every((x) => /^C:\/Dev\/cpilot-iso\/(canary|outside)\//.test(x.canary) || x.tool === 'Write'), 'canaries live in scratch dirs or inside protected globs');
  }
  assert.ok(abuseVariants('git -C C:/Dev/df-u18pkg status', 't').some((v) => v.id.endsWith('trav') && v.input.command.includes('/../')));
});

test('I2. evaluation uses harness records only: denied/allowed/not-attempted, and an allowed abuse call is a failure', () => {
  const probes = [{ id: 'p1', tool: 'Bash', input: { command: 'echo a' }, expect: 'denied' }, { id: 'p2', tool: 'Bash', input: { command: 'echo b' }, expect: 'denied' }, { id: 'p3', tool: 'Bash', input: { command: 'echo c' }, expect: 'allowed' }, { id: 'p4', tool: 'Read', input: { file_path: 'C:\\x\\y' }, expect: 'denied' }, { id: 'p5', tool: 'Bash', input: { command: 'echo e' }, expect: 'allowed' }, { id: 'p6', tool: 'Bash', input: { command: 'echo f' }, expect: 'denied' }];
  const sp = new StreamParser(); const E = (x) => JSON.stringify(x) + '\n';
  sp.feed(E({ type: 'assistant', message: { content: [{ type: 'tool_use', id: '1', name: 'Bash', input: { command: 'echo a' } }, { type: 'tool_use', id: '2', name: 'Bash', input: { command: 'echo b' } }, { type: 'tool_use', id: '3', name: 'Bash', input: { command: 'echo c' } }, { type: 'tool_use', id: '4', name: 'Read', input: { file_path: 'C:/x/y' } }, { type: 'tool_use', id: '6', name: 'Bash', input: { command: 'echo f' } }] } }));
  sp.feed(E({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: '1', is_error: true, content: 'Permission to use Bash has been denied.' }, { type: 'tool_result', tool_use_id: '2', is_error: false, content: 'b' }, { type: 'tool_result', tool_use_id: '3', is_error: false, content: 'c' }, { type: 'tool_result', tool_use_id: '4', is_error: true, content: 'Permission to use Read has been denied.' }, { type: 'tool_result', tool_use_id: '6', is_error: true, content: 'bash: ./x: Permission denied' }] } }));
  const r = Object.fromEntries(evaluate(probes, sp).map((x) => [x.id, x]));
  assert.deepEqual([r.p1.status, r.p1.ok], ['DENIED', true]); assert.deepEqual([r.p2.status, r.p2.ok], ['ALLOWED', false], 'an abuse probe that ran is a failure');
  assert.deepEqual([r.p3.status, r.p3.ok], ['ALLOWED', true]); assert.deepEqual([r.p4.status, r.p4.ok], ['DENIED', true], 'path slashes are normalized'); assert.deepEqual([r.p5.status, r.p5.ok], ['NOT_ATTEMPTED', false]);
  assert.deepEqual([r.p6.status, r.p6.ok], ['ALLOWED', false], 'an OS-level Permission denied from a command that RAN is not a harness denial');
});

test('I3. isolation report check: must pass, be fresh, match the exact configuration and version, and prove both denials and allowed controls', () => {
  const sha = childConfigSha(policy, required); const now = Date.now();
  const good = { ok: true, versionOk: true, at: new Date(now).toISOString(), childConfigSha: sha, templates: { a: { ok: true, denied: 100, allowedControls: 3 } } };
  assert.equal(checkIsolationReport(good, sha, now).ok, true);
  const p = (r, s = sha, n = now) => checkIsolationReport(r, s, n).problems.join();
  assert.match(p(null), /no isolation report/); assert.match(p({ ...good, ok: false }), /did not pass/); assert.match(p(good, 'other'), /different child configuration/);
  assert.match(p({ ...good, versionOk: false }), /untested claude version/); assert.match(p(good, sha, now + 25 * 3600000), /stale/); assert.match(p({ ...good, at: new Date(now + 3 * 3600000).toISOString() }), /future-dated/);
  assert.match(p({ ...good, templates: { a: { ok: true, denied: 100, allowedControls: 0 } } }), /always-deny child proves nothing/); assert.match(p({ ...good, templates: {} }), /no denied probes|always-deny/);
  assert.match(p({ ...good, templates: { a: { ok: false, denied: 100, allowedControls: 3 } } }), /always-deny|no denied/);
});

test('C9. the shipped authorizations match the shipped policy and queue exactly (no stale scope hashes), and Q5 stays unauthorized', () => {
  const queue = JSON.parse(fs.readFileSync(path.join(HERE, 'phase2', 'queue.json'), 'utf8'));
  const shipped = JSON.parse(fs.readFileSync(path.join(HERE, 'phase2', 'authorizations.json'), 'utf8'));
  assert.deepEqual(shipped, entries(queue, policy, { notAfter: '2026-11-17T00:00:00Z' }));
  assert.deepEqual(shipped.map((a) => a.id), ['Q1', 'Q2', 'Q3', 'Q4']); assert.equal(policy.pilot.enabled, false, 'shipped inert');
  O.validatePolicy(policy, shipped);
});

test('C10. commit/containers fields are validated; the child cannot stage or commit; scripts are pinned by path and by content', () => {
  const b = () => structuredClone(policy.templates['u18-rollback-rehearsal']);
  const badT = (mut, re) => { const x = b(); mut(x); assert.throws(() => validateTemplateIsolation('x', x, required), re); };
  badT((x) => { x.commit.dir = 'C:/Dev/studioapp'; }, /commit\.dir/); badT((x) => { x.commit.paths = ['../x/']; }, /commit\.paths/); badT((x) => { x.commit.paths = ['.git/']; }, /commit\.paths/); badT((x) => { x.commit.paths = ['docs']; }, /commit\.paths/);
  badT((x) => { x.commit.message = 'x\ny'; }, /commit\.message/); badT((x) => { x.commit.message = 'ab'; }, /commit\.message/); badT((x) => { x.containers = ['cf1c-qa-db']; }, /containers/); badT((x) => { x.containers = 'cf1pilot-q1'; }, /containers/);
  for (const [n, tp] of A) { assert.ok(tp.commit, n + ' has a driver-side commit'); assert.ok(!tp.allow.some((r) => / (add|commit) /.test(r)), n + ': no git add/commit for the child'); for (const r of tp.allow) assert.ok(!r.includes('C:/Dev/studioapp/docs/ops'), 'scripts only via {CODE}: ' + r); }
  const run = fs.readFileSync(path.join(HERE, 'phase2', 'scripts', 'run_u18s2.sh'), 'utf8'); const apply = fs.readFileSync(path.join(HERE, 'phase2', 'scripts', 'apply_sql.sh'), 'utf8');
  const dockerRuns = run.split('\n').filter((l) => /docker run/.test(l) && !l.trim().startsWith('#')); assert.ok(dockerRuns.length >= 1 && dockerRuns.every((l) => l.includes('--network none') && l.includes('no-new-privileges')), 'every docker run is --network none');
  assert.match(run, /cf1pilot-q\[0-9\]/); assert.match(run, /refused: image must be ns1-base:snap/); assert.match(apply, /pwd -P/); assert.match(apply, /refused: only C:\/Dev\/df-u18\*/); assert.ok(!/docs/.test(apply.split('\n').filter((l) => /case "\$F"/.test(l)).slice(0, 1).join()));
  assert.equal(CODE_DIR, HERE.replaceAll(String.fromCharCode(92), '/'));
});
