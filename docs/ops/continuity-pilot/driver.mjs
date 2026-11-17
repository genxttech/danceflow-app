#!/usr/bin/env node
// Phase 2 (option A) driver. Replaces the in-session /loop: deterministic code claims ONE item at a time and runs it in an
// ISOLATED Claude Code child process (own settings file, --restricted, no MCP, default-deny permissions, minimal tools, file tools
// confined to the item's directories). The model never claims, completes or schedules anything and shares no global setting with
// any other session. Stop conditions are enforced here: any permission denial, timeout, STOP file, limit, or HALT.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import * as O from './orchestrator.mjs';
import { DEFAULT_SOURCE, DEFAULT_CLAUDE_CMD, WORK_ROOT } from './config.mjs';
import { CLAUDE_VERSION, childArgs, childEnv, childSettings, resolveCode } from './child-config.mjs';

const DENIAL_TEXT = /permission|denied|not allowed|requires approval|was blocked|don't have access|cannot be used|doesn't allow/i;
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text ?? '').join(' ') : JSON.stringify(c ?? ''));

// Incremental stream-json parser: objective records of what the child tried and whether the harness denied it.
export class StreamParser {
  constructor() { this.buf = ''; this.init = null; this.calls = new Map(); this.results = new Map(); this.result = null; this.denials = []; this.strict = new Set(); this.events = 0; }
  feed(chunk) {
    this.buf += chunk; let nl; const fresh = [];
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim(); this.buf = this.buf.slice(nl + 1); if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      this.events++;
      if (e.type === 'system' && e.subtype === 'init') this.init = { tools: e.tools, mcp_servers: e.mcp_servers, permissionMode: e.permissionMode, model: e.model };
      else if (e.type === 'assistant') for (const b of e.message?.content ?? []) { if (b.type === 'tool_use') this.calls.set(b.id, { id: b.id, name: b.name, input: b.input }); }
      else if (e.type === 'user') for (const b of e.message?.content ?? []) {
        if (b.type !== 'tool_result') continue;
        const r = { is_error: !!b.is_error, text: textOf(b.content).slice(0, 400) }; this.results.set(b.tool_use_id, r);
        if (r.is_error && /^\s*Permission to use .+ (has been )?denied/i.test(r.text)) this.strict.add(b.tool_use_id); // the harness's own wording, not an OS error from a command that ran
        if (r.is_error && DENIAL_TEXT.test(r.text)) { const d = { id: b.tool_use_id, call: this.calls.get(b.tool_use_id), reason: r.text }; this.denials.push(d); fresh.push(d); }
      } else if (e.type === 'result') {
        this.result = e;
        for (const d of e.permission_denials ?? []) this.strict.add(d.tool_use_id);
        for (const d of e.permission_denials ?? []) if (!this.denials.some((x) => x.id === d.tool_use_id)) { const x = { id: d.tool_use_id, call: { name: d.tool_name, input: d.tool_input }, reason: 'permission_denials' }; this.denials.push(x); fresh.push(x); }
      }
    }
    return fresh;
  }
}

export function buildPrompt(item) {
  return [
    'You are executing ONE pre-approved local task inside an isolated environment. You have no network, no hosted systems and no way to change permissions.',
    `TASK: ${item.title}`, `HOW: ${resolveCode(item.cmd)}`, `DONE WHEN: ${item.done}`,
    'RULES: use only the tools and commands you have been allowed; give the commands exactly as written, one per tool call; never chain commands, use redirection, command substitution, or semicolons; if ANY tool call is denied, stop immediately and say which one: do not retry, rephrase or work around it; do not push, open pull requests, merge, or touch any hosted system; do not run code you wrote yourself.',
    'When finished reply with one short paragraph that starts with "DONE:" (success) or "FAILED:" (could not complete).',
  ].join('\n');
}

function killTree(child) {
  try { if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill('SIGKILL'); } catch { try { child.kill(); } catch { /* gone */ } }
}

export function changedPaths(dirs) {
  const out = [];
  for (const d of dirs) { try { for (const l of execFileSync('git', ['-C', d, '-c', 'core.fsmonitor=false', 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, env: childEnv() }).split('\n')) if (l.trim()) out.push(l.slice(3).trim()); } catch { /* not a repo */ } }
  return out;
}

// The driver's git ignores the owner's global/system git config (childEnv) and never runs hooks. The commit identity is read ONCE
// (read-only `git config --global`, unscrubbed) and passed explicitly, so no config file can inject commands into the driver's git.
const EMPTY_HOOKS = fs.mkdtempSync(path.join(os.tmpdir(), 'cpilot-nohooks-')); // per process: nobody can pre-populate it
process.on('exit', () => { try { fs.rmSync(EMPTY_HOOKS, { recursive: true, force: true }); } catch { /* best effort */ } });
const gitCfg = (k, d) => { try { return execFileSync('git', ['config', '--global', k], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim() || d; } catch { return d; } };
const IDENT = ['-c', 'user.name=' + gitCfg('user.name', 'Continuity Pilot'), '-c', 'user.email=' + gitCfg('user.email', 'pilot@localhost')];
const git = (dir, args) => execFileSync('git', ['--no-replace-objects', '-C', dir, '-c', 'core.hooksPath=' + EMPTY_HOOKS, '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'commit.gpgsign=false', '-c', 'protocol.allow=never', ...IDENT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, env: childEnv() });
const dirty = (dir) => { const parts = git(dir, ['status', '--porcelain', '-z', '-uall']).split('\0').filter((x) => x.length); const out = []; for (let i = 0; i < parts.length; i++) { const e = parts[i]; out.push(e.slice(3)); if (/^[RC]/.test(e.slice(0, 2))) { out.push(parts[i + 1]); i++; } } return out; }; // -z: no quoting, rename/copy entries carry both paths

// ---- Round 5: the child NEVER writes into a repository. It writes plain files into a stage directory outside every repository
// (C:/Dev/cpilot-out/<cwd>); the DRIVER validates them and copies them into commit.dir/commit.paths[0] as NEW regular files, then commits.
// This closes the whole class "something the child planted in the worktree runs later or gets committed" (nested repos, bare layouts,
// ignored files, retries, edits to existing gate scripts): the repository is byte-for-byte what it was before the child ran, plus files
// the driver itself created from a validated list.
export const STAGE_LIMITS = { files: 50, bytes: 1048576, depth: 4, entries: 200 };
const GITISH = /^(HEAD|config|commondir|gitdir|packed-refs|objects|refs|hooks|alternates|info|worktrees|modules|shallow|FETCH_HEAD|ORIG_HEAD|description|branches|logs|index|COMMIT_EDITMSG|MERGE_HEAD)$/i;
const STAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const STAGE_EXT = /\.(md|txt|sql|json|sh|csv)$/i;
const refuse = (m) => { const e = new Error('refused: ' + m); e.refused = true; return e; };

// Lists the stage directory. FLAT only (no subdirectories), every file must be one of the names the template declares in commit.files,
// a plain regular file with a single link and a safe name. Throws a refusal on anything else (round 6: exact expected outputs).
export function collectStage(stage, allowed = []) {
  const files = []; let entries = 0;
  for (const e of fs.readdirSync(stage, { withFileTypes: true })) {
    if (++entries > STAGE_LIMITS.entries) throw refuse('too many entries in the stage directory');
    const full = path.join(stage, e.name); const st = fs.lstatSync(full);
    if (st.isSymbolicLink() || !st.isFile()) throw refuse('stage entry is not a plain file (subdirectories, links and devices are not allowed): ' + e.name);
    if (st.nlink !== 1) throw refuse('stage file has more than one hard link: ' + e.name);
    if (!STAGE_NAME.test(e.name) || /^\.git/i.test(e.name) || GITISH.test(e.name)) throw refuse('stage entry has a forbidden name: ' + e.name);
    if (!STAGE_EXT.test(e.name)) throw refuse('stage file type not allowed (md, txt, sql, json, sh, csv): ' + e.name);
    if (!allowed.some((a) => a.toLowerCase() === e.name.toLowerCase())) throw refuse('stage file is not one of the outputs this item may produce (' + allowed.join(', ') + '): ' + e.name);
    if (st.size > STAGE_LIMITS.bytes) throw refuse('stage file too large: ' + e.name);
    files.push(e.name); if (files.length > STAGE_LIMITS.files) throw refuse('too many stage files');
  }
  return files.sort();
}

// Every existing component from the repository root down to a path must be a plain directory: a junction or symlink under the commit path
// would make the copy land outside the repository (git status does not list untracked junctions).
function assertPlainPath(base, rel) {
  let cur = base;
  for (const part of rel.split('/').filter(Boolean)) {
    cur = path.join(cur, part); let st; try { st = fs.lstatSync(cur); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (st.isSymbolicLink() || !st.isDirectory()) throw refuse('a path component is a link or not a directory: ' + rel);
  }
}
const assertPlainDir = (p) => { const st = fs.lstatSync(p); if (st.isSymbolicLink() || !st.isDirectory()) throw refuse('not a plain directory: ' + p); };

const snapshotRepo = (dir) => ({ head: git(dir, ['rev-parse', 'HEAD']).trim(), status: git(dir, ['status', '--porcelain', '-z', '-uall', '--ignored=matching']) });

// Before the child runs: the commit directory must be clean (so every later change is detectable), remember HEAD and the complete
// status INCLUDING ignored files, and start from an empty stage directory.
export function repoPrepare(iso) {
  if (!iso.commit) return { base: null };
  const { dir, stage } = iso.commit;
  const d = dirty(dir); if (d.length) throw new Error('worktree ' + dir + ' is not clean before the item: ' + d.slice(0, 5).join(', '));
  fs.mkdirSync(path.dirname(stage), { recursive: true }); assertPlainDir(path.dirname(stage)); assertPlainDir(dir); // never rm through a junction
  try { if (fs.lstatSync(stage).isSymbolicLink()) throw new Error('stage is a link'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage, { recursive: true });
  const snap = snapshotRepo(dir);
  return { base: snap.head, snap, stage };
}

// After a successful child: the repository must be exactly as it was (the child has no write access to it); then import the stage
// files as new regular files under commit.paths[0] and make ONE local commit with hooks disabled. Returns { ok, reason, changed, commit }.
export function repoFinish(iso, prep) {
  if (!iso.commit) return { ok: true, changed: [] };
  const { dir, paths, message, stage, files: expected = [] } = iso.commit;
  const now = snapshotRepo(dir);
  if (now.head !== prep.snap.head) return { ok: false, reason: 'child changed HEAD (it must not commit)', changed: [] };
  if (now.status !== prep.snap.status) { const a = new Set(prep.snap.status.split('\0')); const diff = now.status.split('\0').filter((x) => !a.has(x)).slice(0, 5); return { ok: false, reason: 'refused: the repository changed while the child ran (it has no write access): ' + diff.join(', '), changed: [] }; }
  let files; try { assertPlainDir(stage); files = collectStage(stage, expected); } catch (e) { if (e.refused) return { ok: false, reason: e.message, changed: [] }; throw e; }
  if (!files.length) return { ok: true, changed: [], commit: null };
  const root = path.join(dir, paths[0]);
  try { assertPlainDir(dir); assertPlainPath(dir, paths[0]); assertPlainDir(root); } catch (e) { if (e.refused) return { ok: false, reason: e.message, changed: [] }; throw e; }
  const rootReal = path.resolve(root) + path.sep; const rels = []; const made = [];
  for (const f of files) {
    const dest = path.resolve(root, f); if (!dest.startsWith(rootReal)) return { ok: false, reason: 'refused: stage file escapes the commit path: ' + f, changed: [] };
    if (fs.existsSync(dest) || (() => { try { fs.lstatSync(dest); return true; } catch { return false; } })()) return { ok: false, reason: 'refused: a file already exists at ' + paths[0] + f + ' (the pilot only creates new files)', changed: [] };
    rels.push(paths[0] + f);
  }
  try {
    for (const f of files) { const dest = path.resolve(root, f); fs.writeFileSync(dest, fs.readFileSync(path.join(stage, f)), { flag: 'wx' }); made.push(dest); } // default data stream only (no NTFS alternate streams)
    git(dir, ['--literal-pathspecs', 'add', '--', ...rels]);
    const staged = git(dir, ['diff', '--cached', '--raw', '--no-renames', '-z']).split('\0').filter((x) => x.length);
    const names = staged.filter((x) => !x.startsWith(':')).sort(); const modes = staged.filter((x) => x.startsWith(':'));
    if (JSON.stringify(names) !== JSON.stringify([...rels].sort()) || modes.some((m) => !/^:000000 100644 /.test(m))) throw refuse('staged set differs from the imported files or has a non-regular mode');
    git(dir, ['commit', '--no-verify', '-m', message]);
    return { ok: true, changed: rels, commit: git(dir, ['rev-parse', 'HEAD']).trim() };
  } catch (e) {
    try { git(dir, ['reset', '-q']); } catch { /* best effort */ } for (const m of made) { try { fs.rmSync(m, { force: true }); } catch { /* best effort */ } }
    return { ok: false, reason: e.refused ? e.message : 'repository step failed: ' + String(e.message).split('\n')[0], changed: [] };
  }
}
export function removeContainers(iso) { for (const c of iso.containers ?? []) { try { execFileSync('docker', ['rm', '-f', '-v', c], { stdio: 'ignore', timeout: 60000 }); } catch { /* not present */ } } }

// Runs one claimed item in an isolated child. Never throws; returns { ok, reason, denials, ... }.
export async function runChild(root, claim, { claudeCmd = DEFAULT_CLAUDE_CMD, workRoot = WORK_ROOT, env = {}, stopOnDenial = true, hbMs = 60000, pollMs = 1000 } = {}) {
  const item = claim.item; const iso = item.iso;
  const workDir = path.join(workRoot, iso.cwd); fs.rmSync(workDir, { recursive: true, force: true }); fs.mkdirSync(workDir, { recursive: true });
  const runDir = path.join(path.dirname(workRoot), 'runs', iso.cwd); fs.rmSync(runDir, { recursive: true, force: true }); fs.mkdirSync(runDir, { recursive: true }); // not a working directory of the child
  removeContainers(iso); // a leftover container from an earlier run must not outlive into this item
  let prep; try { prep = repoPrepare(iso); } catch (e) { O.log(root, { ev: 'CHILD_END', id: item.id, ok: false, reason: String(e.message) }); return { ok: false, reason: String(e.message), denials: [], stoppedBy: 'precondition' }; }
  const settingsPath = path.join(runDir, 'pilot-settings.json'); fs.writeFileSync(settingsPath, JSON.stringify(childSettings({ allow: iso.allow })));
  const args = childArgs({ prompt: buildPrompt(item), settingsPath, tpl: iso });
  const parser = new StreamParser(); const streamPath = path.join(runDir, 'stream.jsonl'); const sf = fs.createWriteStream(streamPath);
  O.log(root, { ev: 'CHILD_START', id: item.id, model: iso.model, addDirs: iso.addDirs, budget: iso.maxBudgetUsd });
  const child = spawn(claudeCmd[0], [...claudeCmd.slice(1), ...args], { cwd: workDir, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let why = null; let stderr = '';
  const stop = (reason) => { if (!why) { why = reason; killTree(child); } };
  const done = new Promise((res) => { child.on('close', (code) => res(code)); child.on('error', (e) => { stderr += String(e.message); res(-1); }); });
  child.stdout.on('data', (d) => { sf.write(d); const fresh = parser.feed(d.toString('utf8')); if (fresh.length && stopOnDenial) stop(`permission denial: ${fresh[0].call?.name ?? '?'}`); });
  child.stderr.on('data', (d) => { stderr += d.toString('utf8').slice(0, 2000); });
  const timer = setTimeout(() => stop(`timeout after ${iso.timeoutMs} ms`), iso.timeoutMs);
  const stopper = setInterval(() => { if (fs.existsSync(path.join(root, 'STOP'))) stop('STOP file set'); }, pollMs);
  const beat = setInterval(() => { try { O.heartbeat(root, item.id, item.runner.token); } catch { /* never kill the driver */ } }, hbMs);
  const code = await done; clearTimeout(timer); clearInterval(stopper); clearInterval(beat); sf.end();
  try { killTree(child); } catch { /* already gone */ } // background grandchildren must be dead before the repository is inspected (round 5)
  removeContainers(iso); // a timeout or kill must never leave the database container running
  const r = parser.result; const text = String(r?.result ?? '');
  let ok = !why && code === 0 && r && !r.is_error && /^\s*DONE:/.test(text) && parser.denials.length === 0;
  let fin = { changed: [] }; let finReason = null;
  if (ok) { try { fin = repoFinish(iso, prep); if (!fin.ok) { ok = false; finReason = fin.reason; } } catch (e) { ok = false; finReason = 'repository step failed: ' + String(e.message).split('\n')[0]; } }
  const reason = finReason ? finReason : ok ? null : (why ?? (parser.denials.length ? `permission denial: ${parser.denials[0].call?.name}` : r?.is_error ? `child error: ${text.slice(0, 200)}` : !/^\s*DONE:/.test(text) ? `child did not report DONE: ${text.slice(0, 200)}` : `child exited with code ${code}: ${stderr.slice(0, 200)}`));
  const tools = {}; for (const c of parser.calls.values()) tools[c.name] = (tools[c.name] ?? 0) + 1;
  O.log(root, { ev: 'CHILD_END', id: item.id, ok, reason, code, changed: fin.changed, commit: fin.commit, cost: r?.total_cost_usd, turns: r?.num_turns, tools, denials: parser.denials.map((d) => ({ tool: d.call?.name, input: JSON.stringify(d.call?.input ?? '').slice(0, 160) })), init: parser.init });
  return { ok, reason, denials: parser.denials, init: parser.init, cost: r?.total_cost_usd, summary: text.slice(0, 400), streamPath, stoppedBy: why, changed: fin.changed ?? [], commit: fin.commit ?? null };
}

export function acquireDriverLock(root) {
  const f = path.join(root, 'driver.lock');
  for (let n = 0; n < 2; n++) {
    try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); return () => { try { fs.rmSync(f, { force: true }); } catch { /* ok */ } }; }
    catch (e) { if (e.code !== 'EEXIST') throw e; let pid = 0; try { pid = Number(fs.readFileSync(f, 'utf8')); } catch { /* racing */ } let alive = false; try { process.kill(pid, 0); alive = pid > 0; } catch (err) { alive = err.code === 'EPERM'; } if (alive) throw new Error(`another driver is running (pid ${pid})`); fs.rmSync(f, { force: true }); }
  }
  throw new Error('could not take the driver lock');
}

export async function runDriver(root, { worker = 'COMPETITION', source = DEFAULT_SOURCE, claudeCmd = DEFAULT_CLAUDE_CMD, maxItems = 4, versionCheck = true, ...rest } = {}) {
  O.init(root); const release = acquireDriverLock(root); const results = [];
  try {
    if (versionCheck) {
      let v = ''; try { v = execFileSync(claudeCmd[0], [...claudeCmd.slice(1), '--version'], { encoding: 'utf8', timeout: 30000, env: childEnv(rest.env ?? {}), stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* reported below */ }
      if (!v.includes(CLAUDE_VERSION)) { O.log(root, { ev: 'HALT', reason: `claude version is not the tested ${CLAUDE_VERSION}: ${v.trim()}` }); return { status: 'HALT', reason: `claude version is not the tested ${CLAUDE_VERSION}`, results }; }
    }
    for (let n = 0; n < maxItems; n++) {
      const c = O.claim(root, { worker, source, external: true });
      if (c.status !== 'CLAIMED') return { status: c.status, reason: c.reason, blocked: c.blocked, stuck: c.stuck, results };
      const r = await runChild(root, c, { claudeCmd, ...rest });
      const state = O.complete(root, c.item, r.ok ? {} : { error: r.reason }, source, r.changed ?? []);
      results.push({ id: c.item.id, ok: r.ok, state, reason: r.reason });
      if (!r.ok && (r.denials.length || r.stoppedBy)) return { status: 'STOPPED', reason: r.reason, results }; // stop conditions end the run
    }
    return { status: 'LIMIT', reason: `maxItems ${maxItems}`, results };
  } finally { release(); }
}

if (process.argv[1]?.endsWith('driver.mjs')) {
  const a = process.argv.slice(2); const f = (n, d) => { const k = a.indexOf(`--${n}`); return k < 0 ? d : a[k + 1]; };
  const root = f('root'); if (!root) { console.error('usage: node driver.mjs --root DIR [--worker COMPETITION] [--max-items N]'); process.exit(2); }
  const res = await runDriver(root, { worker: f('worker', 'COMPETITION'), maxItems: Number(f('max-items', 4)) });
  console.log(JSON.stringify(res, null, 2)); process.exit(res.status === 'LIMIT' || res.status === 'IDLE' ? 0 : 1);
}
