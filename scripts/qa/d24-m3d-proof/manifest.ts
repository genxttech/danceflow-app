// Script identity for pinning. The manifest hash covers EVERY file in this directory (sources, tests, README) so the owner can pin one
// value. Line endings are normalised (CRLF -> LF) so a Windows checkout and CI produce the same hash.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

export function manifest(dir: string): { files: Array<{ path: string; sha256: string }>; sha256: string } {
  const files = walk(dir)
    .map((p) => relative(dir, p).split(sep).join("/"))
    .sort()
    .map((rel) => {
      const text = readFileSync(join(dir, rel), "utf8").replace(/\r\n/g, "\n");
      return { path: rel, sha256: createHash("sha256").update(text).digest("hex") };
    });
  const roll = createHash("sha256");
  for (const f of files) roll.update(`${f.path}\0${f.sha256}\n`);
  return { files, sha256: roll.digest("hex") };
}
