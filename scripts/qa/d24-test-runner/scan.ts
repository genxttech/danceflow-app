// Secret / PII scanning and sanitising for everything the RUNNER prints, logs or reports. Findings never include the matched text.

export type Finding = { kind: string; severity: "secret" | "warn"; count: number };

const PATTERNS: Array<{ kind: string; severity: "secret" | "warn"; re: RegExp; to: string }> = [
  { kind: "stripe-key", severity: "secret", re: /(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9]+/g, to: "[REDACTED_KEY]" },
  { kind: "webhook-secret", severity: "secret", re: /whsec_[A-Za-z0-9]+/g, to: "[REDACTED_WHSEC]" },
  { kind: "bearer-token", severity: "secret", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, to: "Bearer [REDACTED]" },
  { kind: "authorization-header", severity: "secret", re: /\bAuthorization\s*[:=]\s*\S+(?:\s+\S+)?/gi, to: "Authorization: [REDACTED]" },
  { kind: "email", severity: "secret", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, to: "[REDACTED_EMAIL]" },
  { kind: "unmasked-account-id", severity: "warn", re: /acct_[A-Za-z0-9]{12,}(?![A-Za-z0-9…])/g, to: "[ACCT_ID]" },
];

/** Literals (e.g. the exact key held in memory) that must never appear, in any form: plain, reversed-free substring match on length >= 8. */
export function scanForSecrets(text: string, literals: readonly string[] = []): Finding[] {
  const out: Finding[] = [];
  for (const p of PATTERNS) {
    const n = (text.match(p.re) ?? []).length;
    if (n > 0) out.push({ kind: p.kind, severity: p.severity, count: n });
  }
  for (const lit of literals) {
    if (lit.length >= 8 && text.includes(lit)) out.push({ kind: "exact-credential-literal", severity: "secret", count: text.split(lit).length - 1 });
  }
  return out;
}

export function sanitize(text: string, literals: readonly string[] = []): string {
  let s = text;
  for (const lit of literals) if (lit.length >= 8) s = s.split(lit).join("[REDACTED_KEY]");
  for (const p of PATTERNS) if (p.severity === "secret") s = s.replace(p.re, p.to);
  return s;
}

export const hasSecretFinding = (f: Finding[]): boolean => f.some((x) => x.severity === "secret");
