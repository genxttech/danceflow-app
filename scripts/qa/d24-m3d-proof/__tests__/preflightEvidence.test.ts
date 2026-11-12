import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { EVIDENCE_ENV, evidenceDirProblem, maskAccountIds, sanitize, writeEvidence } from "../evidence";
import { createFakeTransport } from "../fakeTransport";
import { AUTHORIZATION_PHRASE, ENV } from "../identity";
import { manifest } from "../manifest";
import { runPreflight } from "../preflight";
import { runProof } from "../run";
import type { Transport } from "../types";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(DIR, "..", "..", "..");
const PLATFORM = "acct_1PlatformABCDEF1234";
const CONNECTED = "acct_1ConnectedABCDEF5678";
// built at run time so no secret-shaped literal exists in the repository (GitHub push protection rightly flags realistic-looking keys)
const KEY = ["rk", "test", "REALLOOKINGKEY9876543210"].join("_");
const good = (over: Record<string, string> = {}): Record<string, string> => ({
  [ENV.key]: KEY, [ENV.platform]: PLATFORM, [ENV.connected]: CONNECTED, [ENV.pinnedSha]: manifest(DIR).sha256, [ENV.phrase]: AUTHORIZATION_PHRASE, ...over,
});
const dockerNone = async () => ({ available: true, rows: [] as string[] });
const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "d24proof-")); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
const cap = () => { const lines: string[] = []; return { lines, io: { out: (s: string) => void lines.push(s), sleep: async () => undefined } }; };

describe("preflight (local checks only)", () => {
  const byId = (cs: Awaited<ReturnType<typeof runPreflight>>) => Object.fromEntries(cs.map((c) => [c.id, c]));
  it("a valid environment with no QA container passes every local check and lists the owner-only items as MANUAL, never as passed", async () => {
    const c = byId(await runPreflight(good(), DIR, dockerNone));
    for (const id of ["node", "owner-values", "fixture-synthetic-email", "version-pin", "call-cap", "local-postgres"]) expect(c[id].status, id).toBe("ok");
    for (const id of ["sandbox", "connected-account", "key-permissions", "no-webhooks", "api-version"]) expect(c[id].status, id).toBe("manual");
    expect(c.sandbox.detail).toContain("DanceFlow D24-M3 TEST");
  });
  it("fails on missing owner values, an old node, and a stale hash pin", async () => {
    expect(byId(await runPreflight({}, DIR, dockerNone))["owner-values"].status).toBe("fail");
    expect(byId(await runPreflight(good(), DIR, dockerNone, "18.19.0")).node.status).toBe("fail");
    expect(byId(await runPreflight(good({ [ENV.pinnedSha]: "0".repeat(64) }), DIR, dockerNone))["owner-values"].status).toBe("fail");
  });
  it("a labelled QA container with a published port or a network is a FAIL; none/none passes; docker unreachable is MANUAL, not ok", async () => {
    const probe = (rows: string[], available = true) => async () => ({ available, rows });
    expect(byId(await runPreflight(good(), DIR, probe(["abc|0.0.0.0:5432->5432/tcp|none"])))["local-postgres"].status).toBe("fail");
    expect(byId(await runPreflight(good(), DIR, probe(["abc||bridge"])))["local-postgres"].status).toBe("fail");
    expect(byId(await runPreflight(good(), DIR, probe(["abc||none"])))["local-postgres"].status).toBe("ok");
    expect(byId(await runPreflight(good(), DIR, probe([], false)))["local-postgres"].status).toBe("manual");
  });
  it("never prints the key", async () => {
    const c = cap();
    await runProof(["--preflight"], { env: good(), io: c.io, docker: dockerNone });
    expect(c.lines.join("\n")).not.toContain("REALLOOKINGKEY");
  });
  it("a live run refuses on a failing preflight check and sends nothing", async () => {
    const live = vi.fn<Transport>();
    const c = cap();
    const bad = async () => ({ available: true, rows: ["abc|0.0.0.0:5432->5432/tcp|bridge"] });
    expect(await runProof(["--live"], { env: good(), io: c.io, liveTransport: live, docker: bad })).toBe(2);
    expect(live).not.toHaveBeenCalled();
    expect(c.lines.join("\n")).toMatch(/preflight local-postgres/);
  });
});

describe("evidence handling and redaction", () => {
  it("accepts only an absolute directory outside the repository", () => {
    expect(evidenceDirProblem(undefined, REPO)).toBeNull();
    expect(evidenceDirProblem(tmpdir(), REPO)).toBeNull();
    expect(evidenceDirProblem("relative/dir", REPO)).toMatch(/absolute/);
    expect(evidenceDirProblem(REPO, REPO)).toMatch(/outside the repository/);
    expect(evidenceDirProblem(join(REPO, "scripts", "evidence"), REPO)).toMatch(/outside the repository/);
  });
  it("sanitize removes keys, webhook secrets, Authorization headers and emails, and masks account ids", () => {
    const s = sanitize(`Authorization: Bearer ${KEY}\nkey ${KEY} whsec_ABCDEF123 mail jo@example.com sk_live_ZZZ9 ${CONNECTED}`);
    for (const secret of ["REALLOOKINGKEY", "whsec_ABCDEF123", "jo@example.com", "sk_live_ZZZ9", "Bearer", CONNECTED]) expect(s, secret).not.toContain(secret);
    expect(maskAccountIds(CONNECTED)).toBe("acct_1Co…78");
    // short ids are masked too, and never revealed whole
    expect(maskAccountIds("acct_123456")).toBe("acct_12…");
    expect(maskAccountIds("acct_12345678")).toBe("acct_12…");
    expect(maskAccountIds("acct_1AbCdEfGhIjKlMn")).toBe("acct_1Ab…Mn");
  });
  it("a live run (fake transport) writes a redacted pack: no key, no Authorization, no full idempotency key, no full account ids", async () => {
    const dir = tmp();
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED });
    const c = cap();
    const code = await runProof(["--live"], { env: good({ [EVIDENCE_ENV]: dir }), io: c.io, liveTransport: f.transport, docker: dockerNone, runId: "ev000001", now: () => new Date("2026-11-06T12:00:00Z") });
    expect(code).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(["evidence-ev000001.json", "transcript-ev000001.txt"]);
    for (const name of readdirSync(dir)) {
      const text = readFileSync(join(dir, name), "utf8");
      for (const forbidden of ["REALLOOKINGKEY", "Authorization", "Bearer", "whsec_", PLATFORM, CONNECTED]) expect(text, `${name} contains ${forbidden}`).not.toContain(forbidden);
      expect(text).not.toMatch(/d24proof-ev000001-inv-A\b/); // idempotency keys are masked to 12 characters
    }
    const ev = JSON.parse(readFileSync(join(dir, "evidence-ev000001.json"), "utf8"));
    expect(ev).toMatchObject({ runId: "ev000001", mode: "live", stripeApiVersionPinned: expect.any(String), abort: null });
    expect(ev.callsUsed).toBeLessThanOrEqual(40);
    expect(ev.stripeApiVersionsReportedByStripe).toHaveLength(1);
    expect(ev.accountDefaultApiVersion).toMatch(/RECORD BY HAND/);
    expect(ev.scriptManifestSha256).toBe(manifest(DIR).sha256);
    // the terminal carries the same sanitised text: no key, no header, no full account id
    expect(c.lines.join("\n")).not.toContain(CONNECTED);
    expect(c.lines.join("\n")).not.toContain(PLATFORM);
    expect(c.lines.join("\n")).not.toContain("REALLOOKINGKEY");
    expect(ev.outcome).toBe("OK");
  });
  it("an evidence directory inside the repository is refused before any call (dry run and live)", async () => {
    const inside = join(REPO, "scripts", "qa", "evidence-should-not-exist");
    const live = vi.fn<Transport>();
    const a = cap();
    expect(await runProof(["--live"], { env: good({ [EVIDENCE_ENV]: inside }), io: a.io, liveTransport: live, docker: dockerNone })).toBe(2);
    expect(live).not.toHaveBeenCalled();
    const b = cap();
    expect(await runProof(["--dry-run"], { env: { [EVIDENCE_ENV]: inside }, io: b.io })).toBe(2);
  });
  it("writeEvidence sanitises even a hostile payload", () => {
    const dir = tmp();
    const files = writeEvidence(dir, {
      runId: "ev000002", mode: "dry-run", outcome: "FAILED", scriptSha256: "a".repeat(64), apiVersionPinned: "v", apiVersionsReported: [], callsUsed: 1, blocked: 0, scenarios: [], verdicts: {},
      cleanup: { note: `leak ${KEY} jo@example.com` }, abort: { code: "x", message: `Authorization: Bearer ${KEY}` }, transcriptText: `line ${KEY} ${CONNECTED}`, finishedUtc: "t",
    }, REPO);
    for (const p of [files.json, files.transcript]) {
      const t = readFileSync(p, "utf8");
      expect(t).not.toMatch(/REALLOOKINGKEY|jo@example\.com|Bearer/);
      expect(t).not.toContain(CONNECTED);
    }
  });
});
