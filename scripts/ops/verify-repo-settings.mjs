#!/usr/bin/env node
// Read-only comparison of a repository's live GitHub settings with a saved baseline, for use around a repository
// transfer or visibility change. It changes no setting: every request is a GET, except the one that issues a
// short-lived installation token, which is requested with read permissions only. Tokens are never printed.
//
// Usage:
//   node scripts/ops/verify-repo-settings.mjs --baseline <dir> --repo <owner/name> --app-id <id> --app-key <pem file>
//        [--expect private|public] [--owner-type Organization|User] [--pr <number>] [--verbose]
//
// The baseline directory holds the saved API responses: repo.json, workflows.json, environments.json,
// env_branch_policies_<environment>.json, ruleset_<id>.json and github_app_installation.json.
//
// Exit code: 0 every automated check passed; 1 at least one difference; 2 something could not be verified.
// Checks that this token cannot make are listed as MANUAL at the end and never count as passed.
import { createPrivateKey, createSign } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const READ_ONLY_PERMISSIONS = { actions: "read", contents: "read", metadata: "read", pull_requests: "read" };
const REPO_SETTINGS = ["default_branch", "allow_squash_merge", "allow_merge_commit", "allow_rebase_merge", "allow_auto_merge", "delete_branch_on_merge", "allow_update_branch", "web_commit_signoff_required", "has_issues", "has_wiki", "has_pages", "has_discussions", "pull_request_creation_policy", "archived"];
// GitHub shows these only to a token that can write contents, which this script deliberately never requests.
const SETTINGS_HIDDEN_FROM_READERS = new Set(["allow_squash_merge", "allow_merge_commit", "allow_rebase_merge", "allow_auto_merge", "delete_branch_on_merge", "allow_update_branch"]);
const PROBE_BRANCH_LEAF = "settings-verification-probe";

export const MANUAL_CHECKS = [
  "Ruleset bypass actors (visible to repository administrators only).",
  "Secret scanning and push protection are enabled.",
  "Actions policy, fork approval and default workflow token permissions.",
  "Repository and environment secret names, and webhooks.",
  "Enforcement: a direct push to the default branch, a force push to a release branch and an unapproved change to a code-owned path are each refused.",
  "An environment-gated workflow waits for its reviewer (cancel it without approving).",
  "Hosting builds, scheduled jobs and every local clone still work.",
];

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const show = (v) => (v === undefined ? "(absent)" : JSON.stringify(v));

/** Differences between two JSON values, as "path: baseline X, live Y" lines. */
export function diff(expected, actual, path = "") {
  if (isObject(expected) && isObject(actual)) {
    return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort().flatMap((k) => diff(expected[k], actual[k], path ? `${path}.${k}` : k));
  }
  if (Array.isArray(expected) && Array.isArray(actual) && expected.length === actual.length) {
    return expected.flatMap((v, i) => diff(v, actual[i], `${path}[${i}]`));
  }
  return JSON.stringify(expected) === JSON.stringify(actual) ? [] : [`${path || "value"}: baseline ${show(expected)}, live ${show(actual)}`];
}

const byKey = (key) => (a, b) => String(key(a)).localeCompare(String(key(b)));
const sorted = (list) => (Array.isArray(list) ? [...list].sort(byKey((v) => JSON.stringify(v))) : list);

/** Rules keyed by type, with the order of unordered lists removed. */
export function normalizeRules(rules) {
  const out = {};
  for (const rule of rules ?? []) {
    const p = isObject(rule.parameters) ? { ...rule.parameters } : null;
    if (p?.required_status_checks) p.required_status_checks = [...p.required_status_checks].sort(byKey((c) => c.context));
    if (p?.allowed_merge_methods) p.allowed_merge_methods = sorted(p.allowed_merge_methods);
    if (p?.required_reviewers) p.required_reviewers = sorted(p.required_reviewers);
    out[rule.type] = p;
  }
  return out;
}

const normalizeRuleset = (r) => ({
  target: r.target,
  enforcement: r.enforcement,
  include: sorted(r.conditions?.ref_name?.include),
  exclude: sorted(r.conditions?.ref_name?.exclude),
  other_conditions: Object.keys(r.conditions ?? {}).filter((k) => k !== "ref_name").sort(),
  rules: normalizeRules(r.rules),
  current_user_can_bypass: r.current_user_can_bypass,
});

const normalizeEnvironment = (e) => ({
  can_admins_bypass: e.can_admins_bypass,
  deployment_branch_policy: e.deployment_branch_policy,
  protection_rules: Object.fromEntries(
    (e.protection_rules ?? []).map((rule) => {
      const { id: _id, node_id: _node, type, reviewers, ...rest } = rule;
      if (reviewers) rest.reviewers = reviewers.map((r) => ({ type: r.type, name: r.reviewer?.login ?? r.reviewer?.slug, id: r.reviewer?.id })).sort(byKey((r) => `${r.type}:${r.name}`));
      return [type, rest];
    }),
  ),
});

const normalizePolicies = (body) => sorted((body.branch_policies ?? []).map((p) => ({ name: p.name, type: p.type })));

export function loadBaseline(dir) {
  const read = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
  const names = readdirSync(dir);
  const rulesets = names.filter((n) => /^ruleset_[^.]+\.json$/.test(n)).sort().map(read);
  if (rulesets.length === 0) throw new Error("the baseline has no ruleset_*.json file");
  const policies = {};
  for (const n of names) {
    const m = /^env_branch_policies_(.+)\.json$/.exec(n);
    if (m) policies[m[1]] = read(n);
  }
  return { repo: read("repo.json"), workflows: read("workflows.json"), environments: read("environments.json"), installation: read("github_app_installation.json"), rulesets, policies };
}

/**
 * `request(auth, method, path)` resolves to { status, body }. auth is "anonymous", "app" (App JWT), "token"
 * (installation token) or "git" (anonymous request to the git host).
 */
export async function verify({ baseline, repo, expect = "private", ownerType, pr, request }) {
  const results = [];
  const add = (level, check, detail) => results.push({ level, check, detail });
  /** PASS when there is no difference, otherwise one DIFF line per difference. */
  const compare = (check, expected, actual) => {
    const lines = diff(expected, actual);
    if (lines.length === 0) add("PASS", check, "matches the baseline");
    for (const line of lines) add("DIFF", check, line);
  };
  const get = async (check, auth, path) => {
    const res = await request(auth, "GET", path);
    if (res.status === 200) return res.body;
    add("UNVERIFIED", check, `GET ${path} returned ${res.status}`);
    return null;
  };
  const [owner, name] = repo.split("/");
  const R = `/repos/${owner}/${name}`;
  const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

  // 1. what an anonymous visitor sees
  const anonymous = [["anonymous-api", "anonymous", R, [404]], ["anonymous-git", "git", `/${owner}/${name}.git/info/refs?service=git-upload-pack`, [401, 404]]];
  for (const [check, auth, path, hidden] of anonymous) {
    const { status } = await request(auth, "GET", path);
    const visible = status === 200;
    if (!visible && !hidden.includes(status)) add("UNVERIFIED", check, `unexpected status ${status}`);
    else if (visible === (expect === "public")) add("PASS", check, `status ${status}, as expected for a ${expect} repository`);
    else add("DIFF", check, `status ${status}: expected the repository to be ${expect}`);
  }

  // 2. the App and its installation
  const want = baseline.installation;
  const inst = await get("installation", "app", `${R}/installation`);
  const app = await get("app", "app", "/app");
  if (app) {
    compare("app", { slug: want.app.slug, permissions: want.app.permissions, events: sorted(want.app.events) }, { slug: app.slug, permissions: app.permissions, events: sorted(app.events) });
    if (app.owner?.login !== want.app.owner) add("CHANGED", "app", `App owner: baseline ${show(want.app.owner)}, live ${show(app.owner?.login)}`);
  }
  if (!inst) return results; // without an installation there is no token for the remaining checks
  const pick = (i) => ({ permissions: i.permissions, repository_selection: i.repository_selection, events: sorted(i.events), suspended_at: i.suspended_at });
  compare("installation", pick(want.installation), pick(inst));
  if (!sameName(inst.account?.login, owner)) add("DIFF", "installation", `installed on ${show(inst.account?.login)}, expected the repository owner ${show(owner)}`);
  const wantType = ownerType ?? want.installation.account_type;
  if (inst.account?.type !== wantType) add("DIFF", "installation", `account type ${show(inst.account?.type)}, expected ${show(wantType)}`);

  const minted = await request("app", "POST", `/app/installations/${inst.id}/access_tokens`, { repositories: [name], permissions: READ_ONLY_PERMISSIONS });
  if (minted.status !== 201) {
    add("UNVERIFIED", "token", `could not issue a read-only token (status ${minted.status})`);
    return results;
  }
  const listed = await get("installation-repositories", "token", "/installation/repositories?per_page=100");
  if (listed) compare("installation-repositories", [repo.toLowerCase()], (listed.repositories ?? []).map((r) => String(r.full_name).toLowerCase()));

  // 3. repository
  const live = await get("repository", "token", R);
  if (live) {
    if (!sameName(live.full_name, repo)) add("DIFF", "repository", `the name resolves to ${show(live.full_name)}, not ${show(repo)}`);
    compare("repository-identity", { id: baseline.repo.id, name: baseline.repo.name }, { id: live.id, name: live.name });
    compare("repository-visibility", expect, live.visibility);
    if (live.owner?.type !== wantType) add("DIFF", "repository", `owner type ${show(live.owner?.type)}, expected ${show(wantType)}`);
    if (live.owner?.login !== baseline.repo.owner?.login) add("CHANGED", "repository", `owner: baseline ${show(baseline.repo.owner?.login)}, live ${show(live.owner?.login)}`);
    for (const key of REPO_SETTINGS) {
      if (baseline.repo[key] === undefined) continue;
      if (live[key] !== undefined) compare(`repository-settings ${key}`, baseline.repo[key], live[key]);
      else if (SETTINGS_HIDDEN_FROM_READERS.has(key)) add("MANUAL", "repository-settings", `${key}: compare with the baseline value ${show(baseline.repo[key])} in the repository settings`);
      else add("UNVERIFIED", "repository-settings", `${key} is missing from the response`);
    }
  }

  // 4. rulesets: what is configured, and what GitHub says applies to a branch
  const defaultBranch = live?.default_branch ?? baseline.repo.default_branch;
  const list = await get("rulesets", "token", `${R}/rulesets?includes_parents=true&per_page=100`);
  if (list) {
    const names = new Set(baseline.rulesets.map((r) => r.name));
    for (const extra of list.filter((r) => !names.has(r.name))) add("CHANGED", "rulesets", `additional ruleset ${show(extra.name)}`);
    for (const base of baseline.rulesets) {
      const check = `ruleset ${base.name}`;
      const matches = list.filter((r) => r.name === base.name);
      if (matches.length !== 1) {
        add("DIFF", check, `found ${matches.length} rulesets with this name, expected 1`);
        continue;
      }
      const full = await get(check, "token", `${R}/rulesets/${matches[0].id}`);
      if (!full) continue;
      if (full.id !== base.id) add("CHANGED", check, `id: baseline ${base.id}, live ${full.id}`);
      compare(check, normalizeRuleset(base), normalizeRuleset(full));

      for (const pattern of base.conditions?.ref_name?.include ?? []) {
        const glob = /^refs\/heads\/([A-Za-z0-9_./-]+)\/\*\*$/.exec(pattern);
        const branch = pattern === "~DEFAULT_BRANCH" ? defaultBranch : glob ? `${glob[1]}/${PROBE_BRANCH_LEAF}` : null;
        if (!branch) {
          add("UNVERIFIED", check, `cannot derive a branch to test for pattern ${show(pattern)}`);
          continue;
        }
        const applied = await get(check, "token", `${R}/rules/branches/${branch}?per_page=100`);
        if (applied) compare(`${check}, applied to ${branch}`, normalizeRules(base.rules), normalizeRules(applied.filter((r) => r.ruleset_id === full.id)));
      }
    }
  }

  // 5. environments
  const envs = await get("environments", "token", `${R}/environments?per_page=100`);
  if (envs) {
    const liveByName = new Map((envs.environments ?? []).map((e) => [e.name, e]));
    const baseNames = new Set(baseline.environments.environments.map((e) => e.name));
    for (const n of liveByName.keys()) if (!baseNames.has(n)) add("CHANGED", "environments", `additional environment ${show(n)}`);
    for (const base of baseline.environments.environments) {
      const check = `environment ${base.name}`;
      const protectedEnv = (base.protection_rules ?? []).length > 0 || Boolean(base.deployment_branch_policy);
      const found = liveByName.get(base.name);
      if (!found) {
        add(protectedEnv ? "DIFF" : "CHANGED", check, "missing");
        continue;
      }
      compare(check, normalizeEnvironment(base), normalizeEnvironment(found));
      if (!base.deployment_branch_policy?.custom_branch_policies) continue;
      const saved = baseline.policies[base.name];
      if (!saved) {
        add("UNVERIFIED", check, "the baseline has no branch policy file for it");
        continue;
      }
      const policies = await get(`${check} branch policies`, "token", `${R}/environments/${encodeURIComponent(base.name)}/deployment-branch-policies?per_page=100`);
      if (policies) compare(`${check} branch policies`, normalizePolicies(saved), normalizePolicies(policies));
    }
  }

  // 6. workflows
  const flows = await get("workflows", "token", `${R}/actions/workflows?per_page=100`);
  if (flows) {
    const states = new Map((flows.workflows ?? []).map((w) => [w.path, w.state]));
    for (const w of baseline.workflows.workflows) compare(`workflow ${w.path}`, w.state, states.get(w.path));
    const known = new Set(baseline.workflows.workflows.map((w) => w.path));
    for (const path of states.keys()) if (!known.has(path)) add("CHANGED", "workflows", `additional workflow ${show(path)}`);
  }

  // 7. the required checks report on a pull request
  const required = [...new Set(baseline.rulesets.flatMap((r) => r.rules.filter((x) => x.type === "required_status_checks").flatMap((x) => x.parameters.required_status_checks.map((c) => c.context))))];
  if (required.length > 0 && !pr) add("UNVERIFIED", "required-checks", "not run: pass --pr with a pull request opened for this verification");
  if (required.length > 0 && pr) {
    const pull = await get("required-checks", "token", `${R}/pulls/${pr}`);
    const runs = pull && (await get("required-checks", "token", `${R}/actions/runs?head_sha=${pull.head.sha}&per_page=100`));
    if (runs) {
      const jobs = [];
      for (const run of runs.workflow_runs ?? []) {
        const body = await get("required-checks", "token", `${R}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
        if (body) jobs.push(...body.jobs);
      }
      for (const context of required) {
        const matching = jobs.filter((j) => j.name === context);
        if (matching.length === 0) add("DIFF", "required-checks", `${show(context)} did not report on ${pull.head.sha}`);
        else if (matching.every((j) => j.conclusion === "success")) add("PASS", "required-checks", `${show(context)} succeeded on ${pull.head.sha} (started ${matching[0].started_at})`);
        else add("DIFF", "required-checks", `${show(context)} on ${pull.head.sha}: ${matching.map((j) => j.conclusion ?? j.status).join(", ")}`);
      }
    }
  }
  return results;
}

export const exitCode = (results) => (results.some((r) => r.level === "DIFF") ? 1 : results.some((r) => r.level === "UNVERIFIED") ? 2 : 0);

/** Report lines. Anything shaped like a token or key is masked, whatever produced it. */
export function report(results, { verbose = false } = {}) {
  const count = (level) => results.filter((r) => r.level === level).length;
  const lines = results.filter((r) => verbose || r.level !== "PASS").map((r) => `${r.level.padEnd(10)} ${r.check}: ${r.detail}`);
  lines.push(`Summary: ${count("PASS")} passed, ${count("DIFF")} differences, ${count("UNVERIFIED")} not verified, ${count("CHANGED")} changes to review.`);
  lines.push(...MANUAL_CHECKS.map((m) => `MANUAL     ${m}`));
  return lines.join("\n").replace(/gh[a-z]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+|-----BEGIN[^\n]*/g, "[masked]");
}

function parseArgs(argv) {
  const out = {};
  const flags = new Set(["baseline", "repo", "app-id", "app-key", "expect", "owner-type", "pr"]);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (argv[i] === "--verbose") out.verbose = true;
    else if (argv[i].startsWith("--") && flags.has(key) && argv[i + 1] !== undefined) out[key] = argv[++i];
    else throw new Error(`unknown or incomplete argument: ${argv[i]}`);
  }
  for (const key of ["baseline", "repo", "app-id", "app-key"]) if (!out[key]) throw new Error(`--${key} is required`);
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(out.repo)) throw new Error("--repo must be owner/name");
  if (out.expect && !["private", "public"].includes(out.expect)) throw new Error("--expect must be private or public");
  if (out["owner-type"] && !["Organization", "User"].includes(out["owner-type"])) throw new Error("--owner-type must be Organization or User");
  if (out.pr && !/^\d+$/.test(out.pr)) throw new Error("--pr must be a number");
  if (!/^\d+$/.test(out["app-id"])) throw new Error("--app-id must be a number");
  return out;
}

function githubRequest(appId, keyFile) {
  const key = createPrivateKey(readFileSync(keyFile));
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const appJwt = () => {
    const now = Math.floor(Date.now() / 1000);
    const data = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: appId })}`;
    return `${data}.${createSign("RSA-SHA256").update(data).sign(key).toString("base64url")}`;
  };
  let token = null;
  return async (auth, method, path, body) => {
    const base = auth === "git" ? "https://github.com" : "https://api.github.com";
    const headers = { "User-Agent": "repo-settings-verify" };
    if (auth !== "git") Object.assign(headers, { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });
    if (auth === "app") headers.Authorization = `Bearer ${appJwt()}`;
    if (auth === "token") headers.Authorization = `Bearer ${token}`;
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
    let json = null;
    if (auth !== "git") json = await res.json().catch(() => null);
    else await res.body?.cancel();
    if (method === "POST" && res.status === 201 && typeof json?.token === "string") {
      token = json.token;
      json = null; // the token stays inside this closure
    }
    return { status: res.status, body: json };
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const results = await verify({
      baseline: loadBaseline(args.baseline),
      repo: args.repo,
      expect: args.expect ?? "private",
      ownerType: args["owner-type"],
      pr: args.pr,
      request: githubRequest(args["app-id"], args["app-key"]),
    });
    console.log(report(results, { verbose: args.verbose }));
    process.exitCode = exitCode(results);
  } catch (error) {
    console.error(`verify-repo-settings: ${error.message}`);
    process.exitCode = 2;
  }
}
