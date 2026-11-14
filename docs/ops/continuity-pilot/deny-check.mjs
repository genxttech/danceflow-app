// Static check of Claude Code permission settings against the pilot's required deny coverage, plus validation of the
// live-probe evidence file. Read-only: never edits settings. The static matcher is an APPROXIMATION of Claude Code's matcher
// (it is deliberately conservative: case-sensitive, absolute-path forms only count everywhere, relative forms only under the
// session cwd). The live probe is the authority and is required. Both the probe file and the attestation are self-reported
// local evidence for a cooperative agent; they are not tamper-proof.
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const SESSION_CWD = 'C:/Dev/studioapp';
// Files hashed for change detection (rule files + project files that can alter behavior).
const MANAGED = ['C:/ProgramData/ClaudeCode/managed-settings.json', 'C:/Program Files/ClaudeCode/managed-settings.json'];
export const defaultSettingsFiles = (cwd = process.cwd()) => [...new Set([path.join(os.homedir(), '.claude', 'settings.json'), ...[SESSION_CWD, slash(cwd)].flatMap((c) => [`${c}/.claude/settings.json`, `${c}/.claude/settings.local.json`]), ...MANAGED].map((f) => slash(f)))];
// Only USER (or managed) settings count toward coverage: project files apply only when the session cwd is that project.
export const ruleSettingsFiles = () => [path.join(os.homedir(), '.claude', 'settings.json')];
export const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
const slash = (p) => String(p).replaceAll('\\', '/');
// c:\x, C:/x and /c/x all become c:/x ; case of the rest is preserved (matching is case-sensitive, drive letter aside)
const norm = (p) => slash(p).replace(/^\/([A-Za-z])\//, (_, d) => `${d.toLowerCase()}:/`).replace(/^([A-Za-z]):\//, (_, d) => `${d.toLowerCase()}:/`);

export function bashMatch(spec, cmd) {
  const m = /^(.*):\*$/.exec(spec);
  const body = (s) => s.split('*').map(esc).join('.*');
  const re = m ? new RegExp(`^${body(m[1])}(\\s.*)?$`) : new RegExp(`^${body(spec)}$`);
  return re.test(cmd.trim());
}

// Claude Code path rule forms: //abs (absolute), ~/ (home), /x (project root), x or **/x (relative to cwd).
export function pathMatch(spec, p, cwd = SESSION_CWD) {
  let s = slash(spec); const target = norm(p);
  if (s.startsWith('//')) s = norm(s.slice(1));               // //c/Users/... -> c:/Users/...
  else if (s.startsWith('~/')) s = norm(slash(os.homedir()) + s.slice(1));
  else {                                                      // relative forms only protect paths under the session cwd
    const base = norm(cwd).replace(/\/$/, '');
    if (!(target === base || target.startsWith(base + '/'))) return false;
    s = base + '/' + s.replace(/^\/+/, '');
  }
  const core = s.split('**').map((seg) => seg.split('*').map(esc).join('[^/]*')).join('.*');
  return new RegExp(`^${core.replaceAll('/.*/', '/(.*/)?')}$`).test(target);
}

const parse = (r) => { const m = /^(\w+)\((.*)\)$/.exec(r); return m ? { tool: m[1], spec: m[2] } : null; };
const toolRuleCovers = (rule, tool) => rule === tool || tool.startsWith(rule + '__') || (rule.endsWith('__*') && tool.startsWith(rule.slice(0, -1)));

export function loadDenyRules(files) {
  const rules = []; const hashes = {};
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const raw = fs.readFileSync(f); hashes[f] = crypto.createHash('sha256').update(raw).digest('hex');
    try { for (const r of JSON.parse(raw.toString('utf8'))?.permissions?.deny || []) rules.push({ r, file: f }); } catch { /* unreadable settings count as no rules */ }
  }
  return { rules, hashes };
}

export function coverage(required, denyRules) {
  const parsed = denyRules.map((d) => ({ ...parse(d.r), raw: d.r })).filter((x) => x.tool);
  const uncovered = [];
  for (const v of required.bashVariants) if (!parsed.some((p) => p.tool === v.tool && bashMatch(p.spec, v.cmd))) uncovered.push(v.id);
  for (const v of required.editVariants) if (!parsed.some((p) => p.tool === v.tool && pathMatch(p.spec, v.path))) uncovered.push(v.id);
  for (const v of required.toolVariants || []) if (!denyRules.some((d) => !parse(d.r) && toolRuleCovers(d.r, v.tool))) uncovered.push(v.id);
  return { ok: uncovered.length === 0, uncovered };
}

export const allVariantIds = (required) => [...required.bashVariants, ...required.editVariants, ...(required.toolVariants || [])].map((v) => v.id);

// Settings posture: the allow side and mode. Fails on bypass mode or any configured hooks.
export function posture(files) {
  const problems = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    let s; try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { problems.push(`${f}: unreadable settings`); continue; }
    if (s?.permissions?.defaultMode === 'bypassPermissions') problems.push(`${f}: defaultMode is bypassPermissions`);
    const h = s?.hooks; if (h && (Array.isArray(h) ? h.length : Object.keys(h).length)) problems.push(`${f}: hooks are configured`);
    if (s?.enabledPlugins && Object.values(s.enabledPlugins).some(Boolean)) problems.push(`${f}: plugins are enabled (plugins can carry hooks)`);
  }
  return { ok: problems.length === 0, problems };
}

// Probe evidence: { at, requiredSha, settingsHashes, results: [{ id, denied: true }] } covering EVERY required variant id.
export function checkProbe(required, probe, settingsHashes, now = Date.now(), maxAgeMs = 24 * 3600000, requiredSha) {
  const problems = [];
  if (!probe || !Array.isArray(probe.results)) return { ok: false, problems: ['probe file missing or malformed'] };
  const age = now - Date.parse(probe.at);
  if (!(age >= -60000 && age < maxAgeMs)) problems.push('probe future-dated, older than 24h or undated');
  if (requiredSha !== undefined && probe.requiredSha !== requiredSha) problems.push('probe was recorded against a different required-deny list');
  if (JSON.stringify(probe.settingsHashes) !== JSON.stringify(settingsHashes)) problems.push('settings changed since the probe');
  for (const id of allVariantIds(required)) {
    const r = probe.results.find((x) => x.id === id);
    if (!r) problems.push(`no probe result for ${id}`); else if (r.denied !== true) problems.push(`${id} was NOT denied`);
  }
  return { ok: problems.length === 0, problems };
}

// Representative commands the pilot's authorized work legitimately needs must NOT be denied by the installed rules.
export function allowedConflicts(required, denyRules) {
  const parsed = denyRules.map((d) => ({ ...parse(d.r), raw: d.r })).filter((x) => x.tool === 'Bash' || x.tool === 'PowerShell');
  const hits = [];
  for (const cmd of required.allowedCommands || []) for (const p of parsed) if (bashMatch(p.spec, cmd)) { hits.push({ cmd, rule: p.raw }); break; }
  return hits;
}
