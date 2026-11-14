// Isolated-child configuration for Phase 2 (option A). Everything the pilot's model process is allowed to do is derived HERE,
// from the owner-authorized policy template (protected ref) plus constants in reviewed code. Nothing global is touched:
// the child runs with --restricted (user/project/local settings ignored), its own --settings file, only the named tools,
// no MCP servers, default-deny permissions (dontAsk) and no one to answer prompts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bashMatch, pathMatch } from './deny-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CLAUDE_VERSION = '2.1.321';
export const CHILD_TOOLS = 'Bash,Read,Edit,Write,Glob,Grep';
export const CHILD_FLAGS = ['--restricted', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--no-session-persistence', '--disable-slash-commands', '--output-format', 'stream-json', '--verbose'];
// Second layer: classes of shell syntax that smuggle a second command or a file write through an allowed prefix.
export const EXTRA_DENY = ['Bash(*>*)', 'Bash(*>>*)', 'Bash(*$(*)', 'Bash(*`*)', 'Bash(*/../*)', 'Bash(*--output*)', 'Bash(*--exec*)', 'Bash(*--upload-pack*)', 'Bash(*--git-dir*)', 'Bash(*--work-tree*)', 'Bash(*<*)', 'Bash(*;*)', 'Bash(*&&*)', 'Bash(*||*)', 'Bash(*|*)',
  // host-information and interpreter commands the harness would otherwise auto-approve, and sensitive-looking file names (defense in depth)
  'Bash(ps*)', 'Bash(netstat*)', 'Bash(whoami*)', 'Bash(hostname*)', 'Bash(id)', 'Bash(id *)', 'Bash(uname*)', 'Bash(which *)', 'Bash(node *)', 'Bash(python*)', 'Bash(printenv*)', 'Bash(env)', 'Bash(env *)',
  'Bash(*.env*)', 'Bash(*.pem*)', 'Bash(*id_rsa*)', 'Bash(*credentials*)', 'Bash(*.npmrc*)', 'Bash(*.key*)',
  // commands the real harness auto-approves WITHOUT path confinement (found by the isolation test and census, 2026-11-14)
  'Bash(type *)', 'Bash(tree*)', 'Bash(du *)', 'Bash(df*)', 'Bash(readlink*)', 'Bash(realpath*)', 'Bash(basename*)', 'Bash(dirname*)',
  // read-only docker subcommands are auto-approved for ANY container (other coordinators' stacks): the child may only exec into cf1pilot-qN
  'Bash(docker ps*)', 'Bash(docker images*)', 'Bash(docker inspect*)', 'Bash(docker logs*)', 'Bash(docker top*)', 'Bash(docker stats*)', 'Bash(docker port*)', 'Bash(docker diff*)', 'Bash(docker history*)', 'Bash(docker events*)', 'Bash(docker container *)', 'Bash(docker image *)'];
export const CAPS = { maxBudgetUsd: 10, timeoutMs: 3600000 };

// Every Bash allow rule must match one of these reviewed families (wildcard families first, then exact commands).
export const WILDCARD_FAMILIES = [
  /^git -C C:\/Dev\/[A-Za-z0-9._-]+ (ls-tree|show|cat-file|log|rev-parse|diff|status|add|commit -m|worktree list) \*$/,
  /^docker exec( -i)?( -e [A-Z_]+=[A-Za-z0-9_]+)* cf1pilot-q[0-9]+ (psql|pg_dump|pg_restore|pg_isready)( [A-Za-z0-9_@:=.\/-]+)* \*$/,
  // reviewed helper: applies one host .sql file (the helper itself enforces .sql, C:/Dev/<dir>/, no "..")
  /^bash C:\/Dev\/studioapp\/docs\/ops\/continuity-pilot\/phase2\/scripts\/apply_sql\.sh cf1pilot-q[0-9]+ (postgres|supabase_admin) C:\/Dev\/[A-Za-z0-9._-]+\/\*$/,
];
export const EXACT_FAMILIES = [
  /^KEEP=1 SUITES=none IMG=[A-Za-z0-9:._-]+ bash C:\/Dev\/studioapp\/docs\/ops\/continuity-pilot\/phase2\/scripts\/run_u18s2\.sh cf1pilot-q[0-9]+ (none|u18|u18s|both) C:\/Dev\/cpilot-iso\/work\/[a-z0-9-]+\/[A-Za-z0-9._-]+$/,
  /^docker rm -f -v cf1pilot-q[0-9]+$/,
  /^bash -n C:\/Dev\/df-pilot-runner\/scripts\/qa\/[A-Za-z0-9._-]+\.sh$/,
  /^git -C C:\/Dev\/[A-Za-z0-9._-]+ (status|rev-parse HEAD|log --oneline -[0-9]+|branch --show-current|worktree list)$/,
];
const FILE_TOOL = /^(Read|Glob|Grep|Edit|Write)\(\/\/c\/Dev\/[A-Za-z0-9._\-/*]+\)$/;
const BASH_RULE = /^Bash\((.+)\)$/;

export const loadRequired = () => JSON.parse(fs.readFileSync(path.join(HERE, 'phase2', 'required-deny.json'), 'utf8'));

// Throws on any unsafe template: used by validatePolicy for every class-A template.
export function validateTemplateIsolation(name, t, required = loadRequired()) {
  const fail = (m) => { throw new Error(`template ${name}: ${m}`); };
  if (!Array.isArray(t.allow) || t.allow.length === 0 || !t.allow.every((r) => typeof r === 'string')) fail('allow must be a non-empty array of rule strings');
  if (!Array.isArray(t.examples) || !t.examples.every((r) => typeof r === 'string')) fail('examples must be an array of command strings');
  if (!Array.isArray(t.addDirs) || !t.addDirs.every((d) => /^C:\/Dev\/[A-Za-z0-9._-]+$/.test(d))) fail('addDirs must be directories directly under C:/Dev');
  if (typeof t.cwd !== 'string' || !/^[a-z0-9-]+$/.test(t.cwd)) fail('cwd must be a short scratch directory name');
  if (typeof t.model !== 'string' || !/^[a-z0-9.-]+$/.test(t.model)) fail('model missing');
  if (!(t.maxBudgetUsd > 0 && t.maxBudgetUsd <= CAPS.maxBudgetUsd)) fail(`maxBudgetUsd must be in (0, ${CAPS.maxBudgetUsd}]`);
  if (!(Number.isInteger(t.timeoutMs) && t.timeoutMs > 0 && t.timeoutMs <= CAPS.timeoutMs)) fail(`timeoutMs must be an integer in (0, ${CAPS.timeoutMs}]`);
  for (const r of t.allow) {
    const m = BASH_RULE.exec(r);
    if (m) {
      const spec = m[1];
      const SHELL_META = /[;&|<>$`\n]/;
      if (SHELL_META.test(spec.endsWith(' *') ? spec.slice(0, -2) : spec)) fail(`shell metacharacter in allow rule: ${r}`);
      if (!(WILDCARD_FAMILIES.some((re) => re.test(spec)) || EXACT_FAMILIES.some((re) => re.test(spec)))) fail(`Bash allow rule outside the reviewed families: ${r}`);
      for (const v of required.bashVariants) if (bashMatch(spec, v.cmd)) fail(`allow rule ${r} would permit protected variant ${v.id}`);
    } else if (FILE_TOOL.test(r)) {
      const tool = r.slice(0, r.indexOf('(')); const spec = r.slice(r.indexOf('(') + 1, -1);
      if (/(^|\/)\.\.(\/|$)/.test(spec)) fail(`file allow rule contains a ".." segment: ${r}`);
      // overlap with a protected GLOB (not just the specific protected files): test a concrete sample path under the allow rule
      const sample = spec.replace(/^\/\/c\//, 'C:/').replaceAll('**', 'x/x').replaceAll('*', 'x');
      for (const d of required.recommendedRules) { const dm = /^(Read|Edit|Write)\((.*)\)$/.exec(d); if (dm && dm[1] === tool && pathMatch(dm[2], sample)) fail(`file allow rule ${r} overlaps protected deny glob ${d}`); }
      for (const v of required.editVariants) if (v.tool === tool || (tool === 'Edit' && v.tool === 'Write')) if (pathMatch(spec, v.path) || (v.probePath && pathMatch(spec, v.probePath))) fail(`file allow rule ${r} would permit protected target ${v.id}`);
      const dirs = t.addDirs.map((d) => `//c/Dev/${d.slice('C:/Dev/'.length)}`);
      if (!dirs.some((d) => spec === `${d}/**` || spec.startsWith(`${d}/`))) fail(`file allow rule ${r} must stay inside the template addDirs`);
    } else fail(`unsupported allow rule form: ${r}`);
  }
}

export function childSettings(t, required = loadRequired()) {
  return { permissions: { defaultMode: 'dontAsk', allow: [...t.allow], deny: [...required.recommendedRules, ...EXTRA_DENY] }, disableAllHooks: true, enableAllProjectMcpServers: false };
}

// Deterministic hash over everything that defines the child's authority. The attestation and the isolation report bind to it.
export function childConfigSha(policy, required = loadRequired()) {
  const tpl = Object.fromEntries(Object.entries(policy.templates).filter(([, t]) => t.class === 'A').map(([n, t]) => [n, { allow: t.allow, examples: t.examples, addDirs: t.addDirs, cwd: t.cwd, model: t.model, maxBudgetUsd: t.maxBudgetUsd, timeoutMs: t.timeoutMs }]));
  return crypto.createHash('sha256').update(JSON.stringify({ v: CLAUDE_VERSION, tools: CHILD_TOOLS, flags: CHILD_FLAGS, extraDeny: EXTRA_DENY, deny: required.recommendedRules, tpl })).digest('hex');
}

export function childArgs({ prompt, settingsPath, tpl }) {
  return ['-p', prompt, ...CHILD_FLAGS, '--tools', CHILD_TOOLS, '--settings', settingsPath, '--model', tpl.model, '--max-budget-usd', String(tpl.maxBudgetUsd), ...tpl.addDirs.flatMap((d) => ['--add-dir', d])];
}

// Minimal environment for the child: no tokens or secrets from the parent except what the CLI needs to authenticate.
export function childEnv(extra = {}) {
  const keep = ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
  return { ...Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])), ...extra };
}

// Every example command a template says it needs must be matched by one of its own allow rules and by NO deny rule.
export function checkExamples(tpl, required = loadRequired()) {
  const allow = tpl.allow.map((r) => BASH_RULE.exec(r)?.[1]).filter(Boolean);
  const deny = childSettings(tpl, required).permissions.deny.map((r) => BASH_RULE.exec(r)?.[1]).filter(Boolean);
  const problems = [];
  for (const ex of tpl.examples) {
    if (!allow.some((s) => bashMatch(s, ex))) problems.push(`example not allowed by any allow rule: ${ex}`);
    const hit = deny.find((s) => bashMatch(s, ex)); if (hit) problems.push(`example blocked by deny rule Bash(${hit}): ${ex}`);
  }
  return problems;
}
