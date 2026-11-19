#!/usr/bin/env node
/**
 * Sets CF1_PINNED_COMMIT in the Competition Stripe TEST workflows, after proving the commit is fit to approve.
 *   node scripts/qa/cf1-stripe-workflow/set-pin.mjs <40-hex commit> [--acceptance] [--dry-run]
 * Checks (all fail closed, nothing is written unless all pass):
 *   - the commit id is 40 hex and exists in the local clone;
 *   - it is an ancestor of origin/release/website-embeds (fetch first: `git fetch origin release/website-embeds`);
 *   - it contains scripts/qa/cf1-stripe-guard.ts and src/lib/e2e/stripeGuard.ts (the canary's code) and, with --acceptance, the relay and the failure/settlement spec;
 *   - it is within the last 300 commits of the branch (the workflow fetches depth 300).
 * Run it, commit the resulting one-line change in its own PR, and have the owner compare the pinned id with this PR's text.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const sha = args.find((a) => /^[0-9a-f]{40}$/.test(a));
const dry = args.includes("--dry-run");
const acceptance = args.includes("--acceptance");
const BRANCH = "origin/release/website-embeds";
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const fail = (m) => { console.error(`set-pin: ${m}`); process.exit(1); };

if (!sha) fail("give a full 40-hex commit id");
try { git("cat-file", "-e", `${sha}^{commit}`); } catch { fail("commit not found locally (git fetch origin release/website-embeds)"); }
try { git("merge-base", "--is-ancestor", sha, BRANCH); } catch { fail(`commit is not an ancestor of ${BRANCH}`); }
const behind = Number(git("rev-list", "--count", `${sha}..${BRANCH}`));
if (behind > 290) fail(`commit is ${behind} commits behind the branch tip; the workflow fetches depth 300`);
const required = ["scripts/qa/cf1-stripe-guard.ts", "src/lib/e2e/stripeGuard.ts", "src/lib/e2e/stripeRelay.ts"];
if (acceptance) required.push("scripts/qa/cf1-stripe-relay.ts", "e2e/tests/competition-stripe-failure-settlement.spec.ts", "e2e/tests/competition-full-event.spec.ts");
for (const file of required) { try { git("cat-file", "-e", `${sha}:${file}`); } catch { fail(`the commit has no ${file}`); } }

const files = ["competition-stripe-canary.yml", ...(acceptance ? ["competition-stripe-test-acceptance.yml"] : [])];
for (const name of files) {
  const path = join(".github", "workflows", name);
  const before = readFileSync(path, "utf8");
  const next = before.replace(/(CF1_PINNED_COMMIT: ")[^"]*(")/, `$1${sha}$2`);
  if (next === before) fail(`${name}: pin line not found or already equal`);
  if (dry) console.log(`dry-run: would set ${name} to ${sha} (${behind} behind the tip)`); else { writeFileSync(path, next); console.log(`set ${name} -> ${sha} (${behind} behind the tip)`); }
}
