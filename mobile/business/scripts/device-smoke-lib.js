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
  writes: false,
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
    else if (arg === "--writes") opts.writes = true;
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
  if (opts.writes) steps.push("WRITES mode: the build carries the four Phase 1A write words and the web app runs with STAFF_API_WRITE_POLICY enabling them; flows replace the default matrix: quick-add client and duplicate_client, add note and notes list, private-lesson attended and no-show, roster add and remove, writes_disabled (policy off), upgrade_required (minimum above the build), then a 2.0 font + dark pass; emits business-writes-isoqa-smoke.txt (the evidence the release build gate reads)");
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
 * A plain HTTP GET over toybox nc, with stdin held open 2 s (nc half-closes at stdin EOF and Kong then drops the proxied request: empty answer); the answer is judged by probeAnswered.
 */
function reachProbeCommand(port, urlPath = "/") {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("reachProbeCommand: bad port");
  if (!/^\/[\w./-]*$/.test(urlPath)) throw new Error("reachProbeCommand: bad path");
  return `(printf 'GET ${urlPath} HTTP/1.0\\r\\nHost: 10.0.2.2\\r\\n\\r\\n'; sleep 2) | nc -w 4 10.0.2.2 ${port}`;
}

/** True when the probe output starts like an HTTP response (any status: the service answered; 401/404 still means reachable). */
function probeAnswered(output) {
  return /^HTTP\/1\.[01] \d{3}/m.test(String(output ?? "").replace(/\r/g, ""));
}

/** True when `ip -4 addr show wlan0` shows an address (the emulator's Wi-Fi joined; it does so tens of seconds after sys.boot_completed). */
function hasWifiAddress(output) {
  return /^\s*inet \d+\.\d+\.\d+\.\d+\//m.test(String(output ?? ""));
}

/**
 * The string table of a Hermes bytecode file (version 96 layout: 128-byte header, 16-byte function headers, string kinds, identifier hashes, the small string
 * table, the overflow table, then the storage). Every EXPO_PUBLIC_* value is inlined into the JS bundle as one of these strings, so this is how a built APK is
 * asked what server and key it carries without a device. Throws when the file is not Hermes bytecode of a layout this reads.
 */
function hermesStrings(buf) {
  if (buf.length < 128 || buf.readUInt32LE(0) !== 0x03bc1fc6 || buf.readUInt32LE(4) !== 0x1f1903c1) throw new Error("not a Hermes bytecode file");
  const version = buf.readUInt32LE(8);
  if (version < 90 || version > 99) throw new Error(`unsupported Hermes bytecode version ${version}`);
  const word = (o) => buf.readUInt32LE(o);
  const functionCount = word(40);
  const stringKindCount = word(44);
  const identifierCount = word(48);
  const stringCount = word(52);
  const overflowCount = word(56);
  const align = (n) => (n + 3) & ~3;
  let pos = align(128 + functionCount * 16);
  pos = align(pos + stringKindCount * 4);
  pos = align(pos + identifierCount * 4);
  const small = pos;
  pos = align(pos + stringCount * 4);
  const overflow = pos;
  const storage = align(pos + overflowCount * 8);
  const out = [];
  for (let i = 0; i < stringCount; i++) {
    const entry = word(small + i * 4);
    const utf16 = entry & 1;
    let offset = (entry >>> 1) & 0x7fffff;
    let length = entry >>> 24;
    if (length === 255) {
      const at = overflow + offset * 8;
      offset = word(at);
      length = word(at + 4);
    }
    out.push(utf16 ? buf.subarray(storage + offset, storage + offset + length * 2).toString("utf16le") : buf.subarray(storage + offset, storage + offset + length).toString("latin1"));
  }
  return out;
}

/**
 * What a QA APK must carry for this run's stack and web app: the stack URL as the emulator sees it, the web URL, and this stack's anon key. Returns the problems
 * (empty = fine). A stale Metro cache once baked an older build's port and key (runs 7-17), so the smoke refuses an APK that disagrees with its stack.
 */
function anonKeyVerifies(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const sig = require("node:crypto").createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest("base64url");
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return sig === parts[2] && claims.role === "anon" && claims.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

function bakedConfigProblems(strings, { stackPort, webPort, anonKey, jwtSecret }) {
  const problems = [];
  const apiUrls = strings.filter((s) => /^http:\/\/10\.0\.2\.2:\d+$/.test(s) && s !== `http://10.0.2.2:${webPort}`);
  if (!strings.includes(`http://10.0.2.2:${stackPort}`)) problems.push(`the APK does not carry http://10.0.2.2:${stackPort} (it carries ${[...new Set(apiUrls)].join(", ") || "no 10.0.2.2 stack URL"})`);
  if (!strings.includes(`http://10.0.2.2:${webPort}`)) problems.push(`the APK does not carry the web URL http://10.0.2.2:${webPort}`);
  const keyOk = strings.includes(anonKey) || (jwtSecret && strings.some((t) => t.startsWith("eyJ") && anonKeyVerifies(t, jwtSecret)));
  if (!keyOk) problems.push("the APK does not carry this stack's anon key (it was built for another stack)");
  return problems;
}

/**
 * The last `keep` lines of a logcat dump without the lines our own harness causes: every uiautomator dump logs one AccessibilityNodeInfoDumper line per hidden node,
 * which filled the 3000-line window of smoke 17 (about 66 s of log) and left no room for the app's own errors.
 */
function dropLogNoise(text, keep = 3000) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => !/AccessibilityNodeInfoDumper|W PageIndicator: Total number of pages invalid/.test(line));
  return lines.slice(-keep).join("\n");
}


/** The four Phase 1A write words, the same keys as the server gate (src/lib/staff/writeGuard.ts) and the app flags (src/lib/features.ts). */
const WRITE_WORDS = ["appointmentAttendance", "clientNotes", "clientCreate", "classRoster"];

/**
 * Seed statements for the --writes flows, run once after the standard seed (disposable stack only). Pure strings so they can be validated against a real database
 * without the emulator (each `expect` is a count query and the number it must return).
 *  1. lessons are free/comped, so "attended" needs no payment and a package charge has nothing to take from (the charge_failed scenario);
 *  2. clients are ACTIVE: the staff client search lists active clients only (Staff_API_Contract), and seeded clients start as leads;
 *  3. two more open private lessons, clones of the 10:00 one at 14:00 (Colin) and 15:00 (Ana), for the outcome_conflict and charge_failed scenarios.
 */
const WRITES_SEED = [
  { sql: "update public.appointments set billing_type='free_comped' where appointment_type in ('private_lesson','intro_lesson')", expect: null },
  { sql: "update public.clients set status='active'", expect: null },
  ...[[4, "Colin"], [5, "Ana"]].map(([hours, client]) => ({
    // an explicit column list: duration_minutes (and others) are generated columns and cannot be copied (run 2 never had these lessons; found by validating the seed on a real stack)
    sql: `insert into public.appointments (id, studio_id, instructor_id, appointment_type, client_id, room_id, starts_at, ends_at, title, notes, status, price_amount, billing_type) select gen_random_uuid(), a.studio_id, a.instructor_id, a.appointment_type, (select id from public.clients where first_name='${client}' and studio_id=a.studio_id limit 1), a.room_id, a.starts_at + interval '${hours} hours', a.ends_at + interval '${hours} hours', a.title, a.notes, 'scheduled', a.price_amount, a.billing_type from public.appointments a where a.appointment_type='private_lesson' and a.status='scheduled' and a.starts_at = (select min(starts_at) from public.appointments where appointment_type='private_lesson' and status='scheduled' and studio_id=a.studio_id and instructor_id=a.instructor_id and starts_at::date = a.starts_at::date) and a.studio_id=(select id from public.studios where name='Maple Street Dance' limit 1) limit 1`,
    expect: null,
  })),
];
/** Counts that must hold after WRITES_SEED (name, query, expected). */
const WRITES_SEED_CHECKS = [
  ["four open private lessons in the Maple Street studio (the seed's two plus the two clones)", "select count(*) from public.appointments where appointment_type='private_lesson' and status in ('scheduled','confirmed') and studio_id=(select id from public.studios where name='Maple Street Dance' limit 1)", "4"],
  ["a 2:00 PM Colin lesson that is open", "select count(*) from public.appointments a join public.clients c on c.id=a.client_id where a.appointment_type='private_lesson' and a.status='scheduled' and c.first_name='Colin' and (a.starts_at at time zone 'America/New_York')::time = time '14:00'", "1"],
  ["a 3:00 PM Ana lesson that is open", "select count(*) from public.appointments a join public.clients c on c.id=a.client_id where a.appointment_type='private_lesson' and a.status='scheduled' and c.first_name='Ana' and (a.starts_at at time zone 'America/New_York')::time = time '15:00'", "1"],
  ["no lesson has a package linked (a package charge cannot succeed: charge_failed)", "select count(*) from public.appointments where appointment_type='private_lesson' and client_package_id is not null", "0"],
  ["every seeded client is active", "select count(*) from public.clients where status <> 'active'", "0"],
];

/** The exact check names (device-smoke.js --writes) that must all pass for a write word to be called proven. */
const WRITE_CAPABILITY_CHECKS = {
  clientCreate: ["writes: quick-add client creates and opens the client", "writes: the same phone again offers the existing client (duplicate_client)"],
  clientNotes: ["writes: add a note, it is saved and appears in the notes list"],
  appointmentAttendance: ["writes: private lesson marked attended (final, no undo)", "writes: private lesson marked no-show with no charge", "writes: a stale screen marking an already-recorded lesson shows Already recorded (outcome_conflict)", "writes: a no-show whose charge could not be applied says so and offers Try again"],
  classRoster: ["writes: add a dancer to the class roster", "writes: remove a dancer from the class roster"],
};

/**
 * The evidence file docs/mobile/tools/Test-StaffFeatures.ps1 reads before a build may carry a write word. `results` are the smoke's check results (name, ok); `capabilityChecks` maps each
 * word to the exact check names that prove it. A word gets its CAPABILITY line only when every one of its checks passed; RESULT is PASS only when the whole run passed.
 * `commit` is the commit the APP was built from; `web` the commit of the server code the smoke ran against. Never says production: the stack is always iso-qa.
 */
function writesEvidence({ date, commit, web, results, capabilityChecks, runOk }) {
  const byName = new Map(results.map((r) => [r.name, r.ok]));
  const lines = [
    "Business Phase 1A write smoke (iso-qa device smoke, disposable stack; never production)",
    `Date: ${date}`,
    `kind=iso-qa-device-smoke  stack=iso-qa  commit=${commit}  web=${web}`,
  ];
  for (const word of WRITE_WORDS) {
    const names = capabilityChecks[word] ?? [];
    if (names.length > 0 && names.every((n) => byName.get(n) === true)) lines.push(`CAPABILITY ${word} PASS`);
    else lines.push(`CAPABILITY ${word} NOT-PROVEN`);
  }
  const allWords = WRITE_WORDS.every((w) => (capabilityChecks[w] ?? []).length > 0 && capabilityChecks[w].every((n) => byName.get(n) === true));
  lines.push(`RESULT: ${runOk && allWords ? "PASS" : "FAIL"}`);
  return lines.join(String.fromCharCode(10)) + String.fromCharCode(10);
}

module.exports = { WRITES_SEED, WRITES_SEED_CHECKS, WRITE_WORDS, WRITE_CAPABILITY_CHECKS, writesEvidence, dropLogNoise, hermesStrings, bakedConfigProblems, hasWifiAddress, reachProbeCommand, probeAnswered, secretFromStackJson, systemUiTrouble, isAnrExit, isLauncherTop, topActivity, isAppForeground, parseArgs, buildPlan, busyReason, parseNodes, findNode, findTappable, hasLabel, centerOf, makeResult, summarize };
