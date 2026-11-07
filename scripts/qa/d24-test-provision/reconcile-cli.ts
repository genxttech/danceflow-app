// Offline CLI: npx tsx scripts/qa/d24-test-provision/reconcile-cli.ts --transcript <transcript-*.txt> --provider <provider-log.json>
// Reads two local files, prints the findings, exits 0 only when CONSISTENT. Makes no network call and prints no secret.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { sanitize } from "../d24-m3d-proof/evidence";
import { parseProofTranscript, parseProviderLog, reconcile } from "./reconcile";

export function main(argv: string[], out: (s: string) => void): number {
  const get = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const t = get("--transcript");
  const p = get("--provider");
  if (!t || !p) { out("usage: --transcript <file> --provider <file>"); return 2; }
  const sent = parseProofTranscript(readFileSync(t, "utf8"));
  let parsed;
  try { parsed = parseProviderLog(JSON.parse(readFileSync(p, "utf8"))); } catch { out("provider file is not valid JSON"); return 2; }
  if (parsed.problems.length > 0) { for (const x of parsed.problems) out(`INPUT PROBLEM: ${sanitize(x)}`); return 2; }
  const r = reconcile(sent, parsed.entries, parsed.provenance);
  out(`verdict: ${r.verdict}   independent verification: ${r.independentVerification}`);
  out(`app network requests ${r.counts.sentNetwork}, blocked ${r.counts.sentBlocked}, provider in window ${r.counts.providerInWindow}, matched ${r.counts.matched}`);
  for (const e of r.perEndpoint) out(`  ${e.key}: app ${e.sent} / provider ${e.provider}`);
  for (const f of r.findings) out(`${f.severity.toUpperCase()} ${f.kind}${f.requestId ? ` [${f.requestId}]` : ""}: ${sanitize(f.detail)}`);
  out("A CONSISTENT verdict is NOT proof the provider log is complete or genuine: a human must still compare it with the Stripe dashboard (see D24-REQUEST-RECONCILIATION.md).");
  return r.verdict === "CONSISTENT" ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2), (s) => console.log(s)));
