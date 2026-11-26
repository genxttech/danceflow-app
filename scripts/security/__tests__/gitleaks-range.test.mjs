// node --test scripts/security/__tests__/gitleaks-range.test.mjs
// Builds a throwaway repository and checks which commits gitleaks-range.sh selects for each CI event.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "gitleaks-range.sh").replaceAll("\\", "/");
// On Windows the first "bash" on PATH may be the WSL launcher, so use the one shipped with Git.
const BASH = process.platform === "win32" ? join(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "..", "..", "..", "bin", "bash.exe") : "bash";
const ZERO = "0".repeat(40);
let repo;
const sha = {};

const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const commit = (name) => {
  writeFileSync(join(repo, `${name}.txt`), name);
  git("add", "-A");
  git("commit", "-q", "-m", name);
  sha[name] = git("rev-parse", "HEAD");
};
const run = (env) => spawnSync(BASH, [SCRIPT], { cwd: repo, encoding: "utf8", env: { ...process.env, DEFAULT_BRANCH: "main", REF_NAME: "topic", EVENT_NAME: "push", PR_BASE_SHA: "", PR_HEAD_SHA: "", PUSH_BEFORE_SHA: "", PUSH_AFTER_SHA: "", ...env } });
const selected = (env) => {
  const r = run(env);
  assert.equal(r.status, 0, r.stderr);
  const list = git("rev-list", ...r.stdout.trim().split(" "));
  return list ? list.split("\n").map((id) => Object.keys(sha).find((n) => sha[n] === id)).sort() : [];
};

before(() => {
  repo = mkdtempSync(join(tmpdir(), "gitleaks-range-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  commit("m1");
  commit("m2");
  git("switch", "-q", "-c", "topic");
  commit("t1");
  commit("t2");
  git("switch", "-q", "main");
  commit("m3");
  git("update-ref", "refs/remotes/origin/main", sha.m3);
  git("switch", "-q", "topic");
  git("merge", "-q", "--no-ff", "-m", "merge", "main");
  sha.merge = git("rev-parse", "HEAD");
});
after(() => rmSync(repo, { recursive: true, force: true }));

describe("pull_request", () => {
  it("selects the commits that are on the head and not on the base", () => {
    assert.deepEqual(selected({ EVENT_NAME: "pull_request", PR_BASE_SHA: sha.m3, PR_HEAD_SHA: sha.t2 }), ["t1", "t2"]);
  });
  it("fails when a commit is missing", () => {
    assert.notEqual(run({ EVENT_NAME: "pull_request", PR_BASE_SHA: sha.m3, PR_HEAD_SHA: "1".repeat(40) }).status, 0);
    assert.notEqual(run({ EVENT_NAME: "pull_request", PR_BASE_SHA: "", PR_HEAD_SHA: sha.t2 }).status, 0);
  });
});

describe("push", () => {
  it("selects only the newly pushed commits of a branch", () => {
    assert.deepEqual(selected({ PUSH_BEFORE_SHA: sha.t1, PUSH_AFTER_SHA: sha.t2 }), ["t2"]);
  });
  it("leaves out default branch commits brought in by a merge", () => {
    assert.deepEqual(selected({ PUSH_BEFORE_SHA: sha.t2, PUSH_AFTER_SHA: sha.merge }), ["merge"]);
  });
  it("selects everything not on the default branch for a new branch", () => {
    assert.deepEqual(selected({ PUSH_BEFORE_SHA: ZERO, PUSH_AFTER_SHA: sha.t2 }), ["t1", "t2"]);
  });
  it("selects everything not on the default branch after a force push that dropped the old tip", () => {
    assert.deepEqual(selected({ PUSH_BEFORE_SHA: "2".repeat(40), PUSH_AFTER_SHA: sha.t2 }), ["t1", "t2"]);
  });
  it("selects the new commits of the default branch", () => {
    assert.deepEqual(selected({ REF_NAME: "main", PUSH_BEFORE_SHA: sha.m2, PUSH_AFTER_SHA: sha.m3 }), ["m3"]);
  });
  it("scans the whole default branch when there is no previous tip", () => {
    assert.deepEqual(selected({ REF_NAME: "main", PUSH_BEFORE_SHA: ZERO, PUSH_AFTER_SHA: sha.m3 }), ["m1", "m2", "m3"]);
  });
  it("fails when the pushed commit or the default branch ref is missing", () => {
    assert.notEqual(run({ PUSH_BEFORE_SHA: sha.t1, PUSH_AFTER_SHA: "3".repeat(40) }).status, 0);
    assert.notEqual(run({ DEFAULT_BRANCH: "nope", PUSH_BEFORE_SHA: sha.t1, PUSH_AFTER_SHA: sha.t2 }).status, 0);
  });
});

describe("other input", () => {
  it("fails on an unknown event and on a value that is not a commit id", () => {
    assert.notEqual(run({ EVENT_NAME: "schedule" }).status, 0);
    assert.notEqual(run({ EVENT_NAME: "pull_request", PR_BASE_SHA: "HEAD", PR_HEAD_SHA: sha.t2 }).status, 0);
  });
});
