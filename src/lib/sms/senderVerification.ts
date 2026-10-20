import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RedactedSecret } from "./twilioIsv/account";
import { fakeAdapterAllowed, isvEnvName } from "./twilioIsv/config";

/**
 * TW-4F sender readiness (design section 9): the READ-ONLY half. The server reads the Twilio resources a business's sender depends on, using the
 * SUBACCOUNT's own credentials, reduces every response to a few normalized fields plus a digest, and hands only that to the database, which computes
 * the outcome (tw4_sender_verify / tw4_sender_reverify -> _tw4sr_judge). Nothing here writes to Twilio, stores a token, or keeps a raw response.
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
  service: (ServiceRead & { inbound_route_ok: boolean }) | null;
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
        inbound_route_ok:
          (serviceRaw.use_inbound_webhook_on_number === false && serviceRaw.inbound_request_url === inboundUrl) ||
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

export type ReverifyCounts = { due: number; verified: number; failed: number; inconclusive: number; skipped: number; errors: number };

/** Refresh approved senders whose last decisive verification is getting old. One failure never stops the rest. Nothing schedules this. */
export async function reverifyDueSenders(admin: SupabaseClient, provider: SenderReadProvider, input: { limit?: number; inboundUrl?: string | null } = {}): Promise<ReverifyCounts> {
  const counts: ReverifyCounts = { due: 0, verified: 0, failed: 0, inconclusive: 0, skipped: 0, errors: 0 };
  const inboundUrl = input.inboundUrl === undefined ? expectedInboundUrl() : input.inboundUrl;
  if (!inboundUrl) return counts;
  const due = await admin.rpc("tw4_sender_due_reverify", { p_limit: input.limit ?? 100 });
  if (due.error || !Array.isArray(due.data)) {
    counts.errors += 1;
    return counts;
  }
  counts.due = due.data.length;
  for (const item of due.data as Array<Record<string, unknown>>) {
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
      const evidence = await buildSenderEvidence(provider, ids, inboundUrl);
      const { data, error } = await admin.rpc("tw4_sender_reverify", { p_studio_id: studioId, p_sender_id: senderId, p_evidence: evidence, p_source: provider.isFake ? "fake" : "provider_read" });
      if (error) {
        counts.errors += 1;
        continue;
      }
      const result = readResult(data);
      if (result.outcome === "error") counts.errors += 1;
      else counts[result.outcome] += 1;
    } catch {
      counts.errors += 1;
    }
  }
  return counts;
}
