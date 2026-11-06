// D24 M3-D Stripe TEST-mode proof: shared types. PROOF-ONLY code (never imported from src/). No Stripe SDK here: the
// only network path is the injected Transport, and every request passes the allow-list BEFORE the transport is called.

export type Method = "GET" | "POST" | "DELETE";

/** One Stripe API request, fully described (no hidden headers). Body keys are Stripe form keys, e.g. metadata[d24_intent_id]. */
export type ProofRequest = {
  method: Method;
  path: string;
  query?: Record<string, string>;
  /** Value of the Stripe-Account header, when sent. */
  stripeAccount?: string;
  idempotencyKey?: string;
  body?: Record<string, string>;
};

export type ProofResponse = {
  status: number;
  requestId?: string;
  /** Idempotent-Replayed response header, when Stripe sent it. */
  replayed?: boolean;
  json: Record<string, unknown> | null;
};

/** The ONLY thing that can reach the network. Called by the guarded client after the allow-list approved the request. */
export type Transport = (req: ProofRequest, apiKey: string) => Promise<ProofResponse>;

export type Expect = { platformAcct: string; connectedAcct: string };

/** Why a run stopped. Every abort is a typed error so callers (and tests) can distinguish them. */
export type AbortCode =
  | "blocked_request"
  | "budget_exceeded"
  | "livemode_true"
  | "non_draft_invoice"
  | "identity_mismatch"
  | "unexpected_4xx_streak"
  | "server_error_streak"
  | "rate_limited"
  | "interrupted"
  | "environment_refused"
  | "key_refused";

export class ProofAbort extends Error {
  readonly code: AbortCode;
  constructor(code: AbortCode, message: string) {
    super(message);
    this.name = "ProofAbort";
    this.code = code;
  }
}

export type TranscriptEntry = {
  n: number;
  atUtc: string;
  method: Method;
  path: string;
  query: string;
  stripeAccount: string;
  idempotencyKey: string;
  status: number | "BLOCKED" | "ERROR";
  requestId: string;
  replayed: boolean | null;
  /** Only id/livemode/status/total/object of the response, never the body. */
  summary: Record<string, unknown>;
  note?: string;
};
