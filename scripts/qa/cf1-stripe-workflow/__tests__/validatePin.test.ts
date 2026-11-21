import { describe, expect, it } from "vitest";
import { governanceOwners, PinValidationError, renderFailure, renderSummary, validatePin } from "../validatePin.mjs";

/**
 * Offline self-test matrix for the pin validator: an in-memory fake of the GitHub REST API, one scenario per row of the matrix in
 * docs/ops/CF1_Stripe_Workflow_Pin_Validation.md. The happy path must pass; every negative case must fail closed with the expected code.
 */
const REPO = "genxttech/danceflow-app";
const BRANCH = "release/website-embeds";
const SHA = "a".repeat(40);
const PARENT = "b".repeat(40);
const HEAD = "c".repeat(40);
const OTHER = "d".repeat(40);
const CODEOWNERS = "# c\n/.github/ @genxttech\n/package.json @genxttech @someone-else\n";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const BLOB = "e".repeat(40);
const file = (name: string, extra: Any = {}) => ({ filename: name, status: "modified", additions: 3, deletions: 1, patch: "@@ -1,2 +1,4 @@\n a\n-b\n+c\n+d\n+e", sha: "x", ...extra });
const review = (id: number, login: string, state: string, commit_id = HEAD, extra: Any = {}) => ({ id, user: { login, type: "User" }, state, commit_id, submitted_at: "2026-11-19T10:00:00Z", ...extra });

function scenario(over: Any = {}) {
  const s: Any = {
    commit: { sha: SHA, parents: [{ sha: PARENT }] },
    compare: { status: "ahead", ahead_by: 4, merge_base_commit: { sha: SHA } },
    assoc: [{ number: 7, merged_at: "2026-11-19T12:00:00Z", merge_commit_sha: SHA, base: { ref: BRANCH } }],
    pr: { number: 7, merged: true, merged_at: "2026-11-19T12:00:00Z", merge_commit_sha: SHA, base: { ref: BRANCH }, head: { sha: HEAD }, user: { login: "dev-author" }, commits: 2, changed_files: 2 },
    prCommits: [{ sha: OTHER }, { sha: HEAD }],
    prFiles: [file("a.ts"), file("b.ts")],
    commitFiles: [file("a.ts"), file("b.ts", { patch: "@@ -9,2 +9,4 @@\n a\n-b\n+c\n+d\n+e" })], // hunk line numbers may differ after a squash on a moved base
    reviews: [review(1, "genxttech", "APPROVED")],
    errors: {} as Record<string, number>,
    ...over,
  };
  return s;
}

function fakeApi(s: Any) {
  const calls: string[] = [];
  const page = (items: Any[], url: URL) => {
    const per = Number(url.searchParams.get("per_page") ?? 30);
    const n = Number(url.searchParams.get("page") ?? 1);
    return items.slice((n - 1) * per, n * per);
  };
  return {
    calls,
    async get(path: string) {
      calls.push(path);
      const url = new URL(path, "https://x");
      const p = url.pathname;
      for (const [frag, status] of Object.entries(s.errors as Record<string, number>)) if (p.includes(frag)) return { status, body: { message: "boom" } };
      const ok = (body: unknown) => ({ status: 200, body });
      if (p === `/repos/${REPO}/commits/${SHA}`) return s.commit === null ? { status: 404, body: {} } : ok(s.commit);
      if (p === `/repos/${REPO}/compare/${SHA}...heads/${BRANCH}`) return ok(s.compare);
      if (p === `/repos/${REPO}/commits/${SHA}/pulls`) return ok(page(s.assoc, url));
      if (p === `/repos/${REPO}/pulls/7`) return ok(s.pr);
      if (p === `/repos/${REPO}/pulls/7/commits`) return ok(page(s.prCommits, url));
      if (p === `/repos/${REPO}/pulls/7/files`) return ok(page(s.prFiles, url));
      if (p === `/repos/${REPO}/compare/${PARENT}...${SHA}`) return ok({ files: page(s.commitFiles, url) });
      if (p === `/repos/${REPO}/pulls/7/reviews`) return ok(page(s.reviews, url));
      return { status: 404, body: {} };
    },
  };
}

async function run(over: Any = {}, input: Any = {}) {
  const s = scenario(over);
  const api = fakeApi(s);
  return validatePin({ sha: SHA, repo: REPO, branch: BRANCH, api, codeownersText: CODEOWNERS, ...input });
}
async function code(over: Any = {}, input: Any = {}): Promise<string> {
  try { await run(over, input); } catch (e) { expect(e).toBeInstanceOf(PinValidationError); return (e as { code: string }).code; }
  return "PASSED";
}

describe("validatePin: the reviewed commit passes", () => {
  it("squash merge, approved on the head, ancestor of the release branch", async () => {
    const r = await run();
    expect(r).toMatchObject({ sha: SHA, ancestry: "ahead", pr: { number: 7, author: "dev-author", head: HEAD, files: 2 }, review: { reviewer: "genxttech", id: 1 } });
    const text = renderSummary(r);
    for (const part of [SHA, "pull/7", "genxttech", "ahead", HEAD]) expect(text).toContain(part);
  });
  it("a merge commit whose second parent is the PR head passes", async () => {
    expect((await run({ commit: { sha: SHA, parents: [{ sha: PARENT }, { sha: HEAD }] } })).parents).toHaveLength(2);
  });
  it("the sha may be the branch tip itself (identical)", async () => {
    expect((await run({ compare: { status: "identical", ahead_by: 0, merge_base_commit: { sha: SHA } } })).ancestry).toBe("identical");
  });
  it("reads every page: 250 files, and an earlier approval superseded by a later one", async () => {
    const many = Array.from({ length: 250 }, (_, i) => file(`f${i}.ts`));
    const r = await run({ prFiles: many, commitFiles: many, pr: { ...scenario().pr, changed_files: 250 }, reviews: [review(1, "genxttech", "CHANGES_REQUESTED", OTHER), review(2, "genxttech", "APPROVED")] });
    expect(r.pr.files).toBe(250);
  });
});

describe("validatePin: negative matrix (all fail closed)", () => {
  it("N01 malformed pin: short, uppercase, branch name, injection text", async () => {
    for (const bad of ["abc123", SHA.toUpperCase(), "release/website-embeds", `${SHA}; echo`, "", `${SHA}\n`]) expect(await code({}, { sha: bad })).toBe("shape");
  });
  it("N02 commit does not exist / API returns another object", async () => {
    expect(await code({ commit: null })).toBe("api");
    expect(await code({ commit: { sha: OTHER, parents: [{ sha: PARENT }] } })).toBe("commit");
  });
  it("N03 commit with zero or three parents", async () => {
    expect(await code({ commit: { sha: SHA, parents: [] } })).toBe("commit");
    expect(await code({ commit: { sha: SHA, parents: [{ sha: PARENT }, { sha: HEAD }, { sha: OTHER }] } })).toBe("commit");
  });
  it("N04 not an ancestor of the release branch: diverged, behind, or merge base differs", async () => {
    expect(await code({ compare: { status: "diverged", merge_base_commit: { sha: PARENT } } })).toBe("ancestry");
    expect(await code({ compare: { status: "behind", merge_base_commit: { sha: PARENT } } })).toBe("ancestry");
    expect(await code({ compare: { status: "ahead", merge_base_commit: { sha: PARENT } } })).toBe("ancestry");
  });
  it("N05 no PR for the commit (direct push)", async () => {
    expect(await code({ assoc: [] })).toBe("no-pr");
  });
  it("N06 PR not merged, merged into another base, or merge commit is another sha", async () => {
    expect(await code({ assoc: [{ ...scenario().assoc[0], merged_at: null }] })).toBe("no-pr");
    expect(await code({ assoc: [{ ...scenario().assoc[0], base: { ref: "main" } }] })).toBe("no-pr");
    expect(await code({ assoc: [{ ...scenario().assoc[0], merge_commit_sha: OTHER }] })).toBe("no-pr");
    expect(await code({ pr: { ...scenario().pr, merged: false } })).toBe("pr-state");
  });
  it("N07 two PRs claim the merge commit", async () => {
    const a = scenario().assoc[0];
    expect(await code({ assoc: [a, { ...a, number: 8 }] })).toBe("ambiguous-pr");
  });
  it("N08 unapproved PR: no reviews, only comments, only pending", async () => {
    expect(await code({ reviews: [] })).toBe("not-approved");
    expect(await code({ reviews: [review(1, "genxttech", "COMMENTED")] })).toBe("not-approved");
    expect(await code({ reviews: [review(1, "genxttech", "PENDING")] })).toBe("not-approved");
  });
  it("N09 approval by someone who is not a code owner (even if APPROVED)", async () => {
    expect(await code({ reviews: [review(1, "random-dev", "APPROVED")] })).toBe("not-approved");
    expect(await code({ reviews: [review(1, "someone-else", "APPROVED")] })).toBe("not-approved"); // owner of /package.json, not of /.github/
  });
  it("N10 push after approval: the approval is on an older commit", async () => {
    expect(await code({ reviews: [review(1, "genxttech", "APPROVED", OTHER)] })).toBe("approval-stale");
  });
  it("N11 push after approval: the PR head is not the last commit of the PR, or the count is off", async () => {
    expect(await code({ prCommits: [{ sha: HEAD }, { sha: OTHER }] })).toBe("push-after");
    expect(await code({ pr: { ...scenario().pr, commits: 3 } })).toBe("push-after");
  });
  it("N12 dismissed review, including approval later dismissed with no force-push (same head, no new commit)", async () => {
    expect(await code({ reviews: [review(1, "genxttech", "DISMISSED")] })).toBe("not-approved");
    expect(await code({ reviews: [review(1, "genxttech", "APPROVED"), review(2, "genxttech", "DISMISSED")] })).toBe("not-approved");
  });
  it("N13 later change request by the code owner overrides the approval", async () => {
    expect(await code({ reviews: [review(1, "genxttech", "APPROVED"), review(2, "genxttech", "CHANGES_REQUESTED")] })).toBe("changes-requested");
  });
  it("N14 self-approval by the PR author, and a bot reviewer", async () => {
    expect(await code({ pr: { ...scenario().pr, user: { login: "genxttech" } } })).toBe("not-approved");
    expect(await code({ reviews: [{ ...review(1, "genxttech", "APPROVED"), user: { login: "genxttech", type: "Bot" } }] })).toBe("not-approved");
  });
  it("N15 approval submitted after the merge", async () => {
    expect(await code({ reviews: [review(1, "genxttech", "APPROVED", HEAD, { submitted_at: "2026-11-19T12:00:01Z" })] })).toBe("approval-stale");
  });
  it("N16 extra commits beyond the PR: merge commit's second parent is not the head", async () => {
    expect(await code({ commit: { sha: SHA, parents: [{ sha: PARENT }, { sha: OTHER }] } })).toBe("extra-commits");
  });
  it("N17 extra diff beyond the PR: extra file, missing file, altered line counts, altered patch, rename", async () => {
    const s = scenario();
    expect(await code({ commitFiles: [...s.commitFiles, file("evil.ts")] })).toBe("diff");
    expect(await code({ commitFiles: [s.commitFiles[0]] })).toBe("diff");
    expect(await code({ commitFiles: [s.commitFiles[0], file("b.ts", { additions: 4 })] })).toBe("diff");
    expect(await code({ commitFiles: [s.commitFiles[0], file("b.ts", { patch: "@@ -1 +1 @@\n-x\n+y" })] })).toBe("diff");
    expect(await code({ commitFiles: [s.commitFiles[0], file("b.ts", { status: "renamed", previous_filename: "z.ts" })] })).toBe("diff");
    expect(await code({ prFiles: [s.prFiles[0]] })).toBe("diff");
  });
  it("N18 rebase merge of several commits (the commit holds only the last commit's diff)", async () => {
    expect(await code({ commitFiles: [file("b.ts", { patch: "@@ -9,2 +9,4 @@\n a\n-b\n+c\n+d\n+e" })], pr: { ...scenario().pr, changed_files: 2 } })).toBe("diff");
  });
  it("N19 any API error at any stage fails closed", async () => {
    for (const frag of ["/commits/" + SHA, "/compare/" + SHA, "/pulls/7/reviews", "/pulls/7/files", "/pulls/7/commits", "/compare/" + PARENT, "/pulls/7"]) {
      for (const status of [500, 403, 404, 502]) expect(await code({ errors: { [frag]: status } }), `${frag} ${status}`).toBe("api");
    }
  });
  it("N20 a throwing client or an empty body fails closed", async () => {
    const throwing = { get: async () => { throw new Error("network"); } };
    await expect(validatePin({ sha: SHA, repo: REPO, branch: BRANCH, api: throwing, codeownersText: CODEOWNERS })).rejects.toMatchObject({ code: "api" });
    const empty = { get: async () => ({ status: 200, body: null }) };
    await expect(validatePin({ sha: SHA, repo: REPO, branch: BRANCH, api: empty, codeownersText: CODEOWNERS })).rejects.toMatchObject({ code: "api" });
  });
  it("N21 truncated lists are refused rather than validated partially", async () => {
    const big = Array.from({ length: 3001 }, (_, i) => review(100 + i, `user${i}`, "COMMENTED"));
    expect(await code({ reviews: big })).toBe("truncated");
  });
  it("N22 CODEOWNERS on main without a user owner for /.github/", async () => {
    expect(await code({}, { codeownersText: "/package.json @genxttech\n" })).toBe("codeowners");
    expect(await code({}, { codeownersText: "/.github/ @org/team\n" })).toBe("codeowners");
  });
  it("N23 bad repository or branch inputs", async () => {
    expect(await code({}, { repo: "x" })).toBe("input");
    expect(await code({}, { branch: "a..b" })).toBe("input");
    expect(await code({}, { branch: "a b" })).toBe("input");
  });
});

describe("review follow-ups (N1-N3)", () => {
  it("N2 the ancestry compare uses the qualified heads/ ref only; a bare-name route (tag ambiguity) is never called", async () => {
    const api = fakeApi(scenario());
    await validatePin({ sha: SHA, repo: REPO, branch: BRANCH, api, codeownersText: CODEOWNERS });
    expect(api.calls.some((c) => c.includes(`...heads/${BRANCH}`))).toBe(true);
    expect(api.calls.some((c) => c.includes(`...${BRANCH}`) && !c.includes(`...heads/${BRANCH}`))).toBe(false);
  });
  it("N3 binary or oversize file (no patch): passes only when PR and commit blob shas are equal; missing or different blob sha fails", async () => {
    const bin = (o: Any = {}) => file("img.png", { patch: undefined, sha: BLOB, ...o });
    const s = scenario();
    expect((await run({ prFiles: [s.prFiles[0], bin()], commitFiles: [s.commitFiles[0], bin()] })).pr.files).toBe(2);
    expect(await code({ prFiles: [s.prFiles[0], bin()], commitFiles: [s.commitFiles[0], bin({ sha: "f".repeat(40) })] })).toBe("diff");
    expect(await code({ prFiles: [s.prFiles[0], bin({ sha: undefined })], commitFiles: [s.commitFiles[0], bin({ sha: undefined })] })).toBe("diff");
    expect(await code({ prFiles: [s.prFiles[0], bin()], commitFiles: [s.commitFiles[0], file("img.png")] })).toBe("diff");
  });
  it("N1 precondition, pinned by test: the diff base is the commit's first parent, and its provenance is NOT verified (documented release-ruleset precondition)", async () => {
    const api = fakeApi(scenario());
    await validatePin({ sha: SHA, repo: REPO, branch: BRANCH, api, codeownersText: CODEOWNERS });
    expect(api.calls.some((c) => c.includes(`/compare/${PARENT}...${SHA}`))).toBe(true);
  });
});

describe("helpers", () => {
  it("governanceOwners reads only the /.github/ rule, case-insensitively, ignoring comments", () => {
    expect([...governanceOwners("/.github/ @GenxTech # c\n/x @other\n")]).toEqual(["genxtech"]);
  });
  it("renderFailure never echoes API bodies and states nothing ran", () => {
    const text = renderFailure(new PinValidationError("diff", "the commit's changes differ"));
    expect(text).toContain("FAILED (diff)");
    expect(text).toContain("Nothing ran");
    expect(renderFailure(new Error("secret-ish"))).not.toContain("secret-ish");
  });
});
