#!/usr/bin/env node
// Documented ACTIVATION PREFLIGHT. Run by the coordinator after (1) the pilot PR is independently reviewed and merged,
// (2) the owner has installed deny rules, and (3) the owner has given a SEPARATE explicit activation approval that names the
// sha256 of policy.json and authorizations.json. Writes PREFLIGHT_REPORT.json always, and PREFLIGHT_OK.json (the attestation
// `claim` requires) only if every check passes. A failing run deletes any old attestation.
// Not part of the loop's command set. Side effects: read-only `docker ps`, throwaway temp repos/dirs (removed), the report and
// attestation in --root. The attestation and the probe evidence are local, self-reported evidence for a cooperative agent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as O from './orchestrator.mjs';
import { loadProtected, scrubbedEnv } from './protected-source.mjs';
import { DEFAULT_SOURCE } from './config.mjs';
import { loadDenyRules, coverage, checkProbe, posture, defaultSettingsFiles, ruleSettingsFiles, allVariantIds, allowedConflicts } from './deny-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED_PATH = path.join(HERE, 'phase2', 'required-deny.json');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
// Hard caps live in reviewed code: a policy asking for more fails the preflight.
export const CAPS = { maxHours: 4, maxWakeups: 10, maxClaims: 4, maxCalls: 60, claimTtlMs: 3600000, maxAttempts: 2 };
// ADVISORY text screen of the prose `cmd` (the real control is the deny rules): remote/hosted/PR/push vocabulary.
const NOT_LOCAL = /\bpush\b|\bpr\s+(create|merge|review)\b|\bghapp\b|\bgh\s|\bpublish\b|\bcurl\b|\bwget\b|\bsupabase\b|\bpsql\b|\bsb\.sh\b|https?:\/\//i;

// Git for throwaway repos runs in the same scrubbed environment as protected-source (no user/global config, no hooks).
function git(cwd, aux, ...a) { return execFileSync('git', ['--no-replace-objects', '-c', `core.hooksPath=${aux.hooks}`, '-c', 'user.name=pf', '-c', 'user.email=pf@pf', '-c', 'commit.gpgsign=false', ...a], { cwd, env: scrubbedEnv(aux.cfg), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
const cleanups = [];
const cleanupTo = (mark) => { while (cleanups.length > mark) { try { fs.rmSync(cleanups.pop(), { recursive: true, force: true }); } catch { /* best effort */ } } };

// Build a throwaway protected remote holding the given policy/auths, to exercise real claim() behavior.
export function tempRemote(policy, auths, { code = false, mutateCode } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cpilot-pf-')); cleanups.push(base);
  const aux = { cfg: path.join(base, 'empty.gitconfig'), hooks: path.join(base, 'nohooks') }; fs.writeFileSync(aux.cfg, ''); fs.mkdirSync(aux.hooks);
  const origin = path.join(base, 'o.git'); const clone = path.join(base, 'c');
  git(base, aux, 'init', '--bare', '--quiet', '-b', 'main', origin); git(base, aux, 'clone', '--quiet', origin, clone); git(clone, aux, 'checkout', '-q', '-b', 'main');
  fs.mkdirSync(path.join(clone, 'p')); const pj = JSON.stringify(policy); const aj = JSON.stringify(auths);
  fs.writeFileSync(path.join(clone, 'p/policy.json'), pj); fs.writeFileSync(path.join(clone, 'p/authorizations.json'), aj);
  const codeFiles = code ? DEFAULT_SOURCE.codeFiles : [];
  for (const f of codeFiles) { const dst = path.join(clone, 'p/code', f); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(path.join(HERE, f), dst); if (mutateCode) fs.writeFileSync(dst, mutateCode(f, fs.readFileSync(dst, 'utf8'))); }
  git(clone, aux, 'add', '-A'); git(clone, aux, 'commit', '-q', '-m', 'pf'); git(clone, aux, 'push', '-q', 'origin', 'main');
  return { base, source: { url: origin, ref: 'refs/heads/main', policyPath: 'p/policy.json', authPath: 'p/authorizations.json', allowFile: true, cacheMs: 0, ...(code ? { codeDir: 'p/code', codeFiles } : {}) }, policySha: sha256(pj), authSha: sha256(aj) };
}
function simRoot(items, att, settingsHashes = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpilot-pfroot-')); cleanups.push(root); O.init(root);
  fs.writeFileSync(path.join(root, 'queue.json'), JSON.stringify({ meta: {}, items: items.map((i) => ({ id: i.id, template: i.template, params: i.params || {}, deps: i.deps || [], state: 'PENDING' })) }));
  if (att) O.writeAttestation(root, { ...att, settingsHashes, expiresAt: Date.now() + 3600000 });
  return root;
}

export function runPreflight(opts) {
  const { root, source = DEFAULT_SOURCE, worker = 'COMPETITION', expectPolicySha, expectAuthSha, requiredDeny, settingsFiles, ruleFiles = settingsFiles, probe, now = Date.now(), host = true, skipSuite = false } = opts;
  const checks = []; const add = (id, ok, detail) => checks.push({ id, ok: !!ok, detail }); const mark = cleanups.length; // only dirs created by THIS run are removed
  fs.mkdirSync(root, { recursive: true }); fs.rmSync(path.join(root, O.ATTEST), { force: true }); // a failing preflight never leaves an old attestation behind
  let prot = null;
  try { prot = loadProtected({ ...source, cacheMs: 0 }); O.validatePolicy(prot.policy, prot.auths); add('1.source+validity', true, `commit ${prot.commit}; policy and authorizations pass validation`); }
  catch (e) { add('1.source+validity', false, String(e.message).split('\n')[0]); }
  if (prot) {
    const { policy, auths } = prot; const pl = policy.pilot;
    const cm = O.codeMismatches(prot.codeShas); const pinned = Object.keys(prot.codeShas || {}).length;
    add('1.code-matches-main', pinned > 0 && cm.length === 0, pinned === 0 ? 'no code files pinned in the source: the local code cannot be tied to the reviewed code' : cm.length ? `local code differs from the reviewed code on the protected ref: ${cm.join(', ')}` : `${pinned} local code files byte-equal (CRLF-normalized) the reviewed copy at ${prot.commit}`);
    add('1.policy-integrity', prot.policySha === expectPolicySha && prot.authSha === expectAuthSha, `policy ${prot.policySha}, authorizations ${prot.authSha}; owner-approved ${expectPolicySha}/${expectAuthSha}`);
    const nb = Date.parse(pl.not_before); const na = Date.parse(pl.not_after); const need = pl.maxHours * 3600000;
    add('2.enabled', pl.enabled === true, `pilot.enabled=${pl.enabled}`);
    add('2.window', now >= nb && now <= na && na - now >= need, `now within window and at least ${pl.maxHours}h remain (not_after ${pl.not_after})`);
    add('2.auth-expiry', auths.every((a) => a.not_after && Date.parse(a.not_after) - now >= need), 'every authorization has not_after at least maxHours away');
    add('2.coordinator', pl.coordinator === worker, `coordinator ${pl.coordinator}`);
    let q = null; try { q = JSON.parse(fs.readFileSync(path.join(root, 'queue.json'), 'utf8')); } catch { /* reported below */ }
    if (!q?.items) add('3.queue', false, 'queue.json unreadable');
    else {
      const ids = q.items.map((i) => i.id); const uniq = new Set(ids).size === ids.length; const problems = []; let authorizedA = 0;
      for (const i of q.items) {
        const t = Object.hasOwn(policy.templates, i.template) ? policy.templates[i.template] : null; const a = auths.find((x) => x.id === i.id);
        if (!t) { problems.push(`${i.id}: unknown template`); continue; }
        if (t.class === 'G') { if (a) problems.push(`${i.id}: class G item has an authorization entry`); continue; }
        if (!a || a.scope_sha !== O.scopeSha(i, policy) || a.template !== i.template || JSON.stringify(a.params) !== JSON.stringify(i.params || {}) || JSON.stringify(a.deps) !== JSON.stringify(i.deps || [])) problems.push(`${i.id}: not authorized for this exact scope`); else authorizedA++;
        if (NOT_LOCAL.test(t.cmd)) problems.push(`${i.id}: cmd mentions remote/hosted/push/PR vocabulary (advisory screen)`);
        if ((t.touches || []).some((p) => O.PROTECTED_PATHS.some((x) => p.includes(x)))) problems.push(`${i.id}: class A template touches a protected path`);
      }
      for (const a of auths) if (!ids.includes(a.id)) problems.push(`${a.id}: authorization with no queue item`);
      add('3.scope', uniq && problems.length === 0 && authorizedA > 0 && authorizedA <= pl.maxClaims, `${authorizedA} class-A items exactly authorized, no class-G authorization, no unauthorized item${problems.length ? '; problems: ' + problems.join('; ') : ''}${uniq ? '' : '; duplicate ids'}`);
      if (skipSuite) add('4.suite-skipped', false, 'fail-closed suite skipped (test-only option): this run can never attest');
      else try { failClosedSuite(prot, q.items, worker, now, add); } catch (e) { add('4.fail-closed-suite', false, `suite error: ${String(e.message).split('\n')[0]}`); }
    }
    add('5.limits', Object.entries(CAPS).every(([k, v]) => Number.isInteger(pl[k]) && pl[k] > 0 && pl[k] <= v), `limits ${JSON.stringify(Object.fromEntries(Object.keys(CAPS).map((k) => [k, pl[k]])))} within caps ${JSON.stringify(CAPS)}`);
  }
  if (host) {
    try {
      const names = execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).split(/\r?\n/).filter(Boolean);
      add('5.docker', true, 'docker reachable'); add('5.no-leftovers', names.every((n) => !n.startsWith('cf1pilot-')), `leftover cf1pilot- containers: ${names.filter((n) => n.startsWith('cf1pilot-')).length}`);
    } catch { add('5.docker', false, 'docker not reachable'); }
    try { const s = fs.statfsSync(os.tmpdir()); add('5.disk', s.bavail * s.bsize >= 20 * 1024 ** 3, `free ${(s.bavail * s.bsize / 1024 ** 3).toFixed(1)} GiB (need 20)`); } catch { add('5.disk', false, 'cannot read disk space'); }
    try { const f = path.join(root, '.w'); fs.writeFileSync(f, 'x'); fs.rmSync(f); add('5.root-writable', true, root); } catch { add('5.root-writable', false, root); }
  } else add('5.host-skipped', false, 'host checks (docker, disk, root) skipped (test-only option): this run can never attest');
  // 6. deny rules: coverage from USER settings only, posture of all settings in force, live probe bound to settings + required list
  const rules = loadDenyRules(ruleFiles).rules; const { hashes } = loadDenyRules(settingsFiles);
  const cov = coverage(requiredDeny, rules);
  add('6.deny-static', cov.ok, cov.ok ? `all ${allVariantIds(requiredDeny).length} variants covered by ${rules.length} user-level deny rules` : `uncovered: ${cov.uncovered.join(', ')}`);
  const conf = allowedConflicts(requiredDeny, rules); add('6.pilot-work-not-denied', conf.length === 0, conf.length ? `deny rules block the pilot's own work: ${conf.map((c) => `${c.rule} blocks ${c.cmd}`).join('; ')}` : `${(requiredDeny.allowedCommands || []).length} representative pilot commands are not denied`);
  const ps = posture(settingsFiles); add('6.posture', ps.ok, ps.ok ? 'no bypass mode, no hooks configured' : ps.problems.join('; '));
  const pr = checkProbe(requiredDeny, probe, hashes, now, undefined, opts.requiredSha ?? sha256(fs.readFileSync(REQUIRED_PATH)));
  add('6.deny-probe', pr.ok, pr.ok ? 'live probe: every variant denied, settings and required list unchanged since' : pr.problems.join('; '));

  const ok = checks.every((c) => c.ok);
  const report = { at: new Date(now).toISOString(), ok, commit: prot?.commit, policySha: prot?.policySha, authSha: prot?.authSha, hashHowTo: 'git cat-file blob <commit>:<path> | sha256sum', settingsHashes: hashes, checks };
  fs.writeFileSync(path.join(root, 'PREFLIGHT_REPORT.json'), JSON.stringify(report, null, 2));
  if (ok) O.writeAttestation(root, { at: report.at, commit: prot.commit, policySha: prot.policySha, authSha: prot.authSha, settingsHashes: hashes, expiresAt: Math.min(now + prot.policy.pilot.maxHours * 3600000, Date.parse(prot.policy.pilot.not_after)) });
  cleanupTo(mark);
  return report;
}

// Exercises stop controls and fail-closed behavior with the real claim()/complete() code on the LIVE queue.
function failClosedSuite(prot, liveItems, worker, now, add) {
  const { policy } = prot; const wide = { ...policy.pilot, coordinator: worker, enabled: true, not_before: '2000-01-01T00:00:00Z', not_after: '2099-01-01T00:00:00Z', maxClaims: 100, maxCalls: 1000, maxWakeups: 1000 };
  const simPolicy = { ...policy, pilot: wide };
  const items = liveItems.map((i) => ({ id: i.id, template: i.template, params: i.params || {}, deps: i.deps || [] }));
  const hasG = items.some((i) => policy.templates[i.template]?.class === 'G');
  const gTemplate = Object.keys(policy.templates).find((k) => policy.templates[k].class === 'G');
  if (!hasG && gTemplate) items.push({ id: 'GSIM', template: gTemplate, params: {}, deps: [] });
  const authFor = (list, pol) => list.filter((i) => pol.templates[i.template]?.class === 'A').map((i) => ({ id: i.id, template: i.template, params: i.params, deps: i.deps, scope_sha: O.scopeSha(i, pol), by: 'owner' }));
  const r = tempRemote(simPolicy, authFor(items, simPolicy)); const att = { policySha: r.policySha, authSha: r.authSha };
  const out = []; const claim = (root, o = {}) => O.claim(root, { worker, source: r.source, now, settingsFiles: [], ...o });
  const reason = (c, re) => c.status === 'HALT' && re.test(c.reason);

  // happy path: hand out + complete every claimable class-A item THROUGH complete() so dependencies really clear
  let root = simRoot(items, att); const handed = [];
  for (let n = 0; n < 12; n++) { const c = claim(root); if (c.status !== 'CLAIMED') break; handed.push(c.item.template); if (O.complete(root, c.item, {}, r.source) !== 'DONE') break; }
  const aCount = items.filter((i) => policy.templates[i.template]?.class === 'A').length;
  out.push(['4.claims-work', handed.length === aCount, `${handed.length} of ${aCount} class-A items handed out and completed in simulation (dependencies cleared)`]);
  // class gate in isolation: the gated item must be PARKED by the class gate (not merely unauthorized)
  const gq = JSON.parse(fs.readFileSync(path.join(root, 'queue.json'), 'utf8')).items.filter((i) => policy.templates[i.template]?.class === 'G');
  out.push(['4.class-gate', gq.length > 0 && gq.every((i) => i.state === 'BLOCKED-OWNER' && /class G/.test(i.reason || '')) && !handed.some((t) => policy.templates[t].class === 'G'), `class-G items parked BLOCKED-OWNER by the class gate and never handed out (${gq.map((i) => i.id).join(',')})`]);
  // forged local state on a gated item cannot unlock it or its dependents
  const fq = JSON.parse(fs.readFileSync(path.join(root, 'queue.json'), 'utf8')); for (const i of fq.items) if (policy.templates[i.template]?.class === 'G') { i.state = 'OWNER-DONE'; i.class = 'A'; } fs.writeFileSync(path.join(root, 'queue.json'), JSON.stringify(fq));
  out.push(['4.forged-owner-done', claim(root).status !== 'CLAIMED', 'locally forged OWNER-DONE/class on a gated item hands out nothing']);
  // a policy whose authorizations name a class-G template is rejected as invalid
  const badAuths = [...authFor(items, simPolicy), ...(gTemplate ? [{ id: 'GAUTH', template: gTemplate, params: {}, deps: [], scope_sha: 'x', by: 'owner' }] : [])];
  const bad = tempRemote(simPolicy, badAuths); out.push(['4.auth-of-class-G-rejected', reason(O.claim(simRoot(items, { policySha: bad.policySha, authSha: bad.authSha }), { worker, source: bad.source, now, settingsFiles: [] }), /non-class-A/), 'an authorization naming a class-G template HALTs']);
  // stop control
  root = simRoot(items, att); O.stop(root, 'preflight'); out.push(['4.stop-file', claim(root).status === 'STOPPED', 'STOP file halts claim']); O.resume(root); out.push(['4.resume', claim(root).status === 'CLAIMED', 'resume restores claims']);
  // fail closed, each with its specific reason
  out.push(['4.unreachable-source', reason(claim(simRoot(items, att), { source: { ...r.source, url: path.join(r.base, 'nope.git') } }), /unavailable/), 'unreachable protected source HALTs (unavailable)']);
  out.push(['4.wrong-worker', reason(claim(simRoot(items, att), { worker: 'OTHER' }), /not the authorized coordinator/), 'unauthorized worker name HALTs']);
  out.push(['4.no-attestation', reason(claim(simRoot(items, null)), /attestation/), 'missing attestation HALTs']);
  out.push(['4.stale-attestation', reason(claim(simRoot(items, { policySha: 'x', authSha: 'y' })), /attestation/), 'attestation for other content HALTs']);
  out.push(['4.settings-drift', reason(claim(simRoot(items, att, { 'C:/x': 'aaaa' })), /permission settings changed/), 'deny/settings changes after the preflight HALT']);
  out.push(['4.duplicate-ids', reason(claim(simRoot([...items, { ...items[0] }], att)), /unique/), 'duplicate queue ids HALT']);
  const off = tempRemote({ ...simPolicy, pilot: { ...wide, enabled: false } }, authFor(items, simPolicy)); out.push(['4.remote-disable', reason(O.claim(simRoot(items, { policySha: off.policySha, authSha: off.authSha }), { worker, source: off.source, now, settingsFiles: [] }), /disabled/), 'enabled=false on the protected ref HALTs']);
  const lim = tempRemote({ ...simPolicy, pilot: { ...wide, maxClaims: 1 } }, authFor(items, simPolicy)); const lr = simRoot(items, { policySha: lim.policySha, authSha: lim.authSha });
  const first = O.claim(lr, { worker, source: lim.source, now, settingsFiles: [] }); if (first.status === 'CLAIMED') O.complete(lr, first.item, {}, lim.source);
  out.push(['4.limit-enforced', reason(O.claim(lr, { worker, source: lim.source, now, settingsFiles: [] }), /maxClaims/), 'maxClaims HALTs after the limit']);
  for (const [id, ok, d] of out) add(id, ok, d);
}

if (process.argv[1]?.endsWith('preflight.mjs')) {
  const a = process.argv.slice(2); const f = (n) => { const k = a.indexOf(`--${n}`); return k < 0 ? undefined : a[k + 1]; };
  const root = f('root'); if (!root || !f('expect-policy-sha') || !f('expect-auth-sha')) { console.error('usage: node preflight.mjs --root DIR --expect-policy-sha SHA --expect-auth-sha SHA [--probe FILE]'); process.exit(2); }
  const probe = f('probe') && fs.existsSync(f('probe')) ? JSON.parse(fs.readFileSync(f('probe'), 'utf8')) : null;
  const rep = runPreflight({ root, expectPolicySha: f('expect-policy-sha'), expectAuthSha: f('expect-auth-sha'), probe, requiredDeny: JSON.parse(fs.readFileSync(REQUIRED_PATH, 'utf8')), settingsFiles: defaultSettingsFiles(), ruleFiles: ruleSettingsFiles() });
  for (const c of rep.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.detail}`);
  console.log(rep.ok ? '\nPREFLIGHT PASSED: attestation written. No unattended execution before this point.' : '\nPREFLIGHT FAILED: no attestation; the loop will HALT.');
  process.exit(rep.ok ? 0 : 1);
}
