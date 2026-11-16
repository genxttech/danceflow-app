/*
  Pure helpers for scripts/device-smoke.js, kept free of adb, docker and the file system so they are unit-tested in jest
  (src/__tests__/deviceSmokeLib.test.ts). CommonJS on purpose: the script runs under plain node, jest loads it as-is.
*/

const DEFAULTS = {
  out: "./device-smoke-out",
  stackName: "smoke",
  webPort: 3107,
  avd: "df-api35",
  dryRun: false,
  a11y: false,
  allowBusy: false,
  keepEmulator: false,
  apk: null,
  buildDir: null,
};

/** `--apk <file>` skips the Gradle build; otherwise `--build-dir <short-path worktree>` builds it (see DEVICE_QA.md). */
function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const takes = { "--out": "out", "--stack-name": "stackName", "--web-port": "webPort", "--avd": "avd", "--apk": "apk", "--build-dir": "buildDir" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--allow-busy") opts.allowBusy = true;
    else if (arg === "--a11y") opts.a11y = true;
    else if (arg === "--keep-emulator") opts.keepEmulator = true;
    else if (takes[arg]) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      opts[takes[arg]] = arg === "--web-port" ? Number(value) : value;
    } else throw new Error(`unknown option ${arg}`);
  }
  if (!Number.isInteger(opts.webPort) || opts.webPort < 1024 || opts.webPort > 65535) throw new Error("--web-port must be 1024-65535");
  if (!/^[a-z0-9-]{1,24}$/.test(opts.stackName)) throw new Error("--stack-name must be lowercase letters, digits and dashes");
  if (!opts.apk && !opts.buildDir && !opts.dryRun) throw new Error("give --apk <file> (reuse a build) or --build-dir <worktree> (build one)");
  return opts;
}

/** The ordered plan, printed by --dry-run and followed by the script. Teardown is always last and always runs. */
function buildPlan(opts) {
  const steps = ["preflight (emulator and Gradle/Java not in use by another session)", `stack: iso-qa --auth "${opts.stackName}", roster migration, seed, QA passwords`, `web: production next build, next start on ${opts.webPort}`];
  steps.push(opts.apk ? `apk: reuse ${opts.apk}` : `apk: expo prebuild + Gradle assembleRelease in ${opts.buildDir} (both new flags on, cleartext QA only)`);
  steps.push(`emulator: boot ${opts.avd} if none is running, record font scale and night mode`);
  steps.push("flows: owner light 1.0, dark 1.0, dark 2.0, light 2.0, live font change, empty day, 403 and recovery, 401 and re-sign-in, instructor");
  if (opts.a11y) steps.push("a11y: also save the accessibility tree (.xml) of every check, plus sign-in, class roster, client and More; then run node scripts/a11y-audit.js <out>");
  steps.push("summary: out/summary.json, screenshots, exit code 0 only if every check passed");
  steps.push("teardown (always): restore font scale and night mode, uninstall the app, stop web, remove the stack, stop the emulator only if this run started it");
  return steps;
}

/** Why a shared machine is not free, or null. `emulators`: adb serials; `processes`: running image names. */
function busyReason({ emulators, processes }) {
  const reasons = [];
  if (emulators.length) reasons.push(`an emulator is already running (${emulators.join(", ")})`);
  const busy = processes.filter((name) => /^(java|gradle|gradlew|kotlin-compiler-embeddable)(\.exe)?$/i.test(name));
  if (busy.length) reasons.push(`Java/Gradle processes are running (${[...new Set(busy)].join(", ")})`);
  return reasons.length ? reasons.join("; ") : null;
}

const unescapeXml = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Nodes of a `uiautomator dump`: text, content-desc, class, bounds, clickable. Tolerates the trailing "UI hierchary dumped" line. */
function parseNodes(xml) {
  const nodes = [];
  for (const match of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
    const attrs = {};
    for (const a of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = unescapeXml(a[2]);
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds ?? "");
    if (!b) continue;
    nodes.push({
      text: attrs.text ?? "",
      desc: attrs["content-desc"] ?? "",
      cls: attrs.class ?? "",
      clickable: attrs.clickable === "true",
      bounds: { left: +b[1], top: +b[2], right: +b[3], bottom: +b[4] },
    });
  }
  return nodes;
}

const matches = (value, label) => (label instanceof RegExp ? label.test(value) : value === label || value.includes(label));

/** The first node whose text or content-desc matches; `cls` limits it to a class (an EditText with the same label as its caption). */
function findNode(nodes, label, { cls } = {}) {
  return nodes.find((n) => (!cls || n.cls.includes(cls)) && (matches(n.text, label) || matches(n.desc, label))) ?? null;
}

/** What a tap should hit: a clickable node with that label (the button), else any node with it. A heading and its button can share the same words ("Sign in again"). */
function findTappable(nodes, label) {
  return nodes.find((n) => n.clickable && (matches(n.text, label) || matches(n.desc, label))) ?? findNode(nodes, label);
}

function hasLabel(nodes, label) {
  return findNode(nodes, label) !== null;
}

function centerOf(node) {
  return { x: Math.round((node.bounds.left + node.bounds.right) / 2), y: Math.round((node.bounds.top + node.bounds.bottom) / 2) };
}

/** Pass/fail record with a stable shape for summary.json. */
function makeResult(name, ok, detail = "") {
  return { name, result: ok ? "PASS" : "FAIL", ...(detail ? { detail } : {}) };
}

function summarize(results) {
  const failed = results.filter((r) => r.result !== "PASS");
  return { total: results.length, passed: results.length - failed.length, failed: failed.map((r) => r.name), ok: results.length > 0 && failed.length === 0 };
}

/**
 * The activity that has the screen, from `dumpsys activity activities` ("topResumedActivity=ActivityRecord{31966dd u0 com.idanceflow.business/.MainActivity t64}"),
 * as "package/Activity", or null when the output has no such line. Used to notice that the app lost the foreground (a launcher, a system dialog, or a crash).
 */
function topActivity(dumpsys) {
  const m = /topResumedActivity=ActivityRecord\{[^ ]+ u\d+ ([\w.]+\/[\w.$]+)/.exec(dumpsys ?? "");
  return m ? m[1] : null;
}

function isAppForeground(dumpsys, pkg) {
  const top = topActivity(dumpsys);
  return top !== null && top.startsWith(`${pkg}/`);
}

module.exports = { topActivity, isAppForeground, parseArgs, buildPlan, busyReason, parseNodes, findNode, findTappable, hasLabel, centerOf, makeResult, summarize };
