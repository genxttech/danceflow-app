import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { manifest } from "../manifest";
import { liveRefusals, parseArgs, runProof } from "../run";
import { AUTHORIZATION_PHRASE, ENV } from "../identity";
import type { Transport } from "../types";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const capture = () => {
  const lines: string[] = [];
  return { lines, io: { out: (s: string) => void lines.push(s), sleep: async () => undefined } };
};
const goodEnv = () => ({
  [ENV.key]: "rk_test_FAKEFAKE123",
  [ENV.platform]: "acct_PLATFORMTEST1",
  [ENV.connected]: "acct_CONNECTEDTEST1",
  [ENV.pinnedSha]: manifest(DIR).sha256,
  [ENV.phrase]: AUTHORIZATION_PHRASE,
});

describe("dry run (fake client, no network)", () => {
  it("runs every scenario against the fake, prints the planned call list, stays within the cap and blocks nothing", async () => {
    const c = capture();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const code = await runProof(["--dry-run"], { env: {}, io: c.io });
    const text = c.lines.join("\n");
    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(text).toMatch(/DRY RUN \(fake client, no network\)/);
    const m = /Calls used: (\d+) of hard cap 40; blocked before network: (\d+)/.exec(text);
    expect(Number(m?.[1])).toBeLessThanOrEqual(40);
    expect(Number(m?.[1])).toBeGreaterThan(20);
    expect(m?.[2]).toBe("0");
    expect(text).toMatch(/1\. .*GET \/v1\/account /);
    expect(text).toMatch(/POST \/v1\/invoices /);
    expect(text).toMatch(/add_lines/);
    expect(text).toMatch(/V1: PASS/);
    expect(text).toMatch(/V4: PASS \(Stripe side only\)/);
    expect(text).toMatch(/V7: PASS \(Stripe side only\)/);
    expect(text).toMatch(/"verifiedEmpty":true/);
    for (const verb of ["finalize", "/send", "/pay", "/void", "mark_uncollectible"]) expect(text).not.toContain(verb + " ");
    expect(text).not.toMatch(/FAIL /);
  });
  it("ignores a key present in the environment (never read in dry-run) and does not print it", async () => {
    const c = capture();
    await runProof(["--dry-run"], { env: { [ENV.key]: "rk_test_SHOULDNEVERAPPEAR" }, io: c.io });
    expect(c.lines.join("\n")).not.toContain("SHOULDNEVERAPPEAR");
  });
});

describe("live mode refuses without explicit owner-supplied values", () => {
  it("refuses with an empty environment and sends nothing", async () => {
    const c = capture();
    const live = vi.fn<Transport>();
    const code = await runProof(["--live"], { env: {}, io: c.io, liveTransport: live });
    expect(code).toBe(2);
    expect(live).not.toHaveBeenCalled();
    expect(c.lines.join("\n")).toMatch(/refused: live mode needs every owner-supplied value/);
  });
  for (const [label, mutate] of [
    ["no key", (e: Record<string, string>) => delete e[ENV.key]],
    ["a live key", (e: Record<string, string>) => (e[ENV.key] = "sk_live_ABCDEF123")],
    ["a broad test key", (e: Record<string, string>) => (e[ENV.key] = "sk_test_ABCDEF123")],
    ["no platform id", (e: Record<string, string>) => delete e[ENV.platform]],
    ["no connected id", (e: Record<string, string>) => delete e[ENV.connected]],
    ["a stale pinned hash", (e: Record<string, string>) => (e[ENV.pinnedSha] = "0".repeat(64))],
    ["no pinned hash", (e: Record<string, string>) => delete e[ENV.pinnedSha]],
    ["a wrong approval sentence", (e: Record<string, string>) => (e[ENV.phrase] = "yes")],
    ["a hosted database URL", (e: Record<string, string>) => (e.DATABASE_URL = "postgres://u:p@db.x.supabase.co:5432/postgres")],
  ] as const) {
    it(`refuses with ${label}`, async () => {
      const env = goodEnv() as Record<string, string>;
      mutate(env);
      const c = capture();
      const live = vi.fn<Transport>();
      expect(await runProof(["--live"], { env, io: c.io, liveTransport: live })).toBe(2);
      expect(live).not.toHaveBeenCalled();
      expect(c.lines.join("\n")).not.toMatch(/ABCDEF123/);
    });
  }
  it("accepts a fully valid owner environment (checked without sending anything)", () => {
    expect(liveRefusals(goodEnv(), DIR).problems).toEqual([]);
  });
  it("a valid live environment runs through the injected transport only, with allow-listed calls and the hard cap", async () => {
    const calls: string[] = [];
    const { createFakeTransport } = await import("../fakeTransport");
    const f = createFakeTransport({ platformId: "acct_PLATFORMTEST1", connectedId: "acct_CONNECTEDTEST1" });
    const spyTransport: Transport = async (req, key) => {
      calls.push(`${req.method} ${req.path}`);
      expect(key).toBe("rk_test_FAKEFAKE123");
      return f.transport(req, key);
    };
    const c = capture();
    const code = await runProof(["--live"], { env: goodEnv(), io: c.io, liveTransport: spyTransport, runId: "abcd1234" });
    expect(code).toBe(0);
    expect(calls.length).toBeLessThanOrEqual(40);
    expect(calls.join("\n")).not.toMatch(/finalize|\/send|\/pay|\/void|mark_uncollectible/);
    expect(c.lines.join("\n")).not.toContain("rk_test_FAKEFAKE123");
  });
});

describe("arguments", () => {
  it("accepts exactly one known flag and nothing positional (so no key can be passed on the command line)", () => {
    expect(parseArgs(["--dry-run"])).toEqual({ ok: true, flag: "--dry-run" });
    expect(parseArgs([])).toMatchObject({ ok: false });
    expect(parseArgs(["--dry-run", "--live"])).toMatchObject({ ok: false });
    expect(parseArgs(["--key=rk_test_abc"])).toMatchObject({ ok: false });
    expect(parseArgs(["--live", "rk_test_abc"])).toMatchObject({ ok: false });
    const bad = parseArgs(["--key=rk_test_abc"]);
    expect(JSON.stringify(bad)).not.toContain("rk_test_abc");
  });
});

describe("script identity and hygiene", () => {
  it("the manifest hash is stable and covers every file in the directory", () => {
    const a = manifest(DIR);
    expect(manifest(DIR).sha256).toBe(a.sha256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.files.map((f) => f.path)).toEqual(expect.arrayContaining(["run.ts", "allowlist.ts", "guarded.ts", "__tests__/allowlist.test.ts", "README.md"]));
  });
  it("sources import no Stripe SDK, read no file for a key, and never read the key outside the live branch", () => {
    const sources = readdirSync(DIR).filter((f) => f.endsWith(".ts"));
    for (const f of sources) {
      const code = readFileSync(join(DIR, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/from\s+["']stripe["']|require\(["']stripe/);
      if (f !== "manifest.ts") expect(code, f).not.toMatch(/readFileSync|readFile\b|createReadStream/);
      expect(code, f).not.toMatch(/process\.env\.STRIPE|STRIPE_SECRET_KEY\s*\]/);
    }
    const run = readFileSync(join(DIR, "run.ts"), "utf8");
    // exactly two reads, both inside liveRefusals / the live branch; dry-run never reads the key
    expect(run.match(/env\[ENV\.key\]/g)?.length).toBe(2);
    expect(run.slice(run.indexOf("if (live) {"), run.indexOf("} else {", run.indexOf("if (live) {")))).toContain("env[ENV.key]");
  });
  it("is not imported from application code", () => {
    let hits = "";
    try {
      hits = execFileSync("git", ["grep", "-l", "d24-m3d-proof", "--", "src"], { cwd: join(DIR, "..", "..", "..") }).toString();
    } catch (e) {
      // git grep exits 1 when nothing matches, which is the expected result
      expect((e as { status?: number }).status).toBe(1);
    }
    expect(hits).toBe("");
  });
});
