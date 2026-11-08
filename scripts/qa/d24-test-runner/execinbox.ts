// The scheduled-task entry point: runs as the unprivileged `d24run` account, FROM the install root, and is the only producer of the "verified installed
// root" brand that lets runEnvelope use the real executor. Gate order is fixed (docs/billing/D24-TEST-RUNNER-TRUST-ANCHOR.md section 3.2):
//   run id -> install-root path -> policy parse -> identity (SID) -> node binary -> temp isolation -> owner+DACL of EVERY object under the root -> release
//   record -> tree hash (runner, proof, lockfile, package.json, tsconfig, node_modules) -> policy hash -> anchor -> inbox copy -> envelope vs policy.
// Then runEnvelope performs the hardware assertion check (the existing #419 verifier) against the INSTALLED anchor and the counter in state\.
// Nothing here talks to Stripe; the key is read by runEnvelope through the d24run-only store only after every gate passed.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { manifest } from "../d24-m3d-proof/manifest";
import type { CredentialStore } from "./credstore";
import { checkEnvelopeWindow, type Envelope } from "./envelope";
import type { Exec } from "./exec";
import { fingerprintOfFile } from "./fingerprint";
import { ADMIN_NODE, aclGate, lockedTreeGate, parseRelease, readJson, rootPathGate, verifyInstalledTree, type AclReader, type Gate, type InstalledRun, type Layout, type Release } from "./installroot";
import { markVerifiedInstalled } from "./installmint";
import { ASSERTION_FILE, ENVELOPE_FILE, MAX_INBOX_FILE_BYTES, RUN_ID_RE } from "./launcher";
import { Ledger } from "./ledger";
import { clampEnvelopeToPolicy, parsePolicy, policySha256, proofHardCap, proofMaxLineCents, type Policy } from "./policy";
import { runEnvelope, type RunnerDeps, type RunResult } from "./runner";
import { isRealDir, readFileNoFollow } from "./safefs";
import { loadAnchor, type HardwareAnchor, type HardwareApprovalDoc } from "./webauthn";

export type ExecInboxDeps = {
  layout: Layout;
  /** the file of the code that is running (import.meta.url's path in production) */
  runningFile: string;
  acl: AclReader;
  /** SID of the account this process runs as (production: `whoami /user`) */
  currentSid(): string;
  /** production: process.execPath; must equal ADMIN_NODE and be administrator-only */
  execPath: string;
  /** production: os.tmpdir(); must be <root>\state\tmp so a shared writable TEMP cannot hold a poisoned tsx cache */
  tmpdir(): string;
  /** production: process.env. The task action sets TSX_DISABLE_CACHE=1 BEFORE tsx loads; this gate is the after-the-fact consistency check. */
  env: Record<string, string | undefined>;
  now(): Date;
  out(line: string): void;
  realpath?: (p: string) => string;
  isLink?: (p: string) => boolean;
};
export type Verified = { ok: true; gates: Gate[]; installed: InstalledRun; policy: Policy; release: Release; anchor: HardwareAnchor; envelope: Envelope; envelopePath: string; hardwareDoc: unknown; workDir: string; ledger: Ledger };
export type NotVerified = { ok: false; gates: Gate[] };

const sha12 = (s: string) => s.slice(0, 12);
const lc = (p: string) => resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export async function verifyInstalled(runId: string, d: ExecInboxDeps): Promise<Verified | NotVerified> {
  const gates: Gate[] = [];
  const gate = (id: string, ok: boolean, detail: string): boolean => {
    gates.push({ id, ok, detail });
    d.out(`${ok ? "PASS" : "FAIL"}  ${id}: ${detail}`);
    return ok;
  };
  const l = d.layout;
  let workDir: string | null = null;
  const stop = (): NotVerified => {
    if (workDir) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* state\ is d24run-only; the next run's ACL gate flags anything left behind */
      }
    }
    return { ok: false, gates };
  };

  if (!gate("run-id", RUN_ID_RE.test(runId), "run id has the expected shape")) return stop();

  // 1. the running code and the root are real and inside the install root
  const rp = rootPathGate(l, d.runningFile, d.realpath, d.isLink);
  if (!gate(rp.id, rp.ok, rp.detail)) return stop();

  // 2. policy structure (not yet trusted: the ACL, release and hash gates below decide that)
  let polRaw: unknown;
  try {
    polRaw = readJson(l.policyJson);
  } catch {
    gate("policy", false, "policy.json is missing or not valid JSON");
    return stop();
  }
  const cap = proofHardCap(l.proofDir);
  if (cap === null) {
    gate("policy", false, "the installed proof's HARD_CALL_CAP is unreadable");
    return stop();
  }
  const pp = parsePolicy(polRaw, cap);
  if (!gate("policy", pp.ok, pp.ok ? "policy.json parses and every ceiling is within the proof's hard cap" : pp.problems.join(" | ")) || !pp.ok) return stop();
  const policy = pp.policy;
  const who = { runAsSid: policy.runAsSid, ownerSid: policy.ownerSid };

  // 3. who runs, on what binary, with what temp directory
  if (!gate("identity", d.currentSid() === policy.runAsSid, "running as the policy's run-as SID")) return stop();
  const nodeOk = lc(d.execPath) === lc(ADMIN_NODE);
  if (!gate("node-binary", nodeOk, nodeOk ? `running under ${ADMIN_NODE}` : `node is ${d.execPath}, not the fixed administrator-only binary`)) return stop();
  const na = await lockedTreeGate("node-binary-acl", d.execPath, false, d.acl, who);
  if (!gate(na.id, na.ok, na.detail)) return stop();
  if (!gate("tsx-no-cache", d.env.TSX_DISABLE_CACHE === "1", d.env.TSX_DISABLE_CACHE === "1" ? "TSX_DISABLE_CACHE=1: no compile cache is read" : "TSX_DISABLE_CACHE=1 is not set by the task action: a poisoned tsx cache could have run before any gate")) return stop();
  const tmpOk = lc(d.tmpdir()) === lc(l.tmp) || lc(d.tmpdir()).startsWith(`${lc(l.tmp)}/`);
  if (!gate("temp-isolation", tmpOk, tmpOk ? "TEMP is <root>\\state\\tmp (d24run-only): no shared tsx cache" : `TEMP is ${d.tmpdir()}, not ${l.tmp}`)) return stop();

  // 4. the OS-level protection of the whole root: owner and DACL of every directory and file, fail closed
  const ag = await aclGate(l, d.acl, who);
  if (!gate(ag.id, ag.ok, ag.detail)) return stop();

  // 5. release record, tree hash, policy hash
  let rel: Release;
  try {
    const pr = parseRelease(readJson(l.releaseJson));
    if (!pr.ok) {
      gate("release-record", false, pr.problem);
      return stop();
    }
    rel = pr.release;
  } catch {
    gate("release-record", false, "release.json is missing or not valid JSON");
    return stop();
  }
  gate("release-record", true, `commit ${sha12(rel.commit)}, PR #${rel.prNumber}, installed ${rel.installedAtUtc}`);
  const tg = verifyInstalledTree(l, rel);
  if (!gate(tg.id, tg.ok, tg.detail)) return stop();
  if (!gate("policy-hash", policySha256(policy) === rel.policySha256, "policy.json equals the policy hash recorded by the installer")) return stop();

  // 6. anchor: parsed, byte-identical to what the installer recorded, and the policy's pin
  const la = loadAnchor(l.anchorJson);
  if (la === null || !la.ok) {
    gate("anchor", false, la === null ? "anchor.json is missing" : `anchor.json is invalid: ${la.problems.join("; ")}`);
    return stop();
  }
  const anchorOk = la.sha256 === rel.anchorSha256 && la.anchor.fingerprintSha256 === policy.anchorFingerprint;
  if (!gate("anchor", anchorOk, anchorOk ? `anchor ${la.anchor.fingerprintSha256.slice(0, 16)} equals the release record and the policy pin` : "anchor.json differs from the release record or the policy pin")) return stop();

  // 7. read the inbox files without following links and write PRIVATE copies; everything below reads only the copies. Cleaned on every failure path.
  const inboxRun = join(l.inbox, runId);
  workDir = join(l.state, "work", `${runId}-${randomBytes(6).toString("hex")}`);
  const bufs: Record<string, Buffer | null> = {};
  if (isRealDir(inboxRun)) for (const f of [ENVELOPE_FILE, ASSERTION_FILE]) bufs[f] = readFileNoFollow(join(inboxRun, f), MAX_INBOX_FILE_BYTES);
  if (!isRealDir(inboxRun) || !bufs[ENVELOPE_FILE] || !bufs[ASSERTION_FILE]) {
    gate("inbox-copy", false, "the inbox run directory is missing, a link, or lacks a regular, small envelope.json and assertion.hw.json");
    return stop();
  }
  try {
    mkdirSync(workDir, { recursive: true });
    for (const f of [ENVELOPE_FILE, ASSERTION_FILE]) writeFileSync(join(workDir, f), bufs[f]!, { flag: "wx" });
  } catch {
    gate("inbox-copy", false, "the private work copy could not be written");
    return stop();
  }
  gate("inbox-copy", true, "envelope and assertion read without following links and copied to a private directory; only the copies are read from here on");
  const envelopePath = join(workDir, ENVELOPE_FILE);
  let envRaw: unknown;
  let hardwareDoc: unknown;
  try {
    envRaw = JSON.parse(readFileSync(envelopePath, "utf8"));
    hardwareDoc = JSON.parse(readFileSync(join(workDir, ASSERTION_FILE), "utf8"));
  } catch {
    gate("inbox-parse", false, "envelope or assertion is not valid JSON");
    return stop();
  }
  const fp = fingerprintOfFile(envRaw);
  if (!gate("envelope", fp.ok, fp.ok ? `envelope ${fp.fingerprint} valid, canonical hash recomputed` : fp.why) || !fp.ok) return stop();
  const env = fp.envelope;
  const win = checkEnvelopeWindow(env, d.now());
  if (!gate("envelope-window", win.length === 0, win.length === 0 ? `valid until ${env.expiresUtc}` : win.map((i) => `${i.code}: ${i.detail}`).join(" | "))) return stop();

  // 8. every ceiling: the envelope may equal or narrow the policy, never widen it
  let ledger: Ledger;
  let runsToday: number;
  try {
    ledger = new Ledger(join(l.state, "ledger"), d.now, join(l.state, "ledger-anchor.json"));
    const since = d.now().getTime() - 24 * 3600_000;
    runsToday = ledger.load().filter((e) => e.type === "run-start" && Date.parse(e.atUtc) > since).length;
  } catch (e) {
    gate("ledger", false, `state\\ledger could not be opened or verified: ${String((e as Error).message).slice(0, 120)}`);
    return stop();
  }
  const evRoot = lc(l.evidence);
  const issues = clampEnvelopeToPolicy(env, policy, {
    proofManifestSha256: manifest(l.proofDir).sha256,
    proofMaxLineCents: proofMaxLineCents(l.proofDir),
    evidenceRootAllowed: (p) => {
      const n = lc(p);
      return n === evRoot || n.startsWith(`${evRoot}/`);
    },
    runsToday,
  });
  if (!gate("policy-clamp", issues.length === 0, issues.length === 0 ? "the envelope is within every policy ceiling" : issues.join(" | "))) return stop();

  const installed = markVerifiedInstalled({
    layout: l,
    release: rel,
    anchorPath: l.anchorJson,
    statePath: join(l.state, "hw-signcount.json"),
    ledgerDir: join(l.state, "ledger"),
    ledgerAnchorFile: join(l.state, "ledger-anchor.json"),
    verifyTree: () => verifyInstalledTree(l, rel),
  });
  return { ok: true, gates, installed, policy, release: rel, anchor: la.anchor, envelope: env, envelopePath, hardwareDoc, workDir, ledger };
}

export type RunInstalledDeps = ExecInboxDeps & {
  /** production: realExec. Tests: a simulated-live fake. */
  exec: Exec;
  /** production: a DpapiFileStore rooted at <root>\cred, constructed by the caller under d24run */
  store: () => CredentialStore;
  parentEnv: Record<string, string | undefined>;
  /** the tsx CLI inside the installed release (node_modules is installed and hashed by the elevated installer) */
  tsxCli?: string;
  gitBin?: string;
};

export async function runInstalled(runId: string, d: RunInstalledDeps): Promise<{ verified: Verified | NotVerified; result: RunResult | null }> {
  const v = await verifyInstalled(runId, d);
  if (!v.ok) {
    d.out("BLOCKED: nothing was sent to Stripe and no run was consumed.");
    return { verified: v, result: null };
  }
  const deps: RunnerDeps = {
    exec: d.exec,
    // the proof's tsx must not use a shared TEMP (cache poisoning): children get <root>\state\tmp
    parentEnv: { ...d.parentEnv, TEMP: v.installed.layout.tmp, TMP: v.installed.layout.tmp },
    store: d.store,
    ledger: v.ledger,
    now: d.now,
    out: d.out,
    dry: false,
    runInstall: false,
    tsxCli: d.tsxCli,
    gitBin: d.gitBin,
    installed: v.installed,
    owner: { trust: null, signature: null, hardware: { doc: v.hardwareDoc as HardwareApprovalDoc, anchorPath: v.installed.anchorPath, statePath: v.installed.statePath, pins: { ledgerDir: v.installed.ledgerDir, anchorFile: v.installed.ledgerAnchorFile } } },
  };
  try {
    const result = await runEnvelope(v.envelopePath, v.installed.layout.release, deps);
    return { verified: v, result };
  } finally {
    try {
      rmSync(v.workDir, { recursive: true, force: true });
    } catch {
      /* the work directory holds copies only */
    }
  }
}

/** Scheduled-task entry: exit 0 only for a PASS, 2 when a gate blocked before any run, 1 for a run that did not pass. */
export async function execInboxMain(runId: string, d: ExecInboxDeps, store: () => CredentialStore, parentEnv: Record<string, string | undefined>, exec: Exec): Promise<number> {
  const tsxCli = join(d.layout.release, "node_modules", "tsx", "dist", "cli.mjs");
  const { result } = await runInstalled(runId, { ...d, exec, store, parentEnv, tsxCli });
  return result === null ? 2 : result.exitCode;
}
