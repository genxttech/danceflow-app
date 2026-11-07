// Offline CLI:
//   npx tsx scripts/qa/d24-test-provision/reconcile-cli.ts --transcript <transcript-*.txt> --provider <provider-log.json> --window-start <ISO> --window-end <ISO>
// Reads two local files, prints the findings. Makes no network call and prints no secret. The run window is REQUIRED and must come from the operator, never from the transcript.
//
// Exit codes (there is deliberately NO exit 0: a tool cannot establish independent verification):
//   10  CONSISTENT_UNVERIFIED  no discrepancy found, but independent Dashboard/Workbench verification is STILL REQUIRED
//    1  DISCREPANCIES          at least one failing finding
//    2  usage or input problem (nothing was compared)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { sanitize } from "../d24-m3d-proof/evidence";
import { ISO_UTC, MAX_WINDOW_MS, parseProofTranscript, parseProviderLog, reconcile } from "./reconcile";

export const EXIT_CONSISTENT_UNVERIFIED = 10;
export const EXIT_DISCREPANCIES = 1;
export const EXIT_INPUT = 2;

export function main(argv: string[], out: (s: string) => void): number {
  const get = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const t = get("--transcript");
  const p = get("--provider");
  const ws = get("--window-start");
  const we = get("--window-end");
  if (!t || !p || !ws || !we) { out("usage: --transcript <file> --provider <file> --window-start <ISO-8601 UTC> --window-end <ISO-8601 UTC> (the window is the operator's own run start/end, not taken from the transcript)"); return EXIT_INPUT; }
  if (!ISO_UTC.test(ws) || !ISO_UTC.test(we) || Date.parse(ws) >= Date.parse(we) || Date.parse(we) - Date.parse(ws) > MAX_WINDOW_MS) { out("window-start/window-end must be ISO-8601 UTC (Z or +00:00) timestamps, start before end, at most 24 h apart"); return EXIT_INPUT; }
  let sentParsed;
  try { sentParsed = parseProofTranscript(readFileSync(t, "utf8")); } catch { out("transcript file could not be read"); return EXIT_INPUT; }
  let parsed;
  try { parsed = parseProviderLog(JSON.parse(readFileSync(p, "utf8"))); } catch { out("provider file is not valid JSON"); return EXIT_INPUT; }
  if (parsed.problems.length > 0) { for (const x of parsed.problems) out(`INPUT PROBLEM: ${sanitize(x)}`); return EXIT_INPUT; }
  const r = reconcile(sentParsed.requests, parsed.entries, parsed.provenance, { window: { fromUtc: ws, toUtc: we }, unparsedTranscriptLines: sentParsed.unparsed });
  out(`verdict: ${r.verdict === "CONSISTENT" ? "CONSISTENT_UNVERIFIED" : r.verdict}   independent verification: ${r.independentVerification}`);
  out(`app network requests ${r.counts.sentNetwork}, blocked ${r.counts.sentBlocked}, provider in window ${r.counts.providerInWindow}, matched ${r.counts.matched}`);
  for (const e of r.perEndpoint) out(`  ${e.key}: app ${e.sent} / provider ${e.provider}`);
  for (const f of r.findings) out(`${f.severity.toUpperCase()} ${f.kind}${f.requestId ? ` [${f.requestId}]` : ""}: ${sanitize(f.detail)}`);
  out("A CONSISTENT verdict is NOT independent verification and NOT proof the provider log is complete or genuine: a human must still compare it with the Stripe dashboard (see D24-REQUEST-RECONCILIATION.md).");
  return r.verdict === "CONSISTENT" ? EXIT_CONSISTENT_UNVERIFIED : EXIT_DISCREPANCIES;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2), (s) => console.log(s)));
