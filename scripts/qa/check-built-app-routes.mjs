#!/usr/bin/env node
// After `next build`, fail if any app route handler under src/app (every route.ts / route.js) is missing from the built
// .next/server/app-paths-manifest.json. A route can be absent without a build error (for example a misplaced file or a
// bundler/cache problem), and the symptom is only a 404 at runtime.
//
//   npm run build && node scripts/qa/check-built-app-routes.mjs [--dist .next]
// (Not an npm script: the root package.json is hash-pinned by the D24 proof workflows.)
//
// Exit 0: every route is in the manifest. Exit 1: routes are missing (listed). Exit 2: no build output to check.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const distIndex = args.indexOf("--dist");
const dist = distIndex >= 0 ? args[distIndex + 1] : ".next";
const appDir = path.resolve("src", "app");
const manifestPath = path.resolve(dist, "server", "app-paths-manifest.json");

if (!existsSync(manifestPath)) {
  console.error(`No build manifest at ${manifestPath}. Run \`next build\` first.`);
  process.exit(2);
}

const routeFiles = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry.startsWith("_") || entry === "node_modules") continue;
      walk(full);
    } else if (/^route\.(ts|js|tsx|jsx)$/.test(entry)) {
      routeFiles.push(full);
    }
  }
})(appDir);

// src/app/(group)/x/[id]/route.ts -> "/(group)/x/[id]/route", the key form the manifest uses.
const expected = routeFiles.map((file) => {
  const rel = path.relative(appDir, path.dirname(file)).split(path.sep).join("/");
  return `/${rel ? `${rel}/` : ""}route`.replace(/\/\//g, "/");
});

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const built = new Set(Object.keys(manifest));
const missing = expected.filter((key) => !built.has(key));

console.log(`${expected.length} route handlers in src/app, ${expected.length - missing.length} present in ${path.relative(process.cwd(), manifestPath)}`);
if (missing.length) {
  console.error(`MISSING from the build (${missing.length}):\n${missing.map((m) => `  ${m}`).join("\n")}`);
  process.exit(1);
}
console.log("All app route handlers are in the build.");
