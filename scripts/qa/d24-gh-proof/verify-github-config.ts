// READ-ONLY verification of the GitHub-side configuration that the D24 Stripe TEST proof depends on.
//   verify-github-config.ts --as-bot              run with the bot account's (classic) token: it must be the bot, hold WRITE (not admin), be unable to bypass the ruleset, and be REFUSED on five settings/secrets endpoints
//   verify-github-config.ts --as-app              run with a GitHub App INSTALLATION token: it must be installed on exactly this repository, be unable to bypass the ruleset, and be refused on the same five endpoints
//   verify-github-config.ts --as-owner-readonly   run with a token that can read repository settings: compares the ruleset, environment, Actions settings and collaborators to the expected values
// The token comes ONLY from the environment variable D24_GH_VERIFY_TOKEN. It is never printed, never put in a path, and never leaves api.github.com.
// This tool sends GET requests only, through a default-deny allow-list of exact paths. It cannot change anything. Output lines contain fixed ids and enumerated values only.

import { request } from "node:https";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OWNER = "genxttech";
export const REPO = "danceflow-app";
export const BOT = "danceflow-engineering-bot";
export const ENV_NAME = "d24-stripe-test";
export const SECRET_NAME = "D24_PROOF_STRIPE_KEY";
export const TOKEN_ENV = "D24_GH_VERIFY_TOKEN";
export const RULESET_NAME = "Protect main";
export const REQUIRED_CHECK = "Typecheck, build, lint, unit/integration tests";
export const ACTIONS_APP_ID = 15368; // the GitHub Actions app: pins the required check to checks that GitHub Actions itself reports

// The ruleset the owner imports (the doc embeds exactly this object; a test keeps them equal).
export const EXPECTED_RULESET = {
  name: RULESET_NAME,
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] as string[] } },
  bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" }],
  rules: [
    { type: "deletion" },
    { type: "non_fast_forward" },
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 1,
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: true,
        require_last_push_approval: true,
        required_review_thread_resolution: true,
        allowed_merge_methods: ["squash"],
      },
    },
    {
      type: "required_status_checks",
      parameters: { strict_required_status_checks_policy: false, do_not_enforce_on_create: false, required_status_checks: [{ context: REQUIRED_CHECK, integration_id: ACTIONS_APP_ID }] },
    },
  ],
};

const R = `/repos/${OWNER}/${REPO}`;
const E = `${R}/environments/${ENV_NAME}`;
const EXACT = new Set<string>([
  "/user",
  `${R}/collaborators/${BOT}/permission`,
  `${R}/collaborators?affiliation=direct&per_page=100`,
  `${R}/actions/secrets`,
  `${R}/actions/permissions`,
  `${R}/actions/permissions/workflow`,
  `${R}/actions/permissions/fork-pr-contributor-approval`,
  `${R}/hooks`,
  `${R}/invitations`,
  `${R}/codeowners/errors`,
  "/installation/repositories",
  `${R}/rulesets?includes_parents=false&per_page=100`,
  E,
  `${E}/secrets`,
  `${E}/deployment-branch-policies`,
]);
const RULESET_ID = new RegExp(`^${R.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/rulesets/\\d{1,12}$`);
export const isAllowedPath = (p: string): boolean => EXACT.has(p) || RULESET_ID.test(p);

export type Res = { status: number; body: unknown };
export type Transport = (req: { method: "GET"; path: string; token: string }) => Promise<Res>;

// The ONLY way this tool talks to GitHub. Non-GET is unrepresentable (the type) and a path outside the allow-list is refused before the transport is called.
export class ReadOnlyClient {
  readonly sent: { method: "GET"; path: string }[] = [];
  constructor(private readonly transport: Transport, private readonly token: string) {}
  async get(path: string): Promise<Res> {
    if (!isAllowedPath(path)) throw new Error("blocked: path is not on the read-only allow-list");
    this.sent.push({ method: "GET", path });
    return this.transport({ method: "GET", path, token: this.token });
  }
}

export type Finding = { id: string; status: "PASS" | "FAIL" | "INCONCLUSIVE"; detail: string };
const TOKEN_RE = /^[A-Za-z0-9_.:@~/-]{1,64}$/;
const tok = (v: unknown): string => (typeof v === "string" ? (TOKEN_RE.test(v) ? v : "unrecognised") : v === undefined ? "absent" : v === null ? "null" : typeof v === "boolean" || typeof v === "number" ? String(v) : `unexpected_type:${Array.isArray(v) ? "array" : typeof v}`);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

class Run {
  readonly out: Finding[] = [];
  constructor(readonly c: ReadOnlyClient) {}
  add(id: string, ok: boolean, detail: string) {
    this.out.push({ id, status: ok ? "PASS" : "FAIL", detail });
  }
  inconclusive(id: string, detail: string) {
    this.out.push({ id, status: "INCONCLUSIVE", detail });
  }
  async get(id: string, path: string): Promise<Res | null> {
    try {
      return await this.c.get(path);
    } catch (e) {
      this.inconclusive(id, (e as Error).message.startsWith("blocked:") ? "request blocked by the allow-list" : "transport error");
      return null;
    }
  }
}

const REFUSED = [
  ["refused-repo-secrets", `${R}/actions/secrets`],
  ["refused-actions-permissions", `${R}/actions/permissions`],
  ["refused-actions-workflow-permissions", `${R}/actions/permissions/workflow`],
  ["refused-environment-secrets", `${E}/secrets`],
  ["refused-webhooks", `${R}/hooks`],
] as const;

export async function verifyAsBot(c: ReadOnlyClient): Promise<Finding[]> {
  const r = new Run(c);
  const me = await r.get("token-user", "/user");
  if (me) {
    if (me.status === 200) r.add("token-user", obj(me.body).login === BOT, obj(me.body).login === BOT ? "the token belongs to the bot" : "the token does NOT belong to the bot");
    else r.add("token-user", false, `GET /user returned ${tok(me.status)} (token rejected)`);
  }
  const perm = await r.get("bot-permission", `${R}/collaborators/${BOT}/permission`);
  if (perm) {
    const b = obj(perm.body);
    if (perm.status !== 200) r.add("bot-permission", false, `status ${tok(perm.status)}`);
    else r.add("bot-permission", b.permission === "write" && b.role_name === "write", `permission=${tok(b.permission)} role_name=${tok(b.role_name)} (expected write / write; a missing role_name fails because the legacy field reports maintain as write)`);
  }
  await refusals(r);
  await bypassIsNever(r);
  return r.out;
}

// Refusal checks. These show that these five GETs fail for THIS token; they are not a proof that no other privileged operation is possible.
async function refusals(r: Run) {
  // a missing environment also answers 404, which would make the refusal vacuous: the environment must exist first (run after the owner has created it)
  const envOk = await r.get("environment-exists", E);
  if (envOk) r.add("environment-exists", envOk.status === 200, envOk.status === 200 ? "the environment exists, so a refusal on its secrets is meaningful" : `environment answers ${tok(envOk.status)}: a refusal on its secrets would be vacuous (create the environment first)`);
  for (const [id, path] of REFUSED) {
    const res = await r.get(id, path);
    if (!res) continue;
    if (res.status === 403 || res.status === 404) r.add(id, id !== "refused-environment-secrets" || envOk?.status === 200, `refused with ${res.status}`);
    else if (res.status === 200) r.add(id, false, "READABLE by this token (must be refused)");
    else r.add(id, false, `unexpected status ${tok(res.status)} (neither a clear refusal nor a clear success)`);
  }
}

// The caller must never be able to bypass the ruleset: GitHub reports this per caller.
async function bypassIsNever(r: Run) {
  const list = await r.get("ruleset-bypass-as-caller", `${R}/rulesets?includes_parents=false&per_page=100`);
  if (!list) return;
  const m = arr(list.body).filter((x) => obj(x).name === RULESET_NAME);
  const id = m.length === 1 ? obj(m[0]).id : undefined;
  if (list.status !== 200 || typeof id !== "number" || !Number.isInteger(id) || id <= 0) return void r.add("ruleset-bypass-as-caller", false, "could not find exactly one ruleset to read");
  const rs = await r.get("ruleset-bypass-as-caller", `${R}/rulesets/${id}`);
  if (rs) r.add("ruleset-bypass-as-caller", rs.status === 200 && obj(rs.body).current_user_can_bypass === "never", `current_user_can_bypass=${tok(obj(rs.body).current_user_can_bypass)} (expected never)`);
}

// An installation access token (GitHub App): it is not a user, so /user does not apply; it must be scoped to exactly this repository.
export async function verifyAsApp(c: ReadOnlyClient): Promise<Finding[]> {
  const r = new Run(c);
  const inst = await r.get("app-installation-repos", "/installation/repositories");
  if (inst) {
    const names = arr(obj(inst.body).repositories).map((x) => tok(obj(x).full_name));
    r.add("app-installation-repos", inst.status === 200 && names.length === 1 && names[0] === `${OWNER}/${REPO}`, `installation repositories [${names.join(", ")}] (expected only [${OWNER}/${REPO}])`);
  }
  await refusals(r);
  await bypassIsNever(r);
  return r.out;
}

function subsetEq(expected: unknown, actual: unknown): boolean {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    const a = obj(actual);
    return Object.entries(expected as Record<string, unknown>).every(([k, v]) => subsetEq(v, a[k]));
  }
  return same(expected, actual);
}

export async function verifyAsOwnerReadonly(c: ReadOnlyClient): Promise<Finding[]> {
  const r = new Run(c);

  // 1. ruleset
  const list = await r.get("ruleset", `${R}/rulesets?includes_parents=false&per_page=100`);
  if (list) {
    const matches = arr(list.body).filter((x) => obj(x).name === RULESET_NAME);
    if (list.status !== 200) r.add("ruleset", false, `list status ${tok(list.status)}`);
    else if (matches.length !== 1) r.add("ruleset", false, `expected exactly one ruleset named "${RULESET_NAME}", found ${matches.length}`);
    else {
      const id = obj(matches[0]).id;
      const rs = typeof id === "number" && Number.isInteger(id) && id > 0 ? await r.get("ruleset", `${R}/rulesets/${id}`) : null;
      if (!rs) r.add("ruleset", false, "ruleset id not usable");
      else {
        const b = obj(rs.body);
        r.add("ruleset-target-enforcement", b.target === "branch" && b.enforcement === "active", `target=${tok(b.target)} enforcement=${tok(b.enforcement)} (expected branch / active)`);
        const ref = obj(obj(b.conditions).ref_name);
        r.add("ruleset-ref", same(ref.include, ["~DEFAULT_BRANCH"]) && same(arr(ref.exclude), []), "ref include must be exactly ~DEFAULT_BRANCH with no exclusions");
        const bypass = arr(b.bypass_actors).map((x) => `${tok(obj(x).actor_type)}:${tok(obj(x).actor_id)}:${tok(obj(x).bypass_mode)}`).sort();
        const want = EXPECTED_RULESET.bypass_actors.map((x) => `${x.actor_type}:${x.actor_id}:${x.bypass_mode}`).sort();
        r.add("ruleset-bypass", same(bypass, want), `bypass actors [${bypass.join(", ")}] (expected only [${want.join(", ")}]: the repository admin role, pull-request mode)`);
        const rules = arr(b.rules).map(obj);
        for (const exp of EXPECTED_RULESET.rules) {
          const got = rules.find((x) => x.type === exp.type);
          if (!got) {
            r.add(`ruleset-rule-${exp.type}`, false, "rule missing");
            continue;
          }
          if (exp.type === "required_status_checks") {
            const want = (exp.parameters as { required_status_checks: { context: string; integration_id: number }[] }).required_status_checks;
            const gotChecks = arr(obj(got.parameters).required_status_checks).map(obj);
            const present = want.every((w) => gotChecks.some((g) => g.context === w.context && g.integration_id === w.integration_id));
            const { required_status_checks: _ignored, ...rest } = exp.parameters as Record<string, unknown>;
            void _ignored;
            r.add("ruleset-rule-required_status_checks", present && subsetEq(rest, got.parameters), `required check present with its source pinned to the GitHub Actions app=${present}`);
          } else if (exp.parameters) {
            const bad = Object.keys(exp.parameters).filter((k) => !subsetEq((exp.parameters as Record<string, unknown>)[k], obj(got.parameters)[k]));
            r.add(`ruleset-rule-${exp.type}`, bad.length === 0, bad.length ? `differs: ${bad.map(tok).join(", ")}` : "as expected");
            // parameters GitHub returns that this verifier does not know: reported, never silently accepted (their meaning may weaken the rule)
            const unknown = Object.keys(obj(got.parameters)).filter((k) => !(k in (exp.parameters as object)));
            if (unknown.length) r.add(`ruleset-rule-${exp.type}-unknown-params`, true, `INFO parameters not covered by this verifier: ${unknown.map(tok).join(", ")}`);
          } else r.add(`ruleset-rule-${exp.type}`, true, "present");
        }
        const extra = rules.map((x) => tok(x.type)).filter((t) => !EXPECTED_RULESET.rules.some((e) => e.type === t));
        r.add("ruleset-extra-rules", true, extra.length ? `INFO additional (stricter or unrelated) rule types: ${extra.join(", ")}` : "none");
      }
    }
  }

  // 2. environment
  const env = await r.get("environment", E);
  if (env) {
    if (env.status !== 200) r.add("environment", false, `status ${tok(env.status)}`);
    else {
      const b = obj(env.body);
      const prot = arr(b.protection_rules).map(obj);
      const rev = prot.find((x) => x.type === "required_reviewers");
      const reviewers = arr(rev?.reviewers).map((x) => `${tok(obj(x).type)}:${tok(obj(obj(x).reviewer).login)}`);
      r.add("environment-reviewers", reviewers.length === 1 && reviewers[0] === `User:${OWNER}`, `required reviewers [${reviewers.join(", ")}] (expected only [User:${OWNER}])`);
      r.add("environment-prevent-self-review", rev?.prevent_self_review === true, `prevent_self_review=${tok(rev?.prevent_self_review)}`);
      r.add("environment-admin-bypass-off", b.can_admins_bypass === false, `can_admins_bypass=${tok(b.can_admins_bypass)}`);
      const timer = prot.find((x) => x.type === "wait_timer");
      r.add("environment-no-wait-timer", timer === undefined || timer.wait_timer === 0, `wait_timer=${tok(timer?.wait_timer)}`);
      const pol = obj(b.deployment_branch_policy);
      r.add("environment-branch-policy-mode", pol.custom_branch_policies === true && pol.protected_branches === false, `custom_branch_policies=${tok(pol.custom_branch_policies)} protected_branches=${tok(pol.protected_branches)}`);
    }
  }
  const pols = await r.get("environment-branches", `${E}/deployment-branch-policies`);
  if (pols) {
    const names = arr(obj(pols.body).branch_policies).map(obj);
    r.add("environment-branches-main-only", pols.status === 200 && names.length === 1 && names[0]?.name === "main" && (names[0]?.type === undefined || names[0]?.type === "branch"), `branch policies [${names.map((x) => tok(x.name)).join(", ")}] (expected only [main])`);
  }
  const esec = await r.get("environment-secret", `${E}/secrets`);
  if (esec) {
    if (esec.status !== 200) r.inconclusive("environment-secret", `status ${tok(esec.status)} (the token cannot read environment secret NAMES; values are never readable)`);
    else {
      const names = arr(obj(esec.body).secrets).map((x) => tok(obj(x).name)).sort();
      r.add("environment-secret", same(names, [SECRET_NAME]), `environment secret names [${names.join(", ")}] (expected only [${SECRET_NAME}]); values are never read`);
    }
  }

  // 3. repository Actions settings and repository-level secrets
  const perms = await r.get("actions-permissions", `${R}/actions/permissions`);
  if (perms) {
    if (perms.status !== 200) r.inconclusive("actions-permissions", `status ${tok(perms.status)}`);
    else {
      const b = obj(perms.body);
      r.add("actions-enabled", b.enabled === true, `enabled=${tok(b.enabled)}`);
      r.add("actions-allowed-selected", b.allowed_actions === "selected", `allowed_actions=${tok(b.allowed_actions)} (expected selected; sha pinning alone does not restrict which actions may be used)`);
      if (b.sha_pinning_required === undefined) r.inconclusive("actions-sha-pinning", "field sha_pinning_required absent (UNVERIFIED field name or plan)");
      else r.add("actions-sha-pinning", b.sha_pinning_required === true, `sha_pinning_required=${tok(b.sha_pinning_required)}`);
    }
  }
  const wf = await r.get("actions-workflow-permissions", `${R}/actions/permissions/workflow`);
  if (wf) {
    if (wf.status !== 200) r.inconclusive("actions-workflow-permissions", `status ${tok(wf.status)}`);
    else {
      const b = obj(wf.body);
      r.add("actions-default-token-read", b.default_workflow_permissions === "read", `default_workflow_permissions=${tok(b.default_workflow_permissions)}`);
      r.add("actions-cannot-approve-prs", b.can_approve_pull_request_reviews === false, `can_approve_pull_request_reviews=${tok(b.can_approve_pull_request_reviews)}`);
    }
  }
  const fork = await r.get("actions-fork-approval", `${R}/actions/permissions/fork-pr-contributor-approval`);
  if (fork) {
    if (fork.status !== 200) r.inconclusive("actions-fork-approval", `status ${tok(fork.status)} (UNVERIFIED endpoint)`);
    else r.add("actions-fork-approval", obj(fork.body).approval_policy === "all_external_contributors", `approval_policy=${tok(obj(fork.body).approval_policy)}`);
  }
  const rsec = await r.get("repo-secrets", `${R}/actions/secrets`);
  if (rsec) {
    if (rsec.status !== 200) r.inconclusive("repo-secrets", `status ${tok(rsec.status)}`);
    else {
      const names = arr(obj(rsec.body).secrets).map((x) => obj(x).name);
      const d24 = names.filter((n) => typeof n === "string" && /^D24/i.test(n)).length;
      r.add("repo-secrets-no-d24", d24 === 0, d24 === 0 ? `no D24 repository-level secret; INFO ${names.length} other repository-level secret(s) exist and are readable by same-repo pull_request runs (names not printed)` : `${d24} D24 repository-level secret(s) (must be environment-only)`);
    }
  }

  // 4. collaborators
  const col = await r.get("collaborators", `${R}/collaborators?affiliation=direct&per_page=100`);
  if (col) {
    if (col.status !== 200) r.inconclusive("collaborators", `status ${tok(col.status)}`);
    else {
      const rows = arr(col.body).map(obj);
      const got = rows.map((x) => `${tok(x.login)}:${tok(x.role_name)}`).sort();
      const want = [`${BOT}:write`, `${OWNER}:admin`].sort();
      r.add("collaborators", same(got, want), `direct collaborators [${got.join(", ")}] (expected only [${want.join(", ")}])`);
    }
  }
  const inv = await r.get("invitations", `${R}/invitations`);
  if (inv) r.add("invitations", inv.status === 200 && arr(inv.body).length === 0, inv.status === 200 ? `${arr(inv.body).length} pending invitation(s) (expected none after the bot accepted)` : `status ${tok(inv.status)}`);
  const co = await r.get("codeowners-errors", `${R}/codeowners/errors`);
  if (co) {
    if (co.status !== 200) r.inconclusive("codeowners-errors", `status ${tok(co.status)} (the file exists on the default branch only after this PR is merged)`);
    else r.add("codeowners-errors", arr(obj(co.body).errors).length === 0, `${arr(obj(co.body).errors).length} CODEOWNERS error(s) on the default branch`);
  }
  return r.out;
}

export function render(findings: Finding[]): { lines: string[]; code: number } {
  const lines = findings.map((f) => `${f.status} ${f.id}: ${f.detail}`);
  const bad = findings.filter((f) => f.status !== "PASS").length;
  lines.push(bad === 0 ? `RESULT: all ${findings.length} checks passed` : `RESULT: ${bad} of ${findings.length} checks did not pass (FAIL and INCONCLUSIVE both count: fail closed)`);
  return { lines, code: bad === 0 ? 0 : 1 };
}

export function httpsTransport(): Transport {
  return ({ method, path, token }) =>
    new Promise<Res>((resolve, reject) => {
      if (method !== "GET") return reject(new Error("only GET"));
      const req = request(
        { hostname: "api.github.com", port: 443, method: "GET", path, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "d24-verify-github-config" }, timeout: 15000 },
        (res) => {
          const chunks: Buffer[] = [];
          let n = 0;
          res.on("data", (d: Buffer) => {
            n += d.length;
            if (n > 2_000_000) req.destroy(new Error("response too large"));
            else chunks.push(d);
          });
          res.on("end", () => {
            let body: unknown = null;
            try {
              body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              body = null;
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", () => reject(new Error("transport error")));
      req.end();
    });
}

export async function main(argv: string[], env: Record<string, string | undefined>, io: { out: (s: string) => void }, transport: Transport = httpsTransport()): Promise<number> {
  if (argv.length !== 1 || (argv[0] !== "--as-bot" && argv[0] !== "--as-app" && argv[0] !== "--as-owner-readonly")) {
    io.out("usage: verify-github-config.ts --as-bot | --as-app | --as-owner-readonly   (token in $D24_GH_VERIFY_TOKEN; GET requests only)");
    return 2;
  }
  const token = env[TOKEN_ENV];
  if (!token || /\s/.test(token)) {
    io.out(`refused: set ${TOKEN_ENV} to a token (it is never printed)`);
    return 2;
  }
  const c = new ReadOnlyClient(transport, token);
  const findings = argv[0] === "--as-bot" ? await verifyAsBot(c) : argv[0] === "--as-app" ? await verifyAsApp(c) : await verifyAsOwnerReadonly(c);
  const { lines, code } = render(findings);
  for (const l of lines) io.out(l);
  return code;
}

// Windows-safe entry test (drive-letter case, separators). If this ever fails to run, the tool prints nothing: the absence of a RESULT: line must be treated as a FAILURE.
const isEntry = !!process.argv[1] && resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (isEntry) {
  main(process.argv.slice(2), process.env, { out: (s) => void process.stdout.write(`${s}\n`) }).then((c) => void (process.exitCode = c));
}
