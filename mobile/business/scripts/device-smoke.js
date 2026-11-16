#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- a plain node script (CommonJS) */
/*
  One-command device smoke for the DanceFlow Business app: disposable stack, production web build, a QA-only release APK
  (Pulse and studio schedule flags ON in that build only), an emulator run through light/dark, font 1.0/2.0, a live font
  change, the empty day, 403 (with recovery), 401 and the instructor view, then teardown. Every check asserts on the
  screen's text (uiautomator) and keeps a screenshot; nothing is judged by eye alone.

    node scripts/device-smoke.js --apk C:/path/business-qa-flags.apk        # reuse a build
    node scripts/device-smoke.js --build-dir C:/dfq                          # build it (Gradle; short-path worktree of this repo)
    node scripts/device-smoke.js --dry-run                                   # print the plan, touch nothing

  Local and disposable only: it refuses to run while an emulator or Java/Gradle is in use by someone else (--allow-busy
  overrides, for when you know it is yours). Never touches a hosted database or the shipping flag defaults.
  See DEVICE_QA.md ("One-command smoke").
*/
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const lib = require("./device-smoke-lib");

const APP = "com.idanceflow.business";
const REPO = path.resolve(__dirname, "../../..");
const WIN = process.platform === "win32";
// With shell:true (needed for .bat on Windows) arguments are concatenated, so a value with a space has to carry its own quotes.
const GRADLE_JVMARGS = WIN ? '"-Dorg.gradle.jvmargs=-Xmx3g -XX:MaxMetaspaceSize=768m"' : "-Dorg.gradle.jvmargs=-Xmx3g -XX:MaxMetaspaceSize=768m";
// QA only, set on the two seeded users through GoTrue's admin API of the disposable stack. Lowercase and digits only on purpose: with adb "input text" a
// capital is a shift key plus a letter, and under load the shift can be lost, which types a different password of the same length (a bullet field cannot
// show it, so the length check passes while the server refuses the login: android-release's RC2 run ended exactly like that).
const PASSWORD = "walk2026qa";

const opts = (() => {
  try {
    return lib.parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`device-smoke: ${error.message}`);
    process.exit(2);
  }
})();

if (opts.dryRun) {
  console.log("device-smoke plan:");
  lib.buildPlan(opts).forEach((step, i) => console.log(`  ${i + 1}. ${step}`));
  process.exit(0);
}

const OUT = path.resolve(opts.out);
fs.mkdirSync(OUT, { recursive: true });
const ANDROID_HOME = process.env.ANDROID_HOME || (WIN ? "C:\\Android\\sdk" : "");
const JAVA_HOME = process.env.JAVA_HOME || (WIN ? "C:\\Android\\jdk-17" : "");
const ADB = path.join(ANDROID_HOME, "platform-tools", WIN ? "adb.exe" : "adb");
const EMULATOR = path.join(ANDROID_HOME, "emulator", WIN ? "emulator.exe" : "emulator");

const state = { stack: null, seed: null, webProc: null, startedEmulator: false, installed: false, original: { font: "1.0", night: "no" }, results: [] };
const log = (m) => console.log(`[smoke] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, o = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: WIN && /\.(cmd|bat)$|^npx$|^npm$/.test(cmd), ...o });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
const adb = (...args) => run(ADB, args);
const sh = (cmd) => adb("shell", cmd).stdout.replace(/\r/g, "").trim();
const psql = (sql) => run("docker", ["exec", "-i", `df-isoqa-${opts.stackName}-db`, "psql", "-U", "postgres", "-At", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql]);

// ---------------------------------------------------------------- device helpers
function dump() {
  let nodes = lib.parseNodes(adb("exec-out", "uiautomator", "dump", "/dev/tty").stdout);
  // A cold swiftshader emulator raises "System UI isn't responding" style dialogs that cover the app: tap Wait and look again.
  for (let i = 0; i < 3 && lib.hasLabel(nodes, /isn't responding|isn.t responding/i); i++) {
    const wait = lib.findNode(nodes, /^Wait$/);
    if (!wait) break;
    tapNode(wait);
    nodes = lib.parseNodes(adb("exec-out", "uiautomator", "dump", "/dev/tty").stdout);
  }
  return nodes;
}
/** `scroll`: the dump only lists what is on screen, so at a large text size a card below the fold is found by swiping up a few times (and back to the top afterwards). */
async function waitFor(label, { timeout = 30000, cls, scroll = false, tappable = false } = {}) {
  let end = Date.now() + timeout;
  while (Date.now() < end) {
    // a relaunch (cold start, system UI wait) must not eat the time this wait was given
    if (state.installed && (await ensureForeground(`waiting for ${String(label)}`))) end = Date.now() + timeout;
    const nodes = dump();
    const node = tappable ? lib.findTappable(nodes, label) : lib.findNode(nodes, label, { cls });
    if (node) return node;
    if (scroll) {
      for (let i = 0; i < 4; i++) {
        adb("shell", "input", "swipe", "540", "1800", "540", "700", "300");
        await sleep(800);
        const below = lib.findNode(dump(), label, { cls });
        if (below) return below;
      }
      for (let i = 0; i < 4; i++) adb("shell", "input", "swipe", "540", "700", "540", "1800", "300");
    }
    await sleep(1500);
  }
  return null;
}
function tapNode(node) {
  const { x, y } = lib.centerOf(node);
  adb("shell", "input", "tap", String(x), String(y));
}
async function tapLabel(label, o = {}) {
  const node = await waitFor(label, { ...o, tappable: true });
  if (!node) throw new Error(`not on screen: ${String(label)}`);
  tapNode(node);
  await sleep(1200);
}
function shot(name) {
  // binary output: spawnSync without an encoding, never through run() (which decodes as text)
  const r = spawnSync(ADB, ["exec-out", "screencap", "-p"], { maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(path.join(OUT, name + ".png"), r.stdout ?? Buffer.alloc(0));
}
const swipeRefresh = () => adb("shell", "input", "swipe", "540", "700", "540", "1500", "400");
function hideKeyboard() {
  if (/mInputShown=true/.test(adb("shell", "dumpsys", "input_method").stdout)) adb("shell", "input", "keyevent", "4");
}
/** Saves the crash buffer and the recent main log: after a failure this is what tells a crash, a low-memory kill and a launcher restart apart. */
function saveLogs(tag) {
  try {
    fs.writeFileSync(path.join(OUT, `logcat-${tag}-crash.txt`), adb("logcat", "-b", "crash", "-d").stdout);
    fs.writeFileSync(path.join(OUT, `logcat-${tag}-main.txt`), adb("logcat", "-d", "-t", "600").stdout);
    // Android 11+ ApplicationExitInfo: says whether the process was killed for memory, crashed, or was stopped by the user
    fs.writeFileSync(path.join(OUT, `exit-info-${tag}.txt`), adb("shell", "dumpsys", "activity", "exit-info", APP).stdout + "\n--- lmkd/oom lines ---\n" + adb("logcat", "-d", "-t", "2000", "-s", "lowmemorykiller:*", "lmkd:*", "ActivityManager:I").stdout);
  } catch {
    /* best effort */
  }
}

/**
 * If the app is not the top activity (it crashed, was killed, or something else took the screen), keep the evidence and bring it back once. A second loss
 * fails the run with the logs saved: a flaky emulator is tolerated once, a repeating one is not.
 */
async function ensureForeground(where) {
  const isTop = () => lib.isAppForeground(adb("shell", "dumpsys", "activity", "activities").stdout, APP);
  if (isTop()) return false;
  // A cold start takes several seconds on a loaded emulator (run 9: the check ran 5 s after the launch and called a starting app lost): give it a grace period.
  for (let i = 0; i < GRACE_POLLS; i++) {
    await sleep(2000);
    if (isTop()) return false;
  }
  state.lostForeground = (state.lostForeground ?? 0) + 1;
  saveLogs(`lost-foreground-${state.lostForeground}`);
  log(`the app left the foreground (${where}); logs saved`);
  if (state.lostForeground > 1) throw new Error(`the app left the foreground twice (${where}); see logcat-lost-foreground-*.txt`);
  // A cold relaunch: force-stop, wait for the system UI to be quiet, start again. The first loss in run 8 was an ANR kill after a system UI crash loop.
  const exitInfo = adb("shell", "dumpsys", "activity", "exit-info", APP).stdout;
  log(lib.isAnrExit(exitInfo) ? "the system killed the app after an ANR: cold relaunch after the system UI settles" : "cold relaunch after the system UI settles");
  adb("shell", "am", "force-stop", APP);
  await waitSystemUiStable(180000);
  launch();
  await sleep(8000);
  return true; // relaunched: the caller's own deadline restarts
}
const GRACE_POLLS = 10; // 20 s

function launch(coldStart = true) {
  if (coldStart) adb("shell", "am", "force-stop", APP);
  adb("shell", "am", "start", "-n", `${APP}/.MainActivity`);
}
const setFont = (v) => adb("shell", "settings", "put", "system", "font_scale", v);
const setNight = (on) => adb("shell", "cmd", "uimode", "night", on ? "yes" : "no");

const slug = (name) => name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();

/** The accessibility tree of the screen as it is now, for scripts/a11y-audit.js (TalkBack reads this same tree). */
function saveTree(name) {
  fs.writeFileSync(path.join(OUT, `${name}.xml`), adb("exec-out", "uiautomator", "dump", "/dev/tty").stdout);
}

/** One named check: runs fn, records PASS/FAIL, keeps a screenshot (named after the check) either way. */
async function check(name, fn) {
  let ok = true;
  let detail = "";
  try {
    await fn();
  } catch (error) {
    ok = false;
    detail = String(error.message ?? error);
  }
  try {
    shot(slug(name));
    if (opts.a11y) saveTree(slug(name));
  } catch {
    /* a screenshot failure never hides the result */
  }
  state.results.push(lib.makeResult(name, ok, detail));
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}
const expectLabel = async (label, o) => {
  if (!(await waitFor(label, o))) throw new Error(`expected on screen: ${String(label)}`);
};

/**
 * Types into an EditText and checks what is really in it (adb "input text" drops characters on a busy emulator: run 4 ended with "owe" for a 23-character email).
 * Short chunks, then read the field back through uiautomator and start over until it matches. A password field shows one bullet per character, so its length is compared.
 */
async function typeInto(label, text, { secret = false } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await ensureForeground(`before typing the ${label}`);
    const field = lib.findNode(dump(), label, { cls: "EditText" });
    if (!field) throw new Error(`no ${label} field`);
    tapNode(field);
    await sleep(500);
    adb("shell", "input", "keyevent", "KEYCODE_MOVE_END");
    const del = Array(40).fill("67");
    adb("shell", "input", "keyevent", ...del);
    adb("shell", "input", "keyevent", ...del);
    for (const chunk of text.match(/.{1,6}/g)) {
      adb("shell", "input", "text", chunk);
      await sleep(250);
    }
    await sleep(500);
    const got = lib.findNode(dump(), label, { cls: "EditText" })?.text ?? "";
    if (secret ? got.length === text.length : got === text) return;
  }
  throw new Error(`could not type the ${label} (the field never matched what was sent)`);
}

async function signIn(email) {
  await expectLabel("Sign in to your studio", { timeout: 60000 });
  // A typed password cannot be read back (the field shows bullets), so the proof is the server's answer: if the login is refused, type both fields again, up to three times.
  for (let attempt = 1; attempt <= 3; attempt++) {
    await typeInto("Email", email);
    await typeInto("Password", PASSWORD, { secret: true });
    hideKeyboard();
    await sleep(800);
    const button = lib.findTappable(dump(), /^Sign in$/);
    if (!button) throw new Error("no Sign in button");
    tapNode(button);
    await sleep(2500); // the previous attempt's message is cleared when the button is pressed; do not read it before that render
    const end = Date.now() + 90000;
    while (Date.now() < end) {
      const nodes = dump();
      if (lib.hasLabel(nodes, /^Today$/)) return;
      if (lib.hasLabel(nodes, "did not match")) {
        log(`sign-in refused on attempt ${attempt}; retyping`);
        break;
      }
      await sleep(1500);
    }
  }
  throw new Error("the sign-in was refused three times with the credentials typed each time (a refusal, not a slow screen)");
}

// ---------------------------------------------------------------- steps
function preflight() {
  const devices = adb("devices").stdout.split("\n").slice(1).map((l) => l.split("\t")[0].trim()).filter((s) => s.startsWith("emulator-"));
  const list = WIN ? run("tasklist", ["/FO", "CSV", "/NH"]).stdout : run("ps", ["-A", "-o", "comm="]).stdout;
  const processes = list.split("\n").map((l) => (WIN ? (l.split('","')[0] || "").replace(/"/g, "") : path.basename(l.trim()))).filter(Boolean);
  const reason = lib.busyReason({ emulators: devices, processes });
  if (reason && !opts.allowBusy) throw new Error(`the machine is in use: ${reason}. Wait for the other session, or pass --allow-busy if it is yours.`);
  if (!fs.existsSync(ADB)) throw new Error(`adb not found at ${ADB}: set ANDROID_HOME (docs/mobile/Local_Android_QA.md)`);
  if (run("docker", ["info", "--format", "{{.ServerVersion}}"]).status !== 0) throw new Error("docker is not running");
}

async function bringUpStack() {
  const up = run("node", ["scripts/qa/iso-qa.mjs", "up", "baseline", "--name", opts.stackName, "--auth"], { cwd: REPO });
  if (up.status !== 0) throw new Error(`iso-qa up failed: ${up.stderr.slice(-400)}`);
  state.stack = JSON.parse(up.stdout.slice(up.stdout.indexOf("{")));
  fs.writeFileSync(path.join(OUT, "stack.json"), JSON.stringify(state.stack));
  const migration = path.join(REPO, "src/lib/supabase/migrations/20270214120000_instructor_class_roster_names_rpc.sql");
  const applied = run("docker", ["exec", "-i", `df-isoqa-${opts.stackName}-db`, "psql", "-U", "postgres", "-At", "-q", "-v", "ON_ERROR_STOP=1"], { input: fs.readFileSync(migration, "utf8") });
  if (applied.status !== 0) throw new Error("roster migration failed on the local stack");
  psql("notify pgrst, 'reload schema'");
  const seed = run("node", ["scripts/qa/auth-profile/business-shell/seed-staff.mjs", path.join(OUT, "stack.json"), path.join(OUT, "seed.json")], { cwd: REPO });
  if (seed.status !== 0) throw new Error(`seed failed: ${seed.stderr.slice(-400)}`);
  state.seed = JSON.parse(fs.readFileSync(path.join(OUT, "seed.json"), "utf8"));
  for (const id of [state.seed.users.owen, state.seed.users.ida]) {
    const res = await fetch(`${state.stack.ISO_QA_AUTH_URL}/admin/users/${id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${state.stack.ISO_QA_SERVICE_ROLE_KEY}`, apikey: state.stack.ISO_QA_SERVICE_ROLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    if (!res.ok) throw new Error(`could not set the QA password (${res.status})`);
  }
}

async function startWeb() {
  const env = { ...process.env, NEXT_PUBLIC_SUPABASE_URL: state.stack.TW4A_LOCAL_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: state.stack.ISO_QA_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: state.stack.ISO_QA_SERVICE_ROLE_KEY, NODE_OPTIONS: "--max-old-space-size=8192" };
  log("next build (production; several minutes)");
  const build = run("npx", ["next", "build"], { cwd: REPO, env });
  if (build.status !== 0) throw new Error(`next build failed (exit ${build.status}): ${(build.stderr || build.stdout).slice(-400)}`);
  state.webProc = spawn(WIN ? "npx.cmd" : "npx", ["next", "start", "-p", String(opts.webPort)], { cwd: REPO, env, stdio: "ignore", shell: WIN });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${opts.webPort}/api/staff/me`);
      if (r.status === 401) return;
    } catch {
      /* not up yet */
    }
    await sleep(2000);
  }
  throw new Error("the web app did not come up");
}

function buildApk() {
  if (opts.apk) return path.resolve(opts.apk);
  const dir = path.join(path.resolve(opts.buildDir), "mobile/business");
  const port = new URL(state.stack.TW4A_LOCAL_URL).port;
  const env = {
    ...process.env,
    JAVA_HOME,
    ANDROID_HOME,
    CI: "1",
    EXPO_PUBLIC_SUPABASE_URL: `http://10.0.2.2:${port}`,
    EXPO_PUBLIC_SUPABASE_ANON_KEY: state.stack.ISO_QA_ANON_KEY,
    EXPO_PUBLIC_DANCEFLOW_WEB_URL: `http://10.0.2.2:${opts.webPort}`,
    EXPO_PUBLIC_STAFF_FEATURES: "pulse,studioSchedule",
    DANCEFLOW_UPLOAD_STORE_FILE: process.env.DANCEFLOW_UPLOAD_STORE_FILE || "C:/dfr-qa/qa-only-DO-NOT-UPLOAD.keystore",
    DANCEFLOW_UPLOAD_STORE_PASSWORD: process.env.DANCEFLOW_UPLOAD_STORE_PASSWORD || "qa-only-throwaway",
    DANCEFLOW_UPLOAD_KEY_ALIAS: process.env.DANCEFLOW_UPLOAD_KEY_ALIAS || "qa-only",
    DANCEFLOW_UPLOAD_KEY_PASSWORD: process.env.DANCEFLOW_UPLOAD_KEY_PASSWORD || "qa-only-throwaway",
  };
  if (!fs.existsSync(path.join(dir, "node_modules"))) {
    log("npm ci in the build worktree");
    if (run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir, env }).status !== 0) throw new Error("npm ci failed in the build dir");
  }
  log("expo prebuild + Gradle assembleRelease (one Gradle build at a time; ~15 min)");
  if (run("npx", ["expo", "prebuild", "--platform", "android", "--no-install", "--clean"], { cwd: dir, env }).status !== 0) throw new Error("expo prebuild failed");
  const manifest = path.join(dir, "android/app/src/main/AndroidManifest.xml");
  const xml = fs.readFileSync(manifest, "utf8");
  if (!xml.includes("usesCleartextTraffic")) fs.writeFileSync(manifest, xml.replace("<application ", '<application android:usesCleartextTraffic="true" '));
  const androidDir = path.join(dir, "android");
  // an absolute path: a bare "gradlew.bat" is looked up on PATH, not in the working directory, and fails with no output
  const gradle = run(path.join(androidDir, WIN ? "gradlew.bat" : "gradlew"), ["assembleRelease", "--no-daemon", "-PreactNativeArchitectures=x86_64", GRADLE_JVMARGS], { cwd: androidDir, env });
  if (gradle.status !== 0) throw new Error(`Gradle failed (exit ${gradle.status}): ${(gradle.stderr || gradle.stdout).slice(-400)}`);
  fs.writeFileSync(path.join(OUT, "gradle.log"), gradle.stdout + gradle.stderr);
  const apk = path.join(dir, "android/app/build/outputs/apk/release/app-release.apk");
  fs.copyFileSync(apk, path.join(OUT, "business-qa-flags.apk"));
  return path.join(OUT, "business-qa-flags.apk");
}

/** sys.boot_completed turns 1 well before the system is usable: wait until the activity manager and package manager answer, then let the first-boot churn pass. */
async function waitSettled() {
  for (let i = 0; i < 60; i++) {
    if (/found/.test(sh("service check activity")) && /package:/.test(sh("pm path android"))) break;
    await sleep(5000);
  }
  await sleep(20000);
}

/**
 * Waits for a quiet window: the launcher is the top activity and the log holds no system UI crash or ANR for QUIET_MS. A cold -no-snapshot boot can crash-loop the
 * system UI for a while after boot_completed (run 8); driving the app into that is what killed it. Throws if it never calms down within `limitMs`.
 */
const QUIET_MS = 30000;
async function waitSystemUiStable(limitMs) {
  const end = Date.now() + limitMs;
  while (Date.now() < end) {
    adb("logcat", "-c");
    await sleep(QUIET_MS);
    const trouble = lib.systemUiTrouble(adb("logcat", "-d").stdout);
    const home = lib.isLauncherTop(adb("shell", "dumpsys", "activity", "activities").stdout);
    if (trouble.length === 0 && home) return;
    log(trouble.length ? `system UI still unstable (${trouble.length} crash/ANR lines); waiting` : "launcher not resumed yet; waiting");
    if (!home) adb("shell", "input", "keyevent", "3"); // HOME
  }
  throw new Error(`the system UI did not settle within ${Math.round(limitMs / 1000)} s`);
}

async function bootEmulator() {
  const running = adb("devices").stdout.includes("emulator-");
  if (!running) {
    log(`booting ${opts.avd}`);
    spawn(EMULATOR, ["-avd", opts.avd, "-no-snapshot", "-no-boot-anim", "-gpu", "swiftshader_indirect", "-memory", String(opts.memory), "-no-audio"], { detached: true, stdio: "ignore" }).unref();
    state.startedEmulator = true;
    for (let i = 0; i < 80; i++) {
      if (sh("getprop sys.boot_completed") === "1") break;
      await sleep(10000);
    }
    if (sh("getprop sys.boot_completed") !== "1") throw new Error("the emulator did not finish booting");
  }
  await waitSettled();
  await waitSystemUiStable(300000);
  state.original.font = sh("settings get system font_scale") || "1.0";
  state.original.night = /yes/.test(sh("cmd uimode night")) ? "yes" : "no";
}

// ---------------------------------------------------------------- the matrix
async function flows(apk) {
  if (adb("install", "-r", apk).status !== 0) throw new Error("adb install failed");
  state.installed = true;
  const owner = "owen.owner@example.test";
  const ownerScreens = async (tag) => {
    await check(`${tag}: Today has the My day / Studio switch and a Pulse tab`, async () => {
      await tapLabel(/^Today$/);
      await expectLabel("Studio", { timeout: 30000 });
      await expectLabel(/^My day$/);
      await expectLabel(/^Pulse$/);
    });
    await check(`${tag}: Studio view lists the studio's day with who teaches`, async () => {
      await tapLabel(/^Studio$/);
      await expectLabel("Studio today", { timeout: 30000 });
      await expectLabel(/with Ida Instructor/);
    });
    await check(`${tag}: Pulse shows the studio numbers and new clients`, async () => {
      await tapLabel(/^Pulse$/);
      await expectLabel(/Studio today ·/, { timeout: 30000 });
      await expectLabel("still to come");
      await expectLabel("new in the last 7 days", { scroll: true });
    });
  };

  setFont("1.0");
  setNight(false);
  if (opts.a11y) {
    fs.writeFileSync(path.join(OUT, "density.txt"), (/(d+)s*$/.exec(sh("wm density")) ?? [, "420"])[1]);
    fs.writeFileSync(path.join(OUT, "height.txt"), (/x(d+)/.exec(sh("wm size")) ?? [, "0"])[1]);
  }
  launch();
  if (opts.a11y) {
    await check("a11y sign-in (signed out)", async () => {
      await expectLabel("Sign in to your studio", { timeout: 90000 });
    });
  }
  await signIn(owner);
  await ownerScreens("owner light 1.0");

  setNight(true);
  launch();
  await expectLabel(/^Pulse$/, { timeout: 60000 });
  await ownerScreens("owner dark 1.0");

  setFont("2.0");
  launch();
  await expectLabel(/^Pulse$/, { timeout: 60000 });
  await ownerScreens("owner dark 2.0 cold");

  setNight(false);
  launch();
  await expectLabel(/^Pulse$/, { timeout: 60000 });
  await ownerScreens("owner light 2.0 cold");

  await check("live font change (2.0 to 1.0 while running): screen intact, nothing recreated", async () => {
    setFont("1.0");
    await sleep(6000);
    await expectLabel(/^Pulse$/);
    await expectLabel("new in the last 7 days", { scroll: true });
  });

  setFont("1.0");
  launch();
  await expectLabel(/^Pulse$/, { timeout: 60000 });
  await check("empty day: Studio, next day, explained in words", async () => {
    await tapLabel(/^Today$/);
    await tapLabel(/^Studio$/);
    await tapLabel("Next day");
    await expectLabel("Nothing on the studio schedule", { timeout: 30000 });
  });

  await check("403: role demoted mid-session, pull to refresh shows 'Not available for your role'", async () => {
    await tapLabel(/^Pulse$/);
    psql(`update public.user_studio_roles set role='independent_instructor' where user_id='${state.seed.users.owen}'`);
    swipeRefresh();
    await expectLabel("Not available for your role", { timeout: 30000 });
  });
  await check("403 recovery: role restored, Refresh studios brings the numbers back without a pull", async () => {
    psql(`update public.user_studio_roles set role='studio_owner' where user_id='${state.seed.users.owen}'`);
    await tapLabel("Refresh studios");
    await expectLabel("new in the last 7 days", { timeout: 30000, scroll: true });
  });

  await check("401: session ended, pull to refresh shows 'Sign in again' and the button returns to sign-in", async () => {
    psql(`delete from auth.sessions where user_id='${state.seed.users.owen}'`);
    swipeRefresh();
    await tapLabel(/^Sign in again$/, { timeout: 30000 });
    await expectLabel("Sign in to your studio", { timeout: 30000 });
  });

  await check("instructor: Today has no switch, Pulse is 'Your day' with no client card", async () => {
    await signIn("ida.instructor@example.test");
    if (lib.hasLabel(dump(), /^Studio$/)) throw new Error("an instructor must not see the Studio switch");
    await tapLabel(/^Pulse$/);
    await expectLabel(/Your day ·/, { timeout: 30000 });
    if (lib.hasLabel(dump(), "new in the last 7 days")) throw new Error("an instructor must not see the client count");
  });

  if (opts.a11y) {
    // screens the matrix above does not open, walked as the instructor (the class and the clients are theirs); each check keeps its tree for the audit
    await check("a11y class roster", async () => {
      await tapLabel(/^Today$/);
      await tapLabel(/Beginner Salsa/, { timeout: 30000 });
      await expectLabel("Roster and attendance", { timeout: 30000 });
    });
    adb("shell", "input", "keyevent", "4");
    await sleep(1500);
    await check("a11y clients", async () => {
      await tapLabel(/^Clients$/);
      await expectLabel(/^My clients$/, { timeout: 30000 });
    });
    await check("a11y client detail", async () => {
      await tapLabel(/^Ana/, { timeout: 30000 });
      await expectLabel("Next booking", { timeout: 30000 });
    });
    adb("shell", "input", "keyevent", "4");
    await sleep(1500);
    await check("a11y more", async () => {
      await tapLabel(/^More$/);
      await expectLabel(/^Sign out$/, { timeout: 30000 });
    });
  }
}

// ---------------------------------------------------------------- teardown (always)
async function teardown() {
  log("teardown");
  const quiet = (fn) => {
    try {
      fn();
    } catch {
      /* keep tearing down */
    }
  };
  quiet(() => {
    setFont(state.original.font);
    setNight(state.original.night === "yes");
  });
  if (state.installed) quiet(() => adb("uninstall", APP));
  if (state.startedEmulator && !opts.keepEmulator) quiet(() => adb("emu", "kill"));
  if (state.webProc) quiet(() => (WIN ? run("taskkill", ["/PID", String(state.webProc.pid), "/T", "/F"]) : state.webProc.kill()));
  if (state.stack) quiet(() => run("node", ["scripts/qa/iso-qa.mjs", "down", "--name", opts.stackName, "--force"], { cwd: REPO }));
}

(async () => {
  let fatal = null;
  try {
    log("preflight");
    preflight();
    log("stack");
    await bringUpStack();
    await startWeb();
    const apk = buildApk();
    await bootEmulator();
    await flows(apk);
  } catch (error) {
    fatal = error;
    state.results.push(lib.makeResult("run", false, String(error.message ?? error)));
    if (state.installed) {
      saveLogs("fatal");
      try {
        shot("fatal");
        fs.writeFileSync(path.join(OUT, "fatal.xml"), adb("exec-out", "uiautomator", "dump", "/dev/tty").stdout);
      } catch {
        /* best effort */
      }
    }
  } finally {
    await teardown();
  }
  const summary = lib.summarize(state.results);
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ ...summary, results: state.results }, null, 2));
  console.log(`\n${summary.passed}/${summary.total} passed${summary.ok ? "" : `; FAILED: ${summary.failed.join(" | ")}`}`);
  console.log(`evidence: ${OUT}`);
  process.exit(fatal || !summary.ok ? 1 : 0);
})();
