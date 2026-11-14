/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures mutate loosely-typed JSON response bodies */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOT, ENV_NAME, EXPECTED_RULESET, MOBILE_CHECK, OWNER, REPO, REQUIRED_CHECK, RULESET_NAME, SECRET_NAME, TOKEN_ENV,
  ACTIONS_APP_ID, ReadOnlyClient, isAllowedPath, main, render, verifyAsApp, verifyAsBot, verifyAsOwnerReadonly, type Res, type Transport,
} from "../verify-github-config";

// Offline only: a fake transport answers from a table. Nothing here touches the network.
const R = `/repos/${OWNER}/${REPO}`;
const E = `${R}/environments/${ENV_NAME}`;
const SENTINEL = "ghp_SENTINEL_TOKEN_VALUE_0123456789";
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

type Table = Record<string, Res>;
const botWorld = (): Table => ({
  "/user": { status: 200, body: { login: BOT } },
  [`${R}/collaborators/${BOT}/permission`]: { status: 200, body: { permission: "write", role_name: "write" } },
  [E]: { status: 200, body: { name: ENV_NAME } },
  [`${R}/rulesets?includes_parents=false&per_page=100`]: { status: 200, body: [{ id: 77, name: RULESET_NAME }] },
  [`${R}/rulesets/77`]: { status: 200, body: { id: 77, current_user_can_bypass: "never" } },
  "/installation/repositories": { status: 200, body: { repositories: [{ full_name: `${OWNER}/${REPO}` }] } },
  [`${R}/actions/secrets`]: { status: 403, body: { message: "Resource not accessible" } },
  [`${R}/actions/permissions`]: { status: 403, body: {} },
  [`${R}/actions/permissions/workflow`]: { status: 403, body: {} },
  [`${E}/secrets`]: { status: 404, body: {} },
  [`${R}/hooks`]: { status: 404, body: {} },
});
const ownerWorld = (): Table => ({
  [`${R}/rulesets?includes_parents=false&per_page=100`]: { status: 200, body: [{ id: 77, name: RULESET_NAME }] },
  [`${R}/rulesets/77`]: { status: 200, body: { id: 77, source: "x", ...clone(EXPECTED_RULESET) } },
  [E]: {
    status: 200,
    body: {
      can_admins_bypass: false,
      protection_rules: [{ type: "required_reviewers", prevent_self_review: true, reviewers: [{ type: "User", reviewer: { login: OWNER } }] }],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    },
  },
  [`${E}/deployment-branch-policies`]: { status: 200, body: { branch_policies: [{ name: "main", type: "branch" }] } },
  [`${E}/secrets`]: { status: 200, body: { secrets: [{ name: SECRET_NAME }] } },
  [`${R}/actions/permissions`]: { status: 200, body: { enabled: true, allowed_actions: "selected", sha_pinning_required: true } },
  [`${R}/actions/permissions/workflow`]: { status: 200, body: { default_workflow_permissions: "read", can_approve_pull_request_reviews: false } },
  [`${R}/actions/permissions/selected-actions`]: { status: 200, body: { github_owned_allowed: true, verified_allowed: false, patterns_allowed: [] } },
  [`${R}/actions/permissions/fork-pr-contributor-approval`]: { status: 200, body: { approval_policy: "all_external_contributors" } },
  [`${R}/actions/secrets`]: { status: 200, body: { secrets: [{ name: "E2E_SUPABASE_URL" }] } },
  [`${R}/collaborators?affiliation=direct&per_page=100`]: { status: 200, body: [{ login: OWNER, role_name: "admin" }, { login: BOT, role_name: "write" }] },
  [`${R}/invitations`]: { status: 200, body: [] },
  [`${R}/codeowners/errors`]: { status: 200, body: { errors: [] } },
});

function harness(table: Table) {
  const seen: { method: string; path: string; token: string }[] = [];
  const transport: Transport = async (req) => {
    seen.push(req);
    return table[req.path] ?? { status: 599, body: null };
  };
  return { seen, client: new ReadOnlyClient(transport, SENTINEL), transport };
}
const fails = (f: { status: string; id: string }[]) => f.filter((x) => x.status !== "PASS").map((x) => x.id);

describe("allow-list and read-only guarantees", () => {
  it("every request ever sent is a GET on an allow-listed path (both modes, good worlds)", async () => {
    const b = harness(botWorld());
    await verifyAsBot(b.client);
    const o = harness(ownerWorld());
    await verifyAsOwnerReadonly(o.client, "b");
    for (const s of [...b.seen, ...o.seen]) {
      expect(s.method).toBe("GET");
      expect(isAllowedPath(s.path), s.path).toBe(true);
    }
    expect(b.seen.length).toBeGreaterThan(5);
    expect(o.seen.length).toBeGreaterThan(8);
  });
  it("a path outside the allow-list is refused before the transport is called", async () => {
    const h = harness({});
    for (const p of ["/repos/genxttech/danceflow-app/issues", `${R}/actions/secrets/E2E_X`, `${R}/environments/other/secrets`, "/orgs/x", `${R}/rulesets/abc`, `${R}/rulesets/77/../../x`, `${R}/actions/secrets?x=1`, "https://evil.example/user"]) {
      await expect(h.client.get(p), p).rejects.toThrow(/blocked/);
    }
    expect(h.seen).toEqual([]);
  });
  it("the client exposes no method other than get (no post/put/patch/delete)", () => {
    const c = harness({}).client as unknown as Record<string, unknown>;
    for (const m of ["post", "put", "patch", "delete", "request", "send"]) expect(c[m], m).toBeUndefined();
  });
  it("the real source file contains no non-GET method, no body and no token echo", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "verify-github-config.ts"), "utf8");
    expect(src).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/i);
    expect(src).not.toMatch(/\breq\.write\(|\bbody:\s*JSON\.stringify/);
    expect(src).not.toMatch(/console\./);
    expect(src.match(/method:\s*"[A-Z]+"/g)?.every((m) => m.includes('"GET"'))).toBe(true);
  });
  it("a transport error is INCONCLUSIVE (never a pass) and never prints the token", async () => {
    const c = new ReadOnlyClient(async () => { throw new Error(`boom ${SENTINEL}`); }, SENTINEL);
    const f = await verifyAsBot(c);
    expect(f.every((x) => x.status === "INCONCLUSIVE")).toBe(true);
    expect(JSON.stringify(f)).not.toContain(SENTINEL);
    expect(render(f).code).toBe(3); // inconclusive only: not a pass, not a failure
  });
});

describe("--as-bot", () => {
  it("passes when the token is the bot, write only, and settings endpoints are refused", async () => {
    const f = await verifyAsBot(harness(botWorld()).client);
    expect(fails(f)).toEqual([]);
    expect(render(f).code).toBe(0);
  });
  it("fails when the token is not the bot (e.g. the owner's token)", async () => {
    const w = botWorld();
    w["/user"] = { status: 200, body: { login: OWNER } };
    expect(fails(await verifyAsBot(harness(w).client))).toContain("token-user");
  });
  it("fails when the token is rejected", async () => {
    const w = botWorld();
    w["/user"] = { status: 401, body: {} };
    expect(fails(await verifyAsBot(harness(w).client))).toContain("token-user");
  });
  it.each([["admin", "admin"], ["maintain", "maintain"], ["read", "read"]])("fails when the bot role is %s", async (permission, role) => {
    const w = botWorld();
    w[`${R}/collaborators/${BOT}/permission`] = { status: 200, body: { permission, role_name: role } };
    expect(fails(await verifyAsBot(harness(w).client))).toContain("bot-permission");
  });
  it("fails when role_name is not write even if permission says write (maintain maps to write)", async () => {
    const w = botWorld();
    w[`${R}/collaborators/${BOT}/permission`] = { status: 200, body: { permission: "write", role_name: "maintain" } };
    expect(fails(await verifyAsBot(harness(w).client))).toContain("bot-permission");
  });
  it.each(["refused-repo-secrets", "refused-actions-permissions", "refused-actions-workflow-permissions", "refused-environment-secrets", "refused-webhooks"])("fails when %s is readable", async (id) => {
    const map: Record<string, string> = {
      "refused-repo-secrets": `${R}/actions/secrets`, "refused-actions-permissions": `${R}/actions/permissions`, "refused-actions-workflow-permissions": `${R}/actions/permissions/workflow`,
      "refused-environment-secrets": `${E}/secrets`, "refused-webhooks": `${R}/hooks`,
    };
    const w = botWorld();
    w[map[id] as string] = { status: 200, body: { secrets: [] } };
    expect(fails(await verifyAsBot(harness(w).client))).toEqual([id]);
  });
  it("a 500 on a refused endpoint is not accepted as a refusal", async () => {
    const w = botWorld();
    w[`${R}/hooks`] = { status: 500, body: null };
    expect(fails(await verifyAsBot(harness(w).client))).toEqual(["refused-webhooks"]);
  });
});

describe("--as-bot / --as-app: review round additions", () => {
  it("a missing role_name fails closed (the legacy permission field reports maintain as write)", async () => {
    const w = botWorld();
    w[`${R}/collaborators/${BOT}/permission`] = { status: 200, body: { permission: "write" } };
    expect(fails(await verifyAsBot(harness(w).client))).toEqual(["bot-permission"]);
  });
  it("a missing environment makes the secrets refusal vacuous: both the existence check and the refusal FAIL", async () => {
    const w = botWorld();
    w[E] = { status: 404, body: {} };
    expect(fails(await verifyAsBot(harness(w).client)).sort()).toEqual(["environment-exists", "refused-environment-secrets"]);
  });
  it.each(["always", "pull_request", "exempt", "unknown"])("fails when the caller can bypass the ruleset (%s)", async (v) => {
    const w = botWorld();
    (w[`${R}/rulesets/77`] as any).body.current_user_can_bypass = v;
    expect(fails(await verifyAsBot(harness(w).client))).toEqual(["ruleset-bypass-as-caller"]);
  });
  it("fails when the ruleset cannot be found for the bypass check", async () => {
    const w = botWorld();
    w[`${R}/rulesets?includes_parents=false&per_page=100`] = { status: 200, body: [] };
    expect(fails(await verifyAsBot(harness(w).client))).toEqual(["ruleset-bypass-as-caller"]);
  });
  it("the app mode passes for an installation scoped to exactly this repository", async () => {
    const w = botWorld();
    expect(fails(await verifyAsApp(harness(w).client))).toEqual([]);
  });
  it.each([[[]], [[{ full_name: `${OWNER}/${REPO}` }, { full_name: `${OWNER}/other` }]], [[{ full_name: `${OWNER}/other` }]]])("the app mode fails for installation repositories %j", async (repos) => {
    const w = botWorld();
    w["/installation/repositories"] = { status: 200, body: { repositories: repos } };
    expect(fails(await verifyAsApp(harness(w).client))).toEqual(["app-installation-repos"]);
  });
  it("the app mode also fails when a settings endpoint is readable or the app can bypass", async () => {
    const w = botWorld();
    w[`${R}/actions/secrets`] = { status: 200, body: {} };
    (w[`${R}/rulesets/77`] as any).body.current_user_can_bypass = "always";
    expect(fails(await verifyAsApp(harness(w).client)).sort()).toEqual(["refused-repo-secrets", "ruleset-bypass-as-caller"]);
  });
  it("the CLI accepts --as-app and sends only GETs", async () => {
    const lines: string[] = [];
    const h = harness(botWorld());
    const code = await main(["--as-app"], { [TOKEN_ENV]: SENTINEL }, { out: (s) => lines.push(s) }, h.transport);
    expect(code).toBe(0);
    expect(h.seen.every((s) => s.method === "GET")).toBe(true);
    expect(lines.at(-1)).toMatch(/^RESULT: /);
  });
});

describe("--as-owner-readonly", () => {
  const edit = (mut: (w: Table) => void) => {
    const w = ownerWorld();
    mut(w);
    return w;
  };
  const rsBody = (w: Table) => (w[`${R}/rulesets/77`] as { body: Record<string, unknown> }).body;
  const rule = (w: Table, type: string) => (rsBody(w).rules as Record<string, any>[]).find((r) => r.type === type) as Record<string, any>;

  it("passes against the expected configuration", async () => {
    const f = await verifyAsOwnerReadonly(harness(ownerWorld()).client, "b");
    expect(fails(f)).toEqual([]);
    expect(render(f).code).toBe(0);
    expect(f.length).toBeGreaterThanOrEqual(20);
  });
  const cases: [string, (w: Table) => void, string][] = [
    ["ruleset missing", (w) => { w[`${R}/rulesets?includes_parents=false&per_page=100`] = { status: 200, body: [] }; }, "ruleset"],
    ["two rulesets with the name", (w) => { w[`${R}/rulesets?includes_parents=false&per_page=100`] = { status: 200, body: [{ id: 77, name: RULESET_NAME }, { id: 78, name: RULESET_NAME }] }; }, "ruleset"],
    ["ruleset not active", (w) => { rsBody(w).enforcement = "evaluate"; }, "ruleset-target-enforcement"],
    ["ruleset wrong target", (w) => { rsBody(w).target = "tag"; }, "ruleset-target-enforcement"],
    ["ref excludes something", (w) => { (rsBody(w).conditions as any).ref_name.exclude = ["refs/heads/x"]; }, "ruleset-ref"],
    ["ref is not the default branch", (w) => { (rsBody(w).conditions as any).ref_name.include = ["refs/heads/dev"]; }, "ruleset-ref"],
    ["extra bypass actor", (w) => { (rsBody(w).bypass_actors as any[]).push({ actor_id: 1, actor_type: "RepositoryRole", bypass_mode: "always" }); }, "ruleset-bypass"],
    ["bypass mode always", (w) => { (rsBody(w).bypass_actors as any[])[0].bypass_mode = "always"; }, "ruleset-bypass"],
    ["no bypass actors at all", (w) => { rsBody(w).bypass_actors = []; }, "ruleset-bypass"],
    ["deletion rule missing", (w) => { rsBody(w).rules = (rsBody(w).rules as any[]).filter((r) => r.type !== "deletion"); }, "ruleset-rule-deletion"],
    ["force-push rule missing", (w) => { rsBody(w).rules = (rsBody(w).rules as any[]).filter((r) => r.type !== "non_fast_forward"); }, "ruleset-rule-non_fast_forward"],
    ["pull request rule missing", (w) => { rsBody(w).rules = (rsBody(w).rules as any[]).filter((r) => r.type !== "pull_request"); }, "ruleset-rule-pull_request"],
    ["code-owner review off", (w) => { rule(w, "pull_request").parameters.require_code_owner_review = false; }, "ruleset-rule-pull_request"],
    ["last-push approval switched on (blocks every routine PR)", (w) => { rule(w, "pull_request").parameters.require_last_push_approval = true; }, "ruleset-rule-pull_request"],
    ["required approvals changed from the policy", (w) => { rule(w, "pull_request").parameters.required_approving_review_count = 1; }, "ruleset-rule-pull_request"],
    ["stale reviews not dismissed", (w) => { rule(w, "pull_request").parameters.dismiss_stale_reviews_on_push = false; }, "ruleset-rule-pull_request"],
    ["merge commits allowed", (w) => { rule(w, "pull_request").parameters.allowed_merge_methods = ["squash", "merge"]; }, "ruleset-rule-pull_request"],
    ["required check missing", (w) => { rsBody(w).rules = (rsBody(w).rules as any[]).filter((r) => r.type !== "required_status_checks"); }, "ruleset-rule-required_status_checks"],
    ["wrong required check", (w) => { rule(w, "required_status_checks").parameters.required_status_checks = [{ context: "something else" }]; }, "ruleset-rule-required_status_checks"],
    ["environment reviewer is someone else", (w) => { ((w[E] as any).body.protection_rules[0].reviewers[0].reviewer.login) = BOT; }, "environment-reviewers"],
    ["environment has two reviewers", (w) => { (w[E] as any).body.protection_rules[0].reviewers.push({ type: "User", reviewer: { login: BOT } }); }, "environment-reviewers"],
    ["environment has no reviewers rule", (w) => { (w[E] as any).body.protection_rules = []; }, "environment-reviewers"],
    ["self-review allowed", (w) => { (w[E] as any).body.protection_rules[0].prevent_self_review = false; }, "environment-prevent-self-review"],
    ["admins can bypass", (w) => { (w[E] as any).body.can_admins_bypass = true; }, "environment-admin-bypass-off"],
    ["wait timer set", (w) => { (w[E] as any).body.protection_rules.push({ type: "wait_timer", wait_timer: 30 }); }, "environment-no-wait-timer"],
    ["all branches allowed", (w) => { (w[E] as any).body.deployment_branch_policy = null; }, "environment-branch-policy-mode"],
    ["protected branches mode", (w) => { (w[E] as any).body.deployment_branch_policy = { protected_branches: true, custom_branch_policies: false }; }, "environment-branch-policy-mode"],
    ["extra deployment branch", (w) => { (w[`${E}/deployment-branch-policies`] as any).body.branch_policies.push({ name: "dev", type: "branch" }); }, "environment-branches-main-only"],
    ["deployment branch is not main", (w) => { (w[`${E}/deployment-branch-policies`] as any).body.branch_policies = [{ name: "release/*", type: "branch" }]; }, "environment-branches-main-only"],
    ["environment secret missing", (w) => { (w[`${E}/secrets`] as any).body.secrets = []; }, "environment-secret"],
    ["environment has an extra secret", (w) => { (w[`${E}/secrets`] as any).body.secrets.push({ name: "OTHER" }); }, "environment-secret"],
    ["thread resolution switched off", (w) => { rule(w, "pull_request").parameters.required_review_thread_resolution = false; }, "ruleset-rule-pull_request"],
    ["required check source not pinned", (w) => { rule(w, "required_status_checks").parameters.required_status_checks = [{ context: REQUIRED_CHECK }]; }, "ruleset-rule-required_status_checks"],
    ["required check from another app", (w) => { rule(w, "required_status_checks").parameters.required_status_checks = [{ context: REQUIRED_CHECK, integration_id: ACTIONS_APP_ID + 1 }]; }, "ruleset-rule-required_status_checks"],
    ["all actions allowed", (w) => { (w[`${R}/actions/permissions`] as any).body.allowed_actions = "all"; }, "actions-allowed-selected"],
    ["a pending invitation", (w) => { (w[`${R}/invitations`] as any).body = [{ id: 1 }]; }, "invitations"],
    ["codeowners errors present", (w) => { (w[`${R}/codeowners/errors`] as any).body = { errors: [{ line: 1 }] }; }, "codeowners-errors"],
    ["actions disabled", (w) => { (w[`${R}/actions/permissions`] as any).body.enabled = false; }, "actions-enabled"],
    ["sha pinning not required", (w) => { (w[`${R}/actions/permissions`] as any).body.sha_pinning_required = false; }, "actions-sha-pinning"],
    ["default token is write", (w) => { (w[`${R}/actions/permissions/workflow`] as any).body.default_workflow_permissions = "write"; }, "actions-default-token-read"],
    ["actions may approve PRs", (w) => { (w[`${R}/actions/permissions/workflow`] as any).body.can_approve_pull_request_reviews = true; }, "actions-cannot-approve-prs"],
    ["fork approval not strictest", (w) => { (w[`${R}/actions/permissions/fork-pr-contributor-approval`] as any).body.approval_policy = "first_time_contributors"; }, "actions-fork-approval"],
    ["a D24 repository-level secret exists", (w) => { (w[`${R}/actions/secrets`] as any).body.secrets.push({ name: "D24_PROOF_STRIPE_KEY" }); }, "repo-secrets-no-d24"],
    ["an extra collaborator", (w) => { (w[`${R}/collaborators?affiliation=direct&per_page=100`] as any).body.push({ login: "someone", role_name: "write" }); }, "collaborators"],
    ["the bot is a maintainer", (w) => { (w[`${R}/collaborators?affiliation=direct&per_page=100`] as any).body[1].role_name = "maintain"; }, "collaborators"],
    ["the bot is an admin", (w) => { (w[`${R}/collaborators?affiliation=direct&per_page=100`] as any).body[1].role_name = "admin"; }, "collaborators"],
  ];
  it.each(cases)("detects: %s", async (_name, mut, id) => {
    const f = await verifyAsOwnerReadonly(harness(edit(mut)).client, "b");
    expect(fails(f), _name).toContain(id);
    expect(render(f).code).toBe(1);
  });
  it("a token that cannot read admin-only endpoints yields INCONCLUSIVE (fail closed), not PASS", async () => {
    const w = ownerWorld();
    w[`${E}/secrets`] = { status: 404, body: {} };
    w[`${R}/actions/permissions`] = { status: 403, body: {} };
    const f = await verifyAsOwnerReadonly(harness(w).client, "b");
    expect(f.filter((x) => x.status === "INCONCLUSIVE").map((x) => x.id)).toEqual(expect.arrayContaining(["environment-secret", "actions-permissions"]));
    expect(render(f).code).toBe(3);
  });
  it("exit codes: 0 all passed, 1 when any FAIL (even with inconclusive), 3 inconclusive only", () => {
    expect(render([{ id: "a", status: "PASS", detail: "" }]).code).toBe(0);
    expect(render([{ id: "a", status: "PASS", detail: "" }, { id: "b", status: "INCONCLUSIVE", detail: "" }]).code).toBe(3);
    expect(render([{ id: "a", status: "FAIL", detail: "" }, { id: "b", status: "INCONCLUSIVE", detail: "" }]).code).toBe(1);
    expect(render([{ id: "b", status: "INCONCLUSIVE", detail: "" }]).lines.at(-1)).toContain("only \"all passed\" is success");
  });
  it("option a (GitHub App) expects the owner as the only direct collaborator; option b expects the owner and the bot", async () => {
    const w = ownerWorld();
    expect(fails(await verifyAsOwnerReadonly(harness(w).client, "a"))).toEqual(["collaborators"]);
    const onlyOwner = ownerWorld();
    (onlyOwner[`${R}/collaborators?affiliation=direct&per_page=100`] as any).body = [{ login: OWNER, role_name: "admin" }];
    expect(fails(await verifyAsOwnerReadonly(harness(onlyOwner).client, "a"))).toEqual([]);
    expect(fails(await verifyAsOwnerReadonly(harness(onlyOwner).client, "b"))).toEqual(["collaborators"]);
  });
  it("the selected-actions list is read: Marketplace verified creators, a wildcard-all pattern or a non-GitHub-owned-only list fail", async () => {
    for (const body of [{ github_owned_allowed: true, verified_allowed: true, patterns_allowed: [] }, { github_owned_allowed: true, verified_allowed: false, patterns_allowed: ["*"] }, { github_owned_allowed: true, verified_allowed: false, patterns_allowed: ["*/*"] }, { github_owned_allowed: false, verified_allowed: false, patterns_allowed: [] }, { github_owned_allowed: true, verified_allowed: false, patterns_allowed: [{}] }]) {
      const w = ownerWorld();
      (w[`${R}/actions/permissions/selected-actions`] as any).body = body;
      expect(fails(await verifyAsOwnerReadonly(harness(w).client, "b")), JSON.stringify(body)).toEqual(["actions-selected-list"]);
    }
    const w = ownerWorld();
    (w[`${R}/actions/permissions/selected-actions`] as any).body.patterns_allowed = ["actions/setup-node@*"];
    expect(fails(await verifyAsOwnerReadonly(harness(w).client, "b"))).toEqual([]);
    const w2 = ownerWorld();
    w2[`${R}/actions/permissions/selected-actions`] = { status: 404, body: {} };
    expect((await verifyAsOwnerReadonly(harness(w2).client, "b")).find((x) => x.id === "actions-selected-list")?.status).toBe("INCONCLUSIVE");
  });
  it("an absent sha_pinning_required field is INCONCLUSIVE, never a silent pass", async () => {
    const w = ownerWorld();
    delete (w[`${R}/actions/permissions`] as any).body.sha_pinning_required;
    const f = await verifyAsOwnerReadonly(harness(w).client, "b");
    expect(f.find((x) => x.id === "actions-sha-pinning")?.status).toBe("INCONCLUSIVE");
  });
  it("codeowners errors endpoint unavailable (file not on main yet) is INCONCLUSIVE, never PASS", async () => {
    const w = ownerWorld();
    w[`${R}/codeowners/errors`] = { status: 404, body: {} };
    const f = await verifyAsOwnerReadonly(harness(w).client, "b");
    expect(f.find((x) => x.id === "codeowners-errors")?.status).toBe("INCONCLUSIVE");
  });
  it("unknown pull-request parameters returned by GitHub are reported, not silently accepted", async () => {
    const w = ownerWorld();
    rule(w, "pull_request").parameters.require_extra_approval_for_unattributed_changes = false;
    const f = await verifyAsOwnerReadonly(harness(w).client, "b");
    expect(fails(f)).toEqual([]);
    expect(f.find((x) => x.id === "ruleset-rule-pull_request-unknown-params")?.detail).toContain("require_extra_approval_for_unattributed_changes");
  });
  it("additional stricter rule types are reported as INFO, not as a deviation", async () => {
    const w = ownerWorld();
    (rsBody(w).rules as any[]).push({ type: "required_linear_history" });
    const f = await verifyAsOwnerReadonly(harness(w).client, "b");
    expect(fails(f)).toEqual([]);
    expect(f.find((x) => x.id === "ruleset-extra-rules")?.detail).toContain("required_linear_history");
  });
  it("only names of environment secrets are compared; secret values never appear (no value field is read)", async () => {
    const w = ownerWorld();
    (w[`${E}/secrets`] as any).body.secrets = [{ name: SECRET_NAME, value: "SHOULD-NEVER-APPEAR", created_at: "x" }];
    const f = await verifyAsOwnerReadonly(harness(w).client, "b");
    expect(JSON.stringify(f)).not.toContain("SHOULD-NEVER-APPEAR");
  });
  it("hostile free text in responses is never echoed (unrecognised tokens only)", async () => {
    const w = ownerWorld();
    (w[`${R}/actions/permissions/workflow`] as any).body.default_workflow_permissions = "ghp_ABC \n injected line";
    const f = await verifyAsOwnerReadonly(harness(w).client, "b");
    const out = render(f).lines.join("\n");
    expect(out).not.toContain("injected line");
    expect(out).toContain("unrecognised");
  });
});

describe("CLI", () => {
  const run = async (argv: string[], env: Record<string, string | undefined>, table: Table = {}) => {
    const lines: string[] = [];
    const h = harness(table);
    const code = await main(argv, env, { out: (s) => lines.push(s) }, h.transport);
    return { code, lines, seen: h.seen };
  };
  it("refuses bad usage with exit 2 and sends nothing", async () => {
    for (const argv of [[], ["--as-bot", "--as-owner-readonly"], ["--as-owner-readonly"], ["--as-owner-readonly", "--option"], ["--as-owner-readonly", "--option", "c"], ["--as-owner-readonly", "--opt", "a"], ["--as-bot", "--option", "a"], ["--post"], ["--as-bot", "extra"], ["--as-owner"]]) {
      const r = await run(argv, { [TOKEN_ENV]: SENTINEL });
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.seen).toEqual([]);
    }
  });
  it("refuses without a token and does not print any token", async () => {
    const r = await run(["--as-bot"], {});
    expect(r.code).toBe(2);
    expect(r.seen).toEqual([]);
    const r2 = await run(["--as-bot"], { [TOKEN_ENV]: "has space" });
    expect(r2.code).toBe(2);
    expect(r2.lines.join("\n")).not.toContain("has space");
  });
  it("runs a mode end to end, sends the token only to the transport, and prints no token", async () => {
    const r = await run(["--as-bot"], { [TOKEN_ENV]: SENTINEL }, botWorld());
    expect(r.code).toBe(0);
    expect(r.lines.at(-1)).toMatch(/^RESULT: all \d+ checks passed$/);
    expect(r.lines.join("\n")).not.toContain(SENTINEL);
    expect(r.seen.every((s) => s.token === SENTINEL && s.method === "GET")).toBe(true);
    const o = await run(["--as-owner-readonly", "--option", "b"], { [TOKEN_ENV]: SENTINEL }, ownerWorld());
    expect(o.code).toBe(0);
    expect(o.lines.join("\n")).not.toContain(SENTINEL);
  });
  it("exits 1 when anything deviates", async () => {
    const w = botWorld();
    w["/user"] = { status: 200, body: { login: OWNER } };
    expect((await run(["--as-bot"], { [TOKEN_ENV]: SENTINEL }, w)).code).toBe(1);
  });
});

describe("the doc embeds exactly the ruleset the verifier expects", () => {
  const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "docs", "billing", "D24-GITHUB-ENVIRONMENT-PROOF.md"), "utf8");
  it("the JSON block under 'Ruleset JSON' equals EXPECTED_RULESET", () => {
    const m = doc.match(/<!-- RULESET-JSON-BEGIN -->\s*```json\n([\s\S]*?)\n```\s*<!-- RULESET-JSON-END -->/);
    expect(m, "ruleset JSON block markers").not.toBeNull();
    expect(JSON.parse((m as RegExpMatchArray)[1] as string)).toEqual(EXPECTED_RULESET);
  });
  it("the required check name is the real CI job name", () => {
    const wf = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".github", "workflows", "e2e-public-event-registration.yml"), "utf8");
    expect(wf).toContain(REQUIRED_CHECK);
    const mobile = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".github", "workflows", "mobile-apps.yml"), "utf8");
    expect(mobile).toContain(`name: ${MOBILE_CHECK}`);
  });
});
