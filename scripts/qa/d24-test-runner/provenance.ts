// Release provenance and elevated-toolchain checks for the installer. Pure apart from injected readers/getters.

import { processEnvProblems } from "./envguard";
import type { HttpGet } from "./remotetip";
import { lockedTreeGate, type AclReader, type Gate, type Who } from "./installroot";

export const PINNED_REPO_FULL_NAME = "genxttech/danceflow-app";

/** The release commit must be THE merge commit of a MERGED pull request into main, merged by the owner's GitHub login (anonymous API read). */
export async function verifyMergedPr(get: HttpGet, o: { prNumber: number; commit: string; ownerLogin: string }): Promise<Gate> {
  const fail = (detail: string): Gate => ({ id: "pr-merge-commit", ok: false, detail });
  if (!/^[A-Za-z0-9-]{1,39}$/.test(o.ownerLogin)) return fail("the owner's GitHub login is missing or malformed");
  let res;
  try {
    res = await get(new URL(`https://api.github.com/repos/${PINNED_REPO_FULL_NAME}/pulls/${o.prNumber}`));
  } catch {
    return fail("the pull request could not be fetched");
  }
  if (res.status !== 200 || !/json/i.test(res.contentType)) return fail(`GitHub answered ${res.status} for PR #${o.prNumber}`);
  let j: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    j = JSON.parse(res.body.toString("utf8"));
  } catch {
    return fail("the pull request response is not JSON");
  }
  const problems: string[] = [];
  if (j.number !== o.prNumber) problems.push("PR number mismatch");
  if (j.merged !== true) problems.push("the PR is not merged");
  if (j.merge_commit_sha !== o.commit) problems.push(`the PR's merge commit is ${String(j.merge_commit_sha).slice(0, 12)}, not ${o.commit.slice(0, 12)} (an older or different commit on main is not accepted)`);
  if (j.base?.ref !== "main") problems.push("the PR did not merge into main");
  if (j.base?.repo?.full_name !== PINNED_REPO_FULL_NAME) problems.push("the PR is not in the pinned repository");
  if (String(j.merged_by?.login ?? "").toLowerCase() !== o.ownerLogin.toLowerCase()) problems.push(`the PR was merged by ${String(j.merged_by?.login)}, not by the owner`);
  return problems.length === 0 ? { id: "pr-merge-commit", ok: true, detail: `PR #${o.prNumber} merged into main by ${o.ownerLogin}; ${o.commit.slice(0, 12)} is its merge commit` } : fail(problems.join("; "));
}

const NPM_VARS = /^(npm_config_|NPM_CONFIG_|NODE_PATH$|NODE_OPTIONS$|NODE_ENV$|TSX_|GIT_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/i;
export type ToolchainInput = {
  env: Record<string, string | undefined>;
  execArgv: readonly string[];
  execPath: string;
  adminNode: string;
  runningFile: string;
  sourceRepo: string;
  gitBin: string | null;
  adminGit: string;
  reader: AclReader;
  who: Who;
};
const lc = (p: string) => p.replace(/\\/g, "/").toLowerCase();
/** The elevated installer must not run agent-writable code or inherit agent-controlled configuration. */
export async function toolchainGates(t: ToolchainInput): Promise<Gate[]> {
  const out: Gate[] = [];
  const envBad = [...processEnvProblems(t.env, t.execArgv), ...Object.keys(t.env).filter((k) => NPM_VARS.test(k)).map((k) => `${k} is set in the elevated environment`)];
  out.push({ id: "elevated-env", ok: envBad.length === 0, detail: envBad.length === 0 ? "no NODE_*/npm_config_*/proxy/GIT_* override in the elevated environment" : [...new Set(envBad)].slice(0, 5).join(" | ") });
  const nodeOk = lc(t.execPath) === lc(t.adminNode);
  out.push({ id: "elevated-node", ok: nodeOk, detail: nodeOk ? `running under ${t.adminNode}` : `node is ${t.execPath}, not the administrator-only ${t.adminNode}` });
  if (nodeOk) out.push(await lockedTreeGate("elevated-node-acl", t.execPath, false, t.reader, t.who));
  const inside = lc(t.runningFile).startsWith(`${lc(t.sourceRepo).replace(/\/+$/, "")}/`);
  out.push({ id: "elevated-code-location", ok: inside, detail: inside ? "the installer code runs from the source clone being installed" : "the installer code is not part of the source clone that will be verified" });
  out.push(await lockedTreeGate("elevated-source-acl", t.sourceRepo, true, t.reader, t.who));
  const gitOk = t.gitBin !== null && lc(t.gitBin) === lc(t.adminGit);
  out.push({ id: "elevated-git", ok: gitOk, detail: gitOk ? `git is ${t.adminGit}` : "git was not found at its fixed administrator-only location" });
  if (gitOk) out.push(await lockedTreeGate("elevated-git-acl", t.adminGit, false, t.reader, t.who));
  return out;
}
