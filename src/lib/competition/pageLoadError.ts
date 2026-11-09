/**
 * A page that loads through an RPC may answer 404 only for a genuine "not allowed / not found" outcome. A gateway or server failure
 * (HTTP 5xx, network, unknown code) must surface through the error boundary, never as a misleading 404 for a legitimate manager,
 * and never as a degraded page that silently omits a control or a safety panel (CF1 review P2-A).
 */
export type LoadError = { message?: string | null; code?: string | null } | null | undefined;

const NOT_FOUND_CODES = new Set(["42501", "PGRST116"]);

export function classifyLoadError(error: LoadError): "ok" | "notFound" | "rethrow" {
  if (!error) return "ok";
  if (error.code && NOT_FOUND_CODES.has(error.code)) return "notFound";
  if (/COMP_(FORBIDDEN|NOT_FOUND)\b/.test(error.message ?? "")) return "notFound";
  return "rethrow";
}

/** The thrown error is generic on purpose: the raw database message is logged server-side only and never reaches the error boundary or the browser. */
function failLoad(label: string, error: LoadError): never {
  console.error(`[competition] page read failed (${label}): ${error?.code || "unknown"} ${error?.message ?? "no message"}`);
  throw new Error("Could not load this page. Refresh and try again.");
}

/** Returns true when the caller should call notFound(); throws for anything that is not an authorization or not-found outcome. */
export function shouldNotFound(error: LoadError, data: unknown): boolean {
  const kind = classifyLoadError(error);
  if (kind === "rethrow") failLoad("primary", error);
  return kind === "notFound" || data === null || data === undefined;
}

/**
 * The data of a secondary read (preview, exclusions, withdrawal state, ballot board, correction, trace, rows).
 * An authorization refusal yields null (the panel it feeds stays hidden, as for a non-manager); any other error rethrows,
 * so a failed read can never render a page that looks complete but is missing a panel (for example the co-sign panel, or the Approve guard).
 */
export function secondaryData<T = unknown>(label: string, result: { data?: T | null; error?: LoadError }): T | null {
  const kind = classifyLoadError(result.error);
  if (kind === "rethrow") failLoad(label, result.error);
  if (kind === "notFound") return null;
  return result.data ?? null;
}
