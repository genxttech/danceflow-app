#!/usr/bin/env node
/**
 * Pin validator for the two Competition Stripe TEST workflows.
 *
 * Runs in the `validate-pin` job of the workflow file ON MAIN, BEFORE the environment-protected job, in a job that has no environment and no secret
 * (only the read-only GITHUB_TOKEN). It proves, from GitHub's API and never from PR text, that the commit the owner is about to approve is
 *   1. a full 40-hex commit id that exists;
 *   2. an ancestor of origin/release/website-embeds (API compare: ahead|identical);
 *   3. the merge commit of exactly one merged PR whose base is the release branch;
 *   4. content-identical to that PR (parents, file list, per-file additions/deletions and patch bodies; no extra commits or diff);
 *   5. approved by a code owner (the owners of /.github/ in CODEOWNERS ON MAIN): latest decisive review APPROVED, not dismissed, not the author,
 *      a real user, submitted before the merge, on the commit that is the PR head at merge, and that head is the last commit of the PR (no push after approval).
 * Every failure is fail-closed: any thrown error, any non-200, any truncated page, any ambiguity => exit 1 and NO output `sha`.
 *
 * Usage (CLI, env): PIN, GITHUB_REPOSITORY, GH_TOKEN, CF1_RELEASE_BRANCH, [CODEOWNERS_PATH], GITHUB_OUTPUT, GITHUB_STEP_SUMMARY
 * Library: validatePin({ sha, repo, branch, api, codeownersText }) with an injected `api.get(path) -> { status, body }` so every case is testable offline.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export class PinValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PinValidationError";
    this.code = code;
  }
}
const fail = (code, message) => { throw new PinValidationError(code, message); };

const SHA_RE = /^[0-9a-f]{40}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._\/-]+$/;
const PER_PAGE = 100;
const MAX_PAGES = 30; // 3000 items: the documented maximum of the PR files endpoint
const DECISIVE = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

/** Code owners (user logins) of the governance rule `/.github/`, from the CODEOWNERS text of TRUSTED main. Teams are not resolvable and are ignored. */
export function governanceOwners(text) {
  const owners = new Set();
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const [pattern, ...who] = line.split(/\s+/);
    if (pattern !== "/.github/") continue;
    for (const o of who) if (/^@[A-Za-z0-9-]+$/.test(o)) owners.add(o.slice(1).toLowerCase());
  }
  if (owners.size === 0) fail("codeowners", "no user owner for /.github/ in CODEOWNERS on main");
  return owners;
}

async function getOk(api, path) {
  let res;
  try { res = await api.get(path); } catch { fail("api", `API request failed: ${path.split("?")[0]}`); }
  if (!res || res.status !== 200 || res.body === undefined || res.body === null) fail("api", `unexpected API status ${res?.status} for ${path.split("?")[0]}`);
  return res.body;
}

/** Collects every item of a list endpoint (array body, or body[key] for compare/commit file lists). Fails when the page cap is reached. */
async function paged(api, path, key) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await getOk(api, `${path}${path.includes("?") ? "&" : "?"}per_page=${PER_PAGE}&page=${page}`);
    const items = key ? body[key] : body;
    if (!Array.isArray(items)) fail("api", `unexpected list shape for ${path.split("?")[0]}`);
    out.push(...items);
    if (items.length < PER_PAGE) return out;
  }
  return fail("truncated", `more than ${MAX_PAGES * PER_PAGE} items for ${path.split("?")[0]}; refusing to validate a partial list`);
}

const normPatch = (p) => (typeof p === "string" ? p.split("\n").filter((l) => !l.startsWith("@@")).join("\n") : null);
function fileKey(f) {
  if (typeof f?.filename !== "string") fail("api", "file entry without a name");
  // Binary or oversize files have no patch: then the blob sha (PR head vs merge commit) is the only content proof, and it must exist.
  const blob = typeof f.patch === "string" ? null : f.sha;
  if (typeof f.patch !== "string" && !/^[0-9a-f]{40}$/.test(blob ?? "")) fail("diff", "a changed file has neither a patch nor a blob sha to compare");
  return JSON.stringify([f.filename, f.status, f.previous_filename ?? null, f.additions, f.deletions, normPatch(f.patch), blob]);
}

export async function validatePin({ sha, repo, branch, api, codeownersText }) {
  if (typeof sha !== "string" || !SHA_RE.test(sha)) fail("shape", "the pin must be a full 40-character lowercase hex commit id");
  if (!REPO_RE.test(repo ?? "")) fail("input", "repository shape");
  if (!BRANCH_RE.test(branch ?? "") || branch.includes("..")) fail("input", "release branch shape");
  const owners = governanceOwners(codeownersText);

  // 1. the commit exists and is exactly the requested object
  const commit = await getOk(api, `/repos/${repo}/commits/${sha}`);
  if (commit.sha !== sha) fail("commit", "the API returned a different commit than requested");
  const parents = (commit.parents ?? []).map((p) => p.sha);
  if (parents.length < 1 || parents.length > 2 || !parents.every((p) => SHA_RE.test(p))) fail("commit", "the commit must have one parent (squash) or two (merge commit)");

  // 2. ancestry: sha is an ancestor of (or equal to) the release branch tip
  const cmp = await getOk(api, `/repos/${repo}/compare/${sha}...heads/${branch}`); // qualified: a tag with the branch's name must not win
  if (!["ahead", "identical"].includes(cmp.status) || cmp.merge_base_commit?.sha !== sha) fail("ancestry", `the commit is not an ancestor of ${branch} (compare status: ${String(cmp.status)})`);

  // 3. exactly one merged PR into the release branch whose merge commit is this sha
  const assoc = await paged(api, `/repos/${repo}/commits/${sha}/pulls`);
  const candidates = assoc.filter((p) => p?.merged_at && p.merge_commit_sha === sha && p.base?.ref === branch);
  if (candidates.length === 0) fail("no-pr", `no merged PR into ${branch} has this commit as its merge commit`);
  if (candidates.length > 1) fail("ambiguous-pr", "more than one PR claims this merge commit");
  const pr = await getOk(api, `/repos/${repo}/pulls/${Number(candidates[0].number)}`);
  if (!Number.isInteger(pr.number) || pr.merged !== true || pr.merge_commit_sha !== sha || pr.base?.ref !== branch || !pr.merged_at) fail("pr-state", "the PR is not a merged PR into the release branch with this merge commit");
  const head = pr.head?.sha;
  if (!SHA_RE.test(head ?? "")) fail("pr-state", "PR head sha");
  const author = pr.user?.login;
  if (!LOGIN_RE.test(author ?? "")) fail("pr-state", "PR author login");

  // 4. no extra commits or diff beyond the PR
  if (parents.length === 2 && parents[1] !== head) fail("extra-commits", "the merge commit's second parent is not the PR head: other commits were merged with it");
  const prCommits = await paged(api, `/repos/${repo}/pulls/${pr.number}/commits`);
  if (prCommits.length === 0 || prCommits[prCommits.length - 1].sha !== head || prCommits.length !== pr.commits) fail("push-after", "the PR head is not the last commit of the PR (or the commit list is inconsistent)");
  const prFiles = await paged(api, `/repos/${repo}/pulls/${pr.number}/files`);
  const commitFiles = await paged(api, `/repos/${repo}/compare/${parents[0]}...${sha}`, "files");
  if (prFiles.length !== pr.changed_files) fail("diff", "the PR file list is incomplete");
  const want = prFiles.map(fileKey).sort();
  const got = commitFiles.map(fileKey).sort();
  if (want.length !== got.length || want.some((k, i) => k !== got[i])) fail("diff", "the commit's changes differ from the PR's changes (extra, missing or altered files or lines)");

  // 5. approval provenance from the reviews API
  const reviews = await paged(api, `/repos/${repo}/pulls/${pr.number}/reviews`);
  const latestOf = (list) => {
    const m = new Map();
    for (const r of list) {
      const login = r?.user?.login;
      if (!LOGIN_RE.test(login ?? "") || !DECISIVE.has(r.state)) continue;
      const key = login.toLowerCase();
      const prev = m.get(key);
      if (!prev || Number(r.id) > Number(prev.id)) m.set(key, r); // review ids grow with time
    }
    return m;
  };
  const mergedAt = Date.parse(pr.merged_at);
  const isTime = (r) => Number.isFinite(Date.parse(r?.submitted_at));
  // A change request at ANY time blocks (fail closed). Approval is judged as of the merge: reviews submitted after the merge (e.g. a re-approval) neither grant nor revoke it.
  for (const [login, r] of latestOf(reviews)) if (owners.has(login) && r.state === "CHANGES_REQUESTED") fail("changes-requested", `code owner ${login} has an open change request`);
  const latest = latestOf(reviews.filter((r) => isTime(r) && Date.parse(r.submitted_at) <= mergedAt));
  const approvals = [...latest.entries()].filter(([login, r]) => owners.has(login) && r.state === "APPROVED" && r.user.type === "User" && login !== author.toLowerCase());
  if (approvals.length === 0) fail("not-approved", "no code owner's latest review is an APPROVED review (dismissed, missing, own PR or not a code owner)");
  const good = approvals.filter(([, r]) => r.commit_id === head);
  if (good.length === 0) fail("approval-stale", "the code-owner approval is not on the PR head at merge, or was submitted after the merge");
  const [reviewer, review] = good[0];

  return {
    sha, branch, repo,
    ancestry: cmp.status, aheadBy: cmp.ahead_by,
    pr: { number: pr.number, url: `https://github.com/${repo}/pull/${pr.number}`, author, head, mergedAt: pr.merged_at, commits: prCommits.length, files: prFiles.length },
    parents,
    review: { reviewer, id: review.id, submittedAt: review.submitted_at },
  };
}

export function renderSummary(r) {
  return [
    "## Pin validation - PASSED (before any secret or deployment approval)",
    "",
    `- commit under test: \`${r.sha}\``,
    `- merged PR: ${r.pr.url} (author \`${r.pr.author}\`, head at merge \`${r.pr.head}\`, ${r.pr.commits} commit(s), ${r.pr.files} file(s), merged ${r.pr.mergedAt})`,
    `- code-owner approval: \`${r.review.reviewer}\`, review ${r.review.id}, submitted ${r.review.submittedAt}, on exactly the PR head; no later push`,
    `- release-branch ancestry: ${r.ancestry} (\`${r.sha}\` is ${r.ancestry === "identical" ? "the tip of" : `${r.aheadBy} commit(s) behind the tip of`} \`${r.branch}\`)`,
    `- commit content equals the PR (${r.parents.length === 2 ? "merge commit" : "single parent"}; file list, line counts and patches compared)`,
    "",
    "The environment approval that follows authorizes ONLY this commit. Compare it with the approval message.",
    "",
  ].join("\n");
}
export function renderFailure(err) {
  const code = err instanceof PinValidationError ? err.code : "internal";
  const message = err instanceof PinValidationError ? err.message : "unexpected validator error";
  return [`## Pin validation - FAILED (${code})`, "", message, "", "No secret was available and no deployment approval was requested. Nothing ran.", ""].join("\n");
}

function makeApi(token) {
  return {
    async get(path) {
      const res = await fetch(`https://api.github.com${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "cf1-pin-validator" },
        signal: AbortSignal.timeout(30000),
      });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      return { status: res.status, body };
    },
  };
}

async function main() {
  const env = process.env;
  const out = (file, text) => { if (file) appendFileSync(file, text); };
  try {
    if (!env.GH_TOKEN) fail("input", "no token");
    const codeownersText = readFileSync(env.CODEOWNERS_PATH || ".github/CODEOWNERS", "utf8");
    const result = await validatePin({ sha: env.PIN ?? "", repo: env.GITHUB_REPOSITORY ?? "", branch: env.CF1_RELEASE_BRANCH ?? "", api: makeApi(env.GH_TOKEN), codeownersText });
    const summary = renderSummary(result);
    console.log(summary);
    out(env.GITHUB_STEP_SUMMARY, summary);
    out(env.GITHUB_OUTPUT, `sha=${result.sha}\n`); // only after every check passed
  } catch (err) {
    const text = renderFailure(err);
    console.error(text);
    out(env.GITHUB_STEP_SUMMARY, text);
    process.exitCode = 1; // not process.exit(): on Windows it can abort inside libuv with a pending fetch timer (exit 127); still non-zero, no output sha
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
