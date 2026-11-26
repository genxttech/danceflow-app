import "server-only";
import { TwilioRest } from "./real";
import { suspensionCallsAllowed, type ProviderAccount, type SubaccountStatusProvider } from "./suspension";
import { IsvApiError } from "./types";

/**
 * TW-4F slice E: the REAL subaccount status client (parent credentials; GET and POST /2010-04-01/Accounts/{Sid}.json, documented in Twilio's Subaccounts
 * API). It has NOT been run against live Twilio. It is UNREACHABLE unless BOTH gates are on:
 *   1. the database switch studio_sms_suspension_switch.enabled (default off; owner-level audited setter), read here through tw4susp_switch_state;
 *   2. the environment gate suspensionCallsAllowed (production deployment, production build, TW4_SUBACCOUNT_SUSPENSION_CALLS=on), checked at construction
 *      AND again before every status write.
 * Only the guarded server actions (src/app/platform/sms/suspensionActions.ts) import this module (enforced by suspension.noAutomation.test.ts). It never
 * sends Status=closed: closing is permanent and is not a capability of this class.
 */

type Env = Record<string, string | undefined>;
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;
type Rpc = { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string } | null }> };

const API = "https://api.twilio.com/2010-04-01";
const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;

class RealSubaccountStatusClient extends TwilioRest<{ accountSid: string; authToken: string }> implements SubaccountStatusProvider {
  readonly isFake = false;

  private constructor(config: { accountSid: string; authToken: string }, fetchImpl: FetchLike, private readonly env: Env) {
    super(config, fetchImpl);
  }

  /** @internal construction goes through createRealSuspensionProvider only */
  static build(config: { accountSid: string; authToken: string }, fetchImpl: FetchLike, env: Env) {
    return new RealSubaccountStatusClient(config, fetchImpl, env);
  }

  private target(sid: string): string {
    if (!ACCOUNT_SID.test(sid) || sid === this.config.accountSid) throw new IsvApiError("validation", null, null, "not a subaccount sid");
    return `${API}/Accounts/${encodeURIComponent(sid)}.json`;
  }

  async getAccount(accountSid: string): Promise<ProviderAccount> {
    const json = await this.request("GET", this.target(accountSid));
    return { sid: String(json.sid ?? ""), ownerAccountSid: typeof json.owner_account_sid === "string" ? json.owner_account_sid : null, status: String(json.status ?? "") };
  }

  async setStatus(accountSid: string, status: "suspended" | "active"): Promise<void> {
    if (status !== "suspended" && status !== "active") throw new IsvApiError("validation", null, null, "only suspended or active");
    const gate = suspensionCallsAllowed(this.env);
    if (!gate.allowed) throw new IsvApiError("account", null, null, gate.reason);
    await this.request("POST", this.target(accountSid), { Status: status });
  }
}

/**
 * Builds the real client only when the environment gate AND the database switch are on, and the parent credentials are present. Throws otherwise
 * (nothing is called). The credentials are passed in by the caller and never logged.
 */
export async function createRealSuspensionProvider(
  admin: Rpc,
  credentials: { accountSid: string; authToken: string },
  env: Env = process.env,
  fetchImpl?: FetchLike,
): Promise<SubaccountStatusProvider> {
  const gate = suspensionCallsAllowed(env);
  if (!gate.allowed) throw new IsvApiError("account", null, null, gate.reason);
  const sw = await admin.rpc("tw4susp_switch_state");
  if (sw.error || sw.data !== true) throw new IsvApiError("account", null, null, "the database suspension switch is off");
  if (!ACCOUNT_SID.test(credentials.accountSid) || !credentials.authToken) throw new IsvApiError("account", null, null, "parent credentials missing");
  return RealSubaccountStatusClient.build(credentials, fetchImpl ?? ((url, init) => fetch(url, init)), env);
}
