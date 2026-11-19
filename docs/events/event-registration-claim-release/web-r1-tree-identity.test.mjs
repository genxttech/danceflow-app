// node --test docs/events/event-registration-claim-release/web-r1-tree-identity.test.mjs   (pure, no git, no network)
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareTrees, syntheticTree } from "./web-r1-tree-identity.mjs";

const git = () =>
  new Map([
    [".gitignore", "g0"],
    ["package.json", "p1"],
    ["src/app/page.tsx", "a1"],
    ["src/lib/x.ts", "b2"],
    ["public/logo.svg", "c3"],
  ]);

const dir = (name, children) => ({ name, type: "directory", children });
const file = (name, uid) => ({ name, type: "file", uid });

// Shape of the real GET /v6/deployments/<id>/files response: the source is wrapped in one root directory "src" and a build-output
// directory "out" sits next to it; .gitignore files are not deployed.
const wrapped = (over = {}) => [
  dir("src", [
    file("package.json", "p1"),
    dir("src", [dir("app", [file("page.tsx", over.page ?? "a1")]), dir("lib", [file("x.ts", "b2")])]),
    dir("public", [file("logo.svg", "c3")]),
    ...(over.extra ? [file("stray.txt", "zz")] : []),
  ]),
  dir("out", [file("index.html", "o1"), dir("_next", [file("chunk.js", "o2")])]),
];

test("real-shaped response: unwraps the single root directory and ignores the out directory", () => {
  const r = compareTrees(git(), wrapped());
  assert.equal(r.ok, true);
  assert.equal(r.unwrappedRootDirectory, "src");
  assert.deepEqual(r.missingFromDeployment, [".gitignore"]);
  assert.deepEqual(r.extraInDeployment, []);
});

test("a plain (unwrapped) tree still passes without unwrapping", () => {
  const r = compareTrees(git(), syntheticTree(git()));
  assert.equal(r.ok, true);
  assert.equal(r.unwrappedRootDirectory, null);
});

test("a real top-level src directory is not unwrapped when the raw paths match better", () => {
  const g = new Map([["src/app/page.tsx", "a1"], ["src/lib/x.ts", "b2"]]);
  const r = compareTrees(g, [dir("src", [dir("app", [file("page.tsx", "a1")]), dir("lib", [file("x.ts", "b2")])])]);
  assert.equal(r.ok, true);
  assert.equal(r.unwrappedRootDirectory, null);
});

test("content mismatch, an extra file and a missing non-.gitignore file all FAIL", () => {
  assert.equal(compareTrees(git(), wrapped({ page: "WRONG" })).ok, false);
  assert.deepEqual(compareTrees(git(), wrapped({ page: "WRONG" })).contentMismatch, ["src/app/page.tsx"]);
  assert.equal(compareTrees(git(), wrapped({ extra: true })).ok, false);
  const g = git();
  g.set("src/lib/missing.ts", "m1");
  assert.deepEqual(compareTrees(g, wrapped()).missingFromDeployment.sort(), [".gitignore", "src/lib/missing.ts"]);
  assert.equal(compareTrees(g, wrapped()).ok, false);
});

test("an empty deployment never passes", () => {
  assert.equal(compareTrees(git(), []).ok, false);
});
