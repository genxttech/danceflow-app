// Round 3 of the PR #419 review (R1, R2, R3): the runner's own HTTPS request and process environment, and re-hashing around every spawn that holds the key.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import tls from "node:tls";
import { join } from "node:path";
import https from "node:https";
import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../credstore";

class SpyStore extends MemoryStore {
  reads = 0;
  override async read(label: string) {
    this.reads++;
    return super.read(label);
  }
}
import { processEnvProblems } from "../envguard";
import { createFakeExec } from "../fakeChild";
import { manifest } from "../../d24-m3d-proof/manifest";
import { makeGet, nodeTip, requestSecurityOptions } from "../remotetip";
import { runEnvelope, type RunnerDeps } from "../runner";
import { heldUnchanged, runnerManifest } from "../runnerpin";
import { KEY, LABEL, makeEnvelope, mkLedger, NOW, REPO, SHA, tmp, writeEnvelope } from "./helpers";
import { makeAssertion, testAuth } from "./softauth";
import { join as pj } from "node:path";

describe("R1: the tip request does not obey the process environment", () => {
  it("uses its own agent, node's bundled roots only, and forced certificate verification", () => {
    const o = requestSecurityOptions();
    expect(o.rejectUnauthorized).toBe(true);
    expect(o.ca).toEqual([...tls.rootCertificates]);
    expect(o.ca.length).toBeGreaterThan(10);
    const ao = (o.agent as unknown as { options: { rejectUnauthorized?: boolean; ca?: unknown[]; keepAlive?: boolean } }).options;
    expect(ao.rejectUnauthorized).toBe(true);
    expect(ao.ca?.length).toBe(o.ca.length);
    expect(ao.keepAlive).toBe(false);
    expect(o.agent).not.toBe((globalThis as { __g?: unknown }).__g);
  });

  it("the real https request is made with exactly those options (agent, bundled roots, verification on)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(https, "request").mockImplementation(((_u: unknown, opts: Record<string, unknown>) => {
      seen.push(opts);
      throw new Error("stop: no network in this test");
    }) as unknown as typeof https.request);
    try {
      await makeGet(1000)(new URL("https://example.invalid/o/r.git/info/refs")).catch(() => undefined);
    } finally {
      spy.mockRestore();
    }
    expect(seen.length).toBe(1);
    expect(seen[0].rejectUnauthorized).toBe(true);
    expect(Array.isArray(seen[0].ca) && (seen[0].ca as unknown[]).length > 10).toBe(true);
    expect(seen[0].agent).toBeInstanceOf(https.Agent);
  });

  it("source: no environment variable is read by the request code", () => {
    const src = readFileSync(join(__dirname, "..", "remotetip.ts"), "utf8");
    expect(src).not.toMatch(/process\.env/);
    expect(src).toMatch(/rejectUnauthorized: true/);
  });
});

describe("R1: live runs refuse to start with proxy, CA, TLS or NODE_OPTIONS overrides", () => {
  it("flags each variable and node flag; a clean environment passes", () => {
    expect(processEnvProblems({ PATH: "x", SystemRoot: "C:\\Windows" })).toEqual([]);
    for (const name of ["NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "NODE_TLS_MIN_VERSION", "MY_CORP_PROXY"]) {
      const p = processEnvProblems({ PATH: "x", [name]: name === "NODE_TLS_REJECT_UNAUTHORIZED" ? "0" : "1" });
      expect(p.length, name).toBeGreaterThan(0);
      expect(p.join(" "), name).toContain(name);
    }
    for (const f of ["--use-env-proxy", "--use-system-ca", "--use-openssl-ca", "--openssl-config=x", "--tls-min-v1.0"]) expect(processEnvProblems({}, [f]).length, f).toBeGreaterThan(0);
    expect(processEnvProblems({}, ["--require", "x", "--import", "file:///loader.mjs"])).toEqual([]); // tsx's own launcher flags are not a problem
  });

  async function go(parentEnv: Record<string, string>, dry = false) {
    const dir = tmp();
    const env = makeEnvelope({ evidenceRoot: join(dir, "evidence") });
    const file = writeEnvelope(env);
    const anchorPath = join(dir, "owner-hw-anchor.json");
    writeFileSync(anchorPath, JSON.stringify(testAuth.anchor));
    const ledger = mkLedger();
    const store = new SpyStore();
    await store.write(LABEL, KEY);
    const deps: RunnerDeps = {
      exec: createFakeExec({ commitSha: SHA, repoDir: REPO }, { simulateLive: !dry }),
      parentEnv,
      store: () => store,
      ledger,
      now: () => NOW,
      out: () => undefined,
      dry,
      dryKey: dry ? KEY : undefined,
      runInstall: true,
      owner: { trust: null, signature: null, hardware: { doc: makeAssertion(testAuth, env.envelopeSha256, { signCount: 5 }), anchorPath, statePath: join(dir, "state", "hw.json"), pins: { ledgerDir: ledger.dir, anchorFile: ledger.anchorFile as string } } },
    };
    const r = await runEnvelope(file, REPO, deps);
    return { r, store, ledger, env };
  }

  it("a live run with HTTPS_PROXY / NODE_EXTRA_CA_CERTS / NODE_OPTIONS in the environment is BLOCKED at process-environment, before approval, credential and network", async () => {
    for (const bad of [{ HTTPS_PROXY: "http://127.0.0.1:9" }, { NODE_EXTRA_CA_CERTS: "C:\\evil.pem" }, { NODE_OPTIONS: "--require x.js" }, { NODE_TLS_REJECT_UNAUTHORIZED: "0" }]) {
      const t = await go({ PATH: "C:\\bin", SystemRoot: "C:\\Windows", ...(bad as unknown as Record<string, string>) });
      expect(t.r.status, JSON.stringify(bad)).toBe("BLOCKED");
      expect(t.r.gates.find((g) => !g.ok)?.id).toBe("process-environment");
      expect(t.r.gates.some((g) => g.id === "owner-approval" || g.id === "credential")).toBe(false);
      expect(t.store.reads).toBe(0);
    }
  });

  it("a clean environment passes the gate; a DRY run does not need it", async () => {
    const live = await go({ PATH: "C:\\bin", SystemRoot: "C:\\Windows" });
    expect(live.r.gates.find((g) => g.id === "process-environment")?.ok).toBe(true);
    const dry = await go({ PATH: "C:\\bin", SystemRoot: "C:\\Windows", HTTPS_PROXY: "x" }, true);
    expect(dry.r.gates.some((g) => g.id === "process-environment")).toBe(false);
  });
});

describe("R3: absolute deadline on the tip request", () => {
  it("a server that drips bytes forever is cut off at the deadline (an idle timeout would never fire)", async () => {
    const server = http.createServer((_q, res) => {
      res.writeHead(200, { "Content-Type": "application/x-git-upload-pack-advertisement" });
      const t = setInterval(() => res.write("0"), 50);
      res.on("close", () => clearInterval(t));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const t0 = Date.now();
      const r = await nodeTip(`http://127.0.0.1:${(server.address() as AddressInfo).port}/o/r.git`, "refs/heads/main", makeGet(400));
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.why).toMatch(/deadline/);
      expect(Date.now() - t0).toBeLessThan(5000);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});

describe("R2: the proof and runner folders are re-hashed from disk around every spawn that holds the key", () => {
  it("heldUnchanged sees a same-length rewrite with the mtime restored (no stat cache anywhere)", () => {
    const dir = tmp();
    const proof = join(dir, "proof");
    const runner = join(dir, "runner");
    mkdirSync(proof);
    mkdirSync(runner);
    writeFileSync(join(proof, "a.ts"), "export const x = 1111;\n");
    writeFileSync(join(runner, "b.ts"), "export const y = 2222;\n");
    const held = { proofSha: manifest(proof).sha256, runnerSha: runnerManifest(runner).sha256 };
    const dirs = { proofDir: proof, runnerDir: runner };
    expect(heldUnchanged(dirs, held)).toBe(true);
    const st = statSync(join(proof, "a.ts"));
    writeFileSync(join(proof, "a.ts"), "export const x = 9999;\n");
    utimesSync(join(proof, "a.ts"), st.atime, st.mtime);
    expect(heldUnchanged(dirs, held)).toBe(false);
    writeFileSync(join(proof, "a.ts"), "export const x = 1111;\n");
    expect(heldUnchanged(dirs, held)).toBe(true);
    chmodSync(join(runner, "b.ts"), 0o644);
    writeFileSync(join(runner, "b.ts"), "export const y = 3333;\n");
    expect(heldUnchanged(dirs, held)).toBe(false);
    expect(heldUnchanged({ proofDir: join(dir, "missing"), runnerDir: runner }, held)).toBe(false);
  });

  it("a passing live run has the re-hash gates in this order: ...dry-run, BEFORE preflight, preflight, AFTER preflight, recheck, window, ... live, AFTER live", async () => {
    const dir = tmp();
    const env = makeEnvelope({ evidenceRoot: join(dir, "evidence") });
    const file = writeEnvelope(env);
    const anchorPath = join(dir, "owner-hw-anchor.json");
    writeFileSync(anchorPath, JSON.stringify(testAuth.anchor));
    const ledger = mkLedger();
    const store = new SpyStore();
    await store.write(LABEL, KEY);
    const r = await runEnvelope(file, REPO, {
      exec: createFakeExec({ commitSha: SHA, repoDir: REPO }, { simulateLive: true }),
      parentEnv: { PATH: "C:\\bin", SystemRoot: "C:\\Windows" },
      store: () => store,
      ledger,
      now: () => NOW,
      out: () => undefined,
      dry: false,
      runInstall: true,
      owner: { trust: null, signature: null, hardware: { doc: makeAssertion(testAuth, env.envelopeSha256, { signCount: 5 }), anchorPath, statePath: pj(dir, "state", "hw.json"), pins: { ledgerDir: ledger.dir, anchorFile: ledger.anchorFile as string } } },
    });
    expect(r.status).toBe("PASS");
    const ids = r.gates.map((g) => g.id);
    const at = (id: string) => ids.indexOf(id);
    for (const id of ["held-hashes-before-preflight", "held-hashes-after-preflight", "held-hashes-recheck", "held-hashes-after-live"]) expect(r.gates.find((g) => g.id === id)?.ok, id).toBe(true);
    expect(at("proof-dry-run")).toBeLessThan(at("held-hashes-before-preflight"));
    expect(at("held-hashes-after-preflight")).toBe(at("held-hashes-before-preflight") + 1);
    expect(at("held-hashes-after-preflight")).toBeLessThan(at("held-hashes-recheck"));
    expect(at("held-hashes-recheck")).toBeLessThan(at("held-hashes-after-live"));
  });

  it("source: the live spawn is followed by a re-hash that downgrades the run to UNVERIFIABLE when the folders changed", () => {
    const src = readFileSync(join(__dirname, "..", "runner.ts"), "utf8");
    const iLive = src.indexOf("await proofLive(");
    const iAfter = src.indexOf("const heldAfterLive = heldNow()", iLive);
    expect(iAfter).toBeGreaterThan(iLive);
    expect(src.slice(iAfter, iAfter + 4000)).toMatch(/UNVERIFIABLE/);
    const iPre = src.indexOf("await proofPreflight(");
    expect(src.lastIndexOf("held-hashes-before-preflight", iPre)).toBeGreaterThan(src.lastIndexOf("await proofDryRun(", iPre));
  });
});
