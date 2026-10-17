import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProbeFetch } from "../validation/probe";
import { selfTestFetch } from "../validation/selfTest";
import { checkOutPath, DEFAULT_PRIMARY_PROFILE_SID, executeStageA, hintsFor, STAGE_A_CONFIRM_FLAG, USE_AUTH_TOKEN_FLAG } from "../validation/stageA";

const ACCOUNT = `AC${"1".repeat(32)}`;
const KEY = `SK${"2".repeat(32)}`;
const SECRET = "api-key-secret-value";
const TOKEN = "master-token-value";

function recorder() {
  const calls: { url: string; method: string; authorization: string }[] = [];
  const fetchImpl: ProbeFetch = async (url, init) => {
    calls.push({ url, method: init.method, authorization: init.headers.Authorization });
    if (url.includes("/Accounts/")) return { status: 200, text: async () => JSON.stringify({ status: "active", type: "Full" }) };
    return { status: 200, text: async () => JSON.stringify({ results: [], data: [], sid: DEFAULT_PRIMARY_PROFILE_SID, status: "twilio-approved", policy_sid: `RN${"4".repeat(32)}`, meta: {} }) };
  };
  return { fetchImpl, calls };
}

describe("Stage A entry point", () => {
  it("does nothing without the explicit confirmation flag", async () => {
    const { fetchImpl, calls } = recorder();
    const out = await executeStageA({ argv: [], env: { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_AUTH_TOKEN: TOKEN }, fetchImpl });
    expect(out).toMatchObject({ ok: false, exitCode: 2 });
    expect(out.text).toContain("nothing was sent to Twilio");
    expect(out.text).toContain("To fix:");
    expect(calls).toHaveLength(0);
  });
  it("refuses missing, malformed or incomplete credentials before any request", async () => {
    const { fetchImpl, calls } = recorder();
    const argv = [STAGE_A_CONFIRM_FLAG];
    for (const env of [
      {},
      { TWILIO_ACCOUNT_SID: "nope", TWILIO_AUTH_TOKEN: TOKEN },
      { TWILIO_ACCOUNT_SID: ACCOUNT },
      { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_API_KEY_SID: KEY },
      { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_API_KEY_SID: "SKbad", TWILIO_API_KEY_SECRET: SECRET },
      { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_ISV_PRIMARY_PROFILE_SID: "BUshort" },
    ]) {
      expect(await executeStageA({ argv, env, fetchImpl })).toMatchObject({ ok: false, exitCode: 2 });
    }
    expect(calls).toHaveLength(0);
  });
  it("an API key is used as the Basic-auth user (and only the key)", async () => {
    const { fetchImpl, calls } = recorder();
    const out = await executeStageA({ argv: [STAGE_A_CONFIRM_FLAG], env: { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_API_KEY_SID: KEY, TWILIO_API_KEY_SECRET: SECRET }, fetchImpl });
    expect(out.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.method === "GET" && call.authorization === `Basic ${Buffer.from(`${KEY}:${SECRET}`).toString("base64")}`)).toBe(true);
    // a Standard API key cannot read /Accounts (Twilio docs): that endpoint must never be requested with a key
    expect(calls.some((call) => call.url.includes("/Accounts/"))).toBe(false);
    expect(calls[0].url).toBe("https://trusthub.twilio.com/v1/Policies?PageSize=50");
  });
  it("with the auth token (explicit flag only) the account endpoint IS the first check", async () => {
    const { fetchImpl, calls } = recorder();
    await executeStageA({ argv: [STAGE_A_CONFIRM_FLAG, USE_AUTH_TOKEN_FLAG], env: { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_AUTH_TOKEN: TOKEN }, fetchImpl });
    expect(calls[0].url).toContain(`/Accounts/${ACCOUNT}.json`);
    expect(calls[0].authorization).toBe(`Basic ${Buffer.from(`${ACCOUNT}:${TOKEN}`).toString("base64")}`);
  });
  it("REGRESSION (real-world failure): Twilio answers 401 / code 70004 to a Standard key on /Accounts; Stage A with a key no longer asks and completes cleanly", async () => {
    const calls: string[] = [];
    const fetchImpl: ProbeFetch = async (url, init) => {
      calls.push(url);
      expect(init.method).toBe("GET");
      if (url.includes("/Accounts/")) return { status: 401, text: async () => JSON.stringify({ code: 70004, message: "Unauthorized" }) };
      return { status: 200, text: async () => JSON.stringify({ results: [], data: [], sid: DEFAULT_PRIMARY_PROFILE_SID, status: "twilio-approved", policy_sid: `RN${"4".repeat(32)}`, meta: {} }) };
    };
    const out = await executeStageA({ argv: [STAGE_A_CONFIRM_FLAG], env: { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_API_KEY_SID: KEY, TWILIO_API_KEY_SECRET: SECRET }, fetchImpl });
    expect(out).toMatchObject({ ok: true, exitCode: 0 });
    expect(out.text).toContain('"skipped"');
    expect(out.text).toContain('"ok": null');
    expect(calls.some((url) => url.includes("/Accounts/"))).toBe(false);
    expect(calls.length).toBeGreaterThan(4);
  });
  it("a 401 on a Trust Hub read with an API key IS a credential failure: it stops after that one request and says what to check", async () => {
    const calls: string[] = [];
    const fetchImpl: ProbeFetch = async (url) => {
      calls.push(url);
      return { status: 401, text: async () => JSON.stringify({ code: 20003, message: "Permission Denied" }) };
    };
    const out = await executeStageA({ argv: [STAGE_A_CONFIRM_FLAG], env: { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_API_KEY_SID: KEY, TWILIO_API_KEY_SECRET: SECRET }, fetchImpl });
    expect(out).toMatchObject({ ok: true, exitCode: 1 });
    expect(calls).toEqual(["https://trusthub.twilio.com/v1/Policies?PageSize=50"]);
    expect(out.ok && out.problems).toEqual(["policies: account http 401 code 20003"]);
    expect(out.ok && out.hints.join(" ")).toContain("same Twilio account");
  });
  it("with the master token, the report says which method was used and contains no secret", async () => {
    const { fetchImpl } = recorder();
    const out = await executeStageA({
      argv: [STAGE_A_CONFIRM_FLAG, USE_AUTH_TOKEN_FLAG],
      env: { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_AUTH_TOKEN: TOKEN, TW4_VALIDATION_EXPECTED_NAME: "Secret Co LLC", TW4_VALIDATION_EXPECTED_EIN: "11-2223333", TWILIO_ISV_PRIMARY_POLICY_SID: `RN${"4".repeat(32)}` },
      fetchImpl,
    });
    expect(out.ok).toBe(true);
    expect(out.text).toContain('"authMethod": "auth_token"');
    expect(out.text).not.toContain(TOKEN);
    expect(out.text).not.toContain("Secret Co");
    expect(out.text).not.toContain("112223333");
    expect(out.text).not.toContain(Buffer.from(`${ACCOUNT}:${TOKEN}`).toString("base64"));
  });
  it("exit code is 1 when the probe reports a problem", async () => {
    const fetchImpl: ProbeFetch = async () => ({ status: 401, text: async () => JSON.stringify({ code: 20003, message: "Authenticate" }) });
    const out = await executeStageA({ argv: [STAGE_A_CONFIRM_FLAG, USE_AUTH_TOKEN_FLAG], env: { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_AUTH_TOKEN: TOKEN }, fetchImpl });
    expect(out).toMatchObject({ ok: true, exitCode: 1 });
    expect(out.text).toContain("http 401 code 20003");
  });

  it("every credential refusal names the problem and the fix, never the value", async () => {
    const { fetchImpl, calls } = recorder();
    const argv = [STAGE_A_CONFIRM_FLAG];
    const secretLooking = "Zz9" + "q".repeat(29);
    const cases: [Record<string, string>, string][] = [
      [{}, "TWILIO_ACCOUNT_SID is not set"],
      [{ TWILIO_ACCOUNT_SID: "SK" + "1".repeat(32), TWILIO_AUTH_TOKEN: TOKEN }, "TWILIO_ACCOUNT_SID is malformed"],
      [{ TWILIO_ACCOUNT_SID: ACCOUNT }, "no credentials were provided"],
      [{ TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_API_KEY_SID: KEY }, "TWILIO_API_KEY_SECRET is not set"],
      [{ TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_API_KEY_SECRET: secretLooking }, "TWILIO_API_KEY_SECRET is set but TWILIO_API_KEY_SID is not"],
      [{ TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_API_KEY_SID: ACCOUNT, TWILIO_API_KEY_SECRET: secretLooking }, "AC is the Account SID, not the key SID"],
    ];
    for (const [env, expected] of cases) {
      const out = await executeStageA({ argv, env, fetchImpl });
      expect(out).toMatchObject({ ok: false, exitCode: 2 });
      expect(out.text).toContain(expected);
      expect(out.text).toContain("To fix:");
      expect(out.text).not.toContain(secretLooking);
      expect(out.text).not.toContain(TOKEN);
    }
    expect(calls).toHaveLength(0);
  });
  it("a 401 produces an explicit hint about account/region/secret, and a self-test report is marked as such", async () => {
    const accountHint = hintsFor(["account: account http 401 code 70004"])[0];
    expect(accountHint).toContain("code 70004");
    expect(accountHint).toContain("Standard API key cannot access the Accounts resource");
    expect(accountHint).toContain("does NOT mean the key is wrong");
    expect(hintsFor(["policies: account http 401 code 20003"])[0]).toContain("same Twilio account");
    expect(hintsFor(["x: validation http 404 code 20404"])[0]).toContain("404");
    expect(hintsFor([])).toEqual([]);
    const out = await executeStageA({ argv: [STAGE_A_CONFIRM_FLAG], env: { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_API_KEY_SID: KEY, TWILIO_API_KEY_SECRET: SECRET }, fetchImpl: selfTestFetch, selfTest: true });
    expect(out).toMatchObject({ ok: true, exitCode: 0 });
    expect(out.text).toContain('"selfTest": true');
    expect(out.text).not.toContain(SECRET);
    expect(out.text).not.toContain("000000000\"");
  });
  it("the self-test fetch refuses anything but GET and answers only canned data", async () => {
    await expect(selfTestFetch("https://trusthub.twilio.com/v1/Policies", { method: "POST" as "GET", headers: {} })).rejects.toThrow("GET only");
    expect((await selfTestFetch("https://evil.example/x", { method: "GET", headers: {} })).status).toBe(404);
  });
});

describe("--out validation (the cause of the second Stage A attempt: exit code 2 because the report already existed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "tw4-outcheck-"));
  it("refuses an existing report with an explanation that the old file was not updated and how to fix it", () => {
    const existing = join(dir, "report.json");
    writeFileSync(existing, "{}");
    const out = checkOutPath(["--out", existing]);
    expect(out).toMatchObject({ ok: false, exitCode: 2 });
    expect(out.ok ? "" : out.text).toContain("already exists");
    expect(out.ok ? "" : out.text).toContain("NOT updated");
    expect(out.ok ? "" : out.text).toContain("choose a NEW file name");
  });
  it("refuses a missing value, a flag as value, and a missing folder; accepts a new file in an existing folder and no --out at all", () => {
    expect(checkOutPath(["--out"])).toMatchObject({ ok: false, exitCode: 2 });
    expect(checkOutPath(["--out", "--self-test"])).toMatchObject({ ok: false, exitCode: 2 });
    expect(checkOutPath(["--out", join(dir, "nofolder", "x.json")])).toMatchObject({ ok: false, exitCode: 2 });
    expect(checkOutPath(["--out", join(dir, "new.json")])).toEqual({ ok: true, path: join(dir, "new.json") });
    expect(checkOutPath([])).toEqual({ ok: true, path: null });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Stage A never falls back to the master auth token on its own (verification item 4)", () => {
  it("an ambient TWILIO_AUTH_TOKEN alone is refused unless --use-auth-token is passed", async () => {
    const { fetchImpl, calls } = recorder();
    const out = await executeStageA({ argv: [STAGE_A_CONFIRM_FLAG], env: { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_AUTH_TOKEN: TOKEN }, fetchImpl });
    expect(out).toMatchObject({ ok: false, exitCode: 2 });
    expect(out.text).toContain("never falls back to the master token");
    expect(out.text).not.toContain(TOKEN);
    expect(calls).toHaveLength(0);
  });
  it("a key together with an auth token (in the environment or via the flag) is ambiguous and refused", async () => {
    const { fetchImpl, calls } = recorder();
    const key = { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_API_KEY_SID: KEY, TWILIO_API_KEY_SECRET: SECRET };
    expect(await executeStageA({ argv: [STAGE_A_CONFIRM_FLAG], env: { ...key, TWILIO_AUTH_TOKEN: TOKEN }, fetchImpl })).toMatchObject({ ok: false, exitCode: 2 });
    expect(await executeStageA({ argv: [STAGE_A_CONFIRM_FLAG, USE_AUTH_TOKEN_FLAG], env: key, fetchImpl })).toMatchObject({ ok: false, exitCode: 2 });
    expect(calls).toHaveLength(0);
  });
  it("--use-auth-token without a token is refused", async () => {
    const { fetchImpl, calls } = recorder();
    expect(await executeStageA({ argv: [STAGE_A_CONFIRM_FLAG, USE_AUTH_TOKEN_FLAG], env: { TWILIO_ACCOUNT_SID: ACCOUNT }, fetchImpl })).toMatchObject({ ok: false, exitCode: 2 });
    expect(calls).toHaveLength(0);
  });
});

describe("reports distinguish skipped checks from successful ones (verification item 5)", () => {
  it("API key: the account check is listed as NOT performed, with the reason, and its section says skipped rather than ok", async () => {
    const { fetchImpl } = recorder();
    const out = await executeStageA({ argv: [STAGE_A_CONFIRM_FLAG], env: { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_API_KEY_SID: KEY, TWILIO_API_KEY_SECRET: SECRET }, fetchImpl });
    expect(out).toMatchObject({ ok: true, exitCode: 0 });
    expect(out.ok && out.notRun).toEqual([{ section: "account", reason: expect.stringContaining("Standard API keys cannot read /Accounts") }]);
    const report = JSON.parse(out.text) as { account: { ok: unknown; skipped?: string }; notRun: unknown[] };
    expect(report.account.ok).toBeNull(); // null, not true
    expect(report.account.skipped).toContain("Standard API keys");
    expect(report.notRun).toHaveLength(1);
  });
  it("rejected credentials: primary profile and inventory are listed as NOT performed, not as empty successes", async () => {
    const fetchImpl: ProbeFetch = async () => ({ status: 401, text: async () => JSON.stringify({ code: 20003 }) });
    const out = await executeStageA({ argv: [STAGE_A_CONFIRM_FLAG], env: { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_API_KEY_SID: KEY, TWILIO_API_KEY_SECRET: SECRET }, fetchImpl });
    expect(out.ok && out.notRun.map((n) => n.section)).toEqual(["account", "primary_profile", "inventory"]);
    expect(out).toMatchObject({ exitCode: 1 });
  });
  it("auth token: nothing is skipped when everything runs", async () => {
    const { fetchImpl } = recorder();
    const out = await executeStageA({ argv: [STAGE_A_CONFIRM_FLAG, USE_AUTH_TOKEN_FLAG], env: { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_AUTH_TOKEN: TOKEN }, fetchImpl });
    expect(out.ok && out.notRun).toEqual([]);
  });
});
