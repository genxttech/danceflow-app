import { IsvApiError } from "./types";
import type { AvailableNumber, CampaignComplianceFacts, CreationHistoryFacts, IsvNumberAdapter, OwnedNumberFacts, ServiceNumbersFacts, ServiceRouteFacts } from "./numberTypes";
import type { NumberReleaseAdapter, ProviderPresence, ReleaseResult } from "./releaseTypes";

/**
 * TW-4F R2b: an in-memory Twilio stand-in for phone-number provisioning. The ONLY implementation used by tests and non-production environments. Like Twilio:
 * deterministic SIDs that exist only inside one account, a number that can be owned by exactly one account (a purchase of a number another account holds is refused),
 * lookups by E.164, a service whose sender pool is per account, and injectable failures including the dangerous one: the request SUCCEEDS inside "Twilio" but the
 * caller sees a transient error (`lostResponse`), which the runner must reconcile instead of repeating.
 */

type Method = keyof IsvNumberAdapter | keyof NumberReleaseAdapter;
type Failure = { kind: "validation" | "transient" | "account" | "unexpected"; lostResponse?: boolean; code?: string; status?: number };

let sidCounter = 0;
export const DEFAULT_FAKE_NUMBER_ACCOUNT = `AC${"3".repeat(32)}`;

type OwnedRow = { sid: string; account_sid: string; phone_number: string; sms_capable: boolean };
type ServiceRow = { sid: string; account_sid: string; inbound_request_url: string | null; use_inbound_webhook_on_number: boolean | null; numbers: Set<string> };

/** The numbers every fake account shares (one number, one owner) and the catalogue of numbers a search can return. */
export class FakeNumberUniverse {
  readonly owned = new Map<string, OwnedRow>();
  /** Every number ever created in an account, deleted or not (what a provider's creation history would show). */
  readonly createdLog: { account_sid: string; e164: string; at: number }[] = [];
  readonly catalogue: AvailableNumber[] = [];
}

export class FakeNumberAdapter implements IsvNumberAdapter, NumberReleaseAdapter {
  readonly calls: { method: Method; input: unknown }[] = [];
  readonly services = new Map<string, ServiceRow>();
  readonly campaigns = new Map<string, CampaignComplianceFacts>();
  private failures: { method: Method; failure: Failure }[] = [];
  readonly evidenceSource = "fake" as const;

  constructor(readonly accountSid: string = DEFAULT_FAKE_NUMBER_ACCOUNT, readonly universe: FakeNumberUniverse = new FakeNumberUniverse()) {}

  failNext(method: Method, failure: Failure) {
    this.failures.push({ method, failure });
  }

  count(method: Method) {
    return this.calls.filter((call) => call.method === method).length;
  }

  private sid(prefix: string) {
    sidCounter += 1;
    return `${prefix}${sidCounter.toString(16).padStart(32, "0")}`;
  }

  private enter(method: Method, input: unknown): Failure | null {
    this.calls.push({ method, input });
    const index = this.failures.findIndex((entry) => entry.method === method);
    if (index < 0) return null;
    const [entry] = this.failures.splice(index, 1);
    return entry.failure;
  }

  private throwFor(failure: Failure): never {
    if (failure.kind === "unexpected") throw new Error("fake unexpected failure");
    const status = failure.status ?? (failure.kind === "validation" ? 400 : failure.kind === "account" ? 401 : 503);
    throw new IsvApiError(failure.kind, status, failure.code ?? null, `fake ${failure.kind} failure`);
  }

  private guarded<T>(method: Method, input: unknown, effect: () => T): T {
    const failure = this.enter(method, input);
    if (failure && !failure.lostResponse) this.throwFor(failure);
    const result = effect();
    if (failure && failure.lostResponse) this.throwFor(failure);
    return result;
  }

  // ---- test seams ----------------------------------------------------------------------------------------------------------------------------
  /** A number a search can return. */
  seedAvailable(e164: string, over: Partial<AvailableNumber> = {}): this {
    this.universe.catalogue.push({ e164, locality: "Testville", region: "TS", sms_capable: true, mms_capable: true, address_requirements: "none", ...over });
    return this;
  }

  /** A number this account already owns (bought by hand, or by an earlier run whose response was lost). */
  seedOwned(e164: string, over: Partial<OwnedRow> = {}): string {
    const sid = this.sid("PN");
    this.universe.owned.set(sid, { sid, account_sid: this.accountSid, phone_number: e164, sms_capable: true, ...over });
    this.universe.createdLog.push({ account_sid: this.accountSid, e164, at: Date.now() });
    return sid;
  }

  tamperOwned(sid: string, patch: Partial<OwnedRow>) {
    const row = this.universe.owned.get(sid);
    if (!row) throw new Error("unknown fake number");
    Object.assign(row, patch);
  }

  /** A Messaging Service of this account (R2a's fake owns the real one in a combined run; this one stands alone for number tests). */
  registerService(sid: string, over: Partial<Omit<ServiceRow, "sid" | "numbers">> = {}) {
    this.services.set(sid, { sid, account_sid: this.accountSid, inbound_request_url: null, use_inbound_webhook_on_number: false, numbers: new Set(), ...over });
  }

  registerCampaign(sid: string, facts: Partial<CampaignComplianceFacts>) {
    this.campaigns.set(sid, {
      sid, account_sid: this.accountSid, messaging_service_sid: null, campaign_status: "VERIFIED", mock: false,
      opt_in_keywords: ["START"], opt_out_keywords: ["STOP"], help_keywords: ["HELP"],
      opt_in_message: "You are subscribed to studio messages. Reply STOP to opt out.", opt_out_message: "You are unsubscribed and will receive no more messages.",
      help_message: "Studio help: contact the front desk. Reply STOP to opt out.", ...facts,
    });
  }

  /** A number detached from a service at the provider. */
  detach(messagingServiceSid: string, phoneNumberSid: string) {
    this.services.get(messagingServiceSid)?.numbers.delete(phoneNumberSid);
  }

  // ---- the adapter -----------------------------------------------------------------------------------------------------------------------------
  async searchAvailableNumbers(query: { areaCode?: string; limit: number }) {
    return this.guarded("searchAvailableNumbers", query, () => {
      const taken = new Set([...this.universe.owned.values()].map((row) => row.phone_number));
      return this.universe.catalogue
        .filter((row) => !taken.has(row.e164) && (!query.areaCode || row.e164.slice(2, 5) === query.areaCode))
        .slice(0, query.limit)
        .map((row) => ({ ...row }));
    });
  }

  async listIncomingNumbers() {
    return this.guarded("listIncomingNumbers", {}, () => [...this.universe.owned.values()].filter((row) => row.account_sid === this.accountSid).map((row) => ({ sid: row.sid, phone_number: row.phone_number })));
  }

  async findOwnedNumbers(e164: string) {
    return this.guarded("findOwnedNumbers", { e164 }, () => [...this.universe.owned.values()].filter((row) => row.account_sid === this.accountSid && row.phone_number === e164).map((row) => row.sid));
  }

  async purchaseNumber(input: { e164: string; friendlyName: string }) {
    return this.guarded("purchaseNumber", input, () => {
      // like Twilio: a number is owned by exactly one account, and it must be one the catalogue still offers
      if ([...this.universe.owned.values()].some((row) => row.phone_number === input.e164)) throw new IsvApiError("validation", 400, "21452", "fake: number not available");
      if (!this.universe.catalogue.some((row) => row.e164 === input.e164)) throw new IsvApiError("validation", 400, "21452", "fake: number not available");
      const sid = this.sid("PN");
      this.universe.owned.set(sid, { sid, account_sid: this.accountSid, phone_number: input.e164, sms_capable: true });
      this.universe.createdLog.push({ account_sid: this.accountSid, e164: input.e164, at: Date.now() });
      return sid;
    });
  }

  /** test seam: the history is truncated / has a retention gap */
  historyComplete = true;

  async readCreationHistory(since: Date): Promise<CreationHistoryFacts> {
    return this.guarded("readCreationHistory", { since: since.toISOString() }, () => ({
      account_sid: this.accountSid,
      window_start: since.toISOString(),
      window_end: new Date().toISOString(),
      complete: this.historyComplete,
      created_e164: this.universe.createdLog.filter((row) => row.account_sid === this.accountSid && row.at >= since.getTime()).map((row) => row.e164),
    }));
  }

  async getNumber(sid: string): Promise<OwnedNumberFacts> {
    return this.guarded("getNumber", { sid }, () => {
      const row = this.universe.owned.get(sid);
      // a number of another account is "not found" to this account, like Twilio's per-account scoping
      if (!row || row.account_sid !== this.accountSid) throw new IsvApiError("validation", 404, "20404", "fake: not found");
      return { sid: row.sid, account_sid: row.account_sid, phone_number: row.phone_number, sms_capable: row.sms_capable };
    });
  }

  async listServiceNumbers(messagingServiceSid: string) {
    return this.guarded("listServiceNumbers", { messagingServiceSid }, () => {
      const service = this.services.get(messagingServiceSid);
      if (!service || service.account_sid !== this.accountSid) throw new IsvApiError("validation", 404, "20404", "fake: not found");
      return [...service.numbers];
    });
  }

  async attachNumber(input: { messagingServiceSid: string; phoneNumberSid: string }) {
    return this.guarded("attachNumber", input, () => {
      const service = this.services.get(input.messagingServiceSid);
      const number = this.universe.owned.get(input.phoneNumberSid);
      if (!service || service.account_sid !== this.accountSid || !number || number.account_sid !== this.accountSid) throw new IsvApiError("validation", 404, "20404", "fake: not found");
      // like Twilio: a number belongs to one service at a time
      for (const other of this.services.values()) {
        if (other.sid !== service.sid && other.numbers.has(number.sid)) throw new IsvApiError("validation", 409, "21712", "fake: number already in another service");
      }
      service.numbers.add(number.sid);
      return number.sid;
    });
  }

  async getServiceNumbers(messagingServiceSid: string): Promise<ServiceNumbersFacts> {
    return this.guarded("getServiceNumbers", { messagingServiceSid }, () => {
      const service = this.services.get(messagingServiceSid);
      if (!service || service.account_sid !== this.accountSid) throw new IsvApiError("validation", 404, "20404", "fake: not found");
      return { service_sid: service.sid, account_sid: service.account_sid, number_sids: [...service.numbers] };
    });
  }

  async getCampaignCompliance(messagingServiceSid: string, campaignSid: string): Promise<CampaignComplianceFacts> {
    return this.guarded("getCampaignCompliance", { messagingServiceSid, campaignSid }, () => {
      const row = this.campaigns.get(campaignSid);
      if (!row || row.account_sid !== this.accountSid) throw new IsvApiError("validation", 404, "20404", "fake: not found");
      return { ...row, messaging_service_sid: row.messaging_service_sid ?? messagingServiceSid };
    });
  }

  async getServiceRoute(messagingServiceSid: string): Promise<ServiceRouteFacts> {
    return this.guarded("getServiceRoute", { messagingServiceSid }, () => {
      const service = this.services.get(messagingServiceSid);
      if (!service || service.account_sid !== this.accountSid) throw new IsvApiError("validation", 404, "20404", "fake: not found");
      return { sid: service.sid, account_sid: service.account_sid, inbound_request_url: service.inbound_request_url, use_inbound_webhook_on_number: service.use_inbound_webhook_on_number };
    });
  }

  // ---- TW-4F F5: release (like Twilio: a number of another account is "not found", so it reads as already absent here) ---------------------
  async releaseNumber(phoneNumberSid: string): Promise<ReleaseResult> {
    return this.guarded("releaseNumber", { phoneNumberSid }, () => {
      const row = this.universe.owned.get(phoneNumberSid);
      if (!row || row.account_sid !== this.accountSid) return "already_absent" as const;
      this.universe.owned.delete(phoneNumberSid);
      // a released number leaves every sender pool with it
      for (const service of this.services.values()) service.numbers.delete(phoneNumberSid);
      return "released" as const;
    });
  }

  async detachNumber(input: { messagingServiceSid: string; phoneNumberSid: string }): Promise<ReleaseResult> {
    return this.guarded("detachNumber", input, () => {
      const service = this.services.get(input.messagingServiceSid);
      if (!service || service.account_sid !== this.accountSid || !service.numbers.delete(input.phoneNumberSid)) return "already_absent" as const;
      return "released" as const;
    });
  }

  async numberPresence(phoneNumberSid: string): Promise<ProviderPresence> {
    return this.guarded("numberPresence", { phoneNumberSid }, () => {
      const row = this.universe.owned.get(phoneNumberSid);
      return row && row.account_sid === this.accountSid ? ("present" as const) : ("absent" as const);
    });
  }
}

/** One fake adapter per subaccount sharing ONE number universe (a number has one owner across all of them), like the real world. */
export class FakeNumberHub {
  readonly universe = new FakeNumberUniverse();
  private readonly adapters = new Map<string, FakeNumberAdapter>();

  adapterFor(accountSid: string): FakeNumberAdapter {
    let adapter = this.adapters.get(accountSid);
    if (!adapter) {
      adapter = new FakeNumberAdapter(accountSid, this.universe);
      this.adapters.set(accountSid, adapter);
    }
    return adapter;
  }
}
