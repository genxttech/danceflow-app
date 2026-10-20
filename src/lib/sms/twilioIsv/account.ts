import { inspect } from "node:util";
import { IsvApiError, type IsvParentAdapter } from "./types";

/**
 * TW-4F-3a (D2, owner decision 2026-10-18, choice 1): a studio's SUBACCOUNT auth token is never stored. It is fetched from the parent account at
 * call time, kept in memory for a short time, and wrapped so that it cannot reach a log, an error, JSON or a debugger print by accident.
 */

/** Holds a secret. Every implicit conversion (string, JSON, util.inspect, template literal) yields "[redacted]"; only `reveal()` returns it. */
export class RedactedSecret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return "[redacted]";
  }
  toJSON(): string {
    return "[redacted]";
  }
  [inspect.custom](): string {
    return "[redacted]";
  }
}

export const MAX_TOKEN_TTL_MS = 5 * 60_000;
/** The shortest spacing between two forced token re-reads of ONE subaccount (rotation handling). */
export const REFRESH_MIN_INTERVAL_MS = 30_000;
const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;

export class SubaccountTokenProvider {
  readonly #cache = new Map<string, { secret: RedactedSecret; expiresAt: number }>();
  readonly #ttl: number;
  readonly #now: () => number;

  constructor(private readonly parent: Pick<IsvParentAdapter, "getSubaccountToken">, options: { ttlMs?: number; now?: () => number } = {}) {
    // the lifetime is short by construction: a longer value is clamped, a non-positive one disables caching
    this.#ttl = Math.max(0, Math.min(options.ttlMs ?? MAX_TOKEN_TTL_MS, MAX_TOKEN_TTL_MS));
    this.#now = options.now ?? Date.now;
  }

  /**
   * The token of ONE subaccount, cached per account SID (an entry can never serve another account). The caller has ALREADY established, from the
   * database, that this SID is the subaccount of the studio's legal entity; the provider additionally refuses anything that is not a well-formed SID.
   * Any failure is fail-closed and carries no credential.
   */
  async tokenFor(accountSid: string): Promise<RedactedSecret> {
    if (!ACCOUNT_SID.test(accountSid)) throw new IsvApiError("account", null, null, "not a subaccount sid");
    const hit = this.#cache.get(accountSid);
    if (hit && hit.expiresAt > this.#now()) return hit.secret;
    this.#cache.delete(accountSid);
    let raw: string;
    try {
      raw = await this.parent.getSubaccountToken(accountSid);
    } catch (error) {
      // the underlying message is dropped on purpose: only its class survives
      throw new IsvApiError(error instanceof IsvApiError && error.kind === "transient" ? "transient" : "account", null, null, "subaccount credential unavailable");
    }
    if (typeof raw !== "string" || raw.length === 0) throw new IsvApiError("account", null, null, "subaccount credential unavailable");
    const secret = new RedactedSecret(raw);
    if (this.#ttl > 0) this.#cache.set(accountSid, { secret, expiresAt: this.#now() + this.#ttl });
    return secret;
  }

  /** Forget one account's token (for example after a 401 from that account) or all of them. */
  invalidate(accountSid?: string): void {
    if (accountSid) this.#cache.delete(accountSid);
    else this.#cache.clear();
  }

  readonly #lastRefresh = new Map<string, number>();

  /**
   * TW-4F provider integration (Twilio ticket #29647095, answer 5: Auth Token rotation has NO overlap window). When a token is rejected (a 401 from
   * the subaccount, or a webhook signature that does not verify with the cached token), the token may simply have been rotated: fetch it again,
   * ONCE, and report whether it changed. Refreshes of one account are spaced by at least `minIntervalMs`, so a flood of forged webhooks naming a
   * real subaccount cannot turn into a flood of parent-credential requests to Twilio; inside the interval the cached token is the answer.
   * The old token is NEVER kept as a fallback: after a rotation (possibly because it leaked) only the current token verifies anything.
   */
  async refresh(accountSid: string, rejected: RedactedSecret | null, minIntervalMs = REFRESH_MIN_INTERVAL_MS): Promise<{ secret: RedactedSecret; changed: boolean }> {
    if (!ACCOUNT_SID.test(accountSid)) throw new IsvApiError("account", null, null, "not a subaccount sid");
    const last = this.#lastRefresh.get(accountSid);
    const cached = this.#cache.get(accountSid);
    if (last !== undefined && this.#now() - last < minIntervalMs && cached && cached.expiresAt > this.#now()) {
      return { secret: cached.secret, changed: rejected !== null && cached.secret.reveal() !== rejected.reveal() };
    }
    this.#lastRefresh.set(accountSid, this.#now());
    this.#cache.delete(accountSid);
    const secret = await this.tokenFor(accountSid);
    return { secret, changed: rejected === null || secret.reveal() !== rejected.reveal() };
  }

  get cachedAccounts(): number {
    return this.#cache.size;
  }
}
