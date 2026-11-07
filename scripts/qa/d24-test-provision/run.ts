// CLI for D24 TEST-account provisioning. NOT AUTHORIZED TO RUN LIVE: --live refuses unless an owner-issued envelope reference, the authorization phrase, the
// pinned sandbox platform id, a restricted TEST key and an evidence directory outside every git checkout are all supplied. Nothing reads a key from argv or a file.
//
//   npx tsx scripts/qa/d24-test-provision/run.ts --plan      # prints the exact requests, no network
//   npx tsx scripts/qa/d24-test-provision/run.ts --dry-run   # runs the whole flow against an in-memory fake, no network
//   npx tsx scripts/qa/d24-test-provision/run.ts --live      # REAL Stripe TEST calls (3 at most); refused without the envelope

import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceDirProblem, maskAccountIds, sanitize } from "../d24-m3d-proof/evidence";
import { checkEnvironment, checkKeyShape } from "../d24-m3d-proof/identity";
import { createNodeTransport } from "../d24-m3d-proof/transport";
import type { Transport } from "../d24-m3d-proof/types";
import { AUTHORIZATION_PHRASE, ENV, ENVELOPE_REF_RE, PROVISION_API_VERSION, PROVISION_HARD_CALL_CAP, ProvisionAbort, buildCreateRequest, createFakeProvisionTransport, runProvision } from "./provision";

export type Io = { out: (s: string) => void; err: (s: string) => void };
const ACCT = /^acct_[A-Za-z0-9]{6,64}$/;

/** Reasons --live must not proceed (empty = clear). Never includes a secret value. */
export function liveRefusals(env: Record<string, string | undefined>, repoRoot: string): string[] {
  const r: string[] = [];
  const key = checkKeyShape(env[ENV.key]);
  if (!key.ok) r.push(`${ENV.key}: ${key.reason}`);
  if (!ACCT.test(env[ENV.platform] ?? "")) r.push(`${ENV.platform} must be the pinned sandbox platform account id (acct_…)`);
  if (!ENVELOPE_REF_RE.test(env[ENV.envelope] ?? "")) r.push(`${ENV.envelope} must be the owner-issued envelope reference (D24-ENV-<yyyymmdd>-<id>); without it this script never runs live`);
  if (env[ENV.phrase] !== AUTHORIZATION_PHRASE) r.push(`${ENV.phrase} must be exactly the owner's authorization phrase`);
  if (!env[ENV.evidenceDir]) r.push(`${ENV.evidenceDir} is required (the new account id must be captured outside git)`);
  else {
    const p = evidenceDirProblem(env[ENV.evidenceDir], repoRoot);
    if (p) r.push(p.replace("D24_PROOF_EVIDENCE_DIR", ENV.evidenceDir));
  }
  for (const p of checkEnvironment(Object.fromEntries(Object.entries(env).filter(([k]) => k !== ENV.key)))) r.push(p);
  return r;
}

export type Deps = { transport?: Transport; repoRoot?: string; now?: () => Date; newIdempotencyKey?: () => string };

export async function main(argv: string[], env: Record<string, string | undefined>, io: Io, deps: Deps = {}): Promise<number> {
  const flags = argv.filter((a) => a.startsWith("--"));
  if (flags.length !== 1 || argv.length !== 1 || !["--plan", "--dry-run", "--live"].includes(flags[0])) {
    io.err("exactly one of --plan | --dry-run | --live is required (no positional arguments; keys and ids come from the environment only)");
    return 2;
  }
  const mode = flags[0];
  const repoRoot = deps.repoRoot ?? resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const idemKey = (deps.newIdempotencyKey ?? (() => `d24prov-${randomBytes(12).toString("hex")}`))();
  const dryEnvelope = "D24-ENV-00000000-DRYRUN000";

  if (mode === "--plan") {
    const req = buildCreateRequest({ envelopeRef: dryEnvelope, idempotencyKey: "d24prov-<random>" });
    io.out(`Stripe-Version ${PROVISION_API_VERSION}; hard cap ${PROVISION_HARD_CALL_CAP} calls; no retry.`);
    io.out("1. GET  /v1/account                      (platform identity, must equal the pinned id)");
    io.out(`2. POST /v1/accounts ${JSON.stringify(req.body)}`);
    io.out("3. GET  /v1/accounts/<created id>        (independent readback; judged by the proof's identity gate)");
    return 0;
  }
  if (mode === "--dry-run") {
    const platformId = "acct_FAKEPLATFORM01";
    const fake = createFakeProvisionTransport({ platformId });
    const res = await runProvision({ transport: fake.transport, apiKey: "rk_test_dryrunonly000000", expectPlatformAcct: platformId, envelopeRef: dryEnvelope, idempotencyKey: idemKey, now: deps.now });
    io.out(`dry-run OK against the fake: ${res.calls.map((c) => `${c.method} ${c.path} -> ${c.status}`).join(" | ")}; observed ${JSON.stringify(res.observedController)}`);
    return 0;
  }

  const refusals = liveRefusals(env, repoRoot);
  if (refusals.length > 0) {
    io.err(`REFUSED (nothing was sent):\n - ${refusals.map((x) => sanitize(x)).join("\n - ")}`);
    return 3;
  }
  const transport = deps.transport ?? createNodeTransport();
  const envelopeRef = env[ENV.envelope] as string;
  try {
    const res = await runProvision({ transport, apiKey: env[ENV.key] as string, expectPlatformAcct: env[ENV.platform] as string, envelopeRef, idempotencyKey: idemKey, now: deps.now });
    const dir = env[ENV.evidenceDir] as string;
    const again = evidenceDirProblem(dir, repoRoot);
    if (again) throw new Error(again);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(realpathSync(dir), `provision-${res.accountId.slice(5, 13)}-${Date.now()}.json`);
    // The full account id is written here (the owner pins it for the proof); the key is never present. Stdout shows only a masked id.
    writeFileSync(file, JSON.stringify({ role: "express_prod_equivalent_POSITIVE_FIXTURE", envelopeRef, apiVersion: PROVISION_API_VERSION, ...res }, null, 2), { mode: 0o600, flag: "wx" });
    io.out(`created ${maskAccountIds(res.accountId)}; observed ${JSON.stringify(res.observedController)}; capabilities ${JSON.stringify(res.capabilities)}`);
    io.out(`evidence: ${sanitize(file)}. Owner next: roll/expire the provisioning key, then pin the account id in the proof environment.`);
    return 0;
  } catch (e) {
    const code = e instanceof ProvisionAbort ? e.code : "unexpected";
    io.err(`ABORTED (${code}): ${sanitize(String((e as Error)?.message ?? e))}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env, { out: (s) => console.log(s), err: (s) => console.error(s) }).then((c) => process.exit(c));
}
