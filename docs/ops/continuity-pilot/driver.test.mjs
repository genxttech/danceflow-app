import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as O from './orchestrator.mjs';
import { runDriver, StreamParser, acquireDriverLock } from './driver.mjs';
import { world } from './test-world.mjs';
import { CHILD_TOOLS, EXTRA_DENY } from './child-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const __created = new Set(); const __orig = fs.mkdtempSync;
fs.mkdtempSync = (...a) => { const d = __orig(...a); __created.add(d); return d; };
after(() => { for (const d of __created) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

const FAKE = [process.execPath, path.join(HERE, 'fake-claude.mjs')];
const ev = {
  init: { type: 'system', subtype: 'init', tools: CHILD_TOOLS.split(','), mcp_servers: [], permissionMode: 'dontAsk', model: 'claude-haiku-5-5' },
  call: (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } }),
  res: (id, text, is_error = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content: text }] } }),
  done: (text = 'DONE: finished the task', extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.01, num_turns: 2, permission_denials: [], ...extra }),
};
const scenario = (w, s) => { const f = path.join(w.base, 'scenario.json'); fs.writeFileSync(f, JSON.stringify(s)); return { FAKE_SCENARIO: f }; };
const lines = (...xs) => ({ events: xs.map((line) => ({ line })) });
const st = (w, id) => JSON.parse(fs.readFileSync(path.join(w.root, 'queue.json'), 'utf8')).items.find((i) => i.id === id).state;
const drive = (w, env, o = {}) => runDriver(w.root, { worker: 'W', source: w.source, claudeCmd: FAKE, workRoot: w.workRoot, env, hbMs: 200, pollMs: 100, ...o });

test('S1. StreamParser: split chunks, init, tool calls, results, denials by text and by permission_denials; benign errors are not denials', () => {
  const p = new StreamParser(); const all = [ev.init, ev.call('a', 'Bash', { command: 'echo' }), ev.res('a', "Permission to use Bash with command echo has been denied.", true), ev.call('b', 'Read', { file_path: 'x' }), ev.res('b', 'File does not exist.', true), ev.call('c', 'Bash', { command: 'ls' }), ev.res('c', 'ok'), ev.done('DONE: x', { permission_denials: [{ tool_name: 'Write', tool_use_id: 'd', tool_input: { file_path: 'y' } }] })]
    .map((x) => JSON.stringify(x)).join('\n') + '\n';
  const fresh = []; for (let i = 0; i < all.length; i += 7) fresh.push(...p.feed(all.slice(i, i + 7)));
  assert.deepEqual(p.init.tools, CHILD_TOOLS.split(',')); assert.equal(p.calls.size, 3);
  assert.deepEqual(p.denials.map((d) => d.id).sort(), ['a', 'd']); assert.equal(p.denials.find((d) => d.id === 'b'), undefined, 'file-not-found is not a permission denial');
  assert.equal(fresh.length, 2); assert.match(p.result.result, /^DONE/);
});

test('D1. happy path: isolated child gets exactly the authorized authority, a scrubbed environment, and the item completes', { timeout: 120000 }, async () => {
  const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN, SUPABASE_ACCESS_TOKEN: process.env.SUPABASE_ACCESS_TOKEN };
  Object.assign(process.env, { GH_TOKEN: 'secret-gh', GITHUB_TOKEN: 'secret-gh2', SUPABASE_ACCESS_TOKEN: 'secret-sb' });
  try {
    const w = world([{ id: 'A1', template: 'work' }]);
    const env = scenario(w, { ...lines(ev.init, ev.call('t1', 'Bash', { command: 'git -C C:/Dev/df-iso-test status' }), ev.res('t1', 'clean'), ev.done()) });
    const r = await drive(w, env); assert.equal(r.status, 'IDLE', JSON.stringify(r)); assert.equal(st(w, 'A1'), 'DONE'); assert.equal(r.results[0].ok, true);
    const dump = JSON.parse(fs.readFileSync(path.join(w.workRoot, 'w', 'dump.json'), 'utf8')); const a = dump.args;
    for (const f of ['--restricted', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--verbose']) assert.ok(a.includes(f), f);
    const val = (flag) => a[a.indexOf(flag) + 1];
    assert.equal(val('--permission-mode'), 'dontAsk'); assert.equal(val('--permission-prompts'), 'none'); assert.equal(val('--tools'), CHILD_TOOLS);
    assert.equal(val('--output-format'), 'stream-json'); assert.equal(val('--model'), 'haiku'); assert.equal(val('--max-budget-usd'), '1'); assert.equal(val('--add-dir'), 'C:/Dev/df-iso-test');
    assert.ok(!a.includes('--dangerously-skip-permissions') && !a.includes('--allow-dangerously-skip-permissions') && !a.includes('--bare'));
    assert.equal(dump.settings.permissions.defaultMode, 'dontAsk'); assert.deepEqual(dump.settings.permissions.allow, w.policy.templates.work.allow);
    for (const d of ['Bash(*prod-apply*)', 'Bash(*git*push*)', 'Edit(//c/Users/mcurt/.claude/settings*.json)', 'mcp__terminal', ...EXTRA_DENY]) assert.ok(dump.settings.permissions.deny.includes(d), d);
    assert.equal(dump.settings.disableAllHooks, true);
    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'SUPABASE_ACCESS_TOKEN']) assert.ok(!dump.envKeys.includes(k), `${k} must not reach the child`);
    assert.ok(dump.cwd.startsWith(w.workRoot.replaceAll('\\', '/')) || dump.cwd.includes('work'), 'child runs in its scratch dir');
    assert.ok(O.readLog(w.root).some((e) => e.ev === 'CHILD_START') && O.readLog(w.root).some((e) => e.ev === 'CHILD_END' && e.ok));
  } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});

test('D2. any permission denial kills the child, fails the item and ends the run (no further items)', { timeout: 120000 }, async () => {
  const w = world([{ id: 'A1', template: 'work' }, { id: 'A2', template: 'work' }]);
  const env = scenario(w, { ...lines(ev.init, ev.call('t1', 'Bash', { command: 'sb.sh prod-apply x' }), ev.res('t1', 'Permission to use Bash has been denied.', true)), hangMs: 60000 });
  const t0 = Date.now(); const r = await drive(w, env); assert.ok(Date.now() - t0 < 30000, 'killed promptly, did not wait for the hang');
  assert.equal(r.status, 'STOPPED'); assert.match(r.reason, /permission denial: Bash/); assert.equal(st(w, 'A1'), 'FAILED'); assert.equal(st(w, 'A2'), 'PENDING');
  assert.equal(O.readLog(w.root).find((e) => e.ev === 'CHILD_END').denials[0].tool, 'Bash');
});

test('D3. denial reported only in the result record is still caught', { timeout: 120000 }, async () => {
  const w = world([{ id: 'A1', template: 'work' }]);
  const r = await drive(w, scenario(w, lines(ev.init, ev.call('t1', 'Write', { file_path: 'C:/x' }), ev.done('DONE: all fine', { permission_denials: [{ tool_name: 'Write', tool_use_id: 't1', tool_input: { file_path: 'C:/x' } }] }))));
  assert.equal(r.status, 'STOPPED'); assert.equal(st(w, 'A1'), 'FAILED'); assert.match(r.reason, /permission denial/);
});

test('D4. timeout kills the child and fails the item', { timeout: 120000 }, async () => {
  const t = { work: { ...world([]).policy.templates.work, timeoutMs: 600 } };
  const w = world([{ id: 'A1', template: 'work' }], { templates: t });
  const r = await drive(w, scenario(w, { ...lines(ev.init), hangMs: 60000 })); assert.equal(r.status, 'STOPPED'); assert.match(r.reason, /timeout/); assert.equal(st(w, 'A1'), 'FAILED');
});

test('D5. a STOP file stops the running child', { timeout: 120000 }, async () => {
  const w = world([{ id: 'A1', template: 'work' }]); const p = drive(w, scenario(w, { ...lines(ev.init), hangMs: 60000 }));
  for (let n = 0; n < 100 && st(w, 'A1') !== 'RUNNING'; n++) await new Promise((s) => setTimeout(s, 100));
  await new Promise((s) => setTimeout(s, 800)); O.stop(w.root, 'owner'); const r = await p;
  assert.equal(r.status, 'STOPPED'); assert.match(r.reason, /STOP file/); assert.equal(st(w, 'A1'), 'FAILED');
});

test('D6. child errors (not logged in, no DONE, non-zero exit) fail the item without being treated as success', { timeout: 120000 }, async () => {
  for (const [name, sc, re] of [['not logged in', lines(ev.init, { type: 'result', subtype: 'success', is_error: true, result: 'Not logged in', permission_denials: [] }), /child error: Not logged in/], ['no DONE', lines(ev.init, ev.done('I think it went fine')), /did not report DONE/], ['FAILED report', lines(ev.init, ev.done('FAILED: could not')), /did not report DONE/]]) {
    const w = world([{ id: 'A1', template: 'work' }]); const r = await drive(w, scenario(w, sc)); assert.equal(r.results[0].state, 'FAILED', name); assert.equal(r.results[0].ok, false); assert.match(r.results[0].reason, re, name); assert.notEqual(st(w, 'A1'), 'DONE', name);
  }
});

test('D7. untested claude version, held driver lock, and HALT from claim all refuse to run a child', { timeout: 120000 }, async () => {
  const w = world([{ id: 'A1', template: 'work' }]);
  const v = await drive(w, scenario(w, { version: '9.9.9 (Claude Code)' })); assert.equal(v.status, 'HALT'); assert.match(v.reason, /not the tested 2\.1\.321/); assert.equal(st(w, 'A1'), 'PENDING');
  const rel = acquireDriverLock(w.root); await assert.rejects(() => drive(w, scenario(w, lines(ev.init, ev.done()))), /another driver is running/); rel();
  fs.rmSync(path.join(w.root, 'PREFLIGHT_OK.json')); const h = await drive(w, scenario(w, lines(ev.init, ev.done()))); assert.equal(h.status, 'HALT'); assert.match(h.reason, /attestation/); assert.equal(st(w, 'A1'), 'PENDING');
});

test('D8. maxItems bounds one run; items run one at a time in order', { timeout: 120000 }, async () => {
  const w = world([{ id: 'A1', template: 'work' }, { id: 'A2', template: 'work' }, { id: 'A3', template: 'work' }]);
  const r = await drive(w, scenario(w, lines(ev.init, ev.done())), { maxItems: 2 }); assert.equal(r.status, 'LIMIT'); assert.deepEqual(r.results.map((x) => x.id), ['A1', 'A2']); assert.equal(st(w, 'A3'), 'PENDING');
});
