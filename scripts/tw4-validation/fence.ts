/**
 * Network fence for the validation harness. It must be the FIRST import of the script so it is installed before any other module is
 * evaluated (ES imports are hoisted: code placed after the import list would run too late).
 *
 * Layer 1 (hosts): loopback always; with `--adapter real` the three Twilio registration hosts over https as well. Anything else throws.
 * Layer 2 (stage-aware requests, real adapter only): the S10 boundary is ALSO enforced here, independently of the runner. Stage B may
 * make GET requests and only the draft-creating POSTs below, and no request body may carry a `Status` field (that is how a profile or trust
 * product is submitted for Twilio review). Stage C additionally gets the submission and brand endpoints. Any other method, any POST in a
 * run that is not stage B or C, and any POST outside the lists is refused before it leaves the process.
 * In real mode the ambient TWILIO_AUTH_TOKEN is removed from the environment: the validation harness never uses the auth token.
 */
import { isLoopbackHost } from "../../src/lib/sms/twilioIsv/loopback";

const TWILIO_HOSTS = new Set(["trusthub.twilio.com", "messaging.twilio.com", "api.twilio.com"]);
const adapterIndex = process.argv.indexOf("--adapter");
export const ADAPTER_KIND = adapterIndex >= 0 && process.argv[adapterIndex + 1] === "real" ? "real" : "fake";
const stageIndex = process.argv.indexOf("--stages");
export const STAGE_ARG: string = stageIndex >= 0 ? String(process.argv[stageIndex + 1] ?? "").toUpperCase() : "";

if (ADAPTER_KIND === "real") delete process.env.TWILIO_AUTH_TOKEN;

export function fenceAllows(rawUrl: string, kind: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const loopback = isLoopbackHost(url.hostname);
  return loopback || (kind === "real" && url.protocol === "https:" && TWILIO_HOSTS.has(url.hostname));
}

const SID34 = "[0-9a-fA-F]{32}";
const B_POSTS: RegExp[] = [
  /^trusthub\.twilio\.com\/v1\/CustomerProfiles$/,
  /^trusthub\.twilio\.com\/v1\/EndUsers$/,
  /^trusthub\.twilio\.com\/v1\/SupportingDocuments$/,
  new RegExp(`^trusthub\\.twilio\\.com/v1/CustomerProfiles/BU${SID34}/(EntityAssignments|Evaluations)$`),
  new RegExp(`^api\\.twilio\\.com/2010-04-01/Accounts/AC${SID34}/Addresses\\.json$`),
];
const C_ONLY_POSTS: RegExp[] = [
  new RegExp(`^trusthub\\.twilio\\.com/v1/CustomerProfiles/BU${SID34}$`),
  /^trusthub\.twilio\.com\/v1\/TrustProducts$/,
  new RegExp(`^trusthub\\.twilio\\.com/v1/TrustProducts/BU${SID34}(/(EntityAssignments|Evaluations))?$`),
  /^messaging\.twilio\.com\/v1\/a2p\/BrandRegistrations$/,
];
const STATUS_FIELD = /(^|&)status=/i;
/** The only paths whose body may carry Status (stage C: submit for review). */
const STATUS_PATHS: RegExp[] = [new RegExp(`^trusthub\\.twilio\\.com/v1/CustomerProfiles/BU${SID34}$`), new RegExp(`^trusthub\\.twilio\\.com/v1/TrustProducts/BU${SID34}$`)];

/**
 * What a fetch call really sends: the method and body come from `init` when given, otherwise from a Request object (reading only `init` would
 * treat `fetch(new Request(url, {method: "POST"}))` as a GET).
 */
export function describeRequest(input: RequestInfo | URL, init?: { method?: string; body?: unknown }): { url: string; method: string; body: unknown } {
  const isRequest = typeof Request !== "undefined" && input instanceof Request;
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  const method = init?.method ?? (isRequest ? (input as Request).method : "GET");
  const body = init?.body !== undefined ? init.body : isRequest && (input as Request).body !== null ? (input as Request).body : undefined;
  return { url, method, body };
}

/** The body as text, or null when it cannot be inspected (a stream, FormData, Blob, ...): an uninspectable body is never allowed. */
function bodyText(body: unknown): string | null {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return null;
}

export function requestAllowed(rawUrl: string, init: { method?: string; body?: unknown } | undefined, kind: string, stage: string): boolean {
  if (!fenceAllows(rawUrl, kind)) return false;
  const url = new URL(rawUrl);
  const loopback = isLoopbackHost(url.hostname);
  if (loopback || kind !== "real") return true; // the local database; layer 2 applies to Twilio only
  const method = String(init?.method ?? "GET").toUpperCase();
  if (method === "GET") return true;
  if (method !== "POST") return false;
  if (stage !== "B" && stage !== "C") return false;
  const target = `${url.hostname}${url.pathname}`;
  const body = bodyText(init?.body);
  if (body === null) return false; // a body this fence cannot read could carry a Status field
  const allowedPaths = stage === "B" ? B_POSTS : [...B_POSTS, ...C_ONLY_POSTS];
  if (!allowedPaths.some((pattern) => pattern.test(target))) return false;
  if (STATUS_FIELD.test(body)) return stage === "C" && STATUS_PATHS.some((pattern) => pattern.test(target)) && /(^|&)Status=pending-review(&|$)/.test(body);
  return true;
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = describeRequest(input, init);
  if (!requestAllowed(request.url, request, ADAPTER_KIND, STAGE_ARG)) throw new Error("tw4 validation: request blocked by the network fence");
  return realFetch(input, { ...init, redirect: "error" });
}) as typeof fetch;
