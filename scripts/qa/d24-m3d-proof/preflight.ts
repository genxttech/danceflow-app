// Local preflight (no Stripe call, ever). Checks everything about the intended isolated environment that CAN be checked locally, and lists what only the
// owner can confirm (printed as MANUAL, never reported as passed). A live run refuses on any FAIL.

import { execFile } from "node:child_process";
import { evaluateRequest } from "./allowlist";
import { CLEANUP_RESERVE, HARD_CALL_CAP, SANDBOX_NAME, STRIPE_API_VERSION } from "./config";
import { AUTHORIZATION_PHRASE, checkEnvironment, checkKeyShape, checkPinnedIds, ENV } from "./identity";
import { manifest } from "./manifest";
import type { Expect } from "./types";

export type PreflightCheck = { id: string; status: "ok" | "fail" | "manual"; detail: string };

/** Rows from `docker ps --filter label=df-d24-qa=1`: "<id>|<published ports>|<networks>". Injected so tests need no Docker. */
export type DockerProbe = () => Promise<{ available: boolean; rows: string[] }>;

export const defaultDockerProbe: DockerProbe = () =>
  new Promise((resolve) => {
    execFile("docker", ["ps", "--filter", "label=df-d24-qa=1", "--format", "{{.ID}}|{{.Ports}}|{{.Networks}}"], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve({ available: false, rows: [] });
      resolve({ available: true, rows: stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) });
    });
  });

/** Owner-supplied values for a live run (key, pinned ids, pinned script hash, approval sentence, environment). Never includes a secret value. */
export function liveRefusals(env: Record<string, string | undefined>, dir: string): { problems: string[]; expect?: Expect } {
  const problems: string[] = [];
  const k = checkKeyShape(env[ENV.key]);
  if (!k.ok) problems.push(`${ENV.key}: ${k.reason}`);
  const ids = checkPinnedIds(env);
  if (!ids.ok) problems.push(ids.reason);
  const pinned = env[ENV.pinnedSha] ?? "";
  const actual = manifest(dir).sha256;
  if (!/^[0-9a-f]{64}$/.test(pinned)) problems.push(`${ENV.pinnedSha} must be the 64-hex script hash printed by --print-hash`);
  else if (pinned !== actual) problems.push(`${ENV.pinnedSha} does not match this checkout's script hash (the script changed since it was pinned)`);
  if (env[ENV.phrase] !== AUTHORIZATION_PHRASE) problems.push(`${ENV.phrase} must be the owner's exact approval sentence`);
  problems.push(...checkEnvironment(env));
  return { problems, expect: ids.ok ? ids.expect : undefined };
}

export async function runPreflight(env: Record<string, string | undefined>, dir: string, docker: DockerProbe = defaultDockerProbe, nodeVersion = process.versions.node): Promise<PreflightCheck[]> {
  const out: PreflightCheck[] = [];
  const add = (id: string, ok: boolean, detail: string) => out.push({ id, status: ok ? "ok" : "fail", detail });

  add("node", Number(nodeVersion.split(".")[0]) >= 20, `node ${nodeVersion} (needs >= 20 for global fetch/structuredClone)`);

  const r = liveRefusals(env, dir);
  add("owner-values", r.problems.length === 0, r.problems.length === 0 ? "key shape rk_test_, two distinct pinned acct_ ids, script hash pin, approval sentence, clean environment" : r.problems.join(" | "));

  // static facts about THIS script, asserted by actually evaluating the allow-list
  const acct = r.expect?.connectedAcct ?? "acct_PREFLIGHTCHECK1";
  const probe = (body: Record<string, string>) =>
    evaluateRequest({ method: "POST", path: "/v1/customers", stripeAccount: acct, idempotencyKey: "d24proof-pf-1", stripeVersion: STRIPE_API_VERSION, body }, { connectedAcct: acct });
  add("fixture-synthetic-email", !probe({ name: "x", email: "a@b.co" }).ok && !probe({ name: "x" }).ok && probe({ name: "x", email: "d24-proof-abc123-a@example.com" }).ok, "the allow-list accepts only the synthetic d24-proof-<run>-<ref>@example.com customer email (required by Stripe for send_invoice drafts) and refuses any other address");
  const noVersion = evaluateRequest({ method: "GET", path: "/v1/account" }, { connectedAcct: acct });
  add("version-pin", !noVersion.ok, `every request must carry Stripe-Version ${STRIPE_API_VERSION}`);
  add("call-cap", HARD_CALL_CAP === 40 && CLEANUP_RESERVE === 8, `hard cap ${HARD_CALL_CAP} calls, ${CLEANUP_RESERVE} reserved for cleanup`);

  // local disposable Postgres: the proof itself uses no database in this revision, but if a labelled QA container is running it must be isolated
  const d = await docker();
  if (!d.available) out.push({ id: "local-postgres", status: "manual", detail: "docker not reachable: could not inspect labelled QA containers (this revision uses no database)" });
  else {
    const bad = d.rows.filter((row) => {
      const [, ports = "", networks = ""] = row.split("|");
      return ports.trim() !== "" || networks.trim() !== "none";
    });
    if (bad.length > 0) add("local-postgres", false, `labelled QA container(s) with published ports or a network (must be none/none): ${bad.map((b) => b.split("|")[0]).join(", ")}`);
    else add("local-postgres", true, d.rows.length === 0 ? "no labelled QA container running (this revision uses no database)" : `${d.rows.length} labelled QA container(s), no published ports, network none`);
  }

  // what only the owner can confirm; reported as MANUAL, never as passed
  const manual = (id: string, detail: string) => out.push({ id, status: "manual", detail });
  manual("sandbox", `a NEW Stripe sandbox named "${SANDBOX_NAME}" exists, distinct from the D7 and C6 sandboxes, DanceFlow Dev and production (the name is never trusted: only the pinned platform id is)`);
  manual("connected-account", "exactly ONE connected test account with Express dashboard access exists in that sandbox (legacy type=express, or the controller-model equivalent: type=none with controller type application, stripe_dashboard express, requirement_collection stripe, losses.payments application, fees.payer application or application_express), created with Stripe's test onboarding data");
  manual("key-permissions", "the restricted rk_test_ key was created for this proof only with exactly Invoices=Write, Customers=Write, connected-account Read; everything else None");
  manual("no-webhooks", "the sandbox has no webhook endpoints for this proof; the key cannot create any");
  manual("api-version", `record the account's default API version from the dashboard; the proof sends Stripe-Version ${STRIPE_API_VERSION} on every request regardless`);
  return out;
}
