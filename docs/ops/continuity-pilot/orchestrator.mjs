#!/usr/bin/env node
// Continuity pilot orchestrator v3. ADVISORY SCHEDULER for a cooperative agent.
// What it guarantees: it never HANDS OUT a class-G, unauthorized, expired, replayed or out-of-policy item, based only on
// state fetched from a protected remote ref (see protected-source.mjs, config.mjs). Editing the local queue/state cannot
// change that. What it does NOT do: constrain what a non-cooperative agent does with its own shell. The enforcing layer
// for that is Claude Code permission deny rules (see PHASE2-ACTIVATION.md). Dry-run actions are fictional.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadProtected } from './protected-source.mjs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SOURCE } from './config.mjs';
import { loadDenyRules, defaultSettingsFiles } from './deny-check.mjs';

export const PROTECTED_CMD = [
  /prod[-_ ]?apply/i, /dev[-_ ]?apply/i, /\bpr\s+merge\b/i, /\bapi\b.*\/merge\b/i, /\b(deploy|promote|vercel)\b/i,
  /--force\b|\bpush\s+-f\b|\bpush\b.*\s\+\S/i, /\b(stripe|twilio)\b.*\blive\b/i, /\b(DROP|TRUNCATE|DELETE\s+FROM)\b/i,
  /\bdb\s+push\b/i, /settings(\.local)?\.json|CLAUDE\.md/i, /\bgh\s+auth\b|api[_-]?key|secret|credential|password/i,
];
export const PROTECTED_PATHS = ['.github/', 'CODEOWNERS', 'supabase/migrations', 'src/lib/supabase/migrations', '.claude/', 'docs/ops/continuity-pilot/', 'CLAUDE.md'];

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const P = (root, ...p) => path.join(root, ...p);
const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
const own = (o, k) => Object.hasOwn(o, k);
const POS = (n) => Number.isFinite(n) && Number.isInteger(n) && n > 0;

export const scopeSha = (item, policy) => sha({ id: item.id, template: item.template, params: item.params || {}, deps: item.deps || [], tpl: own(policy.templates, item.template) ? policy.templates[item.template] : null });

export function render(tpl, params = {}) {
  const decl = tpl.params || {};
  for (const [k, re] of Object.entries(decl)) if (!new RegExp(re).test(String(params[k] ?? ''))) throw new Error(`param ${k} invalid`);
  for (const k of Object.keys(params)) if (!own(decl, k)) throw new Error(`unexpected param ${k}`);
  return (tpl.cmd || '').replace(/\{(\w+)\}/g, (_, k) => (own(decl, k) ? String(params[k]) : ''));
}

// Policy + authorizations self-check: fail closed on anything missing, malformed or unsafe.
export function validatePolicy(policy, auths) {
  const pl = policy?.pilot;
  if (!pl || typeof pl !== 'object' || !policy.templates || typeof policy.templates !== 'object' || Array.isArray(policy.templates)) throw new Error('policy malformed');
  if (pl.enabled !== true && pl.enabled !== false) throw new Error('pilot.enabled must be boolean');
  if (typeof pl.coordinator !== 'string' || !pl.coordinator) throw new Error('pilot.coordinator missing');
  const nb = Date.parse(pl.not_before); const na = Date.parse(pl.not_after);
  if (!Number.isFinite(nb) || !Number.isFinite(na) || nb >= na) throw new Error('pilot window invalid');
  for (const k of ['maxHours', 'maxWakeups', 'maxClaims', 'maxCalls', 'claimTtlMs', 'maxAttempts']) if (!POS(pl[k])) throw new Error(`pilot.${k} must be a positive integer`);
  if (policy.owner_done !== undefined && !(Array.isArray(policy.owner_done) && policy.owner_done.every((x) => typeof x === 'string'))) throw new Error('owner_done malformed');
  for (const name of Object.keys(policy.templates)) {
    const t = policy.templates[name];
    if (!t || !['A', 'G'].includes(t.class)) throw new Error(`template ${name}: bad class`);
    if (t.class === 'A') {
      if (typeof t.cmd !== 'string') throw new Error(`template ${name}: cmd missing`);
      if (PROTECTED_CMD.some((r) => r.test(t.cmd))) throw new Error(`template ${name}: class A with protected command`);
      for (const [k, re] of Object.entries(t.params || {})) if (typeof re !== 'string' || !re.startsWith('^') || !re.endsWith('$')) throw new Error(`template ${name}: param ${k} regex must be anchored`);
    }
  }
  if (Array.isArray(auths)) {
    if (new Set(auths.map((a) => a?.id)).size !== auths.length) throw new Error('authorizations: duplicate ids');
    for (const a of auths) if (a && !(Object.hasOwn(policy.templates, a.template) && policy.templates[a.template].class === 'A')) throw new Error(`authorizations: ${a.id} names a non-class-A or unknown template`);
  }
  if (!Array.isArray(auths) || !auths.every((a) => a && typeof a.id === 'string' && typeof a.scope_sha === 'string' && a.by === 'owner' && typeof a.template === 'string' && Array.isArray(a.deps) && a.params && typeof a.params === 'object')) throw new Error('authorizations malformed');
}

export function init(root) {
  for (const d of ['log', 'sandbox']) fs.mkdirSync(P(root, d), { recursive: true });
  if (!fs.existsSync(P(root, 'queue.json'))) fs.writeFileSync(P(root, 'queue.json'), JSON.stringify({ meta: {}, items: [] }, null, 2));
}

function withMutex(root, fn) {
  const dir = P(root, 'mutex'); const t0 = Date.now();
  for (;;) {
    try { fs.mkdirSync(dir); fs.writeFileSync(P(dir, 'owner'), String(process.pid)); break; }
    catch (e) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(e.code)) throw e;
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > 5000) {
          let txt = ''; try { txt = fs.readFileSync(P(dir, 'owner'), 'utf8').trim(); } catch { /* gone or mid-write */ }
          if (!txt || !alive(Number(txt))) {
            const grave = `${dir}.stale.${process.pid}.${Date.now()}`;
            try { fs.renameSync(dir, grave); fs.rmSync(grave, { recursive: true, force: true }); } catch { /* another waiter won the rename */ }
            continue;
          }
        }
      } catch { /* vanished: retry */ }
      if (Date.now() - t0 > 15000) throw new Error('mutex timeout');
      sleepSync(5);
    }
  }
  try { return fn(); } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
}

const loadQ = (root) => { const q = JSON.parse(fs.readFileSync(P(root, 'queue.json'), 'utf8')); q.meta ||= {}; return q; };
const saveQ = (root, q) => { const t = P(root, `queue.json.${process.pid}.tmp`); fs.writeFileSync(t, JSON.stringify(q, null, 2)); fs.renameSync(t, P(root, 'queue.json')); };

export function log(root, ev) { fs.appendFileSync(P(root, 'log', 'execution.jsonl'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...ev }) + '\n'); }
export const readLog = (root) => fs.existsSync(P(root, 'log', 'execution.jsonl'))
  ? fs.readFileSync(P(root, 'log', 'execution.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

const isStopped = (root) => fs.existsSync(P(root, 'STOP'));
const touchesProtected = (paths) => (paths || []).some((t) => PROTECTED_PATHS.some((p) => String(t).replaceAll('\\', '/').includes(p)));
const runnerLive = (i, ttl) => i.runner && (i.runner.external || alive(i.runner.pid)) && Date.now() - i.runner.hb < ttl;
export const ATTEST = 'PREFLIGHT_OK.json';
export function readAttestation(root) { try { return JSON.parse(fs.readFileSync(P(root, ATTEST), 'utf8')); } catch { return null; } }
// Written ONLY by preflight.mjs after every activation check passes. Local and therefore cooperative: the hard gate is
// the protected policy's enabled flag; this makes "no unattended execution until all checks pass" mechanical for a
// cooperative loop, and ties the run to the exact policy+authorization content the preflight verified.
export function writeAttestation(root, a) { fs.writeFileSync(P(root, ATTEST), JSON.stringify(a, null, 2)); }
const CODE_DIR = path.dirname(fileURLToPath(import.meta.url));
// Names of pinned code files whose local bytes (CRLF-normalized) differ from the reviewed copy on the protected ref.
export function codeMismatches(codeShas) {
  const bad = [];
  for (const [f, want] of Object.entries(codeShas || {})) {
    let have = null; try { have = crypto.createHash('sha256').update(fs.readFileSync(path.join(CODE_DIR, f), 'utf8').replaceAll('\r\n', '\n')).digest('hex'); } catch { /* missing locally */ }
    if (want === null || have !== want) bad.push(f);
  }
  return bad;
}
const halt = (root, reason) => { log(root, { ev: 'HALT', reason }); return { status: 'HALT', reason }; };

// An item satisfies a dependency only if it is class A + DONE with a matching DONE record in the log, or listed in
// the protected policy's owner_done array. A locally set DONE / OWNER-DONE on anything else counts for nothing.
function satisfiedFn(q, policy, doneLog) {
  return (id) => {
    if ((policy.owner_done || []).includes(id)) return true;
    const x = q.items.find((i) => i.id === id);
    if (!x || x.state !== 'DONE' || !own(policy.templates, x.template) || policy.templates[x.template].class !== 'A') return false;
    return doneLog.has(`${x.id}|${scopeSha(x, policy)}`);
  };
}

export function claim(root, { worker = 'W', external = false, source = DEFAULT_SOURCE, wake = false, now = Date.now(), settingsFiles = defaultSettingsFiles() } = {}) {
  if (isStopped(root)) return { status: 'STOPPED' };
  let prot;
  try { prot = loadProtected(source); validatePolicy(prot.policy, prot.auths); }
  catch (e) { return halt(root, `protected source unavailable or invalid: ${String(e.message).split('\n')[0]}`); }
  const { policy, auths, commit } = prot; const pl = policy.pilot;
  if (pl.enabled !== true) return halt(root, 'pilot disabled in protected policy');
  if (pl.coordinator !== worker) return halt(root, `worker ${worker} is not the authorized coordinator`);
  if (now < Date.parse(pl.not_before) || now > Date.parse(pl.not_after)) return halt(root, 'outside protected authorization window');
  const cm = codeMismatches(prot.codeShas);
  if (cm.length) return halt(root, `local code differs from the reviewed code on the protected ref: ${cm.join(', ')}`);
  const att = readAttestation(root);
  if (!att || att.policySha !== prot.policySha || att.authSha !== prot.authSha || !(now < att.expiresAt)) return halt(root, 'activation preflight attestation missing, stale, expired or for different policy content');
  if (JSON.stringify(att.settingsHashes ?? null) !== JSON.stringify(loadDenyRules(settingsFiles).hashes)) return halt(root, 'permission settings changed since the activation preflight (deny rules must be re-verified)');
  try {
    return withMutex(root, () => {
      const q = loadQ(root); const m = q.meta; let dirty = true;
      if (!Array.isArray(q.items) || q.items.some((i) => !i || typeof i.id !== 'string') || new Set(q.items.map((i) => i.id)).size !== q.items.length) { return halt(root, 'queue invalid: ids must be unique strings'); }
      m.startedAt ||= now; m.wakeups ||= 0; m.claims ||= 0; m.calls ||= 0;
      if (![m.startedAt, m.wakeups, m.claims, m.calls].every(Number.isFinite)) return halt(root, 'queue meta counters invalid');
      m.calls++;
      if (wake) m.wakeups++;
      const save = () => { if (dirty) saveQ(root, q); };
      if (now - m.startedAt > pl.maxHours * 3600000) { save(); return halt(root, 'maxHours elapsed'); }
      if (m.wakeups > pl.maxWakeups) { save(); return halt(root, 'maxWakeups exceeded'); }
      if (m.calls > pl.maxCalls) { save(); return halt(root, 'maxCalls exceeded'); }

      const evs = readLog(root); const doneLog = new Set(evs.filter((e) => e.ev === 'DONE' && e.scope).map((e) => `${e.id}|${e.scope}`));
      const startCount = (id, sc) => evs.filter((e) => e.ev === 'START' && e.id === id && e.scope === sc).length;
      const satisfied = satisfiedFn(q, policy, doneLog);

      for (const i of q.items) if (i.state === 'RUNNING' && !runnerLive(i, pl.claimTtlMs)) {
        i.state = (i.attempts || 0) >= pl.maxAttempts ? 'NEEDS-REVIEW' : 'PENDING';
        log(root, { ev: 'INTERRUPTED_RECOVERED', id: i.id, attempts: i.attempts, next: i.state }); delete i.runner;
      }
      for (const i of q.items) if (i.state === 'FAILED' && (i.attempts || 0) < pl.maxAttempts) { i.state = 'PENDING'; log(root, { ev: 'RETRY', id: i.id }); }
      // gate sweep: class/validity come from the PROTECTED policy, never from the item; gate-parked items are re-evaluated
      const view = new Map();
      for (const i of q.items) {
        const tpl = own(policy.templates, i.template) ? policy.templates[i.template] : null; let cmd = null; let why = null;
        if (!tpl) why = 'unknown template';
        else { try { cmd = render(tpl, i.params); } catch (e) { why = e.message; }
          if (!why && tpl.class !== 'A') why = `class ${tpl.class} (owner gate)`;
          if (!why && PROTECTED_CMD.some((r) => r.test(cmd))) why = 'protected command pattern'; }
        view.set(i, { tpl, cmd });
        if (i.state === 'BLOCKED-OWNER' && i.parkedBy === 'gate' && !why) { i.state = 'PENDING'; delete i.reason; delete i.parkedBy; log(root, { ev: 'GATE_CLEARED', id: i.id }); }
        if (i.state === 'PENDING' && why) { i.state = 'BLOCKED-OWNER'; i.reason = why; i.parkedBy = 'gate'; log(root, { ev: 'BLOCKED_OWNER', id: i.id, reason: why }); }
        if (i.state === 'PENDING' && !why) {
          const sc = scopeSha(i, policy);
          if (doneLog.has(`${i.id}|${sc}`)) { i.state = 'DONE'; log(root, { ev: 'REPLAY_REFUSED', id: i.id }); }
          else if (startCount(i.id, sc) >= pl.maxAttempts * 2) { i.state = 'NEEDS-REVIEW'; log(root, { ev: 'REPLAY_REFUSED', id: i.id, reason: 'too many starts' }); }
        }
      }
      if (m.claims >= pl.maxClaims) { save(); return halt(root, 'maxClaims reached'); }

      const running = q.items.filter((i) => i.state === 'RUNNING');
      let waiting = running.length > 0; const held = []; let pick = null;
      if (running.some((r) => !view.get(r).tpl)) { waiting = true; held.push({ id: '*', why: 'running item with unknown template: waiting' }); }
      else for (const i of q.items) {
        if (i.state !== 'PENDING') continue;
        const { tpl, cmd } = view.get(i);
        const sc = scopeSha(i, policy);
        const a = auths.find((x) => x.id === i.id && x.scope_sha === sc && x.template === i.template && JSON.stringify(x.params) === JSON.stringify(i.params || {}) && JSON.stringify(x.deps) === JSON.stringify(i.deps || []));
        const authorized = a && (!a.not_after || (Number.isFinite(Date.parse(a.not_after)) && now <= Date.parse(a.not_after)));
        if (!authorized) { held.push({ id: i.id, why: 'PROPOSED (no valid owner authorization in protected ref)' }); continue; }
        const unmet = (i.deps || []).filter((d) => !satisfied(d));
        if (unmet.length) { held.push({ id: i.id, why: `deps ${unmet.join(',')}` }); continue; }
        const clash = running.find((r) => { const rt = view.get(r).tpl; return (tpl.worktree && rt.worktree === tpl.worktree) || (tpl.dbslot && rt.dbslot === tpl.dbslot); });
        if (clash) { waiting = true; held.push({ id: i.id, why: `resource held by ${clash.id}` }); continue; }
        pick = { i, tpl, cmd, sc }; break;
      }
      if (!pick) {
        save();
        const stuck = q.items.filter((i) => ['FAILED', 'NEEDS-REVIEW'].includes(i.state)).map((i) => ({ id: i.id, state: i.state, error: i.error }));
        return { status: waiting ? 'WAIT' : 'IDLE', commit, held, stuck, blocked: q.items.filter((i) => i.state === 'BLOCKED-OWNER').map((i) => ({ id: i.id, reason: i.reason })) };
      }
      const { i, tpl, cmd, sc } = pick;
      i.state = 'RUNNING'; i.attempts = (i.attempts || 0) + 1; m.claims++;
      i.runner = { pid: process.pid, worker, token: crypto.randomUUID(), started: now, hb: now, external, template: i.template, scope: sc };
      saveQ(root, q);
      log(root, { ev: 'START', id: i.id, worker, attempt: i.attempts, commit, template: i.template, scope: sc });
      return { status: 'CLAIMED', commit, item: { id: i.id, template: i.template, title: tpl.title, cmd, done: tpl.done, action: tpl.action, worktree: tpl.worktree, dbslot: tpl.dbslot, attempts: i.attempts, runner: i.runner } };
    });
  } catch (e) { return halt(root, `claim failed: ${String(e.message).split('\n')[0]}`); }
}

export function heartbeat(root, id, token) {
  try { return withMutex(root, () => { const q = loadQ(root); const i = q.items.find((x) => x.id === id); if (i?.runner?.token === token) { i.runner.hb = Date.now(); saveQ(root, q); return 'OK'; } return 'REFUSED'; }); }
  catch { return 'ERROR'; }
}

// `changed` = paths the agent reports having changed (cooperative); any protected path parks the item for the owner.
export function complete(root, item, result, source = DEFAULT_SOURCE, changed = []) {
  let prot = null; try { prot = loadProtected(source); validatePolicy(prot.policy, prot.auths); } catch { /* fail closed below */ }
  return withMutex(root, () => {
    const q = loadQ(root); const i = q.items.find((x) => x.id === item.id);
    if (!i || i.state !== 'RUNNING' || i.runner?.token !== item.runner.token) { log(root, { ev: 'ORPHAN_COMPLETION_REFUSED', id: item.id }); return 'REFUSED'; }
    const rn = i.runner; delete i.runner;
    const tpl = prot && own(prot.policy.templates, rn.template) ? prot.policy.templates[rn.template] : null;
    // use the template/scope recorded at CLAIM time; if the item was edited meanwhile, do not trust the result
    const tampered = !prot || !tpl || scopeSha(i, prot.policy) !== rn.scope;
    if (result.error) { i.state = (i.attempts || 0) >= (prot?.policy.pilot.maxAttempts ?? 2) ? 'NEEDS-REVIEW' : 'FAILED'; i.error = result.error; }
    else if (tampered) { i.state = 'NEEDS-REVIEW'; i.error = 'item edited during run or policy unreadable'; }
    else if (touchesProtected(tpl.touches) || touchesProtected(changed)) { i.state = 'BLOCKED-OWNER'; i.parkedBy = 'merge'; i.reason = 'work done; protected path needs owner/CODEOWNERS approval'; }
    else i.state = 'DONE';
    log(root, { ev: i.state === 'DONE' ? 'DONE' : i.state, id: i.id, reason: i.reason, error: i.error, ...(i.state === 'DONE' ? { scope: rn.scope } : {}) });
    saveQ(root, q); return i.state;
  });
}

async function execute(root, item) {
  const a = item.action || {}; const ex = P(root, 'sandbox', 'executions.jsonl');
  const rec = (phase) => fs.appendFileSync(ex, JSON.stringify({ phase, id: item.id, pid: process.pid, attempt: item.attempts, t: Date.now(), worktree: item.worktree, dbslot: item.dbslot }) + '\n');
  if (!['work', 'fail', 'hang'].includes(a.type)) throw new Error(`unknown action ${a.type} refused`);
  rec('begin');
  if (a.type === 'hang' && (!a.onlyAttempt || a.onlyAttempt === item.attempts)) await sleep(120000);
  else if (a.type === 'fail') throw new Error('fictional failure');
  else await sleep(a.ms ?? 20);
  rec('end');
}

export async function runOne(root, opts = {}) {
  const c = claim(root, opts);
  if (c.status !== 'CLAIMED') return c;
  const hb = setInterval(() => { try { heartbeat(root, c.item.id, c.item.runner.token); } catch { /* never kill the runner */ } }, 5000);
  let res = {};
  try { await execute(root, c.item); } catch (e) { res = { error: String(e.message) }; } finally { clearInterval(hb); }
  return { status: 'RAN', id: c.item.id, state: complete(root, c.item, res, opts.source) };
}

export async function run(root, { wait = false, max = 1000, pollMs = 25, ...opts } = {}) {
  const ran = []; let last;
  for (let n = 0; n < max;) {
    last = await runOne(root, opts);
    if (last.status === 'RAN') { ran.push(last.id); n++; continue; }
    if (last.status === 'WAIT' && wait) { await sleep(pollMs); continue; }
    break;
  }
  return { ran, final: last };
}

export function stop(root, reason = 'manual') { fs.writeFileSync(P(root, 'STOP'), JSON.stringify({ reason, at: new Date().toISOString() })); log(root, { ev: 'STOP_SET', reason }); }
export function resume(root) { fs.rmSync(P(root, 'STOP'), { force: true }); log(root, { ev: 'STOP_CLEARED' }); }

export function status(root) {
  const q = loadQ(root);
  const rows = q.items.map((i) => `${String(i.id).padEnd(8)} ${i.state.padEnd(14)} tpl=${i.template} deps=[${(i.deps || []).join(',')}] ${i.reason ? '| ' + i.reason : ''}`);
  return `${isStopped(root) ? '*** STOPPED ***\n' : ''}meta=${JSON.stringify(q.meta)}\n${rows.join('\n')}`;
}

// CLI entry. `source` is injected by the caller; the production entry below passes the constant DEFAULT_SOURCE and
// there is deliberately no flag/env to change source, ttl, limits or authorization.
export async function main(argv, source = DEFAULT_SOURCE, extra = {}) {
  const [cmd, ...rest] = argv;
  const flag = (n, d) => { const k = rest.indexOf(`--${n}`); return k < 0 ? d : (rest[k + 1] && !rest[k + 1].startsWith('--') ? rest[k + 1] : true); };
  const root = flag('root'); if (!root) { console.error('--root required'); return 2; }
  init(root);
  const opts = { worker: flag('worker', 'W'), wait: flag('wait', false) === true, max: Number(flag('max', 1000)), wake: flag('wake', false) === true, source, ...extra };
  if (cmd === 'status') console.log(status(root));
  else if (cmd === 'log') console.log(readLog(root).map((e) => `${e.at} ${e.ev} ${e.id || ''} ${e.reason || ''}`).join('\n'));
  else if (cmd === 'stop') stop(root, String(flag('reason', 'manual')));
  else if (cmd === 'resume') resume(root);
  else if (cmd === 'claim') console.log(JSON.stringify(claim(root, { ...opts, external: true })));
  else if (cmd === 'heartbeat') console.log(heartbeat(root, flag('id'), flag('token')));
  else if (cmd === 'complete') console.log(complete(root, { id: flag('id'), runner: { token: flag('token') } }, flag('error', false) ? { error: String(flag('error')) } : {}, source, String(flag('changed', '')).split(',').filter(Boolean)));
  else if (cmd === 'tick') console.log(JSON.stringify(await runOne(root, opts)));
  else if (cmd === 'run') console.log(JSON.stringify(await run(root, opts)));
  else { console.error('usage: status|log|stop|resume|claim|heartbeat|complete|tick|run --root DIR'); return 2; }
  return 0;
}

if (process.argv[1]?.endsWith('orchestrator.mjs')) process.exit(await main(process.argv.slice(2)));
