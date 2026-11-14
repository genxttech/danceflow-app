import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as O from './orchestrator.mjs';
import { entries } from './owner-tool.mjs';
import { loadProtected } from './protected-source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORCH = path.join(HERE, 'orchestrator.mjs');
const TCLI = path.join(HERE, 'test-cli.mjs');
const G = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const PILOT = { enabled: true, coordinator: 'W', not_before: '2000-01-01T00:00:00Z', not_after: '2099-01-01T00:00:00Z', maxHours: 4, maxWakeups: 12, maxClaims: 100, maxCalls: 1000, claimTtlMs: 600000, maxAttempts: 2 };
const TPL = {
  work: { class: 'A', title: 'fictional work', cmd: 'echo {n}', params: { n: '^[0-9]+$' }, action: { type: 'work', ms: 30 }, done: 'x' },
  slow: { class: 'A', title: 'slow', cmd: 'echo', action: { type: 'work', ms: 700 } },
  wtA: { class: 'A', title: 'wtA', cmd: 'echo', worktree: 'wtA', action: { type: 'work', ms: 700 } },
  slot1: { class: 'A', title: 'slot1', cmd: 'echo', dbslot: 'slot1', action: { type: 'work', ms: 700 } },
  free: { class: 'A', title: 'free', cmd: 'echo', worktree: 'wtB', dbslot: 'slot2', action: { type: 'work', ms: 700 } },
  prod: { class: 'G', title: 'prod sql', cmd: 'sb.sh prod-apply x.sql' },
  hang1: { class: 'A', title: 'hang once', cmd: 'echo', action: { type: 'hang', onlyAttempt: 1 } },
  ghwf: { class: 'A', title: 'touches workflow', cmd: 'echo', touches: ['.github/workflows/ci.yml'], action: { type: 'work', ms: 20 } },
  failing: { class: 'A', title: 'always fails', cmd: 'echo', action: { type: 'fail' } },
  badact: { class: 'A', title: 'bad action', cmd: 'echo', action: { type: 'shell', cmd: 'rm -rf /' } },
};

// A world = bare "origin" (the protected remote) + a queue sandbox. publish() is what an owner merge does.
function world(items, { templates = TPL, pilot = {}, authIds = 'all', ownerDone } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cpilot-'));
  const origin = path.join(base, 'origin.git'); const clone = path.join(base, 'clone'); const root = path.join(base, 'root');
  G(base, 'init', '--bare', '--quiet', '-b', 'main', origin); G(base, 'clone', '--quiet', origin, clone); G(clone, 'checkout', '-q', '-b', 'main');
  O.init(root);
  const qi = items.map((i) => ({ state: 'PENDING', ...i }));
  fs.writeFileSync(path.join(root, 'queue.json'), JSON.stringify({ meta: {}, items: qi }));
  const w = { base, origin, clone, root, source: { url: origin, ref: 'main', policyPath: 'p/policy.json', authPath: 'p/authorizations.json', allowFile: true, cacheMs: 20000 } };
  w.policy = { pilot: { ...PILOT, ...pilot }, templates, ...(ownerDone ? { owner_done: ownerDone } : {}) };
  w.publish = (policy, auths) => { fs.mkdirSync(path.join(clone, 'p'), { recursive: true }); fs.writeFileSync(path.join(clone, 'p/policy.json'), JSON.stringify(policy)); fs.writeFileSync(path.join(clone, 'p/authorizations.json'), typeof auths === 'string' ? auths : JSON.stringify(auths)); G(clone, 'add', '-A'); G(clone, 'commit', '-q', '-m', 'owner'); G(clone, 'push', '-q', 'origin', 'main'); };
  const ids = authIds === 'all' ? qi.map((i) => i.id) : authIds;
  w.publish(w.policy, entries({ items: qi }, w.policy, { ids }));
  w.opts = (o = {}) => ({ worker: 'W', source: w.source, ...o });
  w.cli = (...a) => ['--root', root, '--worker', 'W', ...a];
  w.env = { ...process.env, PILOT_TEST_SOURCE: JSON.stringify({ ...w.source, cacheMs: 0 }) };
  return w;
}
const q = (w) => JSON.parse(fs.readFileSync(path.join(w.root, 'queue.json'), 'utf8')).items;
const setQ = (w, items, meta) => { const cur = JSON.parse(fs.readFileSync(path.join(w.root, 'queue.json'), 'utf8')); fs.writeFileSync(path.join(w.root, 'queue.json'), JSON.stringify({ meta: meta ?? cur.meta, items })); };
const st = (w, id) => q(w).find((i) => i.id === id).state;
const execs = (w) => fs.readFileSync(path.join(w.root, 'sandbox', 'executions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const noExecs = (w) => !fs.existsSync(path.join(w.root, 'sandbox', 'executions.jsonl'));
const spawnRun = (w, extra = []) => new Promise((res) => { const c = spawn('node', [TCLI, 'run', ...w.cli('--wait', ...extra)], { env: w.env }); let o = ''; c.stdout.on('data', (d) => (o += d)); c.on('close', () => res(o)); });
const it = (id, template, extra = {}) => ({ id, template, params: template === 'work' ? { n: '1' } : {}, ...extra });
const claimOf = (w, o) => O.claim(w.root, w.opts(o));

// ---------- basic flow ----------
test('A1. completed task advances to next authorized task with no prompts', async () => {
  const w = world([it('A1', 'work'), it('A2', 'work', { deps: ['A1'] }), it('A3', 'work', { deps: ['A2'] })]);
  const out = await O.run(w.root, w.opts()); assert.deepEqual(out.ran, ['A1', 'A2', 'A3']); assert.equal(out.final.status, 'IDLE');
});
test('A2. owner-gated task parks itself; independent work continues; dependents wait', async () => {
  const w = world([it('G1', 'prod'), it('D1', 'work'), it('AFTERG', 'work', { deps: ['G1'] }), it('D2', 'work', { deps: ['D1'] })]);
  const out = await O.run(w.root, w.opts());
  assert.deepEqual(out.ran, ['D1', 'D2']); assert.equal(st(w, 'G1'), 'BLOCKED-OWNER'); assert.equal(st(w, 'AFTERG'), 'PENDING'); assert.deepEqual(out.final.blocked.map((b) => b.id), ['G1']);
});
test('A3. protected paths: work finishes, merge parks BLOCKED-OWNER, dependents wait', async () => {
  const w = world([it('M1', 'ghwf'), it('M2', 'work', { deps: ['M1'] })]);
  assert.deepEqual((await O.run(w.root, w.opts())).ran, ['M1']); assert.equal(st(w, 'M1'), 'BLOCKED-OWNER'); assert.equal(st(w, 'M2'), 'PENDING');
});

// ---------- tamper resistance (review: P1/P2 regressions) ----------
test('T1. local queue edits (class/cmd/authorized fields) cannot unlock a gated task', async () => {
  const w = world([it('P1', 'prod'), it('OK', 'work')], { authIds: ['OK'] });
  const items = q(w); Object.assign(items[0], { class: 'A', cmd: 'echo harmless', authorized: true, action: { type: 'work', ms: 1 } }); setQ(w, items);
  assert.deepEqual((await O.run(w.root, w.opts())).ran, ['OK']); assert.equal(st(w, 'P1'), 'BLOCKED-OWNER');
});
test('T2. re-pointing an authorized item to another template, or editing params/deps, voids authorization', async () => {
  const w = world([it('R1', 'work')]); const items = q(w); items[0].template = 'slow'; delete items[0].params; setQ(w, items);
  const o1 = await O.run(w.root, w.opts()); assert.deepEqual(o1.ran, []); assert.equal(o1.final.status, 'IDLE'); assert.ok(noExecs(w));
  const w2 = world([it('R2', 'work')]); const i2 = q(w2); i2[0].params = { n: '2' }; setQ(w2, i2);
  assert.deepEqual((await O.run(w2.root, w2.opts())).ran, []);
  const w3 = world([it('R3', 'work')]); const i3 = q(w3); i3[0].deps = ['X']; setQ(w3, i3); assert.deepEqual((await O.run(w3.root, w3.opts())).ran, []);
});
test('T3. forged items and local authorizations/policy files are ignored', async () => {
  const w = world([it('A1', 'work')], { authIds: [] }); const items = q(w); items.push(it('NEW', 'work')); setQ(w, items);
  fs.writeFileSync(path.join(w.root, 'authorizations.json'), JSON.stringify([{ id: 'A1', scope_sha: 'x', by: 'owner' }])); fs.writeFileSync(path.join(w.root, 'policy.json'), '{}');
  const o3 = await O.run(w.root, w.opts()); assert.deepEqual(o3.ran, []); assert.equal(o3.final.status, 'IDLE'); assert.ok(noExecs(w));
});
test('T4. unpushed local commits in a working clone do not count', async () => {
  const w = world([it('A1', 'work')], { authIds: [] });
  fs.writeFileSync(path.join(w.clone, 'p/authorizations.json'), JSON.stringify(entries({ items: q(w) }, w.policy))); G(w.clone, 'add', '-A'); G(w.clone, 'commit', '-q', '-m', 'forged, not pushed');
  const o4 = await O.run(w.root, w.opts()); assert.deepEqual(o4.ran, []); assert.equal(o4.final.status, 'IDLE');
});
test('T5. class-G (PROD SQL) never claimable, even if the protected auth lists it with a hash for a lying policy', async () => {
  const w = world([it('SQL', 'prod')]);
  w.publish(w.policy, entries({ items: q(w) }, { ...w.policy, templates: { prod: { ...TPL.prod, class: 'A' } } }));
  assert.deepEqual((await O.run(w.root, w.opts())).ran, []); assert.equal(st(w, 'SQL'), 'BLOCKED-OWNER'); assert.notEqual(claimOf(w).status, 'CLAIMED'); assert.ok(noExecs(w));
});
test('T6. P1-2: duplicate ids HALT (cannot smuggle a gated command under an authorized id)', async () => {
  const w = world([it('X', 'work')]); setQ(w, [...q(w), { id: 'X', template: 'prod', params: {}, state: 'DONE' }]);
  const r = claimOf(w); assert.equal(r.status, 'HALT'); assert.match(r.reason, /unique/);
  const w2 = world([it('Y', 'work')]); setQ(w2, [...q(w2), { ...q(w2)[0] }]); assert.equal(claimOf(w2).status, 'HALT'); // RUNNING+PENDING copy
});
test('T7. P1-1: no caller-controlled trust anchor: CLI source flags are ignored, ext:: and non-https blocked, no PWNED file', async () => {
  const w = world([it('A1', 'work')], { authIds: [] });
  const pwn = path.join(w.base, 'PWNED.txt');
  const evilUrl = `ext::node -e "require('fs').writeFileSync(String.raw\`${pwn}\`,'x')"`;
  assert.throws(() => loadProtected({ url: evilUrl, ref: 'main', policyPath: 'p/policy.json', authPath: 'p/authorizations.json' }), /https/);
  assert.throws(() => loadProtected({ url: evilUrl, ref: 'main', policyPath: 'p/policy.json', authPath: 'p/authorizations.json', allowFile: true }));
  assert.equal(fs.existsSync(pwn), false);
  const src = fs.readFileSync(ORCH, 'utf8'); for (const bad of ['source-url', 'git-config', 'process.env', 'cache-ms', '--ttl', 'policy-path']) assert.equal(src.includes(bad), false, bad);
  const r = spawnSync('node', [TCLI, 'claim', ...w.cli('--source-url', evilUrl, '--source-ref', 'agent/x', '--git-config', 'protocol.ext.allow=always')], { env: w.env, encoding: 'utf8' });
  assert.equal(JSON.parse(r.stdout).status, 'IDLE', r.stdout + r.stderr); assert.equal(fs.existsSync(pwn), false);
});
test('T8. P1-3: no persistent cache; git env/config/replace/insteadOf cannot redirect the source', async () => {
  const evil = world([it('A1', 'work')]); // evil remote DOES authorize A1
  const w = world([it('A1', 'work')], { authIds: [] });
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${evil.origin}.insteadOf`, GIT_CONFIG_VALUE_0: w.origin });
    w.source.cacheMs = 0; assert.notEqual(claimOf(w).status, 'CLAIMED');
  } finally { for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) delete process.env[k]; Object.assign(process.env, saved); }
  fs.mkdirSync(path.join(w.root, 'protected-cache')); // pre-seeded junk dir must be irrelevant
  assert.equal(fs.existsSync(path.join(w.root, 'mutex')), false); assert.notEqual(claimOf(w).status, 'CLAIMED');
});
test('T9. policy self-check: protected cmd in class A, unanchored regex, bad dates/limits, non-array auths all HALT', async () => {
  const cases = [
    [{ templates: { ...TPL, evil: { class: 'A', title: 's', cmd: 'sb.sh prod-apply a.sql' } } }, /protected command/], [{ templates: { ...TPL, evil: { class: 'A', title: 's', cmd: 'sb.sh prod_apply a.sql' } } }, /protected command/],
    [{ templates: { ...TPL, loose: { class: 'A', title: 's', cmd: 'echo {n}', params: { n: '[0-9]+' } } } }, /anchored/],
    [{ pilot: { not_before: 'tomorrow', not_after: 'later' } }, /window invalid/], [{ pilot: { maxHours: undefined } }, /maxHours/], [{ pilot: { maxCalls: 0 } }, /maxCalls/], [{ pilot: { claimTtlMs: 'x' } }, /claimTtlMs/],
  ];
  for (const [c, re] of cases) { const w = world([it('E1', 'work')], c); const r = claimOf(w); assert.equal(r.status, 'HALT', JSON.stringify(c).slice(0, 80)); assert.match(r.reason, re); assert.ok(noExecs(w)); }
  const w = world([it('E1', 'work')]); w.publish(w.policy, '{"not":"array"}'); w.source.cacheMs = 0; const rr = claimOf(w); assert.equal(rr.status, 'HALT'); assert.match(rr.reason, /authorizations malformed/);
});
test('T10. every protected command pattern refused at policy level', () => {
  for (const cmd of ['sb.sh dev-apply a.sql', 'ghapp pr merge 5', 'gh api repos/x/pulls/1/merge', 'vercel promote x', 'git push --force', 'git push origin +main', 'stripe live charge', 'psql -c "DROP TABLE x"', 'psql -c "delete from t"', 'supabase db push', 'edit settings.json', 'echo $API_KEY'])
    assert.throws(() => O.validatePolicy({ pilot: PILOT, templates: { t: { class: 'A', cmd } } }, []), /protected command/, cmd);
});
test('T11. params: regex enforced, unexpected/inherited names refused', async () => {
  const w = world([{ id: 'B1', template: 'work', params: { n: '1; rm -rf /' } }, { id: 'B2', template: 'work', params: { n: '1', extra: 'x' } }, { id: 'B3', template: 'work', params: { n: '1', constructor: 'x' } }]);
  assert.deepEqual((await O.run(w.root, w.opts())).ran, []); for (const id of ['B1', 'B2', 'B3']) assert.equal(st(w, id), 'BLOCKED-OWNER');
});
test('T12. fail-closed: unreachable source, wrong worker, closed window, remote disable all HALT', async () => {
  const w = world([it('A1', 'work')]);
  const un = O.claim(w.root, { worker: 'W', source: { ...w.source, url: path.join(w.base, 'nope.git'), cacheMs: 0 } }); assert.equal(un.status, 'HALT'); assert.match(un.reason, /unavailable/); assert.notEqual(claimOf(w).status, 'HALT', 'control: the real source works');
  assert.match(claimOf(w, { worker: 'OTHER' }).reason, /not the authorized coordinator/); assert.match(claimOf(w, { now: Date.parse('2100-01-01') }).reason, /window/);
  w.source.cacheMs = 0; w.publish({ ...w.policy, pilot: { ...w.policy.pilot, enabled: false } }, entries({ items: q(w) }, w.policy));
  const r = claimOf(w); assert.equal(r.status, 'HALT'); assert.match(r.reason, /disabled/); assert.ok(noExecs(w));
});
test('T13. limits: maxClaims, maxCalls, maxWakeups (only with --wake), maxHours halt; startedAt always persisted', async () => {
  const w = world([it('A1', 'work'), it('A2', 'work'), it('A3', 'work')], { pilot: { maxClaims: 2 } });
  const out = await O.run(w.root, w.opts()); assert.deepEqual(out.ran, ['A1', 'A2']); assert.match(out.final.reason, /maxClaims/);
  const w1 = world([it('A1', 'work')], { pilot: { maxCalls: 2 } }); claimOf(w1); claimOf(w1); assert.match(claimOf(w1).reason, /maxCalls/);
  const w2 = world([it('A1', 'work')], { pilot: { maxWakeups: 2 } }); for (let n = 0; n < 2; n++) assert.notEqual(claimOf(w2, { wake: true }).status, 'HALT');
  assert.match(claimOf(w2, { wake: true }).reason, /maxWakeups/);
  const w3 = world([it('P1', 'prod')]); claimOf(w3, { now: Date.now() }); assert.ok(JSON.parse(fs.readFileSync(path.join(w3.root, 'queue.json'))).meta.startedAt, 'startedAt persisted even on a no-op claim');
  assert.match(claimOf(w3, { now: Date.now() + 5 * 3600000 }).reason, /maxHours/);
});
test('T14. per-authorization expiry honored', async () => {
  const w = world([it('A1', 'work')], { authIds: [] }); w.publish(w.policy, entries({ items: q(w) }, w.policy, { notAfter: '2020-01-01T00:00:00Z' }));
  assert.deepEqual((await O.run(w.root, w.opts())).ran, []);
});
test('T15. P2-1: locally forged OWNER-DONE/DONE on a gated item does not release dependents; protected owner_done does', async () => {
  const w = world([it('G1', 'prod'), it('AFTER', 'work', { deps: ['G1'] })]); claimOf(w);
  const items = q(w); items[0].state = 'OWNER-DONE'; setQ(w, items); assert.deepEqual((await O.run(w.root, w.opts())).ran, []);
  items[0].state = 'DONE'; setQ(w, items); assert.deepEqual((await O.run(w.root, w.opts())).ran, []);
  const w2 = world([it('G1', 'prod'), it('AFTER', 'work', { deps: ['G1'] })], { ownerDone: ['G1'] }); assert.deepEqual((await O.run(w2.root, w2.opts())).ran, ['AFTER']);
});
test('T16. P2-4: replay: resetting a DONE item to PENDING (and meta) does not re-run it', async () => {
  const w = world([it('A1', 'work')]); assert.deepEqual((await O.run(w.root, w.opts())).ran, ['A1']);
  const items = q(w); items[0].state = 'PENDING'; items[0].attempts = 0; setQ(w, items, {});
  assert.deepEqual((await O.run(w.root, w.opts())).ran, []); assert.equal(st(w, 'A1'), 'DONE'); assert.equal(execs(w).filter((e) => e.phase === 'begin').length, 1);
});
test('T17. P2-5: editing the item during a run, or reporting protected changed paths, parks instead of DONE', async () => {
  const w = world([it('M', 'work'), it('N', 'work', { deps: ['M'] })]); const c = claimOf(w); const items = q(w); items[0].template = 'slow'; setQ(w, items);
  assert.equal(O.complete(w.root, c.item, {}, w.source), 'NEEDS-REVIEW'); assert.equal(st(w, 'N'), 'PENDING');
  const w2 = world([it('M', 'work')]); const c2 = claimOf(w2); assert.equal(O.complete(w2.root, c2.item, {}, w2.source, ['src/lib/supabase/migrations/x.sql']), 'BLOCKED-OWNER');
});
test('T18. P2-7: failures retry up to maxAttempts then NEEDS-REVIEW and are reported on IDLE', async () => {
  const w = world([it('F1', 'failing'), it('F2', 'work', { deps: ['F1'] })]); const out = await O.run(w.root, w.opts());
  assert.equal(st(w, 'F1'), 'NEEDS-REVIEW'); assert.equal(q(w)[0].attempts, 2); assert.deepEqual(out.final.stuck.map((s) => s.id), ['F1']); assert.equal(st(w, 'F2'), 'PENDING');
});
test('T19. P3: parked-by-gate items are re-evaluated when the protected policy changes', async () => {
  const w = world([it('P1', 'prod')]); claimOf(w); assert.equal(st(w, 'P1'), 'BLOCKED-OWNER');
  w.source.cacheMs = 0; const t = { ...TPL, prod: { class: 'A', title: 'now safe', cmd: 'echo', action: { type: 'work', ms: 1 } } };
  w.publish({ ...w.policy, templates: t }, entries({ items: q(w) }, { ...w.policy, templates: t })); assert.deepEqual((await O.run(w.root, w.opts())).ran, ['P1']);
});

// ---------- duplicate execution / resources / stop / recovery ----------
test('D1. no duplicate execution across 4 concurrent worker processes', async () => {
  const ids = Array.from({ length: 12 }, (_, n) => `T${n}`); const w = world(ids.map((id) => it(id, 'work')));
  await Promise.all([1, 2, 3, 4].map(() => spawnRun(w)));
  assert.deepEqual(execs(w).filter((e) => e.phase === 'begin').map((e) => e.id).sort(), [...ids].sort());
  assert.ok(ids.every((id) => st(w, id) === 'DONE')); assert.ok(new Set(execs(w).map((e) => e.pid)).size > 1);
});
test('D2. worktree and DB slot never overlap; independent resources run in parallel', async () => {
  const w = world([it('W1', 'wtA'), it('W2', 'wtA'), it('S1', 'slot1'), it('S2', 'slot1'), it('X1', 'free')]);
  await Promise.all([1, 2, 3].map(() => spawnRun(w)));
  const ev = execs(w); const span = (id) => [ev.find((e) => e.id === id && e.phase === 'begin').t, ev.find((e) => e.id === id && e.phase === 'end').t];
  const overlap = (a, b) => { const [a0, a1] = span(a), [b0, b1] = span(b); return a0 < b1 && b0 < a1; };
  assert.equal(overlap('W1', 'W2'), false); assert.equal(overlap('S1', 'S2'), false); assert.ok(overlap('W1', 'S1') || overlap('W1', 'X1') || overlap('S1', 'X1'));
});
test('S1. manual stop halts before the next task; resume continues', async () => {
  const w = world([it('S1', 'work'), it('S2', 'work')]); O.stop(w.root, 'owner');
  const a = await O.run(w.root, w.opts()); assert.deepEqual(a.ran, []); assert.equal(a.final.status, 'STOPPED'); assert.match(O.status(w.root), /STOPPED/);
  O.resume(w.root); assert.deepEqual((await O.run(w.root, w.opts())).ran, ['S1', 'S2']);
});
test('S2. stop mid-run lets in-flight finish and starts nothing new', async () => {
  const w = world([it('L1', 'slow'), it('L2', 'work')]); const p = spawnRun(w);
  for (let n = 0; n < 200 && st(w, 'L1') !== 'RUNNING'; n++) await new Promise((s) => setTimeout(s, 25));
  assert.equal(st(w, 'L1'), 'RUNNING'); O.stop(w.root); await p; assert.equal(st(w, 'L1'), 'DONE'); assert.equal(st(w, 'L2'), 'PENDING');
});
test('R1. hard-killed runner recovers once; zombie completion refused', async () => {
  const w = world([it('K1', 'hang1'), it('K2', 'work', { deps: ['K1'] })]);
  const child = spawn('node', [TCLI, 'run', ...w.cli('--wait')], { env: w.env });
  for (let n = 0; n < 200 && st(w, 'K1') !== 'RUNNING'; n++) await new Promise((s) => setTimeout(s, 50));
  assert.equal(st(w, 'K1'), 'RUNNING'); child.kill('SIGKILL'); await new Promise((s) => child.on('close', s));
  const out = await O.run(w.root, w.opts({ wait: true })); assert.deepEqual(out.ran, ['K1', 'K2']);
  assert.ok(O.readLog(w.root).some((x) => x.ev === 'INTERRUPTED_RECOVERED')); assert.equal(q(w).find((i) => i.id === 'K1').attempts, 2);
  assert.equal(execs(w).filter((x) => x.id === 'K1' && x.phase === 'end').length, 1);
  assert.equal(O.complete(w.root, { id: 'K1', runner: { token: 'stale' } }, {}, w.source), 'REFUSED');
});
test('R2. attempts exhausted parks NEEDS-REVIEW (no infinite retry)', async () => {
  const w = world([it('B1', 'work', { attempts: 2, state: 'RUNNING', runner: { pid: 999999, token: 'x', started: 1, hb: 1 } })]);
  assert.deepEqual((await O.run(w.root, w.opts())).ran, []); assert.equal(st(w, 'B1'), 'NEEDS-REVIEW');
});
test('R3. external claim/complete/heartbeat across processes; TTL comes from protected policy', () => {
  const w = world([it('E1', 'work'), it('E2', 'work', { deps: ['E1'] })], { pilot: { claimTtlMs: 60000 } });
  const cli = (...a) => spawnSync('node', [TCLI, ...a, ...w.cli()], { env: w.env, encoding: 'utf8' }).stdout.trim();
  const c = JSON.parse(cli('claim')); assert.equal(c.item.id, 'E1'); assert.equal(c.item.cmd, 'echo 1'); assert.equal(JSON.parse(cli('claim')).status, 'WAIT');
  assert.equal(cli('heartbeat', '--id', 'E1', '--token', c.item.runner.token), 'OK'); assert.equal(cli('heartbeat', '--id', 'E1', '--token', 'bad'), 'REFUSED');
  assert.equal(cli('complete', '--id', 'E1', '--token', c.item.runner.token), 'DONE'); assert.equal(JSON.parse(cli('claim')).item.id, 'E2');
  const items = q(w); items.find((i) => i.id === 'E2').runner.hb = Date.now() - 120000; setQ(w, items); // older than the policy TTL (60 s)
  const r = JSON.parse(cli('claim')); assert.equal(r.item.id, 'E2'); assert.equal(r.item.attempts, 2);
});
test('L1. visible execution log, status table, protected commit recorded', async () => {
  const w = world([it('V1', 'work'), it('V2', 'prod')]); await O.run(w.root, w.opts());
  const evs = O.readLog(w.root).map((e) => e.ev); for (const e of ['START', 'DONE', 'BLOCKED_OWNER']) assert.ok(evs.includes(e), e);
  assert.ok(O.readLog(w.root).find((e) => e.ev === 'START').commit);
  assert.match(spawnSync('node', [TCLI, 'status', ...w.cli()], { env: w.env, encoding: 'utf8' }).stdout, /V2\s+BLOCKED-OWNER/);
});
test('L2. unknown fictional action refused; no shell/session spawning outside protected-source.mjs (git only)', async () => {
  const w = world([it('U1', 'badact')]); await O.run(w.root, w.opts()); assert.notEqual(st(w, 'U1'), 'DONE');
  const src = fs.readFileSync(ORCH, 'utf8'); for (const bad of ['child_process', 'exec(', 'spawn(', 'fetch(', 'claude ', 'https://']) assert.equal(src.includes(bad), false, bad);
  const ps = fs.readFileSync(path.join(HERE, 'protected-source.mjs'), 'utf8');
  assert.deepEqual([...ps.matchAll(/execFileSync\(([^,]+),/g)].map((m) => m[1].trim()), ["'git'"]); for (const bad of ['spawn(', 'exec(', 'fetch(', 'claude ']) assert.equal(ps.includes(bad), false, bad);
});
