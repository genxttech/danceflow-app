// Command line for the engineering-operated TEST runner. No Stripe call is made by anything in this file except through `run` (which launches the
// proof's own --live after every gate). `dry` and `run --dry` use a fake child and never touch the credential store.
//
//   provision --label L [--store wcm|dpapi]      read the rk_test_ key from a hidden prompt or stdin into the protected store (never argv)
//   provision --label L --check | --remove        show the fingerprint only / delete the stored credential
//   approval-template --spec spec.json            print the term line the OWNER must approve (the runner never creates the approval)
//   create-envelope --spec spec.json --approval-file owner.txt --approval-ref "chat 2026-11-07 14:02" --out envelope.json
//   validate-envelope --envelope envelope.json
//   run --envelope envelope.json [--hw-approval approval.json] [--dry]   LIVE needs a hardware-key (WebAuthn) approval of the envelope hash and the enrolled anchor; --dry needs neither and reads no credential
//   (owner-keygen / owner-sign / owner-rotate / owner-show live in ownermain.ts, a separate entry point this CLI never imports)
//   repo-pins                                     print lockfile / proof / runner hashes of this checkout for the envelope spec
//   dry                                           self-test with a synthetic envelope and a fake child (no store, no network)
//   ledger | reconcile --envelope-id ID --run-no N --note "what you checked"

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "../d24-m3d-proof/manifest";
import { resolveGit } from "./bins";
import { lockfileSha } from "./gitverify";
import { defaultOwnerDir, defaultRunnerHome, loadTrust } from "./ownerverify";
import { readSecret } from "./secretprompt";
import { ANCHOR_FILE } from "./webauthn";
import { runnerManifest } from "./runnerpin";
import { existsSync } from "node:fs";
import { checkKeyShape } from "../d24-m3d-proof/identity";
import { DpapiFileStore, WindowsCredentialManagerStore, type CredentialStore } from "./credstore";
import { approvalTemplate, createEnvelope, validateEnvelope, type EnvelopeSpec } from "./envelope";
import { realExec } from "./exec";
import { createFakeExec } from "./fakeChild";
import { Ledger } from "./ledger";
import { runEnvelope } from "./runner";
import { sanitize } from "./scan";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const defaultHome = () => defaultRunnerHome();
export { readSecret };

type Io = { out: (s: string) => void; err: (s: string) => void };

function parseOpts(argv: string[]): { cmd: string; opts: Map<string, string | true> } | { error: string } {
  const [cmd, ...rest] = argv;
  const opts = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) return { error: "positional arguments are not accepted (a secret must never be passed on the command line)" };
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      opts.set(a.slice(2), next);
      i++;
    } else opts.set(a.slice(2), true);
  }
  return { cmd: cmd ?? "", opts };
}
const str = (o: Map<string, string | true>, k: string) => (typeof o.get(k) === "string" ? (o.get(k) as string) : undefined);

export function makeStore(kind: string, home: string): CredentialStore {
  return kind === "dpapi" ? new DpapiFileStore(join(home, "creds")) : new WindowsCredentialManagerStore();
}

export async function provision(opts: Map<string, string | true>, io: Io, stdin: NodeJS.ReadStream, home = defaultHome(), storeOverride?: CredentialStore): Promise<number> {
  const label = str(opts, "label");
  if (!label) {
    io.err("--label is required");
    return 2;
  }
  const store = storeOverride ?? makeStore(str(opts, "store") === "dpapi" ? "dpapi" : "wcm", home);
  if (opts.has("remove")) {
    await store.remove(label);
    io.out(`removed credential ${label} from ${store.kind}`);
    return 0;
  }
  if (opts.has("check")) {
    const v = await store.read(label);
    io.out(v === null ? `no credential under ${label}` : `credential ${label} present in ${store.kind}; fingerprint ${createHash("sha256").update(v).digest("hex").slice(0, 16)}; length ${v.length}`);
    return v === null ? 1 : 0;
  }
  const secret = await readSecret(stdin, (s) => process.stderr.write(s));
  const shape = checkKeyShape(secret);
  if (!shape.ok) {
    io.err(`refused: ${sanitize(shape.reason)}`); // reason never echoes the key
    return 2;
  }
  await store.write(label, secret);
  const back = await store.read(label);
  if (back !== secret) {
    io.err("refused: the stored value did not read back identically; nothing is usable");
    return 1;
  }
  io.out(`stored in ${store.kind} as ${label}; fingerprint (put this in the envelope credential.keyFingerprintSha256Prefix): ${createHash("sha256").update(secret).digest("hex").slice(0, 16)}; length ${secret.length}`);
  io.out("Remember: other processes of this Windows user can read this credential. Expire the key in Stripe when the runs are done.");
  return 0;
}

/** Synthetic envelope + fake child for the self-test. Everything lives in a temp dir; the real ledger and the real store are never touched. */
export async function selfTest(io: Io, now = () => new Date()): Promise<number> {
  const tmp = mkdtempSync(join(tmpdir(), "d24-runner-dry-"));
  const key = ["rk", "test", "DRYRUNFAKE0123456789"].join("_");
  const m = manifest(join(REPO, "scripts", "qa", "d24-m3d-proof"));
  const created = now();
  const spec: EnvelopeSpec = {
    envelopeId: "dry-selftest-1",
    createdUtc: created.toISOString().replace(/\.\d+Z$/, "Z"),
    expiresUtc: new Date(created.getTime() + 86_400_000).toISOString().replace(/\.\d+Z$/, "Z"),
    code: { commitSha: "a".repeat(40), lockfileSha256: lockfileSha(readFileSync(join(REPO, "package-lock.json"))) },
    proof: { manifestSha256: m.sha256, fileCount: m.files.length },
    runner: { manifestSha256: runnerManifest(HERE).sha256, fileCount: runnerManifest(HERE).files.length },
    hardwareAnchorFingerprintSha256: "0".repeat(64), // dry self-test only: no anchor is consulted in dry mode
    accounts: { platformAcct: "acct_DRYRUNPLATFORM", connectedAcct: "acct_DRYRUNCONNECTED" },
    permittedRuleIds: [
      "customer.create", "customer.delete", "identity.connected", "identity.platform", "invoice.add_lines", "invoice.create_draft", "invoice.delete_draft", "invoice.list_by_customer", "invoice.read", "negative.transfers", "negative.webhook_endpoints",
    ],
    apiCallCeiling: 40,
    cleanupReserve: 8,
    credential: { store: "windows-credential-manager", label: "dry-selftest", keyKind: "rk_test", keyFingerprintSha256Prefix: createHash("sha256").update(key).digest("hex").slice(0, 16), keyExpiresUtc: new Date(created.getTime() + 2 * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z") },
    stopConditions: ["any-abort", "livemode-true", "identity-mismatch", "cleanup-unverified", "secret-in-output", "call-ceiling"],
    maxRuns: 1,
    evidenceRoot: join(tmp, "evidence"),
    manualAttestations: Object.fromEntries(["sandbox", "connected-account", "key-permissions", "no-webhooks", "api-version", "local-postgres"].map((id) => [id, { statement: `DRY self-test attestation for ${id}`, attestedBy: "self-test", reference: "dry" }])),
  };
  const env = createEnvelope(spec, approvalTemplate(spec), "dry self-test (synthetic, not an owner approval)");
  if (!env.ok) {
    io.err(`self-test envelope invalid: ${env.issues.map((i) => i.detail).join("; ")}`);
    return 1;
  }
  const file = join(tmp, "envelope.json");
  writeFileSync(file, JSON.stringify(env.envelope, null, 2));
  const r = await runEnvelope(file, REPO, {
    exec: createFakeExec({ commitSha: "a".repeat(40), repoDir: REPO }),
    parentEnv: process.env,
    store: () => {
      throw new Error("DRY must never access the credential store");
    },
    ledger: new Ledger(join(tmp, "ledger"), now),
    now,
    out: io.out,
    dry: true,
    runInstall: true,
    dryKey: key,
    tsxCli: "unused-in-dry",
  });
  io.out(`self-test result: ${r.status} (artifacts in ${tmp})`);
  return r.status === "PASS" ? 0 : 1;
}

export type MainCtx = { ownerDir?: string; repo?: string };

export async function main(argv: string[], io: Io, stdin: NodeJS.ReadStream = process.stdin, ctx: MainCtx = {}): Promise<number> {
  const p = parseOpts(argv);
  if ("error" in p) {
    io.err(`refused: ${p.error}`);
    return 2;
  }
  const { cmd, opts } = p;
  const home = str(opts, "ledger-dir") ?? defaultHome();
  const ownerDir = ctx.ownerDir ?? defaultOwnerDir();
  const repoRoot = ctx.repo ?? REPO;
  const liveLedger = () => {
    const t = loadTrust(ownerDir);
    return t ? new Ledger(t.ledgerDir, () => new Date(), t.anchorFile) : null;
  };
  try {
    switch (cmd) {
      case "provision":
        return await provision(opts, io, stdin, home);
      case "dry":
        return await selfTest(io);
      case "repo-pins": {
        const pm = manifest(join(repoRoot, "scripts", "qa", "d24-m3d-proof"));
        const rm = runnerManifest(join(repoRoot, "scripts", "qa", "d24-test-runner"));
        io.out(JSON.stringify({ code: { lockfileSha256: lockfileSha(readFileSync(join(repoRoot, "package-lock.json"))) }, proof: { manifestSha256: pm.sha256, fileCount: pm.files.length }, runner: { manifestSha256: rm.sha256, fileCount: rm.files.length } }, null, 2));
        return 0;
      }
      case "approval-template": {
        const spec = JSON.parse(readFileSync(str(opts, "spec") ?? "", "utf8")) as EnvelopeSpec;
        io.out(approvalTemplate(spec));
        return 0;
      }
      case "create-envelope": {
        const specPath = str(opts, "spec");
        const apprPath = str(opts, "approval-file");
        const ref = str(opts, "approval-ref");
        const out = str(opts, "out");
        if (!specPath || !apprPath || !ref || !out) {
          io.err("--spec, --approval-file (the owner's approval text, verbatim), --approval-ref and --out are required; the runner cannot create its own approval");
          return 2;
        }
        const r = createEnvelope(JSON.parse(readFileSync(specPath, "utf8")) as EnvelopeSpec, readFileSync(apprPath, "utf8").trim(), ref);
        if (!r.ok) {
          for (const i of r.issues) io.err(`${i.code}: ${i.detail}`);
          return 2;
        }
        mkdirSync(dirname(resolve(out)), { recursive: true });
        writeFileSync(out, JSON.stringify(r.envelope, null, 2), { flag: "wx" });
        io.out(`envelope written to ${out}; sha256 ${r.envelope.envelopeSha256}`);
        return 0;
      }
      case "validate-envelope": {
        const v = validateEnvelope(JSON.parse(readFileSync(str(opts, "envelope") ?? "", "utf8")));
        if (!v.ok) {
          for (const i of v.issues) io.err(`${i.code}: ${i.detail}`);
          return 2;
        }
        io.out(`envelope valid; sha256 ${v.envelope.envelopeSha256}`);
        return 0;
      }
      case "run": {
        const envelope = str(opts, "envelope");
        if (!envelope) {
          io.err("--envelope is required");
          return 2;
        }
        if (opts.has("dry")) {
          // dry: fake child, temp ledger, a store factory that throws; no owner key needed because nothing live is possible
          const raw = JSON.parse(readFileSync(envelope, "utf8")) as { code?: { commitSha?: string } };
          const tmp = mkdtempSync(join(tmpdir(), "d24-runner-dry-"));
          const repo = resolve(str(opts, "repo") ?? repoRoot);
          const r = await runEnvelope(envelope, repo, {
            exec: createFakeExec({ commitSha: raw.code?.commitSha ?? "", repoDir: repo }), parentEnv: process.env,
            store: () => {
              throw new Error("DRY must never access the credential store");
            },
            ledger: new Ledger(join(tmp, "ledger")), now: () => new Date(), out: io.out, dry: true, runInstall: true, dryKey: ["rk", "test", "DRYRUNFAKE0123456789"].join("_"),
          });
          return r.exitCode;
        }
        // LIVE: no location or checkout can be chosen on the command line
        if (opts.has("ledger-dir") || opts.has("repo") || opts.has("home")) {
          io.err("refused: a live run takes its ledger location from the owner trust file and its checkout from this runner's own clone; --ledger-dir/--repo/--home are not accepted");
          return 2;
        }
        // LIVE runs always need the hardware-key approval (REQUIRE_HARDWARE_FOR_LIVE in runner.ts); the passphrase-sealed Ed25519 kind is dry/dev only
        if (!existsSync(join(HERE, ANCHOR_FILE))) {
          io.err(`refused (live): this checkout has no hardware anchor (${ANCHOR_FILE}), so no approval can be verified. Live runs require the owner's hardware-key approval; the owner enrollment is a design-only item, see docs/billing/D24-TEST-RUNNER-OWNER-AUTH.md section 7. Use --dry.`);
          return 2;
        }
        let hwDoc: unknown = null;
        {
          const hwPath = str(opts, "hw-approval") ?? `${envelope}.hw.json`;
          try {
            hwDoc = JSON.parse(readFileSync(hwPath, "utf8"));
          } catch {
            hwDoc = null;
          }
        }
        const gitBin = resolveGit(process.env.PATH);
        if (!gitBin) {
          io.err("refused (live): git was not found at an absolute path on PATH");
          return 2;
        }
        const envDoc = JSON.parse(readFileSync(envelope, "utf8")) as { credential?: { store?: string } };
        const kind = envDoc.credential?.store === "dpapi-file" ? "dpapi" : "wcm";
        const r = await runEnvelope(envelope, repoRoot, { exec: realExec, parentEnv: process.env, store: () => makeStore(kind, home), ledger: new Ledger(join(defaultRunnerHome(), "ledger"), () => new Date(), join(ownerDir, "ledger-anchor.json")), now: () => new Date(), out: io.out, dry: false, runInstall: true, gitBin, owner: { trust: null, signature: null, hardware: { doc: hwDoc } } });
        return r.exitCode;
      }
      case "ledger": {
        for (const e of (liveLedger() ?? new Ledger(join(home, "ledger"))).load()) io.out(`${e.seq} ${e.atUtc} ${e.type} envelope=${e.envelopeId} run=${e.runNo} ${e.outcome ?? e.note ?? ""}`);
        return 0;
      }
      case "reconcile": {
        const l = liveLedger() ?? new Ledger(join(home, "ledger"));
        l.reconcile(str(opts, "envelope-id") ?? "", Number(str(opts, "run-no")), str(opts, "note") ?? "");
        io.out("reconciled (the consumed run is NOT given back)");
        return 0;
      }
      default:
        io.err("usage: provision | repo-pins | approval-template | create-envelope | validate-envelope | run | dry | ledger | reconcile (see the header of cli.ts)");
        return 2;
    }
  } catch (e) {
    io.err(`error: ${sanitize(String((e as Error)?.message ?? e))}`);
    return 1;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main(process.argv.slice(2), { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) }).then((c) => process.exit(c));
}

