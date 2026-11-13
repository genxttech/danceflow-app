#!/usr/bin/env node
// Make a running `next dev` (webpack or Turbopack) rebuild its App Router route list.
//
// Why: in dev, Next builds the route list from its file watcher's first aggregation, and re-builds it only when a watched file
// changes. That first aggregation can run before the watcher's initial scan has reached the deepest folders, so a deep route can
// answer Next's HTML 404 and be missing from .next/dev/server/app-paths-manifest.json until something changes. Observed on
// Windows, intermittently, with both bundlers, for /api/staff/workspaces/[studioId]/appointments/[appointmentId]/attendance/[clientId]
// (2026-11-12). Production builds read src/app in full and are not affected (see scripts/qa/check-built-app-routes.mjs).
//
// What it does: creates, then deletes, one inert file directly under src/app, which the dev watcher reports as a change.
// It never edits an existing file.
//
//   npm run dev                                 # in one terminal, wait for "Ready"
//   node scripts/dev/rescan-app-routes.mjs      # in another; then retry the request
// (Not an npm script: the root package.json is hash-pinned by the D24 proof workflows.)
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const probe = path.resolve("src", "app", ".dev-route-rescan.ts");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (existsSync(probe)) rmSync(probe);
writeFileSync(probe, "// Temporary file written by scripts/dev/rescan-app-routes.mjs to make next dev rebuild its routes. Safe to delete.\nexport {};\n");
await wait(1500);
rmSync(probe, { force: true });
await wait(1500);
console.log("Asked next dev to rebuild its route list. Retry the request.");
