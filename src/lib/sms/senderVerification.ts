import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RedactedSecret } from "./twilioIsv/account";
import { fakeAdapterAllowed, isvEnvName } from "./twilioIsv/config";

/**
 * TW-4F sender readiness (design section 9): the READ-ONLY half. The server reads the Twilio resources a business's sender depends on, using the
 * SUBACCOUNT's own credentials, reduces every response to a few normalized fields plus a digest, and hands only that to the database, which computes
 * the outcome (tw4_sender_verify / tw4_sender_reverify_run -> _tw4sr_judge). Nothing here writes to Twilio, stores a token, or keeps a raw response.
 */

export type ReadErrorKind = "not_found" | "forbidden" | "timeout" | "network" | "rate_limited" | "server" | "credentials_unavailable" | "unreadable";
export type ReadResource = "account" | "service" | "campaign" | "brand" | "number" | "service_number";

export class SenderReadError extends Error {
  constructor(readonly kind: ReadErrorKind) {
    super(`sender read failed: ${kind}`);
    this.name = "SenderReadError";
  }
}

export type AccountRead = { sid: string | null; status: string | null };
export type ServiceRead = {
  sid: string | null; account_sid: string | null; us_app_to_person_registered: boolean | null; inbound_request_url: string | null; use_inbound_webhook_on_number: boolean | null;
};
export type CampaignRead = {
  sid: string | null; account_sid: string | null; messaging_service_sid: string | null; campaign_status: string | null; mock: boolean | null;
  brand_registration_sid: string | null; us_app_to_person_usecase: string | null;
};
export type BrandRead = { sid: string | null; status: string | null; mock: boolean | null };
export type NumberRead = { sid: string | null; account_sid: string | null; phone_number: string | null; sms_capable: boolean | null; status: string | null; sms_url: string | null };
export type ServiceNumberRead = { sid: string | null; service_sid: string | null; account_sid: string | null };

/** Read-only provider reads. Every method returns normalized data or throws SenderReadError. */
export interface SenderReadProvider {
  readonly isFake: boolean;
  fetchAccount(accountSid: string): Promise<AccountRead>;
  fetchService(accountSid: string, messagingServiceSid: string): Promise<ServiceRead>;
  fetchCampaign(accountSid: string, messagingServiceSid: string, campaignSid: string): Promise<CampaignRead>;
  fetchBrand(accountSid: string, brandSid: string): Promise<BrandRead>;
  fetchNumber(accountSid: string, phoneNumberSid: string): Promise<NumberRead>;
  fetchServiceNumber(accountSid: string, messagingServiceSid: string, phoneNumberSid: string): Promise<ServiceNumberRead>;
}

/** The subaccount token source (satisfied by SubaccountTokenProvider and by the token provider usageProvider.ts exports). */
export interface SenderTokenProvider {
  tokenFor(accountSid: string): Promise<RedactedSecret>;
  refresh(accountSid: string, current: RedactedSecret | null): Promise<{ secret: RedactedSecret; changed: boolean }>;
}

type Env = Record<string, string | undefined>;

/** Production deployment AND production build AND SMS_SENDER_VERIFY_READS=on. Never TW4_ISV_REAL_CALLS. */
export function senderVerifyReadsAllowed(env: Env = process.env): { allowed: true } | { allowed: false; reason: string } {
  if (isvEnvName(env) !== "production") return { allowed: false, reason: "Sender verification reads are disabled outside production." };
  if (String(env.NODE_ENV ?? "") !== "production") return { allowed: false, reason: "Sender verification reads are disabled outside a production build." };
  if (String(env.SMS_SENDER_VERIFY_READS ?? "") !== "on") return { allowed: false, reason: "Sender verification reads are switched off." };
  return { allowed: true };
}

const REQUEST_TIMEOUT_MS = 8_000;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const obj = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new SenderReadError("unreadable");
  return v as Record<string, unknown>;
};

const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const SID = (prefix: string) => new RegExp(`^${prefix}[0-9a-fA-F]{32}$`);

export class RealSenderReadProvider implements SenderReadProvider {
  readonly isFake = false;
  constructor(private readonly tokens: SenderTokenProvider, private readonly options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {}

  /** One GET signed with the subaccount's SID + token; one token refresh and retry when Twilio answers 401. */
  private async get(accountSid: string, url: string): Promise<Record<string, unknown>> {
    if (!ACCOUNT_SID.test(accountSid)) throw new SenderReadError("unreadable");
    let secret: RedactedSecret;
    try {
      secret = await this.tokens.tokenFor(accountSid);
    } catch {
      throw new SenderReadError("credentials_unavailable");
    }
    let response = await this.send(accountSid, url, secret);
    if (response.status === 401) {
      let refreshed: { secret: RedactedSecret; changed: boolean };
      try {
        refreshed = await this.tokens.refresh(accountSid, secret);
      } catch {
        throw new SenderReadError("credentials_unavailable");
      }
      if (!refreshed.changed) throw new SenderReadError("forbidden");
      response = await this.send(accountSid, url, refreshed.secret);
    }
    const status = response.status;
    if (status === 401 || status === 403) throw new SenderReadError("forbidden");
    if (status === 404) throw new SenderReadError("not_found");
    if (status === 429) throw new SenderReadError("rate_limited");
    if (status >= 500) throw new SenderReadError("server");
    if (status < 200 || status >= 300) throw new SenderReadError("unreadable");
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new SenderReadError("unreadable");
    }
    return obj(body);
  }

  private async send(accountSid: string, url: string, secret: RedactedSecret): Promise<Response> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    try {
      return await doFetch(url, {
        method: "GET",
        headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${secret.reveal()}`).toString("base64")}`, Accept: "application/json" },
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (error) {
      throw new SenderReadError((error as { name?: string })?.name === "AbortError" ? "timeout" : "network");
    } finally {
      clearTimeout(timer);
    }
  }

  private checkSid(value: string, prefix: string): string {
    if (!SID(prefix).test(value)) throw new SenderReadError("unreadable");
    return value;
  }

  async fetchAccount(accountSid: string): Promise<AccountRead> {
    const b = await this.get(accountSid, `https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`);
    return { sid: str(b.sid), status: str(b.status) };
  }

  async fetchService(accountSid: string, mg: string): Promise<ServiceRead> {
    const b = await this.get(accountSid, `https://messaging.twilio.com/v1/Services/${this.checkSid(mg, "MG")}`);
    return {
      sid: str(b.sid), account_sid: str(b.account_sid), us_app_to_person_registered: bool(b.us_app_to_person_registered),
      inbound_request_url: str(b.inbound_request_url), use_inbound_webhook_on_number: bool(b.use_inbound_webhook_on_number),
    };
  }

  async fetchCampaign(accountSid: string, mg: string, qe: string): Promise<CampaignRead> {
    const b = await this.get(accountSid, `https://messaging.twilio.com/v1/Services/${this.checkSid(mg, "MG")}/Compliance/Usa2p/${this.checkSid(qe, "QE")}`);
    return {
      sid: str(b.sid), account_sid: str(b.account_sid), messaging_service_sid: str(b.messaging_service_sid), campaign_status: str(b.campaign_status), mock: bool(b.mock),
      brand_registration_sid: str(b.brand_registration_sid), us_app_to_person_usecase: str(b.us_app_to_person_usecase),
    };
  }

  async fetchBrand(accountSid: string, bn: string): Promise<BrandRead> {
    const b = await this.get(accountSid, `https://messaging.twilio.com/v1/a2p/BrandRegistrations/${this.checkSid(bn, "BN")}`);
    return { sid: str(b.sid), status: str(b.status), mock: bool(b.mock) };
  }

  async fetchNumber(accountSid: string, pn: string): Promise<NumberRead> {
    const b = await this.get(accountSid, `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers/${this.checkSid(pn, "PN")}.json`);
    const caps = b.capabilities && typeof b.capabilities === "object" && !Array.isArray(b.capabilities) ? (b.capabilities as Record<string, unknown>) : {};
    return { sid: str(b.sid), account_sid: str(b.account_sid), phone_number: str(b.phone_number), sms_capable: bool(caps.sms), status: str(b.status), sms_url: str(b.sms_url) };
  }

  async fetchServiceNumber(accountSid: string, mg: string, pn: string): Promise<ServiceNumberRead> {
    const b = await this.get(accountSid, `https://messaging.twilio.com/v1/Services/${this.checkSid(mg, "MG")}/PhoneNumbers/${this.checkSid(pn, "PN")}`);
    return { sid: str(b.sid), service_sid: str(b.service_sid), account_sid: str(b.account_sid) };
  }
}

type Scripted<T> = T | SenderReadError | undefined;

/** In-memory provider for local QA and tests: scripted per SID; anything unscripted is "not found". Never makes a network call. */
export class FakeSenderReadProvider implements SenderReadProvider {
  readonly isFake = true;
  readonly calls: string[] = [];
  private readonly data = new Map<string, unknown>();

  /** Script the answer (or a SenderReadError) for one resource, keyed by kind and SID. */
  script(kind: ReadResource, sid: string, answer: unknown): this {
    this.data.set(`${kind}:${sid}`, answer);
    return this;
  }

  private answer<T>(kind: ReadResource, sid: string): T {
    this.calls.push(`${kind}:${sid}`);
    const value = this.data.get(`${kind}:${sid}`) as Scripted<T>;
    if (value === undefined) throw new SenderReadError("not_found");
    if (value instanceof SenderReadError) throw value;
    return value;
  }

  async fetchAccount(accountSid: string) { return this.answer<AccountRead>("account", accountSid); }
  async fetchService(_a: string, mg: string) { return this.answer<ServiceRead>("service", mg); }
  async fetchCampaign(_a: string, _mg: string, qe: string) { return this.answer<CampaignRead>("campaign", qe); }
  async fetchBrand(_a: string, bn: string) { return this.answer<BrandRead>("brand", bn); }
  async fetchNumber(_a: string, pn: string) { return this.answer<NumberRead>("number", pn); }
  async fetchServiceNumber(_a: string, _mg: string, pn: string) { return this.answer<ServiceNumberRead>("service_number", pn); }
}

let sharedFake: FakeSenderReadProvider | null = null;
/** The process-wide fake used by local QA (scripted from a harness). */
export function sharedFakeSenderReadProvider(): FakeSenderReadProvider {
  return (sharedFake ??= new FakeSenderReadProvider());
}

/** The provider for this process, or null (with no reads at all) when neither the fake nor the gated real reads are allowed. */
export function senderReadProviderFromEnv(env: Env = process.env, tokens: SenderTokenProvider | null = null): SenderReadProvider | null {
  if (fakeAdapterAllowed(env)) return sharedFakeSenderReadProvider();
  if (!senderVerifyReadsAllowed(env).allowed || !tokens) return null;
  return new RealSenderReadProvider(tokens);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// evidence
// ---------------------------------------------------------------------------------------------------------------------------------------------------

export type SenderIdentifiers = { accountSid: string; messagingServiceSid: string; campaignSid: string; phoneNumberSid: string };
export type ReadErrorEntry = { resource: ReadResource; kind: ReadErrorKind };

export type SenderEvidence = {
  account: AccountRead | null;
  /** inbound_route_ok is null when it cannot be known: the number handles inbound and its read failed (the read error then decides the outcome) */
  service: (ServiceRead & { inbound_route_ok: boolean | null }) | null;
  campaign: CampaignRead | null;
  brand: BrandRead | null;
  number: NumberRead | null;
  service_number: ServiceNumberRead | null;
  read_errors: ReadErrorEntry[];
  digests: Partial<Record<ReadResource, string>>;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** sha256 hex of the normalized object (key order does not matter). */
export function digestOf(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** The canonical inbound webhook URL: the app origin plus the inbound route. Null when no origin is configured. */
export function expectedInboundUrl(env: Env = process.env): string | null {
  const origin = String(env.NEXT_PUBLIC_APP_URL || env.NEXT_PUBLIC_SITE_URL || "").trim().replace(/\/+$/, "");
  return origin ? `${origin}/api/sms/twilio/inbound` : null;
}

/** Performs every read; one failing resource never stops the others. The result carries only normalized fields, read errors and digests. */
export async function buildSenderEvidence(provider: SenderReadProvider, sender: SenderIdentifiers, inboundUrl: string): Promise<SenderEvidence> {
  const read_errors: ReadErrorEntry[] = [];
  const digests: Partial<Record<ReadResource, string>> = {};
  const attempt = async <T>(resource: ReadResource, run: () => Promise<T>): Promise<T | null> => {
    try {
      const value = await run();
      digests[resource] = digestOf(value);
      return value;
    } catch (error) {
      read_errors.push({ resource, kind: error instanceof SenderReadError ? error.kind : "unreadable" });
      return null;
    }
  };
  const a = sender.accountSid;
  const [account, serviceRaw, campaign, number, service_number] = await Promise.all([
    attempt("account", () => provider.fetchAccount(a)),
    attempt("service", () => provider.fetchService(a, sender.messagingServiceSid)),
    attempt("campaign", () => provider.fetchCampaign(a, sender.messagingServiceSid, sender.campaignSid)),
    attempt("number", () => provider.fetchNumber(a, sender.phoneNumberSid)),
    attempt("service_number", () => provider.fetchServiceNumber(a, sender.messagingServiceSid, sender.phoneNumberSid)),
  ]);
  // the brand is the campaign's own; without the campaign there is nothing to name (its failure is already reported)
  const brandSid = campaign?.brand_registration_sid ?? null;
  const brand = brandSid ? await attempt("brand", () => provider.fetchBrand(a, brandSid)) : null;
  const service = serviceRaw
    ? {
        ...serviceRaw,
        // when the NUMBER handles inbound, its routing is known only if the number was read: an unread number is unknown (null), never "misrouted"
        inbound_route_ok:
          serviceRaw.use_inbound_webhook_on_number === true && number === null
            ? null
            : (serviceRaw.use_inbound_webhook_on_number === false && serviceRaw.inbound_request_url === inboundUrl) ||
              (serviceRaw.use_inbound_webhook_on_number === true && number !== null && number.sms_url === inboundUrl),
      }
    : null;
  return { account, service, campaign, brand, number, service_number, read_errors, digests };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// database round trips
// ---------------------------------------------------------------------------------------------------------------------------------------------------

export type SenderOverviewRow = {
  studioId: string; legalEntityId: string | null; senderId: string | null; status: string | null; accountSid: string | null; messagingServiceSid: string | null;
  campaignSid: string | null; phoneNumberSid: string | null; senderE164: string | null; recordedAt: string | null;
  verificationOutcome: string | null; verificationCode: string | null; verifiedAt: string | null; verificationSource: string | null; ready: boolean;
};

const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function parseSenderOverview(raw: unknown): SenderOverviewRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    return {
      studioId: s(o.studio_id) ?? "", legalEntityId: s(o.legal_entity_id), senderId: s(o.sender_id), status: s(o.status), accountSid: s(o.account_sid),
      messagingServiceSid: s(o.messaging_service_sid), campaignSid: s(o.campaign_sid), phoneNumberSid: s(o.phone_number_sid), senderE164: s(o.sender_e164),
      recordedAt: s(o.recorded_at), verificationOutcome: s(o.verification_outcome), verificationCode: s(o.verification_code), verifiedAt: s(o.verified_at),
      verificationSource: s(o.verification_source), ready: o.ready === true,
    };
  }).filter((r) => r.studioId);
}

export async function loadSenderOverview(admin: SupabaseClient, actorId: string): Promise<SenderOverviewRow[] | null> {
  const { data, error } = await admin.rpc("tw4_sender_overview", { p_actor: actorId });
  return error ? null : parseSenderOverview(data);
}

export type SenderHealthState = "none" | "released" | "revoked" | "pending" | "failed" | "expired" | "blocked" | "expiring" | "ready";
const HEALTH_STATES: readonly string[] = ["none", "released", "revoked", "pending", "failed", "expired", "blocked", "expiring", "ready"];

export type SenderHealthRow = {
  studioId: string; legalEntityId: string | null; senderId: string | null; status: string | null; state: SenderHealthState; blocked: boolean;
  lastSuccessAt: string | null; expiresAt: string | null; nextCheckAt: string | null;
  decisiveOutcome: string | null; decisiveCode: string | null; decisiveSource: string | null; decisiveAt: string | null;
  lastAttemptOutcome: string | null; lastAttemptCode: string | null; lastAttemptAt: string | null; retriesSinceSuccess: number;
};
export type SenderSchedulerRun = { runId: string | null; status: string | null; startedAt: string | null; finishedAt: string | null; error: string | null };
export type SenderScheduler = {
  lastCompletedAt: string | null; stale: boolean; running: boolean; runs: SenderSchedulerRun[]; expiring: number; expired: number; failed: number;
};
export type SenderHealth = { senders: SenderHealthRow[]; scheduler: SenderScheduler };

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : 0);

export function parseSenderHealth(raw: unknown): SenderHealth {
  const top = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rows = Array.isArray(top.senders) ? top.senders : [];
  const senders: SenderHealthRow[] = rows.map((r) => {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    // an unknown or missing state is never read as healthy
    const state = (typeof o.state === "string" && HEALTH_STATES.includes(o.state) ? o.state : "blocked") as SenderHealthState;
    return {
      studioId: s(o.studio_id) ?? "", legalEntityId: s(o.legal_entity_id), senderId: s(o.sender_id), status: s(o.status), state, blocked: state !== "ready" && state !== "expiring",
      lastSuccessAt: s(o.last_success_at), expiresAt: s(o.expires_at), nextCheckAt: s(o.next_check_at),
      decisiveOutcome: s(o.decisive_outcome), decisiveCode: s(o.decisive_code), decisiveSource: s(o.decisive_source), decisiveAt: s(o.decisive_at),
      lastAttemptOutcome: s(o.last_attempt_outcome), lastAttemptCode: s(o.last_attempt_code), lastAttemptAt: s(o.last_attempt_at), retriesSinceSuccess: num(o.retries_since_success),
    };
  }).filter((r) => r.studioId);
  const sc = (top.scheduler && typeof top.scheduler === "object" ? top.scheduler : {}) as Record<string, unknown>;
  const runs = (Array.isArray(sc.runs) ? sc.runs : []).map((r) => {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    return { runId: s(o.run_id), status: s(o.status), startedAt: s(o.started_at), finishedAt: s(o.finished_at), error: s(o.error) };
  });
  return {
    senders,
    scheduler: {
      lastCompletedAt: s(sc.last_completed_at),
      // a missing scheduler block is never reassuring
      stale: sc.stale !== false,
      running: Boolean(sc.running && typeof sc.running === "object"), runs, expiring: num(sc.expiring), expired: num(sc.expired), failed: num(sc.failed),
    },
  };
}

/** The sender health (state machine, trust window, scheduler status) or null when it cannot be read here (function not installed or any error). */
export async function loadSenderHealth(admin: Pick<SupabaseClient, "rpc">, actorId: string): Promise<SenderHealth | null> {
  try {
    const { data, error } = await admin.rpc("tw4_sender_health", { p_actor: actorId });
    if (error || !data || typeof data !== "object") return null;
    return parseSenderHealth(data);
  } catch {
    return null;
  }
}

export type SenderGuidance = { headline: string; next: "verify" | "wait" | "provider" | "investigate" | "record" | "none"; detail: string };

const PROVIDER_CODES = new Set([
  "campaign_not_verified", "service_not_a2p_registered", "number_not_ready", "number_not_in_service", "account_not_active", "inbound_not_routed_to_danceflow", "callback:30034",
]);
const MISMATCH_CODES = new Set([
  "service_not_on_account", "campaign_not_on_service", "brand_not_the_business", "mock_registration", "use_case_mismatch", "subaccount_not_active",
]);

/** What a platform admin should do next, from the state alone. Only 'ready' and 'expiring' are ever described as able to send. */
export function senderGuidance(row: SenderHealthRow): SenderGuidance {
  switch (row.state) {
    case "ready":
      return { headline: "Ready", next: "none", detail: "Verified recently; the scheduled re-check keeps it current." };
    case "expiring":
      if (row.lastAttemptOutcome === "inconclusive") {
        return (row.lastAttemptCode ?? "").startsWith("read_credentials_unavailable")
          ? { headline: "Ready, but re-checks cannot read Twilio", next: "investigate", detail: "The subaccount's credentials could not be obtained. This will not fix itself: check the subaccount and the token-read setup before the deadline." }
          : { headline: "Ready, re-checks failing", next: "wait", detail: `Twilio could not be read (${row.retriesSinceSuccess} tries). Sending stops at the deadline unless a check succeeds.` };
      }
      return { headline: "Ready, re-check due", next: "wait", detail: "The scheduled re-check runs before the deadline; verify now if you need certainty." };
    case "expired":
      if (row.lastAttemptOutcome === "inconclusive" && (row.lastAttemptCode ?? "").startsWith("read_credentials_unavailable")) {
        return { headline: "Blocked: Twilio credentials unavailable", next: "investigate", detail: "The subaccount's credentials could not be obtained (closed or suspended subaccount, or token-read setup). Fix that, then Re-check now." };
      }
      if (row.lastSuccessAt && Date.parse(row.lastSuccessAt) < Date.now() - 72 * 3_600_000) {
        return { headline: "Blocked: verification lapsed days ago", next: "verify", detail: "Trust lapsed more than 48 hours ago, so the scheduler no longer restores it. Verify it again (with the Advanced Opt-Out attestation)." };
      }
      return row.lastAttemptOutcome !== "inconclusive"
        ? { headline: "Blocked: verification expired", next: "verify", detail: "The 24-hour verification lapsed and sending is blocked. Re-check now to restore it." }
        : { headline: "Blocked: verification expired", next: "wait", detail: "The scheduler is retrying; Twilio could not be reached. Sending stays blocked until a check succeeds." };
    case "failed": {
      const code = row.decisiveCode ?? "";
      if (PROVIDER_CODES.has(code)) return { headline: "Blocked: Twilio reports a problem", next: "provider", detail: "Fix it in Twilio, then Verify. Sending stays blocked until a check succeeds." };
      if (MISMATCH_CODES.has(code) || code.startsWith("read_not_found") || code.startsWith("read_forbidden") || code.startsWith("read_unreadable")) {
        return { headline: "Blocked: sender identity does not match", next: "investigate", detail: "Possible reassignment or wrong subaccount: investigate before verifying." };
      }
      if (code === "advanced_opt_out_not_attested") return { headline: "Blocked: Advanced Opt-Out not attested", next: "verify", detail: "Attest Advanced Opt-Out in the Twilio Console, then Verify." };
      return { headline: "Blocked: verification failed", next: "investigate", detail: "The last check failed for a reason a person needs to look at before verifying again." };
    }
    case "pending":
      return { headline: "Not yet verified", next: "verify", detail: "Verify the sender; it cannot send billed texts until a check succeeds." };
    case "blocked":
      return { headline: "Blocked: not ready for a reason other than expiry", next: "investigate", detail: "For example the subaccount is no longer active, the location's registration path changed, or the last verification does not match this sender. Investigate, then Verify." };
    case "revoked":
      return { headline: "Revoked", next: "record", detail: "This sender was stopped. Record a new sender to send again." };
    case "released":
      return { headline: "Released", next: "record", detail: "This sender was released. Record a new sender to send again." };
    default:
      return { headline: "No sender", next: "record", detail: "No sender is recorded for this location. Record one to send." };
  }
}

export type VerifyOutcome = "verified" | "failed" | "inconclusive" | "skipped" | "error";
export type VerifyResult = { outcome: VerifyOutcome; code: string | null };

function readResult(data: unknown): VerifyResult {
  const o = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const outcome = o.outcome;
  if (outcome === "verified" || outcome === "failed" || outcome === "inconclusive" || outcome === "skipped") return { outcome, code: s(o.code) };
  return { outcome: "error", code: "unexpected_answer" };
}

function identifiers(row: { accountSid: string | null; messagingServiceSid: string | null; campaignSid: string | null; phoneNumberSid: string | null }): SenderIdentifiers | null {
  if (!row.accountSid || !row.messagingServiceSid || !row.campaignSid || !row.phoneNumberSid) return null;
  return { accountSid: row.accountSid, messagingServiceSid: row.messagingServiceSid, campaignSid: row.campaignSid, phoneNumberSid: row.phoneNumberSid };
}

/** Verify one studio's current sender. The caller supplies only WHO and the attestation; the evidence is always read here. */
export async function verifySender(
  admin: SupabaseClient,
  provider: SenderReadProvider,
  input: { studioId: string; senderId: string; actorId: string; attestedOptOut: boolean; sender?: SenderOverviewRow; inboundUrl?: string | null },
): Promise<VerifyResult> {
  const inboundUrl = input.inboundUrl === undefined ? expectedInboundUrl() : input.inboundUrl;
  if (!inboundUrl) return { outcome: "error", code: "app_url_not_configured" };
  const row = input.sender ?? (await loadSenderOverview(admin, input.actorId))?.find((r) => r.studioId === input.studioId);
  if (!row) return { outcome: "error", code: "sender_unreadable" };
  if (row.senderId !== input.senderId || row.studioId !== input.studioId) return { outcome: "error", code: "sender_not_current" };
  const ids = identifiers(row);
  if (!ids) return { outcome: "error", code: "sender_incomplete" };
  const evidence = await buildSenderEvidence(provider, ids, inboundUrl);
  const { data, error } = await admin.rpc("tw4_sender_verify", {
    p_studio_id: input.studioId, p_sender_id: input.senderId, p_actor: input.actorId, p_evidence: evidence,
    p_attested_opt_out: input.attestedOptOut === true, p_source: provider.isFake ? "fake" : "provider_read",
  });
  if (error) return { outcome: "error", code: "verify_rejected" };
  return readResult(data);
}

export type ReverifyCounts = { due: number; verified: number; failed: number; inconclusive: number; skipped: number; errors: number; truncated: boolean; workListFailed?: boolean };

class ReverifyLeaseLost extends Error {
  constructor() {
    super("sender reverify: the run lost its lease");
  }
}

/**
 * Re-verify the approved senders that are due (the database's work list: last success older than 20 hours, backoff after transient reads), inside a
 * live 'sender_reverify' run: every write goes through the lease-fenced tw4_sender_reverify_run. The database judges the evidence; one sender's failure
 * never stops the rest; a lost lease stops at once. Nothing here can restore a FAILED sender, extend a sender's trust, or touch Twilio beyond GETs.
 */
export async function reverifyDueSenders(
  admin: Pick<SupabaseClient, "rpc">,
  provider: SenderReadProvider,
  input: { runId: string; limit?: number; inboundUrl?: string | null; deadline?: number },
): Promise<ReverifyCounts> {
  const counts: ReverifyCounts = { due: 0, verified: 0, failed: 0, inconclusive: 0, skipped: 0, errors: 0, truncated: false };
  const inboundUrl = input.inboundUrl === undefined ? expectedInboundUrl() : input.inboundUrl;
  if (!inboundUrl) return counts;
  const due = await admin.rpc("tw4_sender_due_reverify", { p_limit: input.limit ?? 50 });
  if (due.error || !Array.isArray(due.data)) {
    counts.errors += 1;
    counts.workListFailed = true;
    return counts;
  }
  counts.due = due.data.length;
  for (const item of due.data as Array<Record<string, unknown>>) {
    if (input.deadline !== undefined && Date.now() > input.deadline) {
      counts.truncated = true;
      break;
    }
    try {
      const ids = identifiers({
        accountSid: s(item.account_sid), messagingServiceSid: s(item.messaging_service_sid), campaignSid: s(item.campaign_sid), phoneNumberSid: s(item.phone_number_sid),
      });
      const studioId = s(item.studio_id);
      const senderId = s(item.sender_id);
      if (!ids || !studioId || !senderId) {
        counts.errors += 1;
        continue;
      }
      // the identifiers come from the database's own sender row (never from a tenant); the reads use that row's subaccount
      const evidence = await buildSenderEvidence(provider, ids, inboundUrl);
      const { data, error } = await admin.rpc("tw4_sender_reverify_run", {
        p_run_id: input.runId, p_studio_id: studioId, p_sender_id: senderId, p_evidence: evidence, p_source: provider.isFake ? "fake" : "provider_read",
      });
      if (error) {
        if (error.code === "TW023") throw new ReverifyLeaseLost();
        counts.errors += 1;
        continue;
      }
      const result = readResult(data);
      if (result.outcome === "error") counts.errors += 1;
      else counts[result.outcome] += 1;
    } catch (error) {
      if (error instanceof ReverifyLeaseLost) throw error;
      counts.errors += 1;
    }
  }
  return counts;
}

export type ScheduledReverifyOutcome =
  | { ran: false; reason: "busy" | "unavailable" }
  | { ran: true; runId: string; failed: boolean; summary: Record<string, number | boolean> };

export const REVERIFY_BUDGET_MS = 45_000;
/** Twice the route's maxDuration: a run killed by the platform frees the lease for the next tick. */
export const REVERIFY_LEASE_SECONDS = 120;

/**
 * The scheduled re-verify: one run at a time (the shared run lease, job 'sender_reverify'), bounded batch and time budget, outcome recorded with counts
 * only. Without a read provider (reads off) or an inbound URL nothing is read and nothing changes; trust then lapses on its own after 24 hours.
 */
export async function runScheduledSenderReverify(
  admin: Pick<SupabaseClient, "rpc">,
  provider: SenderReadProvider | null,
  options: { runner: string; budgetMs?: number; limit?: number; inboundUrl?: string | null },
): Promise<ScheduledReverifyOutcome> {
  const started = Date.now();
  const begin = await admin.rpc("tw4_reconcile_run_begin", { p_job: "sender_reverify", p_runner: options.runner, p_lease_seconds: REVERIFY_LEASE_SECONDS });
  if (begin.error) return { ran: false, reason: "unavailable" };
  const lease = (begin.data ?? {}) as { acquired?: unknown; run_id?: unknown };
  if (lease.acquired !== true || typeof lease.run_id !== "string") return { ran: false, reason: "busy" };
  const runId = lease.run_id;
  const inboundUrl = options.inboundUrl === undefined ? expectedInboundUrl() : options.inboundUrl;
  let counts: ReverifyCounts = { due: 0, verified: 0, failed: 0, inconclusive: 0, skipped: 0, errors: 0, truncated: false };
  let failure: string | null = null;
  try {
    // a run that cannot read anything is recorded as FAILED, never as a completed (healthy-looking) run: the panel's stale alert then shows it
    if (!provider) failure = "sender reverify: provider reads unavailable";
    else if (!inboundUrl) failure = "sender reverify: inbound url not configured";
    else {
      counts = await reverifyDueSenders(admin, provider, { runId, limit: options.limit, inboundUrl, deadline: started + (options.budgetMs ?? REVERIFY_BUDGET_MS) });
      if (counts.workListFailed) failure = "sender reverify: work list unavailable";
    }
  } catch (error) {
    failure = error instanceof ReverifyLeaseLost ? error.message : "sender reverify: unexpected failure";
  }
  const { workListFailed, ...countsOnly } = counts;
  const summary: Record<string, number | boolean> = {
    ...countsOnly, work_list_failed: workListFailed === true, reads_available: provider !== null, inbound_url_configured: Boolean(inboundUrl), duration_ms: Date.now() - started,
  };
  try {
    await admin.rpc("tw4_reconcile_run_finish", { p_run_id: runId, p_status: failure ? "failed" : "completed", p_summary: summary, p_error: failure });
  } catch {
    // an unfinished run's lease expires and the next begin closes it as failed
  }
  return { ran: true, runId, failed: failure !== null, summary };
}
