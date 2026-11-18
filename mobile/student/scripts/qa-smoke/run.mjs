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
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const reach = createRequire(import.meta.url)("./reachability.js"); // Wi-Fi/reach preflight + baked-config check (shared helpers with the Business smoke)
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
  apiCheck: flag("api-check"), // with --claim: call the function over HTTP as each user (no APK, no emulator)
  claimVisual: flag("claim-visual"), // implies --claim: the claim flow (create-password routing, Wallet, tickets) at font 1.0/2.0 x light/dark
  claim: flag("claim") || flag("claim-visual"), // verified-email claim device QA (needs the 604 claim migrations from git; applies them on the disposable stack only)
  events: flag("events"), // also seed an event + paid ticket and audit Event detail and the Wallet ticket screen
  noTeardown: flag("keep"), // debugging only
  email: "dana.dancer@example.test",
  email2: "evan.other@example.test",
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
  state.jwtSecret = grab("TW4A_LOCAL_JWT_SECRET") || null;
  if (!anon || !service) throw new Error("could not read the stack keys from the iso-qa output");
  psql(join(repoRoot, "src", "lib", "supabase", "migrations", "20270213080000_mobile_push_token_claim.sql"));
  if (cfg.claim) {
    // LAUNCH-SEC-1C-A (verified-email proof) is listed as unreplayable in the baseline (it needs the GoTrue auth.users columns), so it is
    // applied here, after --auth, exactly like the 604 SQL run: it provides my_verified_email(), which the 604 function calls.
    psql(join(repoRoot, "src", "lib", "supabase", "migrations", "20261008090000_launchsec1ca_verified_email_proof.sql"));
    // PR 604: the function, then the index (a separate non-transactional file). Disposable stack only, never hosted.
    psql(join(repoRoot, "src", "lib", "supabase", "migrations", "20270221090000_event_registration_claim_function.sql"));
    psql(join(repoRoot, "src", "lib", "supabase", "migrations", "20270221091000_event_registrations_unclaimed_email_index_concurrent.sql"));
    // PR 627: the FINAL function (allowlist: only registration_source public_event_page claims; admin, NULL and unknown sources never do). Replaces the 604 body.
    psql(join(repoRoot, "src", "lib", "supabase", "migrations", "20270222090000_event_registration_claim_buyer_sources_only.sql"));
    // Call counter (case 6): the real function is renamed and a thin wrapper with the SAME name, signature and grants is put in front of it.
    // The wrapper records one row per call (who called, when) and then runs the real body unchanged. PostgREST, pg_stat_user_functions and
    // statement logging gave no usable count on this stack; a row written by the call itself cannot be missed. Disposable stack only.
    psql(join(here, "claim-call-counter.sql"));
  }
  return { anon, service };
}

async function makeDancer(service) {
  const base = `http://127.0.0.1:${cfg.kong}`;
  const h = { apikey: service, authorization: `Bearer ${service}`, "content-type": "application/json" };
  const r = await fetch(`${base}/auth/v1/admin/users`, { method: "POST", headers: h, body: JSON.stringify({ email: cfg.email, email_confirm: true }) });
  const user = await r.json();
  if (!user.id) throw new Error(`could not create the dancer: ${JSON.stringify(user).slice(0, 200)}`);
  psql(join(here, "seed.sql"), ["-v", `uid='${user.id}'`]);
  if (cfg.events || cfg.claim) psql(join(here, "seed-event.sql"), ["-v", `uid='${user.id}'`]);
  state.uid = user.id;
  if (cfg.claim) {
    const r2 = await fetch(`${base}/auth/v1/admin/users`, { method: "POST", headers: h, body: JSON.stringify({ email: cfg.email2, email_confirm: true }) });
    const user2 = await r2.json();
    if (!user2.id) throw new Error(`could not create the second dancer: ${JSON.stringify(user2).slice(0, 200)}`);
    state.uid2 = user2.id;
    psql(join(here, "seed-claim.sql"), ["-v", `uid='${user.id}'`, "-v", `uid2='${user2.id}'`]);
  }
  return async (email = cfg.email) => {
    const g = await fetch(`${base}/auth/v1/admin/generate_link`, { method: "POST", headers: h, body: JSON.stringify({ type: "magiclink", email }) });
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

/**
 * Before the emulator is touched: the APK's Hermes bundle must carry THIS run's stack URL, mock web URL and anon key. A stale APK (reused with --apk, or a
 * stale Metro cache) otherwise fails at sign-in with a misleading "could not reach DanceFlow".
 */
function checkBakedConfig(apk, anon) {
  const dir = join(os.tmpdir(), `smoke-bundle-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    const tar = process.platform === "win32" ? join(process.env.SystemRoot || "C:/Windows", "System32", "tar.exe") : "tar";
    const x = run(tar, ["-xf", apk, "-C", dir, "assets/index.android.bundle"]);
    if (x.status !== 0) throw new Error(`could not read the JS bundle from the APK: ${(x.stderr || "").slice(-200)}`);
    const strings = reach.hermesStrings(readFileSync(join(dir, "assets", "index.android.bundle")));
    const problems = reach.studentBakedConfigProblems(strings, { stackPort: cfg.kong, mockPort: cfg.mockPort, anonKey: anon, jwtSecret: state.jwtSecret || undefined });
    // The URLs are hard requirements (a stale port can never reach the stack). The anon key is only a warning: it is sent as the apikey header, the
    // iso-qa gateway does not validate it, and magic-link sign-in works with a key from another stack (reused APKs ran green); a key mismatch is recorded, not fatal.
    const keyProblems = problems.filter((p) => /anon key/.test(p));
    const urlProblems = problems.filter((p) => !/anon key/.test(p));
    record("APK carries this run's stack URL and mock web URL", urlProblems.length === 0, urlProblems.join("; "));
    if (keyProblems.length) record("APK anon key differs from this stack (warning only: reused APK; magic-link sign-in does not need it)", true, keyProblems.join("; "));
    if (urlProblems.length) throw new Error(`stale or foreign APK: ${urlProblems.join("; ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * After the emulator is up and before any sign-in: its own network must reach the stack and the mock web API on 10.0.2.2. The emulator's Wi-Fi joins tens
 * of seconds after sys.boot_completed and can flap for a few minutes after a cold boot, so this waits (Wi-Fi address up to 2 min, then a steady HTTP answer
 * up to 8 min, confirmed by a second answer 15 s later). If it never answers, the run fails here with a named reason instead of as a sign-in failure.
 */
async function checkReachable() {
  const wifi = await reach.waitForWifiAddress({ probe: () => sh(["shell", "ip", "-4", "addr", "show", "wlan0"]).stdout, sleep });
  record("emulator Wi-Fi has an address", wifi.ok, wifi.ok ? `after ${wifi.tries} check(s)` : "wlan0 never got an address within 2 minutes of boot");
  if (!wifi.ok) throw new Error("the emulator never got a network address");
  for (const [name, port, urlPath] of [["stack API", cfg.kong, "/auth/v1/health"], ["mock web API", cfg.mockPort, "/"]]) {
    const answer = await reach.waitForSteadyAnswer({
      probe: () => { const r = sh(["shell", reach.reachProbeCommand(port, urlPath)]); return `${r.stdout} ${r.stderr}`; },
      sleep,
    });
    record(`emulator reaches the ${name} (10.0.2.2:${port})`, answer.ok, answer.ok ? "" : `no steady HTTP answer from inside the emulator within 8 min (last output: ${reach.oneLine(answer.last)})`);
    if (!answer.ok) throw new Error(`the emulator cannot reach the ${name} at 10.0.2.2:${port}`);
  }
}

async function emulatorUp() {
  state.emulator = spawn(join(cfg.sdk, "emulator", "emulator.exe"), ["-avd", cfg.avd, "-no-snapshot", "-no-boot-anim", "-gpu", "swiftshader_indirect", "-memory", "2048", "-no-audio"], { stdio: "ignore", detached: false });
  await waitFor(() => sh(["shell", "getprop", "sys.boot_completed"]).stdout.trim() === "1", "the emulator to boot", 300_000);
  sh(["shell", "settings", "put", "global", "hide_error_dialogs", "1"]);
  state.prevStay = sh(["shell", "settings", "get", "global", "stay_on_while_plugged_in"]).stdout.trim();
  sh(["shell", "settings", "put", "global", "stay_on_while_plugged_in", "7"]);
  sh(["shell", "svc", "power", "stayon", "true"]);
  sh(["shell", "input", "keyevent", "224"]);
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

// ---- verified-email claim scenario (--claim): 604 function on a disposable stack, Dana, Evan, function missing, offline ----
const q = (sql) => {
  const r = run("docker", ["exec", "-i", `df-isoqa-${cfg.name}-db`, "psql", "-U", "postgres", "-d", "postgres", "-At", "-F", "|", "-c", sql]);
  return r.status === 0 ? r.stdout.trim() : `ERR ${(r.stderr || "").slice(0, 160)}`;
};
const MUST_NOT_CHANGE = ["clients", "client_account_links", "leads", "notifications", "payments", "event_registration_attendees"];
const snapshot = () => ({
  counts: Object.fromEntries(MUST_NOT_CHANGE.map((t) => [t, q(`select count(*) from public.${t}`)])),
  regs: Object.fromEntries(q("select right(id::text,3), coalesce(user_id::text,'null') from public.event_registrations where id::text like '66666666%' order by id").split("\n").filter(Boolean).map((l) => l.split("|"))),
  attendees: q("select md5(string_agg(id::text||coalesce(email,'')||coalesce(registration_id::text,''), ',' order by id)) from public.event_registration_attendees"),
});
const who = (uid) => (uid === state.uid ? "Dana" : uid === state.uid2 ? "Evan" : uid);
const ownerName = (snap, suffix) => (snap.regs[suffix] === "null" ? "unclaimed" : who(snap.regs[suffix]));
// Calls the app made to the claim function, counted by the wrapper in claim-call-counter.sql (all callers, or one user).
const claimCalls = (uid) => Number(q(`select count(*) from public.qa_claim_calls${uid ? ` where caller = '${uid}'` : ""}`));
const resetClaimCalls = () => { q("truncate public.qa_claim_calls"); q("select setval('public.qa_claim_attempts', 1, false)"); };
// Attempts survive a rollback (the raising function of case 9b), unlike the rows of qa_claim_calls.
const claimAttempts = () => Number(q("select case when is_called then last_value else 0 end from public.qa_claim_attempts"));
const saveLogs = (tag) => {
  const l = sh(["logcat", "-d", "-v", "time", "-s", "ReactNativeJS:V", "AndroidRuntime:E"]);
  writeFileSync(join(cfg.out, `${tag}-logcat.txt`), `${l.stdout}\n${l.stderr}`);
  sh(["logcat", "-c"]);
};
const CODES = /QA-(?:DANA|CLAIM|GIFT|OWNED|NOBODY)-\d{4}/g;

async function freshSignIn(link, email, tag, allowSecure = false) {
  sh(["shell", "input", "keyevent", "224"]);
  sh(["shell", "pm", "clear", cfg.pkg]);
  await sleep(2500);
  sh(["shell", "monkey", "-p", cfg.pkg, "-c", "android.intent.category.LAUNCHER", "1"]);
  await sleep(15000);
  const signedIn = () => { const x = hierarchy(); return /Today|Wallet|Settings/.test(x) && !/Continue with email|Start exploring|Sign in needs another try|taking longer than usual/.test(x); };
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    openLink(await link(email));
    ok = await waitFor(signedIn, "sign-in", 90_000, 4000).then(() => true, () => false);
  }
  if (!ok && allowSecure && /Create your password/.test(hierarchy())) {
    shot(join(cfg.out, `${tag}-secure-account.png`));
    record(`${tag}: unbound user is routed to account securing (Create your password), as designed`, true, "");
    return "secure";
  }
  if (!ok) { shot(join(cfg.out, `${tag}-signin-failed.png`)); writeFileSync(join(cfg.out, `${tag}-signin-failed.xml`), hierarchy()); }
  if (ok) writeFileSync(join(cfg.out, `${tag}-after-signin.xml`), hierarchy());
  record(`${tag}: sign-in via magic link`, ok, ok ? "" : "see the -signin-failed files");
  return ok;
}

// Opens Wallet (where the claim runs), then the tickets screen, scrolling to collect every ticket code on it.
async function readTickets(tag) {
  sh(["shell", "input", "keyevent", "224"]);
  openLink("danceflow://wallet");
  await sleep(14000);
  openLink("danceflow://wallet/event-tickets");
  await sleep(8000);
  for (let i = 0; i < 12 && /Loading tickets/.test(hierarchy()); i++) await sleep(4000);
  saveLogs(tag);
  const seen = new Set();
  let xmlAll = "";
  let stale = 0;
  for (let i = 0; i < 8 && stale < 2; i++) {
    const xml = hierarchy();
    xmlAll += xml;
    writeFileSync(join(cfg.out, `${tag}-tickets-${i}.xml`), xml);
    if (i === 0) shot(join(cfg.out, `${tag}-tickets.png`));
    const before = seen.size;
    for (const m of xml.match(CODES) || []) seen.add(m);
    stale = seen.size === before ? stale + 1 : 0;
    sh(["shell", "input", "swipe", "540", "1900", "540", "700", "450"]);
    await sleep(1500);
  }
  return { codes: [...seen].sort(), xml: xmlAll };
}

const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

async function claimScenario(link) {
  const base = snapshot();
  writeFileSync(join(cfg.out, "claim-before.json"), JSON.stringify(base, null, 2));
  const expectOwners = (snap, exp, tag) => {
    const got = { 662: ownerName(snap, "662"), 663: ownerName(snap, "663"), 664: ownerName(snap, "664"), 665: ownerName(snap, "665"), 666: ownerName(snap, "666") };
    record(`${tag}: registration owners ${JSON.stringify(exp)}`, JSON.stringify(got) === JSON.stringify(exp), JSON.stringify(got));
  };
  const sameCounts = (snap, tag) => {
    const diff = MUST_NOT_CHANGE.filter((t) => snap.counts[t] !== base.counts[t]);
    record(`${tag}: must-not-change tables unchanged (${MUST_NOT_CHANGE.join(", ")})`, diff.length === 0 && snap.attendees === base.attendees, diff.length ? `changed: ${diff.join(", ")}` : snap.attendees === base.attendees ? "" : "attendee rows changed");
  };

  // Case 8: Dana signs in with a mailbox-verified but NOT bound account (a first sign-in before a password is bound): the function must
  // return 0, claim nothing, and show nothing new or wrong.
  const unboundState = await freshSignIn(link, cfg.email, "dana0-unbound", true);
  if (unboundState === "secure") {
    const afterSecure = snapshot();
    record("case 8: unbound user: nothing claimed (registration owners unchanged) while the app asks for a password first", ownerName(afterSecure, "662") === "unclaimed" && ownerName(afterSecure, "663") === "unclaimed", `owners 662=${ownerName(afterSecure, "662")} 663=${ownerName(afterSecure, "663")}`);
    sameCounts(afterSecure, "after unbound Dana");
  } else if (unboundState) {
    const unb = await readTickets("dana0-unbound");
    const afterUnb = snapshot();
    record("case 8: unbound session: nothing claimed (registration owners unchanged), only the owned ticket shows or none at all (an unbound user may be routed to account securing first), no error text", ownerName(afterUnb, "662") === "unclaimed" && ownerName(afterUnb, "663") === "unclaimed" && (unb.codes.length === 0 || (unb.codes.length === 0 || same(unb.codes, ["QA-DANA-0001"]))) && !/could not|unavailable|error/i.test(unb.xml), `codes: ${unb.codes.join(", ")}; owners 662=${ownerName(afterUnb, "662")} 663=${ownerName(afterUnb, "663")}`);
    sameCounts(afterUnb, "after unbound Dana");
  }
  // From here both users have a BOUND credential bound a day ago (what any returning user has), so their new sessions are verified.
  for (const [uid, email] of [[state.uid, cfg.email], [state.uid2, cfg.email2]]) {
    const insErr = q(`insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at) values ('${uid}', '${email}', now() - interval '2 days', now() - interval '1 day', 'otp', 'mobile_app', 'bound', now() - interval '1 day') on conflict (user_id, email) do update set credential_status = 'bound', bound_at = now() - interval '1 day', binding_session_id = null, binding_started_at = null`);
    if (/^ERR/.test(insErr)) throw new Error("could not bind the QA user: " + insErr);
  }

  // Cases 1-4, 6: Dana, verified and bound email, first sign-in on this run.
  if (!(await freshSignIn(link, cfg.email, "dana1"))) return;
  const dana = await readTickets("dana1");
  const afterDana = snapshot();
  writeFileSync(join(cfg.out, "claim-after-dana.json"), JSON.stringify(afterDana, null, 2));
  const claimed = afterDana.regs["662"] !== "null";
  if (!claimed) {
    record("case 1 FINDING: Dana's BOUND session claimed nothing (function returned 0, errored or was not reached)", false, `owners 662=${ownerName(afterDana, "662")} 663=${ownerName(afterDana, "663")}`);
  }
  record("case 1: Dana sees QA-DANA-0001 and QA-CLAIM-0001 (web cart) and NOT QA-CLAIM-0002 (studio-sold, excluded)", same(dana.codes.filter((c) => /DANA|CLAIM/.test(c)), ["QA-CLAIM-0001", "QA-DANA-0001"]), `codes seen: ${dana.codes.join(", ")}`);
  record("case 2-4: Dana does NOT see QA-GIFT-0003, QA-OWNED-0004, QA-NOBODY-0005", !dana.codes.some((c) => /GIFT|OWNED|NOBODY/.test(c)), "");
  expectOwners(afterDana, { 662: "Dana", 663: "unclaimed", 664: "unclaimed", 665: "Evan", 666: "unclaimed" }, "after Dana");
  sameCounts(afterDana, "after Dana");
  record("case 1b: studio-sold c2 (663) and null-source c6 (667, NULL registration_source) stay unclaimed", ownerName(afterDana, "663") === "unclaimed" && ownerName(afterDana, "667") === "unclaimed", `663=${ownerName(afterDana, "663")} 667=${ownerName(afterDana, "667")}`);
  record("case 6: Dana's first app run called the claim function exactly once (counted by the wrapper)", claimCalls(state.uid) === 1, `calls: ${claimCalls(state.uid)}`);
  record("no claim wording on the tickets screen", !/claim|linking your|verif/i.test(dana.xml.replace(/QA-CLAIM-\d{4}|Q A - C L A I M[^"]*/g, "")), "");

  // Case 5: Evan, a second user with a different email, same stack and device.
  if (await freshSignIn(link, cfg.email2, "evan")) {
    const evan = await readTickets("evan");
    const afterEvan = snapshot();
    writeFileSync(join(cfg.out, "claim-after-evan.json"), JSON.stringify(afterEvan, null, 2));
    record("case 5: Evan sees QA-GIFT-0003 and QA-OWNED-0004 and none of Dana's tickets", same(evan.codes, ["QA-GIFT-0003", "QA-OWNED-0004"]), `codes seen: ${evan.codes.join(", ")}`);
    expectOwners(afterEvan, { 662: "Dana", 663: "unclaimed", 664: "Evan", 665: "Evan", 666: "unclaimed" }, "after Evan");
    sameCounts(afterEvan, "after Evan");
    record("case 6: Evan's app run called the claim function exactly once", claimCalls(state.uid2) === 1, `calls: ${claimCalls(state.uid2)}`);
  }

  // Case 6/7: Dana again after a cold restart: idempotent, nothing changes.
  if (await freshSignIn(link, cfg.email, "dana2")) {
    const before2 = snapshot();
    const callsBefore2 = claimCalls(state.uid);
    const dana2 = await readTickets("dana2");
    const afterDana2 = snapshot();
    record("case 7: a second run for Dana changes no ownership (idempotent) and shows the same tickets", JSON.stringify(afterDana2.regs) === JSON.stringify(before2.regs) && same(dana2.codes.filter((c) => /DANA|CLAIM/.test(c)), ["QA-CLAIM-0001", "QA-DANA-0001"]), `codes: ${dana2.codes.join(", ")}`);
    sameCounts(afterDana2, "after Dana again");
    record("case 6: Dana's cold restart is a new app run: exactly one more call", claimCalls(state.uid) - callsBefore2 === 1, `calls this run: ${claimCalls(state.uid) - callsBefore2}`);

    // Case 10: offline. The claim has already run for Dana this app run, so this only shows the wallet's offline wording.
    sh(["shell", "cmd", "connectivity", "airplane-mode", "enable"]);
    state.airplane = true;
    await sleep(4000);
    openLink("danceflow://wallet/event-tickets");
    await sleep(6000);
    const off = hierarchy();
    shot(join(cfg.out, "dana2-offline.png"));
    writeFileSync(join(cfg.out, "dana2-offline.xml"), off);
    sh(["shell", "cmd", "connectivity", "airplane-mode", "disable"]);
    state.airplane = false;
    record("case 10: offline: the tickets screen reads as offline or keeps the loaded tickets, with no claim text", /offline|connection|QA-(DANA|CLAIM)-000[0-9]/i.test(off) && !/claim/i.test(off.replace(/QA-CLAIM-\d{4}|Q A - C L A I M[^"]*/g, "")), "see dana2-offline.png");
  }

  // Case 9b: the function raises an error. The app must show nothing about it and must not retry in a loop (one call per run).
  q("update public.event_registrations set user_id = null where id::text like '66666666%2' or id::text like '66666666%3'");
  q("create or replace function public.claim_my_event_registrations() returns integer language plpgsql security definer set search_path = '' as $f$ begin perform nextval('public.qa_claim_attempts'); raise exception 'qa: claim failed on purpose'; end $f$");
  resetClaimCalls();
  if (await freshSignIn(link, cfg.email, "dana3-fnerr")) {
    const dana3e = await readTickets("dana3-fnerr");
    const callsErr = claimAttempts();
    record("case 9b: function raises: only the already-owned ticket shows", same(dana3e.codes, ["QA-DANA-0001"]), `codes: ${dana3e.codes.join(", ")}`);
    record("case 9b: function raises: no error text on the tickets screen", !/could not|unavailable|error|failed on purpose/i.test(dana3e.xml), "see dana3-fnerr-logcat.txt");
    record("case 9b: function raises: exactly one call in the app run (no retry loop)", callsErr === 1, `calls: ${callsErr}`);
  }

  // Case 9: function missing. Reset Dana's two rows, drop the function, cold start: nothing claimed, no error text, no loop.
  q("update public.event_registrations set user_id = null where id::text like '66666666%2' or id::text like '66666666%3'");
  q("drop function public.claim_my_event_registrations()");
  if (await freshSignIn(link, cfg.email, "dana3-nofn")) {
    const dana3 = await readTickets("dana3-nofn");
    record("case 9: function missing: only the already-owned ticket shows", same(dana3.codes, ["QA-DANA-0001"]), `codes: ${dana3.codes.join(", ")}`);
    record("case 9: function missing: no error text on the tickets screen (retry count is measured by case 9b: a missing function has no database-side counter)", !/could not|unavailable|error/i.test(dana3.xml), "see dana3-nofn-logcat.txt");
  }
}


// ---- --claim --api-check: the same ownership cases over HTTP with real user tokens (no device) ----
async function claimApiCheck(link, service, anon) {
  const base = `http://127.0.0.1:${cfg.kong}`;
  const snapBase = snapshot();
  const tokenFor = async (email) => {
    const url = await link(email);
    const hashed = new URL(url.replace("danceflow://", "https://x/")).searchParams.get("token_hash");
    const r = await fetch(`${base}/auth/v1/verify`, { method: "POST", headers: { apikey: anon, "content-type": "application/json" }, body: JSON.stringify({ type: "magiclink", token_hash: hashed }) });
    const j = await r.json();
    if (!j.access_token) throw new Error(`no access token for ${email}: ${JSON.stringify(j).slice(0, 160)}`);
    return j.access_token;
  };
  const rpc = async (token) => {
    const r = await fetch(`${base}/rest/v1/rpc/claim_my_event_registrations`, { method: "POST", headers: { apikey: anon, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    return { status: r.status, body: (await r.text()).slice(0, 200) };
  };
  const owners = () => { const sn = snapshot(); return { 662: ownerName(sn, "662"), 663: ownerName(sn, "663"), 664: ownerName(sn, "664"), 665: ownerName(sn, "665"), 666: ownerName(sn, "666") }; };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const tablesSame = (tag) => { const sn = snapshot(); const diff = MUST_NOT_CHANGE.filter((t) => sn.counts[t] !== snapBase.counts[t]); record(`api ${tag}: must-not-change tables unchanged`, diff.length === 0 && sn.attendees === snapBase.attendees, diff.join(", ")); };

  const danaTok0 = await tokenFor(cfg.email);
  const r0 = await rpc(danaTok0);
  record("api case 8: unbound Dana: function returns 0, status 200, nothing claimed", r0.status === 200 && r0.body.trim() === "0" && eq(owners(), { 662: "unclaimed", 663: "unclaimed", 664: "unclaimed", 665: "Evan", 666: "unclaimed" }), `status ${r0.status} body ${r0.body}`);
  tablesSame("after unbound Dana");

  for (const [uid, email] of [[state.uid, cfg.email], [state.uid2, cfg.email2]]) {
    const apiIns = q(`insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at) values ('${uid}', '${email}', now() - interval '2 days', now() - interval '1 day', 'otp', 'mobile_app', 'bound', now() - interval '1 day') on conflict (user_id, email) do update set credential_status = 'bound', bound_at = now() - interval '1 day', binding_session_id = null, binding_started_at = null`);
    if (/^ERR/.test(apiIns)) throw new Error("could not bind the QA user: " + apiIns);
  }
  const danaTok = await tokenFor(cfg.email);
  const r1 = await rpc(danaTok);
  record("api case 1: bound Dana: function returns 1 (c1 mixed-case web cart only; c2 studio-sold and c6 null-source are excluded)", r1.status === 200 && r1.body.trim() === "1", `status ${r1.status} body ${r1.body}`);
  record("api cases 2-4: only 662 is Dana's now; 663 (studio-sold) stays unclaimed; gift, owned-by-Evan and nobody's untouched", eq(owners(), { 662: "Dana", 663: "unclaimed", 664: "unclaimed", 665: "Evan", 666: "unclaimed" }), JSON.stringify(owners()));
  tablesSame("after Dana");
  const r2 = await rpc(danaTok);
  record("api case 7: second call returns 0 and changes nothing", r2.status === 200 && r2.body.trim() === "0" && eq(owners(), { 662: "Dana", 663: "unclaimed", 664: "unclaimed", 665: "Evan", 666: "unclaimed" }), `status ${r2.status} body ${r2.body}`);
  const evanTok = await tokenFor(cfg.email2);
  const r3 = await rpc(evanTok);
  record("api case 5: Evan returns 1 (the gift c3 he bought); Dana's rows stay Dana's", r3.status === 200 && r3.body.trim() === "1" && eq(owners(), { 662: "Dana", 663: "unclaimed", 664: "Evan", 665: "Evan", 666: "unclaimed" }), `status ${r3.status} body ${r3.body}`);
  tablesSame("after Evan");
  const anonCall = await fetch(`${base}/rest/v1/rpc/claim_my_event_registrations`, { method: "POST", headers: { apikey: anon, "content-type": "application/json" }, body: "{}" });
  record("api: anon (signed out) is denied", anonCall.status >= 400, `status ${anonCall.status}`);
  record("api: the counter saw exactly the 4 signed-in calls (unbound Dana, Dana, Dana again, Evan) and not the denied anon call", claimCalls() === 4, `calls: ${claimCalls()}`);
}
// ---- --claim-visual: the claim flow at font 1.0 and 2.0, light and dark (create-password routing, Wallet, tickets) ----
async function claimVisualScenario(link) {
  const combos = [];
  for (const night of [false, true]) for (const scale of ["1.0", "2.0"]) combos.push({ night, scale, tag: `${scale}-${night ? "dark" : "light"}` });
  const setLook = async (c) => {
    sh(["shell", "cmd", "uimode", "night", c.night ? "yes" : "no"]);
    sh(["shell", "settings", "put", "system", "font_scale", c.scale]);
    await sleep(3000);
  };
  const crashed = (x) => /isn't responding|has stopped|keeps stopping|Unfortunately/i.test(x);

  // Part A: Dana is NOT bound yet: the app routes her to "Create your password" and claims nothing.
  for (const c of combos) {
    await setLook(c);
    const st = await freshSignIn(link, cfg.email, `cv-secure-${c.tag}`, true);
    const x = hierarchy();
    writeFileSync(join(cfg.out, `cv-secure-${c.tag}.xml`), x);
    shot(join(cfg.out, `cv-secure-${c.tag}.png`));
    record(`visual ${c.tag}: unbound Dana lands on Create your password, nothing crashes`, st === "secure" && !crashed(x), st === "secure" ? "" : "did not reach the secure-account screen");
    const sn = snapshot();
    record(`visual ${c.tag}: unbound Dana claimed nothing`, ownerName(sn, "662") === "unclaimed" && ownerName(sn, "663") === "unclaimed", "");
  }

  // Part B: Dana and Evan are bound (what any returning user has). Each combo is a fresh app run with 662/663 unclaimed again.
  for (const [uid, email] of [[state.uid, cfg.email], [state.uid2, cfg.email2]]) {
    const insErr = q(`insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at) values ('${uid}', '${email}', now() - interval '2 days', now() - interval '1 day', 'otp', 'mobile_app', 'bound', now() - interval '1 day') on conflict (user_id, email) do update set credential_status = 'bound', bound_at = now() - interval '1 day', binding_session_id = null, binding_started_at = null`);
    if (/^ERR/.test(insErr)) throw new Error("could not bind the QA user: " + insErr);
  }
  for (const c of combos) {
    await setLook(c);
    q("update public.event_registrations set user_id = null where id::text like '66666666%2' or id::text like '66666666%3'");
    resetClaimCalls();
    if (!(await freshSignIn(link, cfg.email, `cv-dana-${c.tag}`))) continue;
    const d = await readTickets(`cv-${c.tag}`);
    record(`visual ${c.tag}: Dana sees QA-DANA-0001 and QA-CLAIM-0001 (web cart) and NOT QA-CLAIM-0002 (studio-sold, excluded) and nothing else`, same(d.codes, ["QA-CLAIM-0001", "QA-DANA-0001"]), `codes: ${d.codes.join(", ")}`);
    record(`visual ${c.tag}: exactly one claim call in the app run`, claimCalls(state.uid) === 1, `calls: ${claimCalls(state.uid)}`);
    const sn = snapshot();
    record(`visual ${c.tag}: owners after the run`, ownerName(sn, "662") === "Dana" && ownerName(sn, "663") === "unclaimed" && ownerName(sn, "664") === "unclaimed" && ownerName(sn, "665") === "Evan" && ownerName(sn, "666") === "unclaimed", JSON.stringify(sn.regs));
    record(`visual ${c.tag}: no claim wording and no crash on the tickets screen`, !/claim|linking your|verif/i.test(d.xml.replace(/QA-CLAIM-\d{4}|Q A - C L A I M[^"]*/g, "")) && !crashed(d.xml), "");
    // Wallet itself (where the claim is awaited), after the claim
    openLink("danceflow://wallet");
    await sleep(8000);
    const w = hierarchy();
    writeFileSync(join(cfg.out, `cv-wallet-${c.tag}.xml`), w);
    shot(join(cfg.out, `cv-wallet-${c.tag}.png`));
    record(`visual ${c.tag}: Wallet loads, no crash, no claim wording`, /Wallet/i.test(w) && !crashed(w) && !/claim|linking your/i.test(w.replace(/QA-CLAIM-\d{4}|Q A - C L A I M[^"]*/g, "")), "");
  }
}

async function teardown() {
  log("tearing down");
  const quiet = (f) => { try { f(); } catch { /* best effort */ } };
  quiet(() => { if (state.installed) sh(["uninstall", cfg.pkg]); });
  quiet(() => { if (state.emulator) { sh(["shell", "settings", "put", "system", "font_scale", state.prevFont && state.prevFont !== "null" ? state.prevFont : "1.0"]); sh(["shell", "cmd", "uimode", "night", "no"]); sh(["shell", "settings", "put", "global", "hide_error_dialogs", "0"]); sh(["shell", "settings", "put", "global", "stay_on_while_plugged_in", state.prevStay && state.prevStay !== "null" ? state.prevStay : "0"]); sh(["shell", "svc", "power", "stayon", "false"]); sh(["emu", "kill"]); } });
  quiet(() => { if (state.airplane) sh(["shell", "cmd", "connectivity", "airplane-mode", "disable"]); });
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
  if (cfg.claim && cfg.apiCheck) {
    await claimApiCheck(link, service, anon);
    throw Object.assign(new Error("api-check done"), { done: true });
  }
  startMock();
  const apk = cfg.apk || (cfg.skipBuild ? "" : build(anon));
  if (!apk) throw new Error("--skip-build needs --apk <path>");
  checkBakedConfig(apk, anon);
  await emulatorUp();
  const inst = sh(["install", "-r", apk]);
  if (!/Success/.test(inst.stdout)) throw new Error(`install failed: ${inst.stdout}${inst.stderr}`);
  state.installed = true;
  await checkReachable();
  if (cfg.claimVisual) await claimVisualScenario(link);
  else if (cfg.claim) await claimScenario(link);
  else await screens(link);
} catch (e) {
  if (!e.done) record("run", false, e.message);
} finally {
  if (!cfg.noTeardown) await teardown();
  const failed = results.filter((r) => !r.ok);
  writeFileSync(join(cfg.out, "results.json"), JSON.stringify(results, null, 2));
  log(`${results.length - failed.length}/${results.length} passed. Screenshots and results.json in ${cfg.out}`);
  exit = failed.length ? 1 : 0;
}
process.exit(exit);
