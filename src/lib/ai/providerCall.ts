import { checkRateLimit } from "@/lib/security/rate-limit";

/**
 * The ONE place that talks to the OpenAI Responses API.
 *
 * Every cost-bearing provider request in the app goes through `callOpenAiResponses`, so the controls below cannot be
 * forgotten by an individual action:
 *   - fail closed: no provider call unless AI_FEATURES_ENABLED === "true" and OPENAI_API_KEY is set;
 *   - per-feature deny switch: AI_DISABLED_FEATURES (comma list of AiFeature) turns a single feature off without touching
 *     the others; unset = current behaviour;
 *   - input size cap (characters of everything sent) and output token cap, both clamped to hard ceilings;
 *   - request timeout (AbortSignal.timeout), so a hung provider cannot hold a function open or run up cost unobserved;
 *   - optional best-effort budget per feature (in-memory per instance, see rate-limit.ts: a speed bump, not a hard budget);
 *   - no raw provider error text ever reaches the caller: callers get a stable reason and a safe message;
 *   - `store: false` on every request;
 *   - one accounting log line per attempt (feature, model, outcome, latency, sizes, provider-reported token usage). No prompt
 *     or response content, no user or studio identifiers.
 *
 * It does NOT meter usage against a studio/dancer allowance; that stays with the caller (the entitlement differs per feature).
 */

export type AiFeature =
  | "lumi_plan"
  | "lesson_assistant"
  | "follow_up"
  | "campaign_draft"
  | "event_description"
  | "report_insights"
  | "kb_public";

export type AiCallFailureReason =
  | "disabled"
  | "not_configured"
  | "input_too_large"
  | "budget_exceeded"
  | "timeout"
  | "provider_error"
  | "empty_output";

export const AI_SAFE_MESSAGES: Record<AiCallFailureReason, string> = {
  disabled: "This AI feature is not available right now.",
  not_configured: "This AI feature is not configured yet.",
  input_too_large: "That request is too large for the AI assistant. Shorten it and try again.",
  budget_exceeded: "AI help is busy right now. Please try again in a little while.",
  timeout: "The AI assistant took too long to respond. Please try again.",
  provider_error: "The AI assistant could not complete that right now. Please try again.",
  empty_output: "The AI assistant did not return a readable response. Please try again.",
};

export type AiCallResult =
  | {
      ok: true;
      text: string;
      model: string;
      usage: { inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null };
    }
  | {
      ok: false;
      reason: AiCallFailureReason;
      message: string;
      /** True when the request may have reached the provider and been billed (timeout, dropped connection, empty output). */
      mayHaveBilled: boolean;
    };

export type AiInputMessage = { role: "system" | "user" | "assistant"; content: string };

export type AiCallOptions = {
  feature: AiFeature;
  model: string;
  input: AiInputMessage[];
  temperature: number;
  /** Requested output cap; clamped to HARD_MAX_OUTPUT_TOKENS. */
  maxOutputTokens: number;
  /** Cap on total characters sent. Clamped to HARD_MAX_INPUT_CHARS. */
  maxInputChars?: number;
  timeoutMs?: number;
  /** Optional best-effort global budget for this feature (per server instance). */
  budget?: { limit: number; windowMs: number };
};

export const HARD_MAX_OUTPUT_TOKENS = 1000;
export const HARD_MAX_INPUT_CHARS = 60_000;
const DEFAULT_MAX_INPUT_CHARS = 30_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 30_000;

type OpenAiResponseBody = {
  output_text?: string;
  output?: Array<{ content?: Array<{ text?: string }> }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
};

function disabledFeatures() {
  return new Set(
    (process.env.AI_DISABLED_FEATURES ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** True when a provider call for this feature could be attempted (flag on, key present, feature not denied). */
export function isAiFeatureEnabled(feature: AiFeature) {
  return (
    process.env.AI_FEATURES_ENABLED === "true" &&
    Boolean(process.env.OPENAI_API_KEY) &&
    !disabledFeatures().has(feature)
  );
}

function extractText(data: OpenAiResponseBody) {
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  return (
    data.output
      ?.flatMap((item) => item.content ?? [])
      .map((item) => item.text ?? "")
      .join("\n")
      .trim() ?? ""
  );
}

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function logAttempt(options: AiCallOptions, fields: Record<string, unknown>) {
  // One structured line per attempt. Deliberately no prompt/response text and no user or studio identifiers.
  console.info(
    JSON.stringify({
      event: "ai_provider_call",
      feature: options.feature,
      model: options.model,
      maxOutputTokens: Math.min(options.maxOutputTokens, HARD_MAX_OUTPUT_TOKENS),
      ...fields,
    }),
  );
}

function fail(
  options: AiCallOptions,
  reason: AiCallFailureReason,
  startedAt: number,
  inputChars: number,
  extra: Record<string, unknown> = {},
  mayHaveBilled = false,
): AiCallResult {
  logAttempt(options, { outcome: reason, latencyMs: Date.now() - startedAt, inputChars, mayHaveBilled, ...extra });
  return { ok: false, reason, message: AI_SAFE_MESSAGES[reason], mayHaveBilled };
}

function isTimeoutError(error: unknown) {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

export async function callOpenAiResponses(options: AiCallOptions): Promise<AiCallResult> {
  const startedAt = Date.now();
  const inputChars = options.input.reduce((sum, item) => sum + (typeof item.content === "string" ? item.content.length : Number.POSITIVE_INFINITY), 0);

  if (process.env.AI_FEATURES_ENABLED !== "true") return fail(options, "disabled", startedAt, inputChars);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return fail(options, "not_configured", startedAt, inputChars);
  if (disabledFeatures().has(options.feature)) return fail(options, "disabled", startedAt, inputChars);

  const maxInput = Math.min(options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS, HARD_MAX_INPUT_CHARS);
  if (inputChars > maxInput) return fail(options, "input_too_large", startedAt, inputChars);

  if (options.budget) {
    const budget = checkRateLimit(`ai-budget:${options.feature}`, options.budget);
    if (!budget.allowed) return fail(options, "budget_exceeded", startedAt, inputChars);
  }

  const requestedOutput = Number.isFinite(options.maxOutputTokens) ? Math.trunc(options.maxOutputTokens) : HARD_MAX_OUTPUT_TOKENS;
  const maxOutputTokens = Math.max(1, Math.min(requestedOutput, HARD_MAX_OUTPUT_TOKENS));
  const timeoutMs = Math.max(1000, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: options.model,
        temperature: options.temperature,
        max_output_tokens: maxOutputTokens,
        store: false,
        input: options.input,
      }),
    });
  } catch (error) {
    return fail(options, isTimeoutError(error) ? "timeout" : "provider_error", startedAt, inputChars, {}, true);
  }

  let data: OpenAiResponseBody = {};
  try {
    data = (await response.json()) as OpenAiResponseBody;
  } catch (error) {
    if (response.ok && isTimeoutError(error)) {
      return fail(options, "timeout", startedAt, inputChars, { httpStatus: response.status }, true);
    }
    data = {};
  }

  if (!response.ok) {
    return fail(options, "provider_error", startedAt, inputChars, { httpStatus: response.status });
  }

  const usage = {
    inputTokens: num(data.usage?.input_tokens),
    outputTokens: num(data.usage?.output_tokens),
    cachedTokens: num(data.usage?.input_tokens_details?.cached_tokens),
  };
  const text = extractText(data);
  if (!text) {
    return fail(options, "empty_output", startedAt, inputChars, { httpStatus: response.status, ...usage }, true);
  }

  logAttempt(options, { outcome: "ok", httpStatus: response.status, latencyMs: Date.now() - startedAt, inputChars, ...usage });
  return { ok: true, text, model: options.model, usage };
}
