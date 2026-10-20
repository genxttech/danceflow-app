import type { RedactedSecret, SubaccountTokenProvider } from "./account";
import { IsvApiError, type IsvAdapter } from "./types";

/**
 * TW-4F provider integration: a subaccount registration adapter that survives an Auth Token rotation (Twilio ticket #29647095, answer 5: no
 * overlap window, so a token cached a moment before the rotation is rejected with HTTP 401 from then on).
 *
 * On a 401 from the subaccount the token is re-read from the parent ONCE (spaced per account, see SubaccountTokenProvider.refresh) and, only if it
 * actually changed, the same request is sent again with the new token. Retrying is safe even for a POST: Twilio refuses an unauthenticated request
 * before acting on it, so the first attempt created nothing. Any other error, a second 401, or an unchanged token is returned as it was: a
 * credential that really does not work stops the run (kind "account"), it is never retried in a loop and never replaced by parent credentials.
 */

type Build = (accountSid: string, token: RedactedSecret) => IsvAdapter;

function isAuthRejection(error: unknown): boolean {
  return error instanceof IsvApiError && error.kind === "account" && error.httpStatus === 401;
}

export async function rotatingSubaccountAdapter(accountSid: string, tokens: Pick<SubaccountTokenProvider, "tokenFor" | "refresh">, build: Build): Promise<IsvAdapter> {
  let token = await tokens.tokenFor(accountSid);
  let current = build(accountSid, token);
  if (current.accountSid !== accountSid) throw new IsvApiError("account", null, null, "adapter account differs");

  const call = async <K extends keyof IsvAdapter>(method: K, args: unknown[]): Promise<unknown> => {
    const invoke = () => (current[method] as unknown as (...a: unknown[]) => Promise<unknown>).apply(current, args);
    try {
      return await invoke();
    } catch (error) {
      if (!isAuthRejection(error)) throw error;
      let refreshed: { secret: RedactedSecret; changed: boolean };
      try {
        refreshed = await tokens.refresh(accountSid, token);
      } catch {
        throw error;
      }
      if (!refreshed.changed) throw error;
      token = refreshed.secret;
      current = build(accountSid, token);
      if (current.accountSid !== accountSid) throw new IsvApiError("account", null, null, "adapter account differs");
      return invoke();
    }
  };

  return new Proxy({} as IsvAdapter, {
    get(_target, property) {
      if (property === "accountSid") return accountSid;
      if (typeof property !== "string" || typeof (current as unknown as Record<string, unknown>)[property] !== "function") return undefined;
      return (...args: unknown[]) => call(property as keyof IsvAdapter, args);
    },
  });
}
