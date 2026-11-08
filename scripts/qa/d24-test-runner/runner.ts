// Orchestrator. Order is deliberate: cheap local gates first, the credential store is touched only after every gate that does not need the key has
// passed, and a run is written to the ledger (consuming one of maxRuns) BEFORE the first live call. Nothing here talks to Stripe except by launching
// the proof's own --live, which enforces the allow-list and the call cap itself.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceDirProblem } from "../d24-m3d-proof/evidence";
import { checkKeyShape } from "../d24-m3d-proof/identity";
import { manifest } from "../d24-m3d-proof/manifest";
import { runnerInsideClone, runnerManifest } from "./runnerpin";
import { defaultOwnerDir, defaultRunnerHome, verifyOwnerSignature, type OwnerTrust } from "./ownerverify";
import { ANCHOR_FILE, anchorMatchesManifest, checkAgainstState, loadAnchor, type HardwareAnchor } from "./webauthn";

/** Hard-coded policy (part of the runner folder hash that the signed envelope pins): live runs need the hardware-key approval. Tests flip nothing; a dev build that wants the Ed25519 kind must change this line, which changes the runner hash. */
export const REQUIRE_HARDWARE_FOR_LIVE: boolean = true;
import { baseEnv, proofEnv } from "./childenv";
import { sha256 } from "./canon";
import { checkEnvelopeWindow, KNOWN_RULE_IDS, validateEnvelope } from "./envelope";
import type { CredentialStore } from "./credstore";
import { realExec, type Exec } from "./exec";
import { isDryFakeExec, isSimulatedLiveExec, simulatedMainVerifyFor } from "./fakeChild";
import { mainVerification, runnerTracked, verifyCleanClone, type Gate } from "./gitverify";
import type { Ledger, LedgerEntry } from "./ledger";
import { analyzeEvidence, decide, hashFile, redactionScan, renderReport, type FileHash, type RunSummary } from "./postrun";
import { proofAllowList, proofDryRun, proofLive, proofPreflight, proofPrintHash, type ProofCall } from "./proofcli";
import { hasSecretFinding, sanitize } from "./scan";

export type RunnerDeps = {
  exec: Exec;
  parentEnv: Record<string, string | undefined>;
  /** Called only when the credential is needed. In --dry this must never be reachable (tests make it throw). */
  store: () => CredentialStore;
  ledger: Ledger;
  now: () => Date;
  out: (line: string) => void;
  dry: boolean;
  runInstall: boolean;
  /** dry only: the fake key to inject instead of reading a store */
  dryKey?: string;
  tsxCli?: string;
  /** absolute git path for live runs (see bins.resolveGit) */
  gitBin?: string;
  /** LIVE only: the pinned owner trust (null = none registered => refuse) and the parsed detached signature document. Ignored in dry. */
  owner?: {
    trust: OwnerTrust | null;
    signature: unknown;
    /** the hardware-key approval document (webauthn-es256). seams: anchorPath/statePath/pins default to the fixed locations */
    hardware?: { doc: unknown; anchorPath?: string; statePath?: string; pins?: { ledgerDir: string; anchorFile: string } };
  };
};

export type RunResult = { summary: RunSummary | null; status: RunSummary["status"]; exitCode: number; reportPath: string | null; gates: Gate[] };

const sha12 = (s: string) => s.slice(0, 12);

export async function runEnvelope(envelopePath: string, repoDir: string, d: RunnerDeps): Promise<RunResult> {
  // dry is not a trusted caller flag: it must agree with the executor. dry => a dry fake; live => the real executor (or a test-only simulated-live fake).
  if (d.dry && !isDryFakeExec(d.exec)) throw new Error("refused: dry:true requires the dry fake executor (a real executor with dry:true would skip the live gates)");
  if (!d.dry && !(d.exec === realExec || isSimulatedLiveExec(d.exec))) throw new Error("refused: a live run requires the real executor");
  // test seams (anchor / counter-state / ledger locations) exist only for the simulated-live fake; the real executor always uses the fixed locations
  const hwSeams = d.owner?.hardware;
  if (!d.dry && hwSeams && (hwSeams.anchorPath !== undefined || hwSeams.statePath !== undefined || hwSeams.pins !== undefined) && !isSimulatedLiveExec(d.exec)) throw new Error("refused: the anchor/state/ledger test seams are only allowed with the simulated-live test executor");
  const gates: Gate[] = [];
  let literals: string[] = [];
  const say = (s: string) => d.out(sanitize(s, literals));
  const gate = (id: string, ok: boolean, detail: string) => {
    gates.push({ id, ok, detail });
    say(`${ok ? "PASS" : "FAIL"}  ${id}: ${detail}`);
    return ok;
  };
  const startedUtc = d.now().toISOString();
  const blocked = (at: string): RunResult => {
    say(`BLOCKED at ${at}: nothing was sent to Stripe and no run was consumed.`);
    return { summary: null, status: "BLOCKED", exitCode: 2, reportPath: null, gates };
  };

  // 1. envelope
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(envelopePath, "utf8"));
  } catch {
    gate("envelope-readable", false, "envelope file is missing or not valid JSON");
    return blocked("envelope-readable");
  }
  const v = validateEnvelope(raw);
  if (!v.ok) {
    gate("envelope-valid", false, v.issues.map((i) => `${i.code}: ${i.detail}`).join(" | "));
    return blocked("envelope-valid");
  }
  const env = v.envelope;
  gate("envelope-valid", true, `schema, policy, approval terms and canonical hash ok (sha256 ${sha12(env.envelopeSha256)})`);
  const win = checkEnvelopeWindow(env, d.now());
  if (win.length > 0) {
    gate("envelope-window", false, win.map((i) => `${i.code}: ${i.detail}`).join(" | "));
    return blocked("envelope-window");
  }
  gate("envelope-window", true, `valid until ${env.expiresUtc}`);

  // 1b. OWNER APPROVAL. REQUIRE_HARDWARE_FOR_LIVE is a constant in this (runner-hash-pinned) file, not read from any file, environment variable or argument:
  // a LIVE run needs a valid hardware-key (WebAuthn) approval against the anchor file in this folder. A missing, unparseable, mis-pinned or edited anchor BLOCKS
  // the run; it never downgrades to another approval kind. The passphrase-sealed Ed25519 kind is not consulted for live runs at all (dry and dev tooling only).
  let commitApproval: (() => void) | null = null;
  let hwAnchor: HardwareAnchor | null = null;
  let hwAnchorSha = "";
  const anchorPathUsed = d.owner?.hardware?.anchorPath ?? join(__dirnameOf(), ANCHOR_FILE);
  if (d.dry) gate("owner-signature", true, "DRY: not required (no live call is possible in dry mode); a LIVE run needs a valid hardware-key approval");
  else if (REQUIRE_HARDWARE_FOR_LIVE) {
    const hwLoaded = loadAnchor(anchorPathUsed);
    if (hwLoaded === null) {
      gate("owner-approval", false, `no hardware anchor (${ANCHOR_FILE}) in the runner folder: live runs require the hardware-key approval and are never downgraded. The owner enrollment is design only, see docs/billing/D24-TEST-RUNNER-OWNER-AUTH.md section 7`);
      return blocked("owner-approval");
    }
    if (!hwLoaded.ok) {
      gate("owner-approval", false, `hardware anchor is invalid: ${hwLoaded.problems.join("; ")}`);
      return blocked("owner-approval");
    }
    hwAnchor = hwLoaded.anchor;
    hwAnchorSha = hwLoaded.sha256;
    // the envelope (covered by the assertion) names the anchor it was written for: a swapped or edited anchor cannot approve an envelope written for another
    const pinOk = env.hardwareAnchorFingerprintSha256 === hwLoaded.anchor.fingerprintSha256;
    if (!gate("owner-anchor-pin", pinOk, pinOk ? `envelope pins the same anchor (${hwLoaded.anchor.fingerprintSha256.slice(0, 16)})` : "the anchor fingerprint pinned inside the (hardware-approved) envelope differs from the anchor in this runner folder")) return blocked("owner-anchor-pin");
    const chk = checkAgainstState(d.owner?.hardware?.statePath ?? join(defaultOwnerDir(), "hw-signcount.json"), { envelopeSha256: env.envelopeSha256, doc: d.owner?.hardware?.doc, anchor: hwLoaded.anchor });
    if (!gate("owner-approval", chk.result.ok, chk.result.ok ? `HARDWARE-key approval (webauthn-es256) verified against anchor ${hwLoaded.anchor.fingerprintSha256.slice(0, 16)}, counter ${chk.result.signCount} (recorded only when the run is consumed)` : chk.result.reason)) return blocked("owner-approval");
    commitApproval = chk.commit;
  } else {
    const sig = verifyOwnerSignature(env.envelopeSha256, d.owner?.signature, d.owner?.trust ?? null);
    if (!gate("owner-signature", sig.ok, sig.ok ? `DEV KIND (passphrase-sealed Ed25519; same-user, NOT an independent approval): ${sig.reason}` : sig.reason)) return blocked("owner-signature");
  }

  // 1c. the runner's own code is part of the approval: it must live in the verified clone and match the hash in the envelope
  const runnerDir = __dirnameOf();
  const inClone = runnerInsideClone(runnerDir, repoDir);
  if (!gate("runner-in-clone", inClone.ok, inClone.detail)) return blocked("runner-in-clone");
  const rm = runnerManifest(runnerDir);
  const runnerOk = rm.sha256 === env.runner.manifestSha256 && rm.files.length === env.runner.fileCount;
  if (!gate("runner-pin", runnerOk, runnerOk ? `runner folder ${sha12(rm.sha256)}, ${rm.files.length} files == envelope` : `runner folder hash ${sha12(rm.sha256)} (${rm.files.length} files) differs from the envelope (${sha12(env.runner.manifestSha256)}): the enforcement code was changed after approval`)) return blocked("runner-pin");

  // The proof folder is hashed NOW, together with the runner folder: these in-memory hashes are what the committed blobs are later compared with (never a
  // fresh disk read: npm ci runs for minutes in between) and what the last re-hash before going live is compared with.
  const proofDirAbs = join(repoDir, "scripts", "qa", "d24-m3d-proof");
  const proofHeld = manifest(proofDirAbs);

  // 2. ledger: run count, unfinished runs, lock
  let blockers: string[];
  const bind = { envelopeSha256: env.envelopeSha256, keyFp: env.credential.keyFingerprintSha256Prefix };
  if (!d.dry) {
    const pinned = hwAnchor ? (d.owner?.hardware?.pins ?? { ledgerDir: join(defaultRunnerHome(), "ledger"), anchorFile: join(defaultOwnerDir(), "ledger-anchor.json") }) : d.owner?.trust;
    const same = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
    const okPin = Boolean(pinned) && same(d.ledger.dir, pinned!.ledgerDir) && d.ledger.anchorFile !== undefined && same(d.ledger.anchorFile, pinned!.anchorFile);
    if (!gate("ledger-pinned", okPin, okPin ? "ledger directory and anchor are the fixed locations (owner trust file / hardware mode defaults)" : "the ledger is not at the pinned location (a fresh or other ledger would reset the run budget)")) return blocked("ledger-pinned");
  }
  try {
    blockers = d.ledger.startBlockers(env.envelopeId, env.maxRuns, bind);
  } catch (e) {
    blockers = [String((e as Error).message)];
  }
  if (!gate("ledger", blockers.length === 0, blockers.length === 0 ? `${d.ledger.runsStarted(env.envelopeId)} of ${env.maxRuns} runs consumed; no unfinished run` : blockers.join(" | "))) return blocked("ledger");
  const runNo = d.ledger.nextRunNo(env.envelopeId);

  // 3. evidence root (outside any git checkout, resolved on real paths)
  const runDir = join(env.evidenceRoot, env.envelopeId, `run-${runNo}`);
  const evProblem = evidenceDirProblem(runDir, repoDir);
  if (!gate("evidence-dir", evProblem === null, evProblem ?? `${runDir} is outside every git checkout`)) return blocked("evidence-dir");

  // 4. clean clone, pinned commit, npm ci
  const plain = baseEnv(d.parentEnv);
  const git = await verifyCleanClone({ repoDir, commitSha: env.code.commitSha, lockfileSha256: env.code.lockfileSha256, env: plain.env, exec: d.exec, runInstall: d.runInstall, gitBin: d.gitBin });
  for (const g of git) gate(g.id, g.ok, g.detail);
  if (git.some((g) => !g.ok)) return blocked("clean-clone");
  if (hwAnchor) {
    // the anchor bytes parsed above are the bytes the folder hash covered, and every hashed file (anchor included) is tracked by git
    if (resolve(anchorPathUsed) === resolve(runnerDir, ANCHOR_FILE)) {
      const same = anchorMatchesManifest(hwAnchorSha, rm.files);
      if (!gate("anchor-bytes", same, same ? "the anchor that was parsed is byte-identical to the one the runner-folder hash covers" : "the anchor file changed between being parsed and being hashed")) return blocked("anchor-bytes");
    }
    const tr = await runnerTracked({ repoDir, runnerRel: "scripts/qa/d24-test-runner", files: rm.files.map((f) => f.path), env: plain.env, exec: d.exec, gitBin: d.gitBin });
    if (!gate(tr.id, tr.ok, tr.detail)) return blocked("runner-tracked");
    // ancestry (decided in node from SHA-1-verified objects) AND the committed blobs against the hashes this run ALREADY HOLDS (runner folder incl. anchor,
    // proof folder), never against a fresh disk read
    const heldPins = [...rm.files.map((f) => ({ rel: `scripts/qa/d24-test-runner/${f.path}`, sha256: f.sha256 })), ...proofHeld.files.map((f) => ({ rel: `scripts/qa/d24-m3d-proof/${f.path}`, sha256: f.sha256 }))];
    const mainVerify = simulatedMainVerifyFor(d.exec) ?? mainVerification;
    const mv = await mainVerify({ repoDir, commitSha: env.code.commitSha, env: plain.env, exec: d.exec, gitBin: d.gitBin, pins: heldPins });
    if (!gate(mv.ancestry.id, mv.ancestry.ok, mv.ancestry.detail)) return blocked("commit-on-main");
    if (mv.content && !gate(mv.content.id, mv.content.ok, mv.content.detail)) return blocked("committed-content");
  }

  // 5. proof manifest: runner recomputation AND the proof's own --print-hash AND the envelope must all agree
  const call: ProofCall = { repoDir, env: plain.env, exec: d.exec, tsxCli: d.tsxCli };
  const local = manifest(proofDirAbs);
  const theirs = await proofPrintHash(call);
  const agree = theirs.ok && theirs.sha256 === local.sha256 && local.sha256 === proofHeld.sha256 && local.sha256 === env.proof.manifestSha256 && local.files.length === env.proof.fileCount && theirs.fileCount === env.proof.fileCount;
  if (!gate("proof-manifest", agree, agree ? `manifest ${sha12(local.sha256)}, ${local.files.length} files: runner recomputation == proof --print-hash == envelope` : `manifest mismatch (runner ${sha12(local.sha256)}, proof ${theirs.sha256 ? sha12(theirs.sha256) : "unavailable"}, envelope ${sha12(env.proof.manifestSha256)})`)) return blocked("proof-manifest");

  // 5b. the call ceiling: the proof enforces only its own constant (HARD_CALL_CAP), which cannot be lowered without editing the hashed proof folder.
  // So the envelope ceiling must EQUAL the proof constant (read from the manifest-verified source); a lower value could only be checked after the fact.
  let proofCap: number | null = null;
  try {
    proofCap = Number(/HARD_CALL_CAP\s*=\s*(\d+)/.exec(readFileSync(join(repoDir, "scripts", "qa", "d24-m3d-proof", "config.ts"), "utf8"))?.[1] ?? NaN);
  } catch {
    proofCap = null;
  }
  const capOk = proofCap !== null && Number.isInteger(proofCap) && proofCap === env.apiCallCeiling;
  if (!gate("ceiling-pin", capOk, capOk ? `envelope ceiling ${env.apiCallCeiling} == the proof's enforced HARD_CALL_CAP` : `envelope ceiling ${env.apiCallCeiling} differs from the proof's enforced cap ${proofCap ?? "unreadable"}: a different ceiling cannot be enforced live without editing the hashed proof, so it is refused`)) return blocked("ceiling-pin");

  // 6. allow-list rule ids == envelope permitted operations
  const al = await proofAllowList(call);
  const same = al.ok && JSON.stringify(al.ruleIds) === JSON.stringify([...env.permittedRuleIds].sort());
  const unknown = al.ruleIds.filter((r) => !(KNOWN_RULE_IDS as readonly string[]).includes(r));
  if (!gate("allow-list", same && unknown.length === 0, same && unknown.length === 0 ? `${al.ruleIds.length} rule ids equal the envelope's permitted operations` : `proof allow-list ${JSON.stringify(al.ruleIds)} differs from the envelope or has unknown rules ${JSON.stringify(unknown)}`)) return blocked("allow-list");

  // 7. proof dry run (fake client)
  const dry = await proofDryRun(call);
  if (!gate("proof-dry-run", dry.ok, dry.detail)) return blocked("proof-dry-run");

  // 8. credential: only now. Shape, fingerprint and expiry are checked; the value never leaves this function except into the child env.
  let key: string;
  if (d.dry) {
    key = d.dryKey ?? "";
    gate("credential", key !== "", "DRY: fake key injected; the credential store was not accessed");
  } else {
    let got: string | null;
    try {
      got = await d.store().read(env.credential.label);
    } catch (e) {
      gate("credential", false, `credential store failed: ${sanitize(String((e as Error).message))}`);
      return blocked("credential");
    }
    if (got === null) {
      gate("credential", false, `no credential stored under label ${env.credential.label} (run provision)`);
      return blocked("credential");
    }
    key = got;
    literals = [key];
    const shape = checkKeyShape(key);
    if (!gate("credential-shape", shape.ok, shape.ok ? "rk_test_ restricted TEST key" : shape.reason)) return blocked("credential-shape");
    const fp = createHash("sha256").update(key).digest("hex").slice(0, 16);
    if (!gate("credential-fingerprint", fp === env.credential.keyFingerprintSha256Prefix, fp === env.credential.keyFingerprintSha256Prefix ? "stored key matches the fingerprint the owner approved" : "stored key differs from the approved fingerprint (rotated or swapped key): needs a new envelope")) return blocked("credential-fingerprint");
  }
  literals = [key];
  const pe = proofEnv(d.parentEnv, { key, evidenceDir: runDir, envelope: env });
  gate("child-environment", true, `allow-listed environment; ${pe.droppedNames.length} inherited variable(s) dropped (names only: ${pe.droppedNames.slice(0, 12).join(", ")}${pe.droppedNames.length > 12 ? ", …" : ""}); passes the proof's own environment check`);

  // 9. proof preflight with MANUAL items resolved from the envelope
  const pf = await proofPreflight({ ...call, env: pe.env });
  const fails = pf.lines.filter((l) => l.status === "FAIL");
  const manual = pf.lines.filter((l) => l.status === "MANUAL");
  const missing = manual.filter((m) => !env.manualAttestations[m.id]).map((m) => m.id);
  const pfOk = pf.exitCode === 0 && fails.length === 0 && pf.lines.length > 0 && missing.length === 0;
  const pfDetail = fails.length > 0 ? `preflight FAIL: ${fails.map((f) => f.id).join(", ")}` : pf.exitCode !== 0 || pf.lines.length === 0 ? `preflight did not complete (exit ${pf.exitCode})` : missing.length > 0 ? `MANUAL item(s) with no attestation in the envelope: ${missing.join(", ")}` : `no local check failed; ${manual.length} MANUAL item(s) all resolved by envelope attestations (${manual.map((m) => m.id).join(", ")})`;
  if (!gate("proof-preflight", pfOk, pfDetail)) return blocked("proof-preflight");

  // 10. last TOCTOU check, then consume the run BEFORE going live
  const again = await verifyCleanClone({ repoDir, commitSha: env.code.commitSha, lockfileSha256: env.code.lockfileSha256, env: plain.env, exec: d.exec, runInstall: false, gitBin: d.gitBin });
  const stillOk = again.filter((g) => g.id !== "npm-ci").every((g) => g.ok);
  if (!gate("recheck-tree", stillOk, stillOk ? "tree still exactly the pinned commit, clean" : "tree changed during the gates")) return blocked("recheck-tree");
  // the last re-hash of what will be executed, straight from disk (no stat cache), immediately before the approval counter is recorded and the proof is spawned
  const proofNow = manifest(proofDirAbs);
  const runnerNow = runnerManifest(runnerDir);
  const heldOk = proofNow.sha256 === proofHeld.sha256 && runnerNow.sha256 === rm.sha256;
  if (!gate("held-hashes-recheck", heldOk, heldOk ? "the proof folder and runner folder still hash to the values pinned at the start of the run" : "the proof or runner folder changed on disk since it was hashed at the start of the run")) return blocked("held-hashes-recheck");
  // expiry is re-checked at the point the run is consumed (npm ci and the gates can take many minutes)
  const win2 = checkEnvelopeWindow(env, d.now());
  if (!gate("envelope-window-recheck", win2.length === 0, win2.length === 0 ? "still inside the approved window at the moment of consumption" : win2.map((i) => `${i.code}: ${i.detail}`).join(" | "))) return blocked("envelope-window-recheck");
  if (commitApproval) {
    try {
      commitApproval(); // the hardware counter is recorded only now, after every gate has passed
    } catch (e) {
      gate("owner-approval-record", false, sanitize(String((e as Error).message), literals));
      return blocked("owner-approval-record");
    }
  }
  mkdirSync(env.evidenceRoot, { recursive: true });
  const runId = `${env.envelopeId}-r${runNo}`;
  let start: LedgerEntry;
  try {
    start = d.ledger.startRun(env.envelopeId, env.envelopeSha256, runId, { maxRuns: env.maxRuns, keyFp: env.credential.keyFingerprintSha256Prefix });
  } catch (e) {
    gate("ledger-start", false, sanitize(String((e as Error).message), literals));
    return blocked("ledger-start");
  }
  if (start.runNo !== runNo) {
    d.ledger.endRun(start, "ABORTED-RUNNO-RACE");
    gate("ledger-start", false, `another run consumed number ${runNo} between the check and the start (now ${start.runNo}); nothing was sent`);
    return blocked("ledger-start");
  }
  say(`LEDGER: run ${runNo} of ${env.maxRuns} consumed for envelope ${env.envelopeId} (counts even if the run fails).`);

  let childExit: number | null = null;
  let childOut = "";
  let childErr = "";
  let timedOut = false;
  let summary: RunSummary | null = null;
  let status: RunSummary["status"] = "UNVERIFIABLE";
  try {
    const r = await proofLive({ ...call, env: pe.env });
    childExit = r.code;
    childOut = r.stdout;
    childErr = r.stderr;
    timedOut = r.timedOut === true;
    say(`proof --live finished with exit code ${r.code}`);

    // 11. post-run
    const files: Array<{ name: string; text: string }> = [];
    if (existsSync(runDir)) for (const f of readdirSync(runDir).sort()) if (/^(evidence-.*\.json|transcript-.*\.txt)$/.test(f)) files.push({ name: f, text: readFileSync(join(runDir, f), "utf8") });
    const evJson = files.find((f) => f.name.startsWith("evidence-"))?.text ?? null;
    const analysis = analyzeEvidence(evJson, env);
    const outputs = [...files, { name: "child-stdout", text: childOut }, { name: "child-stderr", text: childErr }, { name: "runner-gates", text: gates.map((g) => g.detail).join("\n") }];
    const findings = redactionScan(outputs, literals);
    const hashes: FileHash[] = files.map((f) => hashFile(f.name, f.text));
    const childLog = sanitize(`${childOut}\n--- stderr ---\n${childErr}`, literals);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(runDir, "runner-child-output.txt"), childLog, { mode: 0o600, flag: "wx" });
    hashes.push(hashFile("runner-child-output.txt", childLog));
    const dec = decide({ analysis, safetyFindings: findings, childExitCode: childExit, blockedAt: undefined, timedOut });
    status = dec.status;
    summary = { status: dec.status, statusReason: dec.reason, envelope: env, runNo, runId, startedUtc, finishedUtc: d.now().toISOString(), childExitCode: childExit, analysis, safetyFindings: findings, fileHashes: hashes, gates, dry: d.dry, runnerManifestSha256: rm.sha256 };
    const report = renderReport(summary, d.now());
    writeFileSync(join(runDir, "report.md"), report, { mode: 0o600, flag: "wx" });
    say(`REPORT: ${join(runDir, "report.md")} (sha256 ${sha256(report).slice(0, 16)})`);
    say(`DECISION: ${dec.status} - ${dec.reason}`);
    if (hasSecretFinding(findings)) say("SAFETY: a secret-shaped value was found in the output. Expire the key NOW and delete the stored credential.");
  } finally {
    // a timed-out child's tree was killed, but its calls are unverified: leave the run open (and the lock held) until a human reconciles it
    if (!timedOut) d.ledger.endRun(start, status);
  }
  const exitCode = status === "PASS" ? 0 : 1;
  return { summary, status, exitCode, reportPath: join(runDir, "report.md"), gates };
}

function __dirnameOf(): string {
  return dirname(fileURLToPath(import.meta.url));
}
