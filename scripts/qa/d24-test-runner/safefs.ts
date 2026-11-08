// Reads for untrusted (owner-writable) locations: no link following, a bounded size, and the handle that was opened is the file that was checked.

import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";

/** Contents of a regular, non-link file of at most maxBytes, read from the opened handle; null when anything is off or the file is swapped while reading. */
export function readFileNoFollow(file: string, maxBytes: number): Buffer | null {
  try {
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) return null;
    const fd = openSync(file, "r");
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > maxBytes || st.ino !== before.ino || st.dev !== before.dev) return null;
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < buf.length) {
        const n = readSync(fd, buf, off, buf.length - off, off);
        if (n === 0) break;
        off += n;
      }
      const after = lstatSync(file);
      if (after.isSymbolicLink() || after.ino !== before.ino || after.size !== before.size || off !== buf.length) return null;
      return buf;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}
/** A directory that is a real directory (not a link/junction). */
export function isRealDir(p: string): boolean {
  try {
    const st = lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}
