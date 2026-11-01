import { readFileSync } from "node:fs";
import { assertOperationAllowed, recordProofEntry, scrubAccountEvidence, type ProofLogEntry } from "@/lib/billing/priceTransitionProofGuard";

export function loadKey(envFile: string): string {
  const text = readFileSync(envFile, "utf8");
  const line = text.split(/\r?\n/).find((l) => l.startsWith("STRIPE_SECRET_KEY="));
  return (line ?? "").slice("STRIPE_SECRET_KEY=".length).replace(/^["']|["']$/g, "").trim();
}

export const log: ProofLogEntry[] = [];

/** Runs one allowlisted operation, records the redacted request/response (or the error), and rethrows errors. */
export async function op<T>(operation: string, request: unknown, fn: () => Promise<T>): Promise<T> {
  assertOperationAllowed(operation);
  try {
    const response = await fn();
    recordProofEntry(log, operation, request, operation === "accounts.retrieve" ? scrubAccountEvidence(response) : response);
    return response;
  } catch (error) {
    const e = error as { type?: string; code?: string; statusCode?: number; message?: string; requestId?: string };
    recordProofEntry(log, operation, request, { error: { type: e.type, code: e.code, status: e.statusCode, message: e.message, requestId: e.requestId } });
    throw error;
  }
}
