// node --test scripts/ops/__tests__/verify-repo-settings.test.mjs
// Synthetic baseline and a fake GitHub: no network, no credentials.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { diff, exitCode, loadBaseline, report, verify } from "../verify-repo-settings.mjs";

const permissions = { actions: "write", contents: "write", metadata: "read" };
const rules = [
  { type: "deletion" },
  { type: "pull_request", parameters: { require_code_owner_review: true, allowed_merge_methods: ["squash"] } },
  { type: "required_status_checks", parameters: { required_status_checks: [{ context: "build", integration_id: 1 }, { context: "mobile", integration_id: 1 }] } },
];
const ruleset = (id, name, include) => ({ id, name, target: "branch", enforcement: "active", conditions: { ref_name: { include: [include], exclude: [] } }, rules, current_user_can_bypass: "never" });
const environment = {
  id: 1,
  name: "gate",
  can_admins_bypass: false,
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  protection_rules: [{ id: 2, type: "required_reviewers", prevent_self_review: true, reviewers: [{ type: "User", reviewer: { login: "reviewer-a", id: 7 } }] }],
};
const files = {
  "repo.json": { id: 100, name: "app", owner: { login: "old-owner", type: "User" }, default_branch: "main", allow_squash_merge: true },
  "workflows.json": { workflows: [{ path: ".github/workflows/ci.yml", state: "active" }] },
  "environments.json": { environments: [environment, { name: "plain", protection_rules: [], deployment_branch_policy: null, can_admins_bypass: true }] },
  "env_branch_policies_gate.json": { branch_policies: [{ id: 3, name: "main", type: "branch" }] },
  "ruleset_11.json": ruleset(11, "main rules", "~DEFAULT_BRANCH"),
  "ruleset_12.json": ruleset(12, "release rules", "refs/heads/release/**"),
  "github_app_installation.json": {
    app: { slug: "bot", owner: "old-owner", permissions, events: [] },
    installation: { account: "old-owner", account_type: "User", permissions, repository_selection: "selected", events: [], suspended_at: null },
  },
};

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "repo-settings-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(body));
});
after(() => rmSync(dir, { recursive: true, force: true }));

/** The state after a clean transfer to an organization and a switch to private. */
function cleanWorld() {
  const clone = (v) => structuredClone(v);
  const main = clone(files["ruleset_11.json"]);
  const release = clone(files["ruleset_12.json"]);
  const applied = (r) => r.rules.map((x) => ({ ...clone(x), ruleset_id: r.id }));
  const R = "/repos/new-org/app";
  return {
    anonymous: { [R]: { status: 404 } },
    git: { "/new-org/app.git/info/refs?service=git-upload-pack": { status: 401 } },
    app: {
      [`${R}/installation`]: { id: 5, account: { login: "new-org", type: "Organization" }, permissions: clone(permissions), repository_selection: "selected", events: [], suspended_at: null },
      "/app": { slug: "bot", owner: { login: "new-org" }, permissions: clone(permissions), events: [] },
    },
    token: {
      "/installation/repositories?per_page=100": { repositories: [{ full_name: "new-org/app" }] },
      [R]: { id: 100, name: "app", full_name: "new-org/app", visibility: "private", owner: { login: "new-org", type: "Organization" }, default_branch: "main", allow_squash_merge: true },
      [`${R}/rulesets?includes_parents=true&per_page=100`]: [{ id: 11, name: "main rules" }, { id: 12, name: "release rules" }],
      [`${R}/rulesets/11`]: main,
      [`${R}/rulesets/12`]: release,
      [`${R}/rules/branches/main?per_page=100`]: applied(main),
      [`${R}/rules/branches/release/settings-verification-probe?per_page=100`]: applied(release),
      [`${R}/environments?per_page=100`]: clone(files["environments.json"]),
      [`${R}/environments/gate/deployment-branch-policies?per_page=100`]: clone(files["env_branch_policies_gate.json"]),
      [`${R}/actions/workflows?per_page=100`]: clone(files["workflows.json"]),
      [`${R}/pulls/9`]: { head: { sha: "abc" } },
      [`${R}/actions/runs?head_sha=abc&per_page=100`]: { workflow_runs: [{ id: 21 }] },
      [`${R}/actions/runs/21/jobs?filter=latest&per_page=100`]: { jobs: [{ name: "build", conclusion: "success" }, { name: "mobile", conclusion: "success" }] },
    },
  };
}

async function run(mutate = () => {}, options = {}) {
  const world = cleanWorld();
  mutate(world, (path) => world.token[`/repos/new-org/app${path}`]);
  const calls = [];
  const request = async (auth, method, path, body) => {
    calls.push({ auth, method, path, body });
    if (method === "POST") return { status: 201, body: null };
    const found = world[auth][path];
    if (found === undefined) return { status: 404, body: null };
    return auth === "anonymous" || auth === "git" ? { status: found.status, body: null } : { status: 200, body: found };
  };
  const results = await verify({ baseline: loadBaseline(dir), repo: "new-org/app", ownerType: "Organization", pr: "9", request, ...options });
  return { results, calls, diffs: results.filter((r) => r.level === "DIFF").map((r) => `${r.check}: ${r.detail}`) };
}

describe("clean transfer", () => {
  it("passes, and reports the owner change for review only", async () => {
    const { results, diffs } = await run();
    assert.deepEqual(diffs, []);
    assert.equal(exitCode(results), 0);
    assert.ok(results.some((r) => r.level === "CHANGED" && r.detail.includes("new-org")));
  });
  it("makes no request that writes, apart from a read-only token", async () => {
    const { calls } = await run();
    const writes = calls.filter((c) => c.method !== "GET");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, "/app/installations/5/access_tokens");
    assert.deepEqual([...new Set(Object.values(writes[0].body.permissions))], ["read"]);
    assert.ok(calls.filter((c) => c.auth === "anonymous" || c.auth === "git").length === 2);
  });
});

describe("each weakening is reported", () => {
  const cases = [
    ["the repository is still visible anonymously", (w) => { w.anonymous["/repos/new-org/app"].status = 200; }, /anonymous-api/],
    ["anonymous git access works", (w) => { w.git["/new-org/app.git/info/refs?service=git-upload-pack"].status = 200; }, /anonymous-git/],
    ["a wider App permission", (w) => { w.app["/repos/new-org/app/installation"].permissions.administration = "write"; }, /installation: permissions\.administration/],
    ["all repositories selected", (w) => { w.app["/repos/new-org/app/installation"].repository_selection = "all"; }, /repository_selection/],
    ["a different repository", (_w, at) => { at("").id = 101; }, /repository-identity/],
    ["a merge setting changed", (_w, at) => { at("").allow_squash_merge = false; }, /allow_squash_merge/],
    ["a ruleset is missing", (_w, at) => { at("/rulesets?includes_parents=true&per_page=100").pop(); }, /ruleset release rules: found 0/],
    ["a ruleset is disabled", (_w, at) => { at("/rulesets/11").enforcement = "disabled"; }, /enforcement/],
    ["code owner review is off", (_w, at) => { at("/rulesets/11").rules[1].parameters.require_code_owner_review = false; }, /require_code_owner_review/],
    ["a required check is dropped", (_w, at) => { at("/rulesets/11").rules[2].parameters.required_status_checks.pop(); }, /required_status_checks/],
    ["the bypass changed", (_w, at) => { at("/rulesets/12").current_user_can_bypass = "always"; }, /current_user_can_bypass/],
    ["configured rules do not apply to the branch", (_w, at) => { at("/rules/branches/release/settings-verification-probe?per_page=100").length = 0; }, /applied to release/],
    ["the environment reviewer is gone", (_w, at) => { at("/environments?per_page=100").environments[0].protection_rules = []; }, /environment gate/],
    ["self-review became possible", (_w, at) => { at("/environments?per_page=100").environments[0].protection_rules[0].prevent_self_review = false; }, /prevent_self_review/],
    ["administrators can bypass", (_w, at) => { at("/environments?per_page=100").environments[0].can_admins_bypass = true; }, /can_admins_bypass/],
    ["another branch may deploy", (_w, at) => { at("/environments/gate/deployment-branch-policies?per_page=100").branch_policies.push({ name: "*", type: "branch" }); }, /branch policies/],
    ["a protected environment is missing", (_w, at) => { at("/environments?per_page=100").environments.shift(); }, /environment gate: missing/],
    ["a workflow is disabled", (_w, at) => { at("/actions/workflows?per_page=100").workflows[0].state = "disabled_manually"; }, /workflow .*ci\.yml/],
    ["a required check did not report", (_w, at) => { at("/actions/runs/21/jobs?filter=latest&per_page=100").jobs.pop(); }, /"mobile" did not report/],
    ["a required check failed", (_w, at) => { at("/actions/runs/21/jobs?filter=latest&per_page=100").jobs[0].conclusion = "failure"; }, /"build".*failure/],
  ];
  for (const [name, mutate, expected] of cases) {
    it(name, async () => {
      const { results, diffs } = await run(mutate);
      assert.ok(diffs.some((d) => expected.test(d)), diffs.join("\n") || "no difference reported");
      assert.equal(exitCode(results), 1);
    });
  }
});

describe("nothing unread counts as passed", () => {
  it("an unreadable endpoint exits 2", async () => {
    const { results } = await run((w) => { delete w.token["/repos/new-org/app/environments?per_page=100"]; });
    assert.equal(exitCode(results), 2);
  });
  it("a rate-limited anonymous request exits 2", async () => {
    const { results } = await run((w) => { w.anonymous["/repos/new-org/app"].status = 403; });
    assert.equal(exitCode(results), 2);
  });
  it("skipping the pull request check exits 2", async () => {
    const { results } = await run(undefined, { pr: undefined });
    assert.equal(exitCode(results), 2);
  });
  it("an expected setting missing from the response exits 2", async () => {
    const { results } = await run((_w, at) => { delete at("").default_branch; });
    assert.equal(exitCode(results), 2);
  });
  it("a merge setting hidden from read tokens becomes a manual check with the baseline value, never a pass", async () => {
    const { results } = await run((_w, at) => { delete at("").allow_squash_merge; });
    const rows = results.filter((r) => r.detail.includes("allow_squash_merge"));
    assert.deepEqual(rows.map((r) => r.level), ["MANUAL"]);
    assert.match(report(results), /MANUAL +repository-settings: allow_squash_merge.*true/);
    assert.equal(exitCode(results), 0);
  });
  it("a baseline without rulesets is refused", () => {
    const empty = mkdtempSync(join(tmpdir(), "repo-settings-empty-"));
    try {
      assert.throws(() => loadBaseline(empty), /ruleset/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("output", () => {
  it("masks anything shaped like a token", () => {
    const fake = ["ghs", "A".repeat(36)].join("_");
    const text = report([{ level: "DIFF", check: "x", detail: `value ${fake}` }]);
    assert.ok(!text.includes(fake));
    assert.match(text, /\[masked\]/);
  });
  it("lists differences only unless asked, and always lists the manual checks", () => {
    const rows = [{ level: "PASS", check: "ok-check", detail: "fine" }];
    assert.doesNotMatch(report(rows), /ok-check/);
    assert.match(report(rows, { verbose: true }), /ok-check/);
    assert.match(report(rows), /MANUAL/);
  });
  it("compares order-sensitively only where order matters", () => {
    assert.deepEqual(diff({ a: 1, b: [1] }, { b: [1], a: 1 }), []);
    assert.equal(diff({ a: 1 }, {}).length, 1);
  });
});
