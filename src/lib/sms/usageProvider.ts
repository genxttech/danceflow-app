import "server-only";
import { fakeAdapterAllowed, isvEnvName } from "./twilioIsv/config";

/**
 * TW-4F usage financials: the provider seam for BILLED studio texts and for reading back their billing evidence.
 *
 * Parent credentials sign requests against a SUBACCOUNT's resources. A send is the only thing here that can cost money, so the real
 * provider refuses to send unless `allowSend` is true, and `billedSmsProviderFromEnv` only sets that on a production build of a production
 * deployment with SMS_BILLED_REAL_SEND=on. Reading evidence is gated the same way by SMS_USAGE_EVIDENCE_READS=on.
 *
 * Outcome classification matters for money: `refused` means Twilio DEFINITELY created no message (a 4xx, not 408, carrying a Twilio error
 * code); `uncertain` means a message may or may not exist and the caller must reconcile from evidence rather than retry. Errors and results
 * carry fixed codes only: never credentials, message bodies, phone numbers or Twilio's messages.
 */

type Env = Record<string, string | undefined>;

export type BilledSmsSendInput = { accountSid: string; messagingServiceSid: string; to: string; body: string; statusCallbackUrl: string | null };
export type BilledSmsSendResult = { kind: "accepted"; sid: string } | { kind: "refused"; code: string } | { kind: "uncertain"; code: string };
export type BilledMessageEvidence = {
  sid: string;
  account_sid: string;
  status: string;
  num_segments: string | null;
  num_media: string | null;
  price: string | null;
  price_unit: string | null;
};

export interface BilledSmsProvider {
  /** Never throws. */
  send(input: BilledSmsSendInput): Promise<BilledSmsSendResult>;
  /** Throws on any failure. */
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

export function billedRealSendAllowed(env: Env = process.env): { allowed: true } | { allowed: false; reason: string } {
  return gate(env, "SMS_BILLED_REAL_SEND", "Billed SMS sending");
}

export function usageEvidenceReadsAllowed(env: Env = process.env): { allowed: true } | { allowed: false; reason: string } {
  return gate(env, "SMS_USAGE_EVIDENCE_READS", "Usage evidence reads");
}

type RealOptions = { fetchImpl?: typeof fetch; timeoutMs?: number; allowSend?: boolean; allowRead?: boolean };

function numberText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return value;
  return null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export class RealBilledSmsProvider implements BilledSmsProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly allowSend: boolean;
  private readonly allowRead: boolean;
  private readonly credentials: { accountSid: string; authToken: string };

  constructor(credentials: { accountSid: string; authToken: string }, options: RealOptions = {}) {
    this.credentials = credentials;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.allowSend = options.allowSend === true;
    this.allowRead = options.allowRead === true;
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.credentials.accountSid}:${this.credentials.authToken}`).toString("base64")}`;
  }

  async send(input: BilledSmsSendInput): Promise<BilledSmsSendResult> {
    if (!this.allowSend) return { kind: "refused", code: "real_send_disabled" };
    if (
      !input || !ACCOUNT_SID.test(String(input.accountSid)) || !SERVICE_SID.test(String(input.messagingServiceSid)) ||
      !US_NUMBER.test(String(input.to)) || typeof input.body !== "string" || input.body.length === 0
    ) {
      return { kind: "refused", code: "invalid_input" };
    }
    const form = new URLSearchParams({ To: input.to, MessagingServiceSid: input.messagingServiceSid, Body: input.body });
    if (input.statusCallbackUrl) form.set("StatusCallback", input.statusCallbackUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${API}/Accounts/${input.accountSid}/Messages.json`, {
          method: "POST",
          headers: { Authorization: this.authHeader(), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
          signal: controller.signal,
          cache: "no-store",
        });
      } catch {
        return { kind: "uncertain", code: controller.signal.aborted ? "timeout" : "network" };
      }
      let parsed: unknown = null;
      try {
        const raw = await response.text();
        parsed = raw ? (JSON.parse(raw) as unknown) : null;
      } catch {
        return { kind: "uncertain", code: controller.signal.aborted ? "timeout" : "unreadable" };
      }
      return classifyTwilioSendResponse(response.status, parsed);
    } catch {
      return { kind: "uncertain", code: "network" };
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchMessage(accountSid: string, sid: string): Promise<BilledMessageEvidence> {
    if (!this.allowRead) throw new Error("usage_evidence_reads_disabled");
    if (!ACCOUNT_SID.test(String(accountSid)) || !MESSAGE_SID.test(String(sid))) throw new Error("usage_evidence_invalid_input");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let json: unknown;
      try {
        const response = await this.fetchImpl(`${API}/Accounts/${accountSid}/Messages/${sid}.json`, {
          method: "GET",
          headers: { Authorization: this.authHeader(), Accept: "application/json" },
          signal: controller.signal,
          cache: "no-store",
        });
        if (response.status < 200 || response.status >= 300) throw new Error(`usage_evidence_http_${response.status}`);
        json = JSON.parse(await response.text()) as unknown;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("usage_evidence_http_")) throw error;
        throw new Error(controller.signal.aborted ? "usage_evidence_timeout" : "usage_evidence_unreadable");
      }
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
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** In-memory, deterministic provider for tests and the local fake adapter. */
export class FakeBilledSmsProvider implements BilledSmsProvider {
  readonly sent: BilledSmsSendInput[] = [];
  private readonly queue: BilledSmsSendResult[] = [];
  private readonly evidence = new Map<string, Partial<BilledMessageEvidence>>();
  private readonly failing = new Set<string>();
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

  private generateSid(): string {
    this.counter += 1;
    return `SM${this.counter.toString(16).padStart(32, "0")}`;
  }

  async send(input: BilledSmsSendInput): Promise<BilledSmsSendResult> {
    this.sent.push({ ...input });
    return this.queue.shift() ?? { kind: "accepted", sid: this.generateSid() };
  }

  async fetchMessage(accountSid: string, sid: string): Promise<BilledMessageEvidence> {
    if (this.failing.has(sid)) throw new Error("usage_evidence_unreadable");
    return {
      sid,
      account_sid: accountSid,
      status: "delivered",
      num_segments: "1",
      num_media: "0",
      price: "-0.00830",
      price_unit: "USD",
      ...this.evidence.get(sid),
    };
  }
}

type Globals = typeof globalThis & { __billedFakeSmsProvider?: FakeBilledSmsProvider };

export function billedSmsProviderFromEnv(env: Env = process.env): BilledSmsProvider | null {
  const allowSend = billedRealSendAllowed(env).allowed;
  const allowRead = usageEvidenceReadsAllowed(env).allowed;
  if (allowSend || allowRead) {
    const accountSid = String(env.TWILIO_ACCOUNT_SID ?? "").trim();
    const authToken = String(env.TWILIO_AUTH_TOKEN ?? "").trim();
    if (!ACCOUNT_SID.test(accountSid) || authToken === "") return null;
    return new RealBilledSmsProvider({ accountSid, authToken }, { allowSend, allowRead });
  }
  if (fakeAdapterAllowed(env)) {
    const g = globalThis as Globals;
    g.__billedFakeSmsProvider ??= new FakeBilledSmsProvider();
    return g.__billedFakeSmsProvider;
  }
  return null;
}
