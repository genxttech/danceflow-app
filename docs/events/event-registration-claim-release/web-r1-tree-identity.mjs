#!/usr/bin/env node
// READ-ONLY tree-identity check for a staged Vercel deployment against a git ref ("Web R+1" runbook, section 4).
//
//   node web-r1-tree-identity.mjs <git-ref> <vercel-files.json>   compare a saved Vercel file tree with the git tree
//   node web-r1-tree-identity.mjs <git-ref> --selftest            build a synthetic tree from the ref (minus .gitignore files) and prove the logic
//
// <vercel-files.json> is the body of GET https://api.vercel.com/v6/deployments/<dpl_id>/files?teamId=<team> saved to disk by the operator who holds
// the Vercel credential (this script never reads a token and never touches the network). Entries are nested {name, type, uid, children}; a file's
// uid is the sha1 of its raw content, which is NOT the git blob id (git hashes "blob <size>\0" + content), so this script re-hashes every git blob.
// The real response wraps the source in one root directory ("src") and has a top-level build-output directory ("out"); both are handled.
// Expected result: identical except that .gitignore files are absent from the deployment (the Vercel CLI skips them). Anything else exits 1.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const sha1 = (buf) => createHash("sha1").update(buf).digest("hex");

export function gitTree(r) {
  const out = execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", r], { maxBuffer: 1 << 28 }).toString("utf8");
  const files = [];
  const skipped = [];
  for (const rec of out.split("\0").filter(Boolean)) {
    const tab = rec.indexOf("\t");
    const [mode, type, oid] = rec.slice(0, tab).split(" ");
    const p = rec.slice(tab + 1);
    if (type !== "blob" || mode === "120000") skipped.push(`${mode} ${type} ${p}`);
    else files.push({ path: p, oid });
  }
  // One cat-file process for all blobs: output is "<oid> blob <size>\n<content>\n" per object.
  const res = spawnSync("git", ["cat-file", "--batch"], { input: files.map((f) => f.oid).join("\n") + "\n", maxBuffer: 1 << 30 });
  if (res.status !== 0) throw new Error("git cat-file failed: " + res.stderr.toString());
  const buf = res.stdout;
  let pos = 0;
  const map = new Map();
  for (const f of files) {
    const nl = buf.indexOf(0x0a, pos);
    const [oid, kind, size] = buf.subarray(pos, nl).toString("utf8").split(" ");
    if (oid !== f.oid || kind !== "blob") throw new Error(`unexpected cat-file header for ${f.path}`);
    const start = nl + 1;
    map.set(f.path, sha1(buf.subarray(start, start + Number(size))));
    pos = start + Number(size) + 1;
  }
  return { map, skipped };
}

function flattenVercel(nodes, prefix = "", into = new Map()) {
  for (const n of nodes) {
    const p = prefix ? `${prefix}/${n.name}` : n.name;
    if (n.type === "directory") flattenVercel(n.children ?? [], p, into);
    else if (n.type === "file") into.set(p, n.uid);
    // lambdas / symlinks / other build outputs are not source files and are ignored
  }
  return into;
}

export function syntheticTree(map) {
  const root = [];
  for (const [p, uid] of map) {
    if (p === ".gitignore" || p.endsWith("/.gitignore")) continue;
    const parts = p.split("/");
    let level = root;
    for (const part of parts.slice(0, -1)) {
      let d = level.find((x) => x.type === "directory" && x.name === part);
      if (!d) level.push((d = { name: part, type: "directory", children: [] }));
      level = d.children;
    }
    level.push({ name: parts.at(-1), type: "file", uid });
  }
  return root;
}

export function compareTrees(gitMap, treeJson) {
  const nodes = Array.isArray(treeJson) ? treeJson : (treeJson.files ?? treeJson.tree ?? []);
  // The real API response has a build-output directory "out" at the top level (not source) and wraps the source in a root directory ("src").
  const gitHasOut = [...gitMap.keys()].some((p) => p.startsWith("out/"));
  const top = nodes.filter((n) => gitHasOut || !(n.type === "directory" && n.name === "out"));
  const raw = flattenVercel(top);
  let vercel = raw;
  let unwrapped = null;
  const dirs = top.filter((n) => n.type === "directory");
  if (top.length === 1 && dirs.length === 1) {
    const inner = flattenVercel(dirs[0].children ?? []);
    const hits = (m) => [...gitMap.keys()].filter((p) => m.has(p)).length;
    // Unwrap a single root directory only when that matches the git tree better than the raw paths do.
    if (hits(inner) > hits(raw)) {
      vercel = inner;
      unwrapped = dirs[0].name;
    }
  }
  const missing = [];
  const mismatched = [];
  for (const [p, h] of gitMap) {
    if (!vercel.has(p)) missing.push(p);
    else if (vercel.get(p) !== h) mismatched.push(p);
  }
  const extra = [...vercel.keys()].filter((p) => !gitMap.has(p));
  const unexpectedMissing = missing.filter((p) => p !== ".gitignore" && !p.endsWith("/.gitignore"));
  const ok = unexpectedMissing.length === 0 && extra.length === 0 && mismatched.length === 0 && vercel.size > 0;
  return { ok, unwrappedRootDirectory: unwrapped, gitFiles: gitMap.size, vercelFiles: vercel.size, missingFromDeployment: missing, extraInDeployment: extra, contentMismatch: mismatched };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [ref, second] = process.argv.slice(2);
  if (!ref || !second) {
    console.error("usage: web-r1-tree-identity.mjs <git-ref> <vercel-files.json | --selftest>");
    process.exit(2);
  }
  const { map: gitMap, skipped } = gitTree(ref);
  const treeJson = second === "--selftest" ? syntheticTree(gitMap) : JSON.parse(readFileSync(second, "utf8"));
  const { ok, ...report } = compareTrees(gitMap, treeJson);
  console.log(JSON.stringify({ ref, skippedNonBlobOrSymlink: skipped, ...report }, null, 2));
  console.log(ok ? "TREE IDENTITY: PASS (only .gitignore files absent)" : "TREE IDENTITY: FAIL");
  process.exit(ok ? 0 : 1);
}
