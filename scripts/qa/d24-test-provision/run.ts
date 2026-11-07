// CLI for D24 TEST-account provisioning: PLAN + DRY-RUN ONLY. `--live` is permanently disabled in this PR and exits 3 unconditionally: this file imports no real
// transport and holds no code path that can send POST /v1/accounts. Live provisioning is re-enabled only later, through the test-runner's owner-signed envelope,
// ledger and credential store, in a separate reviewed change.
//
//   npx tsx scripts/qa/d24-test-provision/run.ts --plan      # prints the exact requests, no network
//   npx tsx scripts/qa/d24-test-provision/run.ts --dry-run   # runs the whole flow against an in-memory fake, no network
//   npx tsx scripts/qa/d24-test-provision/run.ts --live      # always refused (exit 3); nothing is read, nothing is sent

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVISION_API_VERSION, PROVISION_HARD_CALL_CAP, buildCreateRequest, createFakeProvisionTransport, runProvision } from "./provision";

export type Io = { out: (s: string) => void; err: (s: string) => void };

export const LIVE_DISABLED_MESSAGE =
  "REFUSED (nothing was read or sent): --live is disabled in this tool. Live provisioning is re-enabled only later, through the test-runner's owner-signed envelope, ledger and credential store.";

/** `env` and `deps` are accepted only so callers/tests can prove they are never used for a live call. */
export type Deps = { transport?: unknown; now?: () => Date; newIdempotencyKey?: () => string };

export async function main(argv: string[], _env: Record<string, string | undefined>, io: Io, deps: Deps = {}): Promise<number> {
  const flags = argv.filter((a) => a.startsWith("--"));
  if (flags.length !== 1 || argv.length !== 1 || !["--plan", "--dry-run", "--live"].includes(flags[0])) {
    io.err("exactly one of --plan | --dry-run | --live is required (no positional arguments)");
    return 2;
  }
  const mode = flags[0];
  if (mode === "--live") {
    io.err(LIVE_DISABLED_MESSAGE);
    return 3;
  }
  const idemKey = (deps.newIdempotencyKey ?? (() => `d24prov-${randomBytes(12).toString("hex")}`))();
  const dryEnvelope = "D24-ENV-00000000-DRYRUN000";

  if (mode === "--plan") {
    const req = buildCreateRequest({ envelopeRef: dryEnvelope, idempotencyKey: "d24prov-<random>" });
    io.out(`Stripe-Version ${PROVISION_API_VERSION}; hard cap ${PROVISION_HARD_CALL_CAP} calls; no retry. PLAN ONLY: this tool cannot run live.`);
    io.out("1. GET  /v1/account                      (platform identity, must equal the pinned id)");
    io.out(`2. POST /v1/accounts ${JSON.stringify(req.body)}`);
    io.out("3. GET  /v1/accounts/<created id>        (independent readback; judged by the proof's identity gate)");
    return 0;
  }
  const platformId = "acct_FAKEPLATFORM01";
  const fake = createFakeProvisionTransport({ platformId });
  const res = await runProvision({ transport: fake.transport, apiKey: "rk_test_dryrunonly000000", expectPlatformAcct: platformId, envelopeRef: dryEnvelope, idempotencyKey: idemKey, now: deps.now });
  io.out(`dry-run OK against the fake: ${res.calls.map((c) => `${c.method} ${c.path} -> ${c.status}`).join(" | ")}; observed ${JSON.stringify(res.observedController)}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env, { out: (s) => console.log(s), err: (s) => console.error(s) }).then((c) => process.exit(c));
}
