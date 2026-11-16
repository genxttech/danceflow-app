// One-command signed-in smoke run for the Student app on a disposable local stack (Windows, QA only).
// Stack up -> QA release build -> emulator -> install -> magic-link sign-in -> core screens at
// font 1.0/2.0 x light/dark (screenshot + hierarchy check) -> teardown (always).
// Nothing here changes shipping config: the build happens in a separate git worktree.
// See README.md. Usage: node mobile/student/scripts/qa-smoke/run.mjs [--help]
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

if (flag("help")) {
  console.log(readFileSync(join(here, "README.md"), "utf8"));
  process.exit(0);
}

const cfg = {
  name: opt("name", "stusmoke"),
  buildDir: opt("build-dir", "C:\\dq"),
  ref: opt("ref", "origin/main"),
  avd: opt("avd", "df-api35"),
  out: resolve(opt("out", join(repoRoot, "..", "qa-smoke-out"))),
  sdk: process.env.ANDROID_SDK_ROOT || "C:\\Android\\sdk",
  jdk: process.env.JAVA_HOME || "C:\\Android\\jdk-17",
  apk: opt("apk", ""), // reuse a QA APK and skip the build
  skipBuild: flag("skip-build"),
  events: flag("events"), // also seed an event + paid ticket and audit Event detail and the Wallet ticket screen
  noTeardown: flag("keep"), // debugging only
  email: "dana.dancer@example.test",
  pkg: "com.idanceflow.student",
  kong: 56600,
  mockPort: 8791,
};
const adb = join(cfg.sdk, "platform-tools", "adb.exe");
const log = (m) => console.log(`[smoke ${new Date().toISOString().slice(11, 19)}] ${m}`);
const results = [];
const record = (name, ok, detail = "") => { results.push({ name, ok, detail }); log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); };

const run = (cmd, a, o = {}) => spawnSync(cmd, a, { encoding: "utf8", shell: false, maxBuffer: 64 << 20, ...o });
const sh = (a, o) => run(adb, a, o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = { stack: false, mock: null, installed: false, emulator: null, madeBuildWorktree: false, prevFont: null };

function preflight() {
  const docker = run("docker", ["ps", "--format", "{{.Names}}"]);
  if (docker.status !== 0) throw new Error("Docker is not running.");
  const busy = docker.stdout.split("\n").filter((n) => /^df-isoqa-/.test(n));
  if (busy.length) throw new Error(`Another iso-qa stack is running (${busy[0]}...). One stack at a time on this PC.`);
  const java = run("tasklist", ["/FI", "IMAGENAME eq java.exe", "/NH"]).stdout;
  if (/java\.exe/i.test(java) && !flag("force")) throw new Error("A java/Gradle process is running. Wait for it, or pass --force.");
  const dev = sh(["devices"]).stdout;
  if (/emulator-\d+\s+device/.test(dev) && !flag("force")) throw new Error("An emulator is already running (not started by this script). Pass --force to use it.");
}

async function waitFor(fn, what, ms, every = 3000) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

function psql(sqlFile, vars = []) {
  const a = ["exec", "-i", `df-isoqa-${cfg.name}-db`, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", ...vars];
  const r = run("docker", a, { input: readFileSync(sqlFile, "utf8") });
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || r.stdout).slice(0, 400)}`);
}

async function stackUp() {
  log("starting the local stack (about 5 minutes)");
  const r = run("node", [join(repoRoot, "scripts", "qa", "iso-qa.mjs"), "up", "main", "--name", cfg.name, "--auth"], { cwd: repoRoot });
  state.stack = true; // down even on a partial start
  const text = `${r.stdout}\n${r.stderr}`;
  if (r.status !== 0) throw new Error(`iso-qa up failed: ${text.slice(-600)}`);
  const grab = (k) => (text.match(new RegExp(`${k}["']?\\s*[=:]\\s*["']?([A-Za-z0-9._-]+)`)) || [])[1];
  const anon = grab("ISO_QA_ANON_KEY");
  const service = grab("ISO_QA_SERVICE_ROLE_KEY");
  if (!anon || !service) throw new Error("could not read the stack keys from the iso-qa output");
  psql(join(repoRoot, "src", "lib", "supabase", "migrations", "20270213080000_mobile_push_token_claim.sql"));
  return { anon, service };
}

async function makeDancer(service) {
  const base = `http://127.0.0.1:${cfg.kong}`;
  const h = { apikey: service, authorization: `Bearer ${service}`, "content-type": "application/json" };
  const r = await fetch(`${base}/auth/v1/admin/users`, { method: "POST", headers: h, body: JSON.stringify({ email: cfg.email, email_confirm: true }) });
  const user = await r.json();
  if (!user.id) throw new Error(`could not create the dancer: ${JSON.stringify(user).slice(0, 200)}`);
  psql(join(here, "seed.sql"), ["-v", `uid='${user.id}'`]);
  if (cfg.events) psql(join(here, "seed-event.sql"));
  return async () => {
    const g = await fetch(`${base}/auth/v1/admin/generate_link`, { method: "POST", headers: h, body: JSON.stringify({ type: "magiclink", email: cfg.email }) });
    const body = await g.json();
    const hashed = body.hashed_token || body.properties?.hashed_token;
    if (!hashed) throw new Error("generate_link returned no token");
    return `danceflow://auth/callback?token_hash=${hashed}&type=magiclink`;
  };
}

function startMock() {
  state.mock = spawn("node", [join(here, "mock-web.mjs")], { stdio: "ignore" });
}

function build(anon) {
  const app = join(cfg.buildDir, "mobile", "student");
  const apkPath = join(app, "android", "app", "build", "outputs", "apk", "release", "app-release.apk");
  if (!existsSync(cfg.buildDir)) {
    log(`creating a build worktree at ${cfg.buildDir}`);
    const w = run("git", ["-C", repoRoot, "worktree", "add", "--detach", cfg.buildDir, cfg.ref]);
    if (w.status !== 0) throw new Error(`git worktree add failed: ${w.stderr.slice(0, 300)}`);
    state.madeBuildWorktree = true;
  } else {
    run("git", ["-C", cfg.buildDir, "checkout", "--detach", "-f", cfg.ref]);
  }
  const manifest = join(app, "android", "app", "src", "main", "AndroidManifest.xml");
  const orig = readFileSync(manifest, "utf8");
  state.restoreManifest = () => writeFileSync(manifest, orig);
  if (!orig.includes("usesCleartextTraffic")) writeFileSync(manifest, orig.replace("<application", '<application android:usesCleartextTraffic="true"'));
  writeFileSync(join(app, ".env"), [`EXPO_PUBLIC_SUPABASE_URL=http://10.0.2.2:${cfg.kong}`, `EXPO_PUBLIC_SUPABASE_ANON_KEY=${anon}`, `EXPO_PUBLIC_DANCEFLOW_WEB_URL=http://10.0.2.2:${cfg.mockPort}`, ""].join("\n"));
  state.envFile = join(app, ".env");
  for (const d of ["generated/assets", "intermediates/assets", "intermediates/merged_assets", "intermediates/compressed_assets", "intermediates/incremental", "outputs/apk/release"]) {
    rmSync(join(app, "android", "app", "build", d), { recursive: true, force: true });
  }
  const tmp = join(os.tmpdir(), `smoke-empty-${Date.now()}`); // empty TEMP: Metro must not reuse a stale cache
  mkdirSync(tmp, { recursive: true });
  const pw = `smoke${Date.now()}`;
  const ks = join(os.tmpdir(), `smoke-${Date.now()}.jks`);
  state.keystore = ks;
  const kt = run(join(cfg.jdk, "bin", "keytool.exe"), ["-genkeypair", "-keystore", ks, "-storepass", pw, "-keypass", pw, "-alias", "smoke", "-keyalg", "RSA", "-keysize", "2048", "-validity", "30", "-dname", "CN=smoke"]);
  if (kt.status !== 0) throw new Error(`keytool failed: ${kt.stderr.slice(0, 200)}`);
  log("building the QA release APK (about 10 minutes)");
  const g = run(join(app, "android", "gradlew.bat"), ["-p", join(app, "android"), ":app:assembleRelease", "--no-daemon", "-PreactNativeArchitectures=x86_64", "-PallowPlaceholderGoogleServices=true"], {
    cwd: join(app, "android"),
    shell: true,
    env: { ...process.env, TEMP: tmp, TMP: tmp, NODE_ENV: "production", JAVA_HOME: cfg.jdk, ANDROID_HOME: cfg.sdk, DANCEFLOW_UPLOAD_STORE_FILE: ks, DANCEFLOW_UPLOAD_STORE_PASSWORD: pw, DANCEFLOW_UPLOAD_KEY_ALIAS: "smoke", DANCEFLOW_UPLOAD_KEY_PASSWORD: pw },
  });
  writeFileSync(join(cfg.out, "gradle.log"), `${g.stdout}\n${g.stderr}`);
  if (g.status !== 0 || !existsSync(apkPath)) throw new Error("the Gradle build failed (see gradle.log in the output folder)");
  return apkPath;
}

async function emulatorUp() {
  state.emulator = spawn(join(cfg.sdk, "emulator", "emulator.exe"), ["-avd", cfg.avd, "-no-snapshot", "-no-boot-anim", "-gpu", "swiftshader_indirect", "-memory", "2048", "-no-audio"], { stdio: "ignore", detached: false });
  await waitFor(() => sh(["shell", "getprop", "sys.boot_completed"]).stdout.trim() === "1", "the emulator to boot", 300_000);
  sh(["shell", "settings", "put", "global", "hide_error_dialogs", "1"]);
  writeFileSync(join(cfg.out, "talkback.txt"), sh(["shell", "pm", "list", "packages", "talkback"]).stdout || "TalkBack package not installed on this image");
  state.prevFont = sh(["shell", "settings", "get", "system", "font_scale"]).stdout.trim();
  const d = /(d+)s*$/.exec(sh(["shell", "wm", "density"]).stdout.trim())?.[1];
  if (d) writeFileSync(join(cfg.out, "density.txt"), d); // px per 160 dpi, for the touch-target check
}

const hierarchy = () => {
  sh(["shell", "uiautomator", "dump", "/sdcard/ui.xml"]);
  return sh(["exec-out", "cat", "/sdcard/ui.xml"]).stdout;
};
const shot = (file) => {
  const r = spawnSync(adb, ["exec-out", "screencap", "-p"], { maxBuffer: 64 << 20 });
  writeFileSync(file, r.stdout);
};
const openLink = (url) => sh(["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `'${url}'`, cfg.pkg]);

const SCREENS = [
  ...(cfg.events
    ? [
        { id: "event-detail", link: "danceflow://events/44444444-4444-4444-8444-444444444441", expect: /QA Social Dance Night/ },
        { id: "event-ticket", link: "danceflow://wallet/event-tickets", expect: /QA Social Dance Night|QA-DANA-0001|Dana/ },
      ]
    : []),
  { id: "settings", link: "danceflow://settings", expect: /Settings|Delete Account/i },
  { id: "payment-requests", link: "danceflow://wallet/payment-requests", expect: /\$40/ },
  { id: "wallet", link: "danceflow://wallet", expect: /Wallet/i },
];

async function screens(link) {
  const signedIn = () => /Today|Discover|Wallet|Settings/.test(hierarchy());
  sh(["shell", "monkey", "-p", cfg.pkg, "-c", "android.intent.category.LAUNCHER", "1"]); // cold start first, so the link is not lost
  await sleep(15000);
  writeFileSync(join(cfg.out, "signin-screen.xml"), hierarchy()); shot(join(cfg.out, "signin-screen.png")); // the signed-out screen, for the a11y audit
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    openLink(await link());
    ok = await waitFor(signedIn, "sign-in to land in the app", 60_000, 4000).then(() => true, () => false);
  }
  if (!ok) {
    shot(join(cfg.out, "sign-in-failed.png"));
    writeFileSync(join(cfg.out, "sign-in-failed.xml"), hierarchy());
    record("sign-in via magic link", false, "see sign-in-failed.png/.xml");
    throw new Error("sign-in did not complete");
  }
  record("sign-in via magic link", true);
  for (const night of [false, true]) {
    sh(["shell", "cmd", "uimode", "night", night ? "yes" : "no"]);
    for (const scale of ["1.0", "2.0"]) {
      sh(["shell", "settings", "put", "system", "font_scale", scale]);
      await sleep(3000);
      for (const s of SCREENS) {
        const tag = `${s.id}-${scale}-${night ? "dark" : "light"}`;
        openLink(s.link);
        await sleep(4000);
        const xml = await waitFor(() => { const x = hierarchy(); return s.expect.test(x) ? x : null; }, `${tag} content`, 25_000, 2500).catch(() => hierarchy());
        shot(join(cfg.out, `${tag}.png`));
        writeFileSync(join(cfg.out, `${tag}.xml`), xml); // accessibility tree, read by a11y-audit.mjs
        const crashed = /isn't responding|has stopped|keeps stopping|Unfortunately/i.test(xml);
        record(tag, s.expect.test(xml) && !crashed, crashed ? "crash/ANR dialog" : s.expect.test(xml) ? "" : `expected ${s.expect}`);
      }
    }
  }
}

async function teardown() {
  log("tearing down");
  const quiet = (f) => { try { f(); } catch { /* best effort */ } };
  quiet(() => { if (state.installed) sh(["uninstall", cfg.pkg]); });
  quiet(() => { if (state.emulator) { sh(["shell", "settings", "put", "system", "font_scale", state.prevFont && state.prevFont !== "null" ? state.prevFont : "1.0"]); sh(["shell", "cmd", "uimode", "night", "no"]); sh(["shell", "settings", "put", "global", "hide_error_dialogs", "0"]); sh(["emu", "kill"]); } });
  quiet(() => state.mock?.kill());
  quiet(() => { if (state.stack) run("node", [join(repoRoot, "scripts", "qa", "iso-qa.mjs"), "down", "--name", cfg.name, "--force"], { cwd: repoRoot }); });
  quiet(() => state.restoreManifest?.());
  quiet(() => state.envFile && rmSync(state.envFile, { force: true }));
  quiet(() => state.keystore && rmSync(state.keystore, { force: true }));
  quiet(() => { if (state.madeBuildWorktree) run("git", ["-C", repoRoot, "worktree", "remove", "--force", cfg.buildDir]); });
}

mkdirSync(cfg.out, { recursive: true });
let exit = 0;
try {
  preflight();
  const { anon, service } = await stackUp();
  const link = await makeDancer(service);
  startMock();
  const apk = cfg.apk || (cfg.skipBuild ? "" : build(anon));
  if (!apk) throw new Error("--skip-build needs --apk <path>");
  await emulatorUp();
  const inst = sh(["install", "-r", apk]);
  if (!/Success/.test(inst.stdout)) throw new Error(`install failed: ${inst.stdout}${inst.stderr}`);
  state.installed = true;
  await screens(link);
} catch (e) {
  record("run", false, e.message);
} finally {
  if (!cfg.noTeardown) await teardown();
  const failed = results.filter((r) => !r.ok);
  writeFileSync(join(cfg.out, "results.json"), JSON.stringify(results, null, 2));
  log(`${results.length - failed.length}/${results.length} passed. Screenshots and results.json in ${cfg.out}`);
  exit = failed.length ? 1 : 0;
}
process.exit(exit);
