/**
 * A page that loads through an RPC may answer 404 only for a genuine "not allowed / not found" outcome. A gateway or server failure
 * (HTTP 5xx, network, unknown code) must surface through the error boundary, never as a misleading 404 for a legitimate manager.
 */
export type LoadError = { message?: string | null; code?: string | null } | null | undefined;

const NOT_FOUND_CODES = new Set(["42501", "PGRST116"]);

export function classifyLoadError(error: LoadError): "ok" | "notFound" | "rethrow" {
  if (!error) return "ok";
  if (error.code && NOT_FOUND_CODES.has(error.code)) return "notFound";
  if (/COMP_(FORBIDDEN|NOT_FOUND)\b/.test(error.message ?? "")) return "notFound";
  return "rethrow";
}

/** Returns true when the caller should call notFound(); throws for anything that is not an authorization or not-found outcome. */
export function shouldNotFound(error: LoadError, data: unknown): boolean {
  const kind = classifyLoadError(error);
  if (kind === "rethrow") throw new Error(`Could not load this page (${error?.code || "unknown"}): ${error?.message ?? "no message"}`);
  return kind === "notFound" || data === null || data === undefined;
}
