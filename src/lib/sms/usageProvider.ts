import "server-only";
import type { RedactedSecret, SubaccountTokenProvider } from "./twilioIsv/account";
import { fakeAdapterAllowed, isvEnvName, subaccountWebhooksAllowed } from "./twilioIsv/config";
import { messagingTokenProvider } from "./twilioIsv/real";

/**
 * TW-4F usage financials: the provider seam for BILLED studio texts and for reading back their billing evidence.
 *
 * Every message request is signed as the studio's SUBACCOUNT (its SID and its own Auth Token, obtained on demand through
 * `messagingTokenProvider` in twilioIsv/real.ts: memory only, short TTL, never stored, never a parent-credential fallback). A send is the only thing
 * here that can cost money, so the real provider refuses to send unless `allowSend` is true, and `billedSmsProviderFromEnv` only sets that on a
 * production build of a production deployment with SMS_BILLED_REAL_SEND=on. Reading evidence is gated the same way by SMS_USAGE_EVIDENCE_READS=on.
 *
 * Outcome classification matters for money: `refused` means Twilio DEFINITELY created no message (a 4xx, not 408, carrying a Twilio error
 * code; or no usable credential, which is decided before anything is sent); `uncertain` means a message may or may not exist and the caller must
 * reconcile from evidence rather than retry. Errors and results carry fixed codes only: never credentials, message bodies, phone numbers or Twilio's messages.
 */

type Env = Record<string, string | undefined>;

export type BilledSmsSendInput = {
  accountSid: string;
  messagingServiceSid: string;
  to: string;
  body: string;
  statusCallbackUrl: string | null;
  /** The location number (E.164) to send from, or null. Sent together with the messaging service: Twilio refuses (21711) when the number left the pool. */
  from: string | null;
};
export type BilledSmsSendResult = { kind: "accepted"; sid: string } | { kind: "refused"; code: string } | { kind: "uncertain"; code: string };
export type BilledMessageEvidence = {
  sid: string;
  account_sid: string;
  status: string;
  num_segments: string | null;
  num_media: string | null;
  price: string | null;
  price_unit: string | null;
  /** Identity and time (TW-4F reconciliation): the database settles only on evidence that proves it describes THIS text. Dates are ISO-8601 or null. */
  direction: string | null;
  messaging_service_sid: string | null;
  from: string | null;
  to: string | null;
  date_created: string | null;
  date_sent: string | null;
  error_code: string | null;
};

/** One message from the subaccount's own Message list, as read for inbound recovery. The body is used in memory to classify only; never stored or logged. */
export type InboundMessageEvidence = {
  sid: string;
  account_sid: string;
  direction: string;
  to: string | null;
  /** the texter's number: used in memory only (an unrecognizable sender is never charged, as the webhook would not record it); never sent to the database */
  from: string | null;
  messaging_service_sid: string | null;
  num_segments: string | null;
  num_media: string | null;
  date_created: string | null;
  date_sent: string | null;
  body: string | null;
};

export type InboundListWindow = {
  since: Date;
  until: Date;
  maxPages: number;
  /** only texts received by this number (Twilio's To filter); the subaccount's other traffic is never listed */
  to?: string;
  /** only texts sent by this number (Twilio's From filter): a texter's own later keywords, for consent ordering */
  from?: string;
  /** epoch ms: no further page is requested after it (complete = false) */
  deadline?: number;
};

export interface InboundMessageLister {
  /**
   * Inbound messages of ONE subaccount received in [since, until] (second precision; the caller filters exactly again), read with that subaccount's own
   * credentials, at most `maxPages` pages. `complete` is false when more pages remained. Throws on any failure (nothing partial is ever reported as complete).
   */
  listInbound(accountSid: string, window: InboundListWindow): Promise<{ messages: InboundMessageEvidence[]; complete: boolean }>;
}

export interface BilledSmsProvider {
  /** Obtains and validates the account's credentials WITHOUT sending anything. Never throws. */
  prepare(accountSid: string): Promise<{ ok: true } | { ok: false; code: string }>;
  /** Never throws. */
  send(input: BilledSmsSendInput): Promise<BilledSmsSendResult>;
  /** Throws on any failure. Uses the credentials of the account passed in, never another. */
  fetchMessage(accountSid: string, sid: string): Promise<BilledMessageEvidence>;
}

const MESSAGE_SID = /^(SM|MM)[0-9a-fA-F]{32}$/;
const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const SERVICE_SID = /^MG[0-9a-fA-F]{32}$/;
const US_NUMBER = /^\+1[2-9][0-9]{9}$/;
const API = "https://api.twilio.com/2010-04-01";
const DEFAULT_TIMEOUT_MS = 10_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function twilioErrorCode(body: unknown): string | null {
  if (!isObject(body)) return null;
  const code = body.code;
  if (typeof code === "number" && Number.isFinite(code)) return String(code);
  if (typeof code === "string" && /^[0-9]+$/.test(code.trim())) return code.trim();
  return null;
}

export function classifyTwilioSendResponse(httpStatus: number | null, body: unknown): BilledSmsSendResult {
  if (httpStatus === null) return { kind: "uncertain", code: "network" };
  if (httpStatus >= 200 && httpStatus < 300) {
    const sid = isObject(body) && typeof body.sid === "string" ? body.sid : "";
    return MESSAGE_SID.test(sid) ? { kind: "accepted", sid } : { kind: "uncertain", code: "no_sid" };
  }
  if (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408) {
    const code = twilioErrorCode(body);
    if (code !== null) return { kind: "refused", code };
    return { kind: "uncertain", code: body === undefined || body === null ? "unreadable" : `http_${httpStatus}` };
  }
  return { kind: "uncertain", code: `http_${httpStatus}` };
}

function gate(env: Env, flag: string, what: string): { allowed: true } | { allowed: false; reason: string } {
  if (isvEnvName(env) !== "production") return { allowed: false, reason: `${what} is disabled outside production.` };
  if (String(env.NODE_ENV ?? "") !== "production") return { allowed: false, reason: `${what} is disabled outside a production build.` };
  if (String(env[flag] ?? "") !== "on") return { allowed: false, reason: `${what} is switched off.` };
  return { allowed: true };
}

/**
 * A billed text goes out from a subaccount number only while that subaccount's webhooks are verified (TW4_SUBACCOUNT_WEBHOOKS): otherwise every
 * STOP / START / HELP reply and every delivery callback (including the 30034 registration flag) would be refused, and consent would never be updated.
 */
export function billedRealSendAllowed(env: Env = process.env): { allowed: true } | { allowed: false; reason: string } {
  const send = gate(env, "SMS_BILLED_REAL_SEND", "Billed SMS sending");
  if (!send.allowed) return send;
  if (!subaccountWebhooksAllowed(env).allowed) return { allowed: false, reason: "Billed SMS sending needs subaccount webhooks (replies and delivery callbacks) switched on." };
  return send;
}

export function usageEvidenceReadsAllowed(env: Env = process.env): { allowed: true } | { allowed: false; reason: string } {
  return gate(env, "SMS_USAGE_EVIDENCE_READS", "Usage evidence reads");
}

type TokenSource = Pick<SubaccountTokenProvider, "tokenFor" | "refresh">;
type RealOptions = { fetchImpl?: typeof fetch; timeoutMs?: number; allowSend?: boolean; allowRead?: boolean };
type Exchange = { status: number; body: unknown } | { error: "timeout" | "network" | "unreadable" };

function numberText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return value;
  return null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Twilio's RFC 2822 dates ("Tue, 20 Oct 2026 12:00:00 +0000") as ISO-8601, else null. */
export function twilioDateToIso(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Twilio's date-time filter form, YYYY-MM-DDThh:mm:ssZ (whole seconds, UTC) */
const utcSecond = (d: Date) => `${d.toISOString().slice(0, 19)}Z`;
const LIST_PAGE_SIZE = 200;

/**
 * Signs with the SUBACCOUNT's own SID and Auth Token. A 401 means Twilio did not act: the token is re-read once (rotation has no overlap window) and
 * the same request is repeated once only if the token changed; otherwise the answer is "credentials_rejected" (a definite not-sent).
 */
export class RealBilledSmsProvider implements BilledSmsProvider, InboundMessageLister {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly allowSend: boolean;
  private readonly allowRead: boolean;

  constructor(private readonly tokens: TokenSource, options: RealOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.allowSend = options.allowSend === true;
    this.allowRead = options.allowRead === true;
  }

  async prepare(accountSid: string): Promise<{ ok: true } | { ok: false; code: string }> {
    if (!this.allowSend) return { ok: false, code: "real_send_disabled" };
    if (!ACCOUNT_SID.test(String(accountSid))) return { ok: false, code: "invalid_input" };
    try {
      await this.tokens.tokenFor(accountSid);
      return { ok: true };
    } catch {
      return { ok: false, code: "credentials_unavailable" };
    }
  }

  private async exchange(url: string, method: "GET" | "POST", accountSid: string, secret: RedactedSecret, form?: string): Promise<Exchange> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const authorization = `Basic ${Buffer.from(`${accountSid}:${secret.reveal()}`).toString("base64")}`;
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: { Authorization: authorization, Accept: "application/json", ...(form !== undefined ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
          ...(form !== undefined ? { body: form } : {}),
          signal: controller.signal,
          cache: "no-store",
        });
      } catch {
        return { error: controller.signal.aborted ? "timeout" : "network" };
      }
      try {
        const raw = await response.text();
        return { status: response.status, body: raw ? (JSON.parse(raw) as unknown) : null };
      } catch {
        return { error: controller.signal.aborted ? "timeout" : "unreadable" };
      }
    } catch {
      return { error: "network" };
    } finally {
      clearTimeout(timer);
    }
  }

  /** One request as the subaccount, with the single 401 -> re-read -> retry-if-changed rule. `credentials` = no usable credential (nothing was sent). */
  private async signed(
    url: string, method: "GET" | "POST", accountSid: string, form?: string,
  ): Promise<Exchange | { credentials: "credentials_unavailable" | "credentials_rejected" }> {
    let secret: RedactedSecret;
    try {
      secret = await this.tokens.tokenFor(accountSid);
    } catch {
      return { credentials: "credentials_unavailable" };
    }
    let result = await this.exchange(url, method, accountSid, secret, form);
    if (!("status" in result) || result.status !== 401) return result;
    let refreshed: { secret: RedactedSecret; changed: boolean };
    try {
      refreshed = await this.tokens.refresh(accountSid, secret);
    } catch {
      return { credentials: "credentials_rejected" };
    }
    if (!refreshed.changed) return { credentials: "credentials_rejected" };
    result = await this.exchange(url, method, accountSid, refreshed.secret, form);
    if ("status" in result && result.status === 401) return { credentials: "credentials_rejected" };
    return result;
  }

  async send(input: BilledSmsSendInput): Promise<BilledSmsSendResult> {
    if (!this.allowSend) return { kind: "refused", code: "real_send_disabled" };
    if (
      !input || !ACCOUNT_SID.test(String(input.accountSid)) || !SERVICE_SID.test(String(input.messagingServiceSid)) ||
      !US_NUMBER.test(String(input.to)) || typeof input.body !== "string" || input.body.length === 0 ||
      (input.from !== null && input.from !== undefined && !US_NUMBER.test(String(input.from)))
    ) {
      return { kind: "refused", code: "invalid_input" };
    }
    const form = new URLSearchParams({ To: input.to, MessagingServiceSid: input.messagingServiceSid, Body: input.body });
    if (input.from) form.set("From", input.from);
    if (input.statusCallbackUrl) form.set("StatusCallback", input.statusCallbackUrl);
    const result = await this.signed(`${API}/Accounts/${input.accountSid}/Messages.json`, "POST", input.accountSid, form.toString());
    if ("credentials" in result) return { kind: "refused", code: result.credentials };
    if ("error" in result) return { kind: "uncertain", code: result.error };
    return classifyTwilioSendResponse(result.status, result.body);
  }

  async fetchMessage(accountSid: string, sid: string): Promise<BilledMessageEvidence> {
    if (!this.allowRead) throw new Error("usage_evidence_reads_disabled");
    if (!ACCOUNT_SID.test(String(accountSid)) || !MESSAGE_SID.test(String(sid))) throw new Error("usage_evidence_invalid_input");
    const result = await this.signed(`${API}/Accounts/${accountSid}/Messages/${sid}.json`, "GET", accountSid);
    if ("credentials" in result) throw new Error(`usage_evidence_${result.credentials}`);
    if ("error" in result) throw new Error(result.error === "timeout" ? "usage_evidence_timeout" : "usage_evidence_unreadable");
    if (result.status < 200 || result.status >= 300) throw new Error(`usage_evidence_http_${result.status}`);
    const json = result.body;
    if (!isObject(json)) throw new Error("usage_evidence_unreadable");
    if (json.sid !== sid || json.account_sid !== accountSid) throw new Error("usage_evidence_mismatch");
    if (typeof json.status !== "string" || json.status === "") throw new Error("usage_evidence_no_status");
    return {
      sid,
      account_sid: accountSid,
      status: json.status,
      num_segments: numberText(json.num_segments),
      num_media: numberText(json.num_media),
      price: numberText(json.price),
      price_unit: textOrNull(json.price_unit),
      direction: textOrNull(json.direction),
      messaging_service_sid: textOrNull(json.messaging_service_sid),
      from: textOrNull(json.from),
      to: textOrNull(json.to),
      date_created: twilioDateToIso(json.date_created),
      date_sent: twilioDateToIso(json.date_sent),
      error_code: numberText(json.error_code),
    };
  }

  async listInbound(accountSid: string, window: InboundListWindow): Promise<{ messages: InboundMessageEvidence[]; complete: boolean }> {
    if (!this.allowRead) throw new Error("usage_evidence_reads_disabled");
    if (!ACCOUNT_SID.test(String(accountSid)) || !(window.since instanceof Date) || !(window.until instanceof Date) || window.until < window.since
        || (window.to !== undefined && !US_NUMBER.test(String(window.to))) || (window.from !== undefined && !/^\+[1-9][0-9]{9,14}$/.test(String(window.from)))) {
      throw new Error("usage_evidence_invalid_input");
    }
    const base = `/2010-04-01/Accounts/${accountSid}/Messages.json`;
    // Twilio's inclusive date-time filters ("DateSent>" = on or after, "DateSent<" = on or before), a second of margin each side; the caller filters exactly
    const query = new URLSearchParams();
    if (window.to) query.set("To", window.to);
    if (window.from) query.set("From", window.from);
    query.set("DateSent>", utcSecond(new Date(window.since.getTime() - 1000)));
    query.set("DateSent<", utcSecond(new Date(window.until.getTime() + 1000)));
    query.set("PageSize", String(LIST_PAGE_SIZE));
    let path: string | null = `${base}?${query.toString()}`;
    const messages: InboundMessageEvidence[] = [];
    let pages = 0;
    while (path !== null) {
      if (pages >= Math.max(1, window.maxPages) || (window.deadline !== undefined && pages > 0 && Date.now() > window.deadline)) return { messages, complete: false };
      // only ever this subaccount's own Message list: a next-page link pointing anywhere else is refused
      if (!path.startsWith(`${base}?`)) throw new Error("usage_evidence_mismatch");
      const result = await this.signed(`https://api.twilio.com${path}`, "GET", accountSid);
      pages += 1;
      if ("credentials" in result) throw new Error(`usage_evidence_${result.credentials}`);
      if ("error" in result) throw new Error(result.error === "timeout" ? "usage_evidence_timeout" : "usage_evidence_unreadable");
      if (result.status < 200 || result.status >= 300) throw new Error(`usage_evidence_http_${result.status}`);
      const json = result.body;
      if (!isObject(json) || !Array.isArray(json.messages)) throw new Error("usage_evidence_unreadable");
      for (const raw of json.messages) {
        if (!isObject(raw)) continue;
        if (raw.account_sid !== accountSid) throw new Error("usage_evidence_mismatch");
        if (typeof raw.sid !== "string" || !MESSAGE_SID.test(raw.sid) || raw.direction !== "inbound") continue;
        messages.push({
          sid: raw.sid,
          account_sid: accountSid,
          direction: "inbound",
          to: textOrNull(raw.to),
          from: textOrNull(raw.from),
          messaging_service_sid: textOrNull(raw.messaging_service_sid),
          num_segments: numberText(raw.num_segments),
          num_media: numberText(raw.num_media),
          date_created: twilioDateToIso(raw.date_created),
          date_sent: twilioDateToIso(raw.date_sent),
          body: textOrNull(raw.body),
        });
      }
      path = typeof json.next_page_uri === "string" && json.next_page_uri !== "" ? json.next_page_uri : null;
    }
    return { messages, complete: true };
  }
}

/** In-memory, deterministic provider for tests and the local fake adapter. Needs no tokens. */
export class FakeBilledSmsProvider implements BilledSmsProvider, InboundMessageLister {
  readonly sent: BilledSmsSendInput[] = [];
  readonly prepared: string[] = [];
  private readonly queue: BilledSmsSendResult[] = [];
  private readonly evidence = new Map<string, Partial<BilledMessageEvidence>>();
  private readonly failing = new Set<string>();
  private readonly failingPrepare = new Map<string, string>();
  private readonly sentBySid = new Map<string, { input: BilledSmsSendInput; at: string }>();
  private readonly inbound = new Map<string, InboundMessageEvidence[]>();
  private readonly failingList = new Set<string>();
  private counter = 0;

  nextSend(result: BilledSmsSendResult): this {
    this.queue.push(result);
    return this;
  }

  setEvidence(sid: string, partial: Partial<BilledMessageEvidence>): this {
    this.evidence.set(sid, { ...this.evidence.get(sid), ...partial });
    return this;
  }

  failFetch(sid: string): this {
    this.failing.add(sid);
    return this;
  }

  /** Makes prepare() fail for this account (credentials unavailable). */
  /** `credentials_unavailable` (transient, the default) or a permanent code such as `real_send_disabled`. */
  failPrepare(accountSid: string, code = "credentials_unavailable"): this {
    this.failingPrepare.set(accountSid, code);
    return this;
  }

  private generateSid(): string {
    this.counter += 1;
    return `SM${this.counter.toString(16).padStart(32, "0")}`;
  }

  async prepare(accountSid: string): Promise<{ ok: true } | { ok: false; code: string }> {
    this.prepared.push(accountSid);
    const code = this.failingPrepare.get(accountSid);
    return code ? { ok: false, code } : { ok: true };
  }

  /** Inbound messages the fake subaccount list returns (recovery tests). */
  setInbound(accountSid: string, messages: InboundMessageEvidence[]): this {
    this.inbound.set(accountSid, messages.map((m) => ({ ...m })));
    return this;
  }

  failList(accountSid: string): this {
    this.failingList.add(accountSid);
    return this;
  }

  async send(input: BilledSmsSendInput): Promise<BilledSmsSendResult> {
    this.sent.push({ ...input });
    const result = this.queue.shift() ?? { kind: "accepted" as const, sid: this.generateSid() };
    if (result.kind === "accepted") this.sentBySid.set(result.sid, { input: { ...input }, at: new Date().toISOString() });
    return result;
  }

  /** the fake list honours the To filter (a message with no To is listed for every number, like an unfiltered read) */
  async listInbound(accountSid: string, window: InboundListWindow): Promise<{ messages: InboundMessageEvidence[]; complete: boolean }> {
    if (this.failingList.has(accountSid)) throw new Error("usage_evidence_unreadable");
    const all = (this.inbound.get(accountSid) ?? []).filter((m) => (window.to === undefined || m.to === null || m.to === window.to) && (window.from === undefined || m.from === window.from));
    return { messages: all.map((m) => ({ ...m })), complete: true };
  }

  async fetchMessage(accountSid: string, sid: string): Promise<BilledMessageEvidence> {
    if (this.failing.has(sid)) throw new Error("usage_evidence_unreadable");
    // by default the evidence describes exactly what this fake sent under that SID (identity and time), as Twilio's Message resource would
    const sent = this.sentBySid.get(sid);
    return {
      sid,
      account_sid: accountSid,
      status: "delivered",
      num_segments: "1",
      num_media: "0",
      price: "-0.00830",
      price_unit: "USD",
      direction: "outbound-api",
      messaging_service_sid: sent?.input.messagingServiceSid ?? null,
      from: sent?.input.from ?? null,
      to: sent?.input.to ?? null,
      date_created: sent?.at ?? null,
      date_sent: sent?.at ?? null,
      error_code: null,
      ...this.evidence.get(sid),
    };
  }
}

type Globals = typeof globalThis & { __billedFakeSmsProvider?: FakeBilledSmsProvider };

/**
 * The reconciler's read-only provider: the real one only where evidence reads are allowed (production build + deployment + SMS_USAGE_EVIDENCE_READS=on),
 * the shared in-memory fake in local fake mode, otherwise null (then the reconciler reads no evidence at all, so a misconfiguration can never be counted
 * as evidence failures). It can never send.
 */
export function usageEvidenceProviderFromEnv(env: Env = process.env): (BilledSmsProvider & InboundMessageLister) | null {
  if (usageEvidenceReadsAllowed(env).allowed) {
    const tokens = messagingTokenProvider(env);
    return tokens ? new RealBilledSmsProvider(tokens, { allowSend: false, allowRead: true }) : null;
  }
  if (fakeAdapterAllowed(env)) {
    const g = globalThis as Globals;
    g.__billedFakeSmsProvider ??= new FakeBilledSmsProvider();
    return g.__billedFakeSmsProvider;
  }
  return null;
}

export function billedSmsProviderFromEnv(env: Env = process.env): BilledSmsProvider | null {
  const allowSend = billedRealSendAllowed(env).allowed;
  const allowRead = usageEvidenceReadsAllowed(env).allowed;
  if (allowSend || allowRead) {
    const tokens = messagingTokenProvider(env);
    return tokens ? new RealBilledSmsProvider(tokens, { allowSend, allowRead }) : null;
  }
  if (fakeAdapterAllowed(env)) {
    const g = globalThis as Globals;
    g.__billedFakeSmsProvider ??= new FakeBilledSmsProvider();
    return g.__billedFakeSmsProvider;
  }
  return null;
}
