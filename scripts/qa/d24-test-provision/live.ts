// LIVE entry point for D24 TEST-account provisioning. Exists ONLY to be run by .github/workflows/d24-provision-account.yml after the owner approves that run
// in the protected `d24-stripe-test` environment. It sends exactly the three requests of provision.ts (platform read, ONE create, readback) through the proof's
// pinned-origin transport, and judges the result with the proof's unchanged identity gate. It does NOT touch run.ts: `run.ts --live` stays permanently refused.
//
// Everything that decides what may be sent lives in provision.ts (default-deny allow-list, hard cap 3, no retry). This file only wires inputs and a real transport,
// refuses unless every precondition holds BEFORE the transport is built, and writes a non-secret summary (ids and enums only; never the key, never the idempotency key).
//
//   node tsx live.ts --live      with the D24_PROVISION_* variables set by the workflow
//
// Exit codes: 0 provisioned and verified; 1 aborted by a safety check or Stripe (see the summary); 2 refused before any request (bad usage or environment).

import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkKeyShape } from "../d24-m3d-proof/identity";
import { redactText, looksLikeLiveSecret } from "../d24-m3d-proof/redact";
import { createNodeTransport } from "../d24-m3d-proof/transport";
import type { Transport } from "../d24-m3d-proof/types";
import { AUTHORIZATION_PHRASE, ENV, ENVELOPE_REF_RE, PROVISION_API_VERSION, PROVISION_HARD_CALL_CAP, ProvisionAbort, runProvision, type ProvisionResult } from "./provision";

export const SUMMARY_ENV = "D24_PROVISION_SUMMARY_FILE";
/** The proof key must never be present in the provisioning process: the two keys have different, non-overlapping powers. */
export const PROOF_KEY_ENV = "D24_PROOF_STRIPE_KEY";

export type Io = { out: (s: string) => void; err: (s: string) => void };
export type Deps = { transport?: Transport; newIdempotencyKey?: () => string; now?: () => Date };

const ACCT = /^acct_[A-Za-z0-9]{6,64}$/;
const REQ = /^req_[A-Za-z0-9]{6,64}$/;
const safeReq = (r: string | undefined) => (r && REQ.test(r) ? r : "-");

/** Why the process must refuse before any request (null = go). Pure; never prints a value from `env`. */
export function preconditionProblem(argv: string[], env: Record<string, string | undefined>): string | null {
  if (argv.length !== 1 || argv[0] !== "--live") return "exactly one argument, --live, is required";
  if (env[ENV.phrase] !== AUTHORIZATION_PHRASE) return `${ENV.phrase} is not the authorization sentence supplied by the reviewed workflow`;
  const platform = env[ENV.platform] ?? "";
  if (!ACCT.test(platform) || /PLACEHOLDER/i.test(platform)) return `${ENV.platform} is not a real pinned platform account id`;
  if (!ENVELOPE_REF_RE.test(env[ENV.envelope] ?? "")) return `${ENV.envelope} is not a well-formed run reference`;
  const key = checkKeyShape(env[ENV.key]);
  if (!key.ok) return `${ENV.key}: ${key.reason}`;
  if (env[PROOF_KEY_ENV] !== undefined && env[PROOF_KEY_ENV] !== "") return `${PROOF_KEY_ENV} must not be present in the provisioning process (the keys are separate)`;
  for (const [name, v] of Object.entries(env)) if (typeof v === "string" && looksLikeLiveSecret(v)) return `environment variable ${name.slice(0, 40)} looks like a live key`;
  if (!env[SUMMARY_ENV]) return `${SUMMARY_ENV} is required (the only place results are written)`;
  return null;
}

export function successSummary(r: ProvisionResult, envelopeRef: string): string {
  const lines = [
    "## D24 TEST account provisioning - result: PROVISIONED AND VERIFIED",
    "",
    `- run reference (also stored in the account's metadata as \`d24_envelope_ref\`): \`${envelopeRef}\``,
    `- new connected account id (a TEST id, not a credential; it is pinned in a reviewed PR next): \`${ACCT.test(r.accountId) ? r.accountId : "(unexpected)"}\``,
    `- Stripe-Version: \`${PROVISION_API_VERSION}\`; hard cap ${PROVISION_HARD_CALL_CAP} requests; no retries`,
    `- requests sent: ${r.calls.length}`,
    ...r.calls.map((c) => `  - ${c.atUtc} ${c.method} ${c.path.replace(/acct_[A-Za-z0-9]+/, "acct_<new>")} -> ${c.status} (${safeReq(c.requestId)})`),
    `- observed Express (controller-model) configuration: \`${JSON.stringify(r.observedController)}\``,
    `- capabilities as returned: \`${JSON.stringify(r.capabilities)}\`; charges_enabled: \`${String(r.chargesEnabled)}\``,
    `- idempotency key SHA-256: \`${r.idempotencyKeySha256}\``,
    "",
    "Owner check (dashboard glance): in the sandbox, Developers > Logs for the provisioning key must show exactly the requests above and nothing else. Then expire the provisioning key and delete the environment secret.",
    "Provisioning is one-shot: do NOT run this workflow again.",
  ];
  return `${lines.join("\n")}\n`;
}

export function failureSummary(code: string, message: string): string {
  return [
    "## D24 TEST account provisioning - result: ABORTED",
    "",
    `- reason code: \`${code}\``,
    `- detail: ${redactText(message).slice(0, 400)}`,
    "",
    "Do NOT re-run. If the code is `transport_error` or `unexpected_status` the create may have happened: look in the sandbox dashboard for an account whose metadata contains the run reference, and ask engineering for a new run reference.",
    "Expire the provisioning key and delete the environment secret.",
  ].join("\n") + "\n";
}

export async function main(argv: string[], env: Record<string, string | undefined>, io: Io, deps: Deps = {}): Promise<number> {
  const problem = preconditionProblem(argv, env);
  if (problem) {
    io.err(`REFUSED before any request: ${redactText(problem)}`);
    return 2;
  }
  const summaryFile = env[SUMMARY_ENV] as string;
  const envelopeRef = env[ENV.envelope] as string;
  const write = (text: string) => appendFileSync(summaryFile, text, { encoding: "utf8" });
  try {
    const transport = deps.transport ?? createNodeTransport(); // pinned to https://api.stripe.com, one connection per request, no redirects
    const result = await runProvision({
      transport,
      apiKey: env[ENV.key] as string,
      expectPlatformAcct: env[ENV.platform] as string,
      envelopeRef,
      idempotencyKey: (deps.newIdempotencyKey ?? (() => `d24prov-${randomBytes(12).toString("hex")}`))(),
      now: deps.now,
      variant: "controller_express", // legacy type=express direct charges are blocked for new platforms; see provision.ts
    });
    write(successSummary(result, envelopeRef));
    io.out(`PROVISIONED and verified; ${result.calls.length} requests; details in the job summary`);
    return 0;
  } catch (e) {
    const code = e instanceof ProvisionAbort ? e.code : "unexpected_error";
    const message = e instanceof ProvisionAbort ? e.message : "unexpected error before or during provisioning";
    write(failureSummary(code, message));
    io.err(`ABORTED: ${code}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env, { out: (s) => console.log(s), err: (s) => console.error(s) }).then((c) => process.exit(c));
}
