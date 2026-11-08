// The public job summary for the GitHub-hosted proof. The repository is PUBLIC, so the summary carries ONLY: outcome, PASS / FAIL / BLOCKED counts, the request count and two SHA-256
// values (ciphertext file, plaintext bundle). No account id, no object id, no message text, no free text from Stripe or the evidence is ever copied: every number is a count
// and the outcome is one of a fixed set.

export type SummaryFacts = {
  outcome: "OK" | "FAILED" | "INCOMPLETE" | "NO_EVIDENCE" | "UNREADABLE";
  pass: number;
  fail: number;
  blocked: number;
  requests: number;
};

const OUTCOMES = new Set(["OK", "FAILED", "INCOMPLETE"]);
const count = (n: unknown): number => (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 1_000_000 ? n : 0);

/** `evidenceJson` is the text of evidence-<runid>.json, or null when the run wrote no evidence pack. */
export function factsFrom(evidenceJson: string | null): SummaryFacts {
  if (evidenceJson === null) return { outcome: "NO_EVIDENCE", pass: 0, fail: 0, blocked: 0, requests: 0 };
  let o: unknown;
  try {
    o = JSON.parse(evidenceJson);
  } catch {
    return { outcome: "UNREADABLE", pass: 0, fail: 0, blocked: 0, requests: 0 };
  }
  const e = (o && typeof o === "object" && !Array.isArray(o) ? o : {}) as Record<string, unknown>;
  let pass = 0;
  let fail = 0;
  if (Array.isArray(e.scenarios)) {
    for (const s of e.scenarios) {
      const checks = (s as { checks?: unknown })?.checks;
      if (!Array.isArray(checks)) continue;
      for (const c of checks) {
        if ((c as { ok?: unknown })?.ok === true) pass += 1;
        else fail += 1;
      }
    }
  }
  return {
    outcome: typeof e.outcome === "string" && OUTCOMES.has(e.outcome) ? (e.outcome as SummaryFacts["outcome"]) : "UNREADABLE",
    pass,
    fail,
    blocked: count(e.blockedBeforeNetwork),
    requests: count(e.callsUsed),
  };
}

export function renderSummary(f: SummaryFacts, ciphertextSha256: string, plaintextSha256: string): string {
  const hex = (s: string) => (/^[0-9a-f]{64}$/.test(s) ? s : "invalid");
  return [
    "## D24 Stripe TEST proof - result",
    "",
    `- outcome: **${f.outcome}**`,
    `- checks: PASS ${f.pass} / FAIL ${f.fail} / BLOCKED ${f.blocked}`,
    `- Stripe requests used: ${f.requests}`,
    `- sha256 of the encrypted evidence file (artifact): \`${hex(ciphertextSha256)}\``,
    `- sha256 of the plaintext evidence bundle: \`${hex(plaintextSha256)}\``,
    "",
    "The evidence itself is encrypted to the engineering evidence key and is not shown here.",
    "",
  ].join("\n");
}
