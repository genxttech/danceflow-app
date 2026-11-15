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
// The verified code directory (the one `claim` checked byte-for-byte against the reviewed copy on the protected ref).
// Policy strings use the placeholder {CODE}; it is resolved to this directory, so the child can only ever run the pinned scripts.
export const CODE_DIR = HERE.replaceAll('\\', '/');
export const CODE_PLACEHOLDER = '{CODE}';
export const resolveCode = (s, codeDir = CODE_DIR) => String(s).replaceAll(CODE_PLACEHOLDER, codeDir);
export const SCRIPTS = ['phase2/scripts/run_u18s2.sh', 'phase2/scripts/apply_sql.sh', 'phase2/scripts/psql_sql.sh', 'phase2/scripts/git_read.sh'];

export const CLAUDE_VERSION = '2.1.321';
export const CHILD_TOOLS = 'Bash,Read,Edit,Write,Glob,Grep';
export const CHILD_FLAGS = ['--restricted', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--no-session-persistence', '--disable-slash-commands', '--output-format', 'stream-json', '--verbose'];
// Second layer: shell syntax that smuggles a second command or a file write through an allowed prefix, git/psql arguments that
// read arbitrary files or run programs, host-information and interpreter commands, sensitive names, and docker reads.
export const EXTRA_DENY = ['Bash(*>*)', 'Bash(*>>*)', 'Bash(*$(*)', 'Bash(*`*)', 'Bash(*/../*)', 'Bash(*--output*)', 'Bash(*--exec*)', 'Bash(*--upload-pack*)', 'Bash(*--git-dir*)', 'Bash(*--work-tree*)', 'Bash(*<*)', 'Bash(*;*)', 'Bash(*&*)', 'Bash(*||*)', 'Bash(*|*)',
  // git argument escapes (review 2026-11-15): arbitrary-file reads, external programs, message-from-file, history rewrite, config injection
  'Bash(*--no-index*)', 'Bash(*pathspec-from-file*)', 'Bash(*--ext-diff*)', 'Bash(*--textconv*)', 'Bash(* -F *)', 'Bash(*--file*)', 'Bash(*--amend*)', 'Bash(*--exec-path*)', 'Bash(*--config*)', 'Bash(*core.hooksPath*)', 'Bash(*core.sshCommand*)',
  // psql meta-commands (\\! \\o \\copy ...) and server-side program/file/network features: any backslash is refused; COPY ... PROGRAM, large-object and file functions, dblink/fdw
  'Bash(*\\\\*)', 'Bash(*PROGRAM*)', 'Bash(*program*)', 'Bash(*Program*)', 'Bash(*pg_read_file*)', 'Bash(*pg_read_binary_file*)', 'Bash(*pg_ls_dir*)', 'Bash(*lo_import*)', 'Bash(*lo_export*)', 'Bash(*dblink*)', 'Bash(*postgres_fdw*)',
  // a later -h/--host/connection string would override the pinned `-h localhost`
  'Bash(*-h *-h *)', 'Bash(*--host*)', 'Bash(*://*)', 'Bash(*host=*)', 'Bash(*PGHOST*)',
  // host-information and interpreter commands the harness would otherwise auto-approve, and sensitive-looking file names (defense in depth)
  'Bash(ps*)', 'Bash(netstat*)', 'Bash(whoami*)', 'Bash(hostname*)', 'Bash(id)', 'Bash(id *)', 'Bash(uname*)', 'Bash(which *)', 'Bash(node *)', 'Bash(python*)', 'Bash(printenv*)', 'Bash(env)', 'Bash(env *)',
  'Bash(*.env*)', 'Bash(*.pem*)', 'Bash(*id_rsa*)', 'Bash(*credentials*)', 'Bash(*.npmrc*)', 'Bash(*.key*)',
  // commands the real harness auto-approves WITHOUT path confinement (found by the isolation test and census, 2026-11-14)
  'Bash(type *)', 'Bash(tree*)', 'Bash(du *)', 'Bash(df*)', 'Bash(readlink*)', 'Bash(realpath*)', 'Bash(basename*)', 'Bash(dirname*)',
  // read-only docker subcommands are auto-approved for ANY container (other coordinators' stacks): the child may only exec into cf1pilot-qN
  'Bash(docker ps*)', 'Bash(docker images*)', 'Bash(docker inspect*)', 'Bash(docker logs*)', 'Bash(docker top*)', 'Bash(docker stats*)', 'Bash(docker port*)', 'Bash(docker diff*)', 'Bash(docker history*)', 'Bash(docker events*)', 'Bash(docker container *)', 'Bash(docker image *)', 'Bash(docker cp*)', 'Bash(docker run*)', 'Bash(docker network*)', 'Bash(docker volume*)'];
export const CAPS = { maxBudgetUsd: 10, timeoutMs: 3600000 };

// Every Bash allow rule must match one of these reviewed families (wildcard families first, then exact commands).
// git add/commit are NOT allowed to the child: the driver stages and commits (hooks disabled) after verifying what changed.
export const WILDCARD_FAMILIES = [
  // git read commands WITH arguments go only through a reviewed helper that validates argv against per-subcommand allowlists
  // (review 2026-11-15, P2-2): raw `git <sub> *` is never allowed, so no flag such as --no-index/-O/--ext-diff can reach git.
  /^bash \{CODE\}\/phase2\/scripts\/git_read\.sh C:\/Dev\/[A-Za-z0-9_-][A-Za-z0-9._-]* (ls-tree|show|cat-file|log|rev-parse|diff|status) \*$/,
  // pg_dump/pg_restore run only inside a disposable cf1pilot-qN container that has NO network (run_u18s2.sh starts it with --network none)
  /^docker exec( -i)?( -e [A-Z_]+=[A-Za-z0-9_]+)* cf1pilot-q[0-9]+ (pg_dump|pg_restore|pg_isready)( [A-Za-z0-9_@:=.\/-]+)* \*$/,
  // the ONLY SQL path: a reviewed helper that refuses backslashes (psql meta-commands), PROGRAM and server-side file/large-object/network features
  /^bash \{CODE\}\/phase2\/scripts\/psql_sql\.sh cf1pilot-q[0-9]+ (postgres|supabase_admin) \*$/,
  // reviewed helper: applies one host migration .sql file (the helper itself enforces df-u18* migrations tree only, real path, no "..")
  /^bash \{CODE\}\/phase2\/scripts\/apply_sql\.sh cf1pilot-q[0-9]+ (postgres|supabase_admin) C:\/Dev\/df-u18[A-Za-z0-9._-]*\/\*$/,
];
export const EXACT_FAMILIES = [
  /^KEEP=1 SUITES=none IMG=ns1-base:snap bash \{CODE\}\/phase2\/scripts\/run_u18s2\.sh cf1pilot-q[0-9]+ (none|u18|u18s|both) C:\/Dev\/cpilot-iso\/work\/[a-z0-9-]+\/[A-Za-z0-9._-]+$/,
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
  if (t.containers !== undefined && !(Array.isArray(t.containers) && t.containers.every((c) => /^cf1pilot-q[0-9]+$/.test(c)))) fail('containers must be cf1pilot-qN names');
  if (t.commit !== undefined) { // the DRIVER (not the child) stages and commits these paths, hooks disabled
    const c = t.commit;
    if (!c || typeof c !== 'object' || !t.addDirs.includes(c.dir)) fail('commit.dir must be one of the template addDirs');
    if (!Array.isArray(c.paths) || c.paths.length === 0 || !c.paths.every((p) => /^[A-Za-z0-9._\/-]+\/$/.test(p) && !/(^|\/)\.\.(\/|$)/.test(p) && !/(^|\/)\.git(\/|$)/.test(p))) fail('commit.paths must be repo-relative directory prefixes ending in /');
    if (typeof c.message !== 'string' || c.message.length < 5 || c.message.length > 120 || /[\n\r]/.test(c.message)) fail('commit.message must be a single line of 5 to 120 characters');
  }
  for (const r of t.allow) {
    const m = BASH_RULE.exec(r);
    if (m) {
      const spec = m[1];
      const SHELL_META = /[;&|<>$`\n\\]/;
      if (SHELL_META.test(spec.endsWith(' *') ? spec.slice(0, -2) : spec)) fail(`shell metacharacter in allow rule: ${r}`);
      if (!(WILDCARD_FAMILIES.some((re) => re.test(spec)) || EXACT_FAMILIES.some((re) => re.test(spec)))) fail(`Bash allow rule outside the reviewed families: ${r}`);
      for (const v of required.bashVariants) if (bashMatch(resolveCode(spec), v.cmd)) fail(`allow rule ${r} would permit protected variant ${v.id}`);
    } else if (FILE_TOOL.test(r)) {
      const tool = r.slice(0, r.indexOf('(')); const spec = r.slice(r.indexOf('(') + 1, -1);
      if (/(^|\/)\.\.(\/|$)/.test(spec)) fail(`file allow rule contains a ".." segment: ${r}`);
      // overlap with a protected GLOB (not just the specific protected files): test a concrete sample path under the allow rule
      const sample = spec.replace(/^\/\/c\//, 'C:/').replaceAll('**', 'x/x').replaceAll('*', 'x');
      for (const d of required.recommendedRules) { const dm = /^(Read|Edit|Write)\((.*)\)$/.exec(d); if (dm && dm[1] === tool && pathMatch(dm[2], sample)) fail(`file allow rule ${r} overlaps protected deny glob ${d}`); }
      // deny wins over allow: an allowed glob may only overlap a protected target that a deny rule of the same tool also covers
      const denied = (p) => required.recommendedRules.some((d) => { const dm = /^(Read|Edit|Write)\((.*)\)$/.exec(d); return dm && dm[1] === tool && pathMatch(dm[2], p); });
      for (const v of required.editVariants) if (v.tool === tool || (tool === 'Edit' && v.tool === 'Write')) for (const p of [v.path, v.probePath].filter(Boolean)) if (pathMatch(spec, p) && !denied(p)) fail(`file allow rule ${r} would permit protected target ${v.id}`);
      const dirs = t.addDirs.map((d) => `//c/Dev/${d.slice('C:/Dev/'.length)}`);
      if (!dirs.some((d) => spec === `${d}/**` || spec.startsWith(`${d}/`))) fail(`file allow rule ${r} must stay inside the template addDirs`);
      // writes must not be wider than what the driver may commit (review 2026-11-15, P2-3): anything else would only fail the item
      if (t.commit && (tool === 'Write' || tool === 'Edit')) {
        const roots = t.commit.paths.map((p) => `//c/Dev/${t.commit.dir.slice('C:/Dev/'.length)}/${p}`);
        if (!roots.some((root) => spec.startsWith(root))) fail(`write allow rule ${r} must stay inside commit.paths`);
      }
    } else fail(`unsupported allow rule form: ${r}`);
  }
}

export function childSettings(t, required = loadRequired(), codeDir = CODE_DIR) {
  return { permissions: { defaultMode: 'dontAsk', allow: t.allow.map((r) => resolveCode(r, codeDir)), deny: [...required.recommendedRules, ...EXTRA_DENY] }, disableAllHooks: true, enableAllProjectMcpServers: false };
}

const lfSha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(HERE, f), 'utf8').replaceAll('\r\n', '\n')).digest('hex'); } catch { return null; } };

// Deterministic hash over everything that defines the child's authority (including the executed scripts' contents).
// The attestation and the isolation report bind to it.
export function childConfigSha(policy, required = loadRequired()) {
  const tpl = Object.fromEntries(Object.entries(policy.templates).filter(([, t]) => t.class === 'A').map(([n, t]) => [n, { allow: t.allow, examples: t.examples, addDirs: t.addDirs, cwd: t.cwd, model: t.model, maxBudgetUsd: t.maxBudgetUsd, timeoutMs: t.timeoutMs, containers: t.containers, commit: t.commit }]));
  return crypto.createHash('sha256').update(JSON.stringify({ v: CLAUDE_VERSION, tools: CHILD_TOOLS, flags: CHILD_FLAGS, extraDeny: EXTRA_DENY, deny: required.recommendedRules, scripts: SCRIPTS.map(lfSha), tpl })).digest('hex');
}

export function childArgs({ prompt, settingsPath, tpl }) {
  return ['-p', prompt, ...CHILD_FLAGS, '--tools', CHILD_TOOLS, '--settings', settingsPath, '--model', tpl.model, '--max-budget-usd', String(tpl.maxBudgetUsd), ...tpl.addDirs.flatMap((d) => ['--add-dir', d])];
}

// Minimal environment for the child. No API key or OAuth token is passed: the CLI uses its own stored login, so allowed
// commands, git hooks and anything else the child runs cannot read the owner's model credential from the environment.
// Git inside the child and in the driver ignores the owner's global and system git config (aliases, pager/fsmonitor commands,
// url rewrites, credential helper; review 2026-11-15, P2-1): GIT_CONFIG_GLOBAL points at an empty file.
export function childEnv(extra = {}) {
  const keep = ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH'];
  const git = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  return { ...Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])), ...git, ...extra };
}

// Every example command a template says it needs must be matched by one of its own allow rules and by NO deny rule.
export function checkExamples(tpl, required = loadRequired()) {
  const allow = tpl.allow.map((r) => BASH_RULE.exec(resolveCode(r))?.[1]).filter(Boolean);
  const deny = childSettings(tpl, required).permissions.deny.map((r) => BASH_RULE.exec(r)?.[1]).filter(Boolean);
  const problems = [];
  for (const raw of tpl.examples) {
    const ex = resolveCode(raw);
    if (!allow.some((s) => bashMatch(s, ex))) problems.push(`example not allowed by any allow rule: ${raw}`);
    const hit = deny.find((s) => bashMatch(s, ex)); if (hit) problems.push(`example blocked by deny rule Bash(${hit}): ${raw}`);
  }
  return problems;
}
