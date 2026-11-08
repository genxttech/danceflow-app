// The scheduled-task entry point: runs as the unprivileged `d24run` account, FROM the install root, and is the only producer of the "verified
// installed root" brand that lets runEnvelope use the real executor. Gate order is fixed (docs/billing/D24-TEST-RUNNER-TRUST-ANCHOR.md section 3.2):
//   identity -> install-root path -> policy parse -> ACLs -> release record -> tree hash -> policy hash -> anchor -> inbox copy -> envelope vs policy.
// Then runEnvelope performs the hardware assertion check (the existing #419 verifier) against the INSTALLED anchor and the counter in state\.
// Nothing here talks to Stripe; the key is read by runEnvelope through the d24run-only store only after every gate passed.

import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { manifest } from "../d24-m3d-proof/manifest";
import type { CredentialStore } from "./credstore";
import { checkEnvelopeWindow, type Envelope } from "./envelope";
import type { Exec } from "./exec";
import { fingerprintOfFile } from "./fingerprint";
import { aclGate, markVerifiedInstalled, parseRelease, readJson, rootPathGate, RUN_AS_ACCOUNT, verifyInstalledTree, type AclReader, type Gate, type InstalledRun, type Layout, type Release } from "./installroot";
import { ASSERTION_FILE, ENVELOPE_FILE, readInboxFile, RUN_ID_RE } from "./launcher";
import { Ledger } from "./ledger";
import { clampEnvelopeToPolicy, parsePolicy, policySha256, proofHardCap, proofMaxLineCents, type Policy } from "./policy";
import { runEnvelope, type RunnerDeps, type RunResult } from "./runner";
import { loadAnchor, type HardwareAnchor, type HardwareApprovalDoc } from "./webauthn";

export type ExecInboxDeps = {
  layout: Layout;
  /** the file of the code that is running (import.meta.url's path in production) */
  runningFile: string;
  acl: AclReader;
  whoami(): string;
  now(): Date;
  out(line: string): void;
  realpath?: (p: string) => string;
  isLink?: (p: string) => boolean;
};
export type Verified = { ok: true; gates: Gate[]; installed: InstalledRun; policy: Policy; release: Release; anchor: HardwareAnchor; envelope: Envelope; envelopePath: string; hardwareDoc: unknown; workDir: string; ledger: Ledger };
export type NotVerified = { ok: false; gates: Gate[] };

const sha12 = (s: string) => s.slice(0, 12);

export async function verifyInstalled(runId: string, d: ExecInboxDeps): Promise<Verified | NotVerified> {
  const gates: Gate[] = [];
  const gate = (id: string, ok: boolean, detail: string): boolean => {
    gates.push({ id, ok, detail });
    d.out(`${ok ? "PASS" : "FAIL"}  ${id}: ${detail}`);
    return ok;
  };
  const stop = (): NotVerified => ({ ok: false, gates });
  const l = d.layout;

  // 1. identity: only the run-as account may execute a live run (the key is unreadable to anyone else anyway)
  if (!gate("identity", d.whoami().split("\\").pop()!.toLowerCase() === RUN_AS_ACCOUNT.toLowerCase(), `running as ${RUN_AS_ACCOUNT}`)) return stop();
  if (!gate("run-id", RUN_ID_RE.test(runId), "run id has the expected shape")) return stop();

  // 2. the running code and the root are real and inside the install root
  const rp = rootPathGate(l, d.runningFile, d.realpath, d.isLink);
  if (!gate(rp.id, rp.ok, rp.detail)) return stop();

  // 3. policy structure (not yet trusted: the ACL, release and hash gates below decide that)
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
  if (!gate("policy-run-as", policy.runAsAccount.toLowerCase() === RUN_AS_ACCOUNT.toLowerCase(), `policy run-as account is ${RUN_AS_ACCOUNT}`)) return stop();

  // 4. the OS-level protection of the root, fail closed
  const ag = await aclGate(l, d.acl, { runAs: RUN_AS_ACCOUNT, owner: policy.ownerAccount });
  if (!gate(ag.id, ag.ok, ag.detail)) return stop();

  // 5-7. release record, tree hash, policy hash
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

  // 8. anchor: parsed, byte-identical to what the installer recorded, and the policy's pin
  const la = loadAnchor(l.anchorJson);
  if (la === null || !la.ok) {
    gate("anchor", false, la === null ? "anchor.json is missing" : `anchor.json is invalid: ${la.problems.join("; ")}`);
    return stop();
  }
  const anchorOk = la.sha256 === rel.anchorSha256 && la.anchor.fingerprintSha256 === policy.anchorFingerprint;
  if (!gate("anchor", anchorOk, anchorOk ? `anchor ${la.anchor.fingerprintSha256.slice(0, 16)} equals the release record and the policy pin` : "anchor.json differs from the release record or the policy pin")) return stop();

  // 9. copy the inbox files into a private directory FIRST; everything below reads only the copies
  const workDir = join(l.state, "work", `${runId}-${randomBytes(6).toString("hex")}`);
  const inboxRun = join(l.inbox, runId);
  try {
    mkdirSync(workDir, { recursive: true });
    for (const f of [ENVELOPE_FILE, ASSERTION_FILE]) {
      if (readInboxFile(join(inboxRun, f)) === null) throw new Error(f);
      copyFileSync(join(inboxRun, f), join(workDir, f));
    }
  } catch {
    gate("inbox-copy", false, "the inbox run directory lacks a regular, small envelope.json and assertion.hw.json");
    return stop();
  }
  gate("inbox-copy", true, "envelope and assertion copied to a private directory; only the copies are read from here on");
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

  // 10. every ceiling: the envelope may equal or narrow the policy, never widen it
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
  const evRoot = resolve(l.evidence).replace(/\\/g, "/").toLowerCase();
  const issues = clampEnvelopeToPolicy(env, policy, {
    proofManifestSha256: manifest(l.proofDir).sha256,
    proofMaxLineCents: proofMaxLineCents(l.proofDir),
    evidenceRootAllowed: (p) => {
      const n = resolve(p).replace(/\\/g, "/").toLowerCase();
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
  /** the tsx CLI inside the installed release (node_modules is installed by the elevated installer) */
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
    parentEnv: d.parentEnv,
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
