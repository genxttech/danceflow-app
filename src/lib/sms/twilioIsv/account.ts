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
  /** One parent read per account at a time: concurrent callers share it. */
  readonly #inflight = new Map<string, Promise<RedactedSecret>>();
  /** When the parent was last asked for this account's token, and whether that read failed. */
  readonly #lastRead = new Map<string, { at: number; failed: boolean }>();
  readonly #ttl: number;
  readonly #interval: number;
  readonly #now: () => number;

  /**
   * @param options.ttlMs how long a token is reused (clamped to MAX_TOKEN_TTL_MS; 0 disables caching).
   * @param options.refreshIntervalMs the shortest spacing between two parent reads of ONE account that a caller can FORCE (a re-read after a
   *   rejection, or a retry after a failed read). Default REFRESH_MIN_INTERVAL_MS. The webhook path keeps it: forged traffic must not be able to
   *   drive parent requests. The admin-triggered registration runner may lower it.
   */
  constructor(private readonly parent: Pick<IsvParentAdapter, "getSubaccountToken">, options: { ttlMs?: number; now?: () => number; refreshIntervalMs?: number } = {}) {
    // the lifetime is short by construction: a longer value is clamped, a non-positive one disables caching
    this.#ttl = Math.max(0, Math.min(options.ttlMs ?? MAX_TOKEN_TTL_MS, MAX_TOKEN_TTL_MS));
    this.#interval = Math.max(0, options.refreshIntervalMs ?? REFRESH_MIN_INTERVAL_MS);
    this.#now = options.now ?? Date.now;
  }

  #recent(accountSid: string): { at: number; failed: boolean } | null {
    const last = this.#lastRead.get(accountSid);
    return last && this.#now() - last.at < this.#interval ? last : null;
  }

  #read(accountSid: string): Promise<RedactedSecret> {
    const running = this.#inflight.get(accountSid);
    if (running) return running;
    this.#lastRead.set(accountSid, { at: this.#now(), failed: false });
    const read = (async () => {
      let raw: string;
      try {
        raw = await this.parent.getSubaccountToken(accountSid);
      } catch (error) {
        this.#lastRead.set(accountSid, { at: this.#now(), failed: true });
        // the underlying message is dropped on purpose: only its class survives
        throw new IsvApiError(error instanceof IsvApiError && error.kind === "transient" ? "transient" : "account", null, null, "subaccount credential unavailable");
      }
      if (typeof raw !== "string" || raw.length === 0) {
        this.#lastRead.set(accountSid, { at: this.#now(), failed: true });
        throw new IsvApiError("account", null, null, "subaccount credential unavailable");
      }
      const secret = new RedactedSecret(raw);
      if (this.#ttl > 0) this.#cache.set(accountSid, { secret, expiresAt: this.#now() + this.#ttl });
      return secret;
    })();
    this.#inflight.set(accountSid, read);
    read.then(() => this.#inflight.delete(accountSid), () => this.#inflight.delete(accountSid));
    return read;
  }

  /**
   * The token of ONE subaccount, cached per account SID (an entry can never serve another account). The caller has ALREADY established, from the
   * database, that this SID is the subaccount of the studio's legal entity; the provider additionally refuses anything that is not a well-formed SID.
   * Any failure is fail-closed and carries no credential. A failed parent read is not repeated inside the refresh interval (negative cache).
   */
  async tokenFor(accountSid: string): Promise<RedactedSecret> {
    if (!ACCOUNT_SID.test(accountSid)) throw new IsvApiError("account", null, null, "not a subaccount sid");
    const hit = this.#cache.get(accountSid);
    if (hit && hit.expiresAt > this.#now()) return hit.secret;
    this.#cache.delete(accountSid);
    if (!this.#inflight.has(accountSid) && this.#recent(accountSid)?.failed) throw new IsvApiError("transient", null, null, "subaccount credential unavailable");
    return this.#read(accountSid);
  }

  /** Forget one account's token (for example after a 401 from that account) or all of them. */
  invalidate(accountSid?: string): void {
    if (accountSid) this.#cache.delete(accountSid);
    else this.#cache.clear();
  }

  /**
   * TW-4F provider integration (Twilio ticket #29647095, answer 5: Auth Token rotation has NO overlap window). When a token is rejected (a 401 from
   * the subaccount, or a webhook signature that does not verify with the cached token), the token may simply have been rotated: read it again and
   * report whether it changed. Parent reads of one account are spaced by the refresh interval and shared while in flight, so a flood of forged
   * webhooks naming a real subaccount costs at most one parent request per interval: inside it the cached token is the answer, and with nothing
   * cached the refresh fails (transient) instead of asking Twilio again. The old token is never kept as a fallback, but a CACHED token stays valid
   * for webhook verification until its TTL ends or a re-read replaces it (see TW-4F_Provider_Integration.md section 4).
   */
  async refresh(accountSid: string, rejected: RedactedSecret | null): Promise<{ secret: RedactedSecret; changed: boolean }> {
    if (!ACCOUNT_SID.test(accountSid)) throw new IsvApiError("account", null, null, "not a subaccount sid");
    const changedFrom = (secret: RedactedSecret) => ({ secret, changed: rejected === null || secret.reveal() !== rejected.reveal() });
    const running = this.#inflight.get(accountSid);
    if (running) return changedFrom(await running);
    if (this.#recent(accountSid)) {
      const cached = this.#cache.get(accountSid);
      if (cached && cached.expiresAt > this.#now()) return changedFrom(cached.secret);
      throw new IsvApiError("transient", null, null, "subaccount credential re-read throttled");
    }
    // the cached token is replaced only by a SUCCESSFUL read: if the parent read fails, the cached token keeps serving until its own TTL
    return changedFrom(await this.#read(accountSid));
  }

  get cachedAccounts(): number {
    return this.#cache.size;
  }
}
