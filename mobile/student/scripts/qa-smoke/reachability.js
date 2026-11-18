/*
  Emulator network preflight for the Student smoke harness (run.mjs), kept free of adb and docker so it is unit-tested in jest
  (src/lib/__tests__/qaReachability.test.ts). CommonJS on purpose: run.mjs loads it with createRequire, jest loads it as-is.

  Why: RC4's Student smoke failed once at sign-in ("could not reach DanceFlow", APK config correct) and passed on retry. The cause is the
  emulator's own network after a cold boot: Wi-Fi (wlan0) joins tens of seconds after sys.boot_completed, then can flap (address, gone for ~2 min,
  back). The shell helpers (reach probe, Wi-Fi address test, Hermes string table, baked-config check) are the ones the Business smoke already uses
  (mobile/business/scripts/device-smoke-lib.js); they are loaded from there instead of copied, so a fix in one place reaches both harnesses.
*/
const fs = require("node:fs");
const path = require("node:path");

// The Business lib is plain CommonJS that only needs node built-ins. It is evaluated from its source text, not require()d, so a test runner that
// transforms required files (jest/babel resolves helpers relative to the Business package, which has its own node_modules) loads exactly the same code.
function loadShared() {
  const file = path.join(__dirname, "..", "..", "..", "business", "scripts", "device-smoke-lib.js");
  const mod = { exports: {} };
  new Function("module", "exports", "require", fs.readFileSync(file, "utf8"))(mod, mod.exports, require);
  return mod.exports;
}
const shared = loadShared();
const { hasWifiAddress, reachProbeCommand, probeAnswered, hermesStrings, bakedConfigProblems } = shared;

/**
 * Waits for wlan0 to have an address. `probe()` returns the text of `ip -4 addr show wlan0`; `sleep(ms)` waits. Resolves { ok, tries }.
 */
async function waitForWifiAddress({ probe, sleep, tries = 40, everyMs = 3000 }) {
  for (let i = 1; i <= tries; i++) {
    if (hasWifiAddress(await probe())) return { ok: true, tries: i };
    if (i < tries) await sleep(everyMs);
  }
  return { ok: false, tries };
}

/**
 * Waits for a STEADY HTTP answer from inside the emulator: a first answer, then a second one `confirmMs` later, so a Wi-Fi flap that happens to answer once
 * is not taken for steady state. `probe()` returns the shell output of the reach probe; `sleep(ms)` waits; `now()` is the clock (injected for tests).
 * Resolves { ok, last } where `last` is the last output seen (for the failure message).
 */
async function waitForSteadyAnswer({ probe, sleep, now = Date.now, timeoutMs = 8 * 60 * 1000, retryMs = 4000, confirmMs = 15000 }) {
  const end = now() + timeoutMs;
  let last = "";
  const answered = async () => {
    last = String((await probe()) ?? "");
    return probeAnswered(last);
  };
  while (now() < end) {
    if (await answered()) {
      await sleep(confirmMs);
      if (await answered()) return { ok: true, last };
    } else await sleep(retryMs);
  }
  return { ok: false, last };
}

/** What the Student QA APK must carry: the stack URL and this run's mock web URL as the emulator sees them, and an anon key this stack accepts. Empty = fine. */
function studentBakedConfigProblems(strings, { stackPort, mockPort, anonKey, jwtSecret }) {
  // A reused APK carries another stack's anon key (it embeds an expiry), so the key is accepted when it is the exact key OR a valid anon token signed with this
  // stack's JWT secret (what the auth server actually checks).
  return bakedConfigProblems(strings, { stackPort, webPort: mockPort, anonKey, jwtSecret });
}

/** A short single-line version of probe output for a result detail. */
function oneLine(text, max = 200) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max) || "none";
}

module.exports = { waitForWifiAddress, waitForSteadyAnswer, studentBakedConfigProblems, oneLine, hermesStrings, reachProbeCommand, probeAnswered, hasWifiAddress };
