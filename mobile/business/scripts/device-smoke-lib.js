/*
  Pure helpers for scripts/device-smoke.js, kept free of adb, docker and the file system so they are unit-tested in jest
  (src/__tests__/deviceSmokeLib.test.ts). CommonJS on purpose: the script runs under plain node, jest loads it as-is.
*/

const DEFAULTS = {
  out: "./device-smoke-out",
  stackName: "smoke",
  webPort: 3107,
  avd: "df-api35",
  memory: 2048,
  dryRun: false,
  a11y: false,
  allowBusy: false,
  keepEmulator: false,
  apk: null,
  keysFrom: null,
  buildDir: null,
};

/** `--apk <file>` skips the Gradle build; otherwise `--build-dir <short-path worktree>` builds it (see DEVICE_QA.md). */
function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const takes = { "--out": "out", "--stack-name": "stackName", "--web-port": "webPort", "--avd": "avd", "--memory": "memory", "--apk": "apk", "--keys-from": "keysFrom", "--build-dir": "buildDir" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--allow-busy") opts.allowBusy = true;
    else if (arg === "--a11y") opts.a11y = true;
    else if (arg === "--keep-emulator") opts.keepEmulator = true;
    else if (takes[arg]) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      opts[takes[arg]] = arg === "--web-port" || arg === "--memory" ? Number(value) : value;
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
  steps.push(`emulator: boot ${opts.avd} if none is running, wait for the system UI to be quiet, record font scale and night mode, check the emulator reaches the stack and web app on 10.0.2.2`);
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

/**
 * Lines in a logcat dump that mean the emulator's own system UI is unstable (run 8: an ANR in com.android.systemui, then "crashed too many times").
 * The smoke waits until a quiet window has none of them before it drives the app.
 */
function systemUiTrouble(logcat) {
  return String(logcat ?? "")
    .split(/\r?\n/)
    .filter((line) => /ANR in com\.android\.systemui|Process com\.android\.systemui has crashed|Process: com\.android\.systemui, PID/.test(line));
}

/** True when the app's ApplicationExitInfo says the system killed it after an ANR (the run 8 signature), not a crash or a low-memory kill. */
function isAnrExit(exitInfo) {
  return /reason=6 \(ANR\)|Application does not have a focused window/.test(String(exitInfo ?? ""));
}

/** True when the foreground activity is a launcher (the system is idle at the home screen). */
function isLauncherTop(dumpsys) {
  const top = topActivity(dumpsys);
  return top !== null && /launcher/i.test(top);
}

/**
 * An APK carries the anon key of the stack that built it, signed with that stack's random JWT secret. A fresh stack has another secret, so a reused APK is refused at
 * sign-in with "email and password did not match" (run 11). `--keys-from <stack.json of the build run>` makes the new stack reuse the old secret.
 */
function secretFromStackJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("--keys-from: the file is not a stack.json");
  }
  const secret = data?.TW4A_LOCAL_JWT_SECRET;
  if (typeof secret !== "string" || !/^[0-9a-f]{32,}$/.test(secret)) throw new Error("--keys-from: no TW4A_LOCAL_JWT_SECRET in that stack.json");
  return secret;
}

/**
 * What to run inside the emulator to see whether the host's service answers (run 12: the phone could not reach 10.0.2.2:<port>, and the app then said the password was wrong).
 * A plain HTTP GET over toybox nc; the answer is judged by probeAnswered.
 */
function reachProbeCommand(port, urlPath = "/") {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("reachProbeCommand: bad port");
  if (!/^\/[\w./-]*$/.test(urlPath)) throw new Error("reachProbeCommand: bad path");
  return `printf 'GET ${urlPath} HTTP/1.0\\r\\nHost: 10.0.2.2\\r\\n\\r\\n' | nc -w 4 10.0.2.2 ${port}`;
}

/** True when the probe output starts like an HTTP response (any status: the service answered; 401/404 still means reachable). */
function probeAnswered(output) {
  return /^HTTP\/1\.[01] \d{3}/m.test(String(output ?? "").replace(/\r/g, ""));
}

/** True when `ip -4 addr show wlan0` shows an address (the emulator's Wi-Fi joined; it does so tens of seconds after sys.boot_completed). */
function hasWifiAddress(output) {
  return /^\s*inet \d+\.\d+\.\d+\.\d+\//m.test(String(output ?? ""));
}

module.exports = { hasWifiAddress, reachProbeCommand, probeAnswered, secretFromStackJson, systemUiTrouble, isAnrExit, isLauncherTop, topActivity, isAppForeground, parseArgs, buildPlan, busyReason, parseNodes, findNode, findTappable, hasLabel, centerOf, makeResult, summarize };
