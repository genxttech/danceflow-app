/**
 * Keeps absolute local paths (drive letters, user home directories, scratchpad locations) out of committed QA evidence.
 * Two steps: a path inside the run directory becomes relative to it; every other absolute path keeps only its last segment
 * behind a "<local>/" marker (so the report still names the file, never the machine layout).
 */
import path from "node:path";

// The drive letter must stand alone, so a URL scheme (http://...) is not mistaken for a drive path.
const WIN_ABS = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'`<>|*?]*/g;
/** Git-Bash / MSYS spelling of a drive path: /c/Dev/..., /d/Users/... */
const MSYS_ABS = /\/[A-Za-z]\/(?:Dev|Users)(?:\/[^\s"'`<>|*?:]*)?/g;
const LOCAL_NAMES = /AppData|\bmcurt\b/;
const POSIX_HOME = /\/(?:Users|home)\/[^\s"'`<>|*?:]+/g;

function slashes(p) {
  return p.replace(/\\/g, "/");
}

/** Relative path under `baseDir` (forward slashes) when `p` lies inside it, otherwise null. */
export function relativeInside(baseDir, p) {
  if (!baseDir) return null;
  const rel = path.relative(path.resolve(baseDir), path.resolve(p));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return slashes(rel);
}

function genericScrub(match) {
  const norm = slashes(match);
  // Playwright run directories look like .../runs/<stamp>/artifacts/...: keep everything from "runs/" on.
  const runs = norm.search(/(^|\/)runs\/[^/]+\//);
  if (runs >= 0) return norm.slice(norm[runs] === "/" ? runs + 1 : runs);
  const last = norm.replace(/\/+$/, "").split("/").pop() || "path";
  return `<local>/${last}`;
}

/** Replaces every absolute local path inside a string. `baseDir` (optional) makes paths inside it relative. */
export function scrubString(text, baseDir) {
  const fix = (match) => relativeInside(baseDir, match) ?? genericScrub(match);
  return String(text).replace(WIN_ABS, fix).replace(POSIX_HOME, fix).replace(MSYS_ABS, fix);
}

/** Deep copy of a JSON value with every string scrubbed. */
export function scrubValue(value, baseDir) {
  if (typeof value === "string") return scrubString(value, baseDir);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, baseDir));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v, baseDir)]));
  return value;
}

/** True when a string still contains an absolute local path. */
export function hasLocalPath(text) {
  return new RegExp(WIN_ABS.source).test(text) || new RegExp(POSIX_HOME.source).test(text) || new RegExp(MSYS_ABS.source).test(text) || LOCAL_NAMES.test(text);
}
