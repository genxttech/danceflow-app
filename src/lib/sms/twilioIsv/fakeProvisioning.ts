import { IsvApiError } from "./types";
import type { CampaignCreateInput, CampaignFacts, IsvProvisioningAdapter, MessagingServiceFacts } from "./provisioningTypes";
import type { ProviderPresence, ProvisioningReleaseAdapter, ReleaseResult } from "./releaseTypes";

/**
 * TW-4F R2a: an in-memory Twilio stand-in for Messaging Service and campaign provisioning. The ONLY implementation used by tests and non-production
 * environments. Like Twilio: deterministic SIDs that exist only inside one account, friendly-name lookups, and a campaign that starts IN_PROGRESS and is
 * approved or rejected only when the test says so (`setCampaignStatus`). Injectable failures include the dangerous one: the request SUCCEEDS inside
 * "Twilio" but the caller sees a transient error (`lostResponse`), which the runner must reconcile instead of repeating.
 */

type Method = keyof IsvProvisioningAdapter | keyof ProvisioningReleaseAdapter;
type Failure = { kind: "validation" | "transient" | "account" | "unexpected"; lostResponse?: boolean; code?: string };

/** SIDs are unique across every fake account, like Twilio's (a per-adapter counter would hand out the same SID in two accounts). */
let sidCounter = 0;

export const DEFAULT_FAKE_PROVISIONING_ACCOUNT = `AC${"2".repeat(32)}`;

type ServiceRow = MessagingServiceFacts & { sid: string; account_sid: string };
type CampaignRow = CampaignFacts & { sid: string; account_sid: string; messaging_service_sid: string; input: CampaignCreateInput };

export class FakeProvisioningAdapter implements IsvProvisioningAdapter, ProvisioningReleaseAdapter {
  readonly calls: { method: Method; input: unknown }[] = [];
  readonly services = new Map<string, ServiceRow>();
  readonly campaigns = new Map<string, CampaignRow>();
  private failures: { method: Method; failure: Failure }[] = [];

  readonly evidenceSource = "fake" as const;

  constructor(readonly accountSid: string = DEFAULT_FAKE_PROVISIONING_ACCOUNT) {}

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
    const status = failure.kind === "validation" ? 400 : failure.kind === "account" ? 401 : 503;
    throw new IsvApiError(failure.kind, status, failure.code ?? null, `fake ${failure.kind} failure`);
  }

  private guarded<T>(method: Method, input: unknown, effect: () => T): T {
    const failure = this.enter(method, input);
    if (failure && !failure.lostResponse) this.throwFor(failure);
    const result = effect();
    if (failure && failure.lostResponse) this.throwFor(failure);
    return result;
  }

  /** Test seam: the provider decides a campaign (VERIFIED / FAILED / IN_PROGRESS / anything else, unrecognized). */
  setCampaignStatus(sid: string, status: string, errors = "") {
    const row = this.campaigns.get(sid);
    if (!row) throw new Error("unknown fake campaign");
    row.campaign_status = status;
    row.errors = errors;
  }

  /** Test seam: an admin removed a (failed) campaign at the provider console. */
  removeCampaign(sid: string) {
    this.campaigns.delete(sid);
  }

  /** Test seam: change what the provider reports about a service or campaign (wrong route, wrong brand, wrong use case, mock ...). */
  tamperService(sid: string, patch: Partial<MessagingServiceFacts>) {
    const row = this.services.get(sid);
    if (!row) throw new Error("unknown fake service");
    Object.assign(row, patch);
  }

  tamperCampaign(sid: string, patch: Partial<CampaignFacts>) {
    const row = this.campaigns.get(sid);
    if (!row) throw new Error("unknown fake campaign");
    Object.assign(row, patch);
  }

  /** Test seam: a resource that already exists in this account (made by hand, or by an earlier run whose response was lost). */
  seedService(friendlyName: string, patch: Partial<Omit<MessagingServiceFacts, "sid" | "account_sid">> = {}): string {
    const sid = this.sid("MG");
    this.services.set(sid, { sid, account_sid: this.accountSid, friendly_name: friendlyName, inbound_request_url: null, use_inbound_webhook_on_number: null, us_app_to_person_registered: false, ...patch });
    return sid;
  }

  async findMessagingServices(prefix: string) {
    return this.guarded("findMessagingServices", { prefix }, () => [...this.services.values()].filter((row) => (row.friendly_name ?? "").startsWith(prefix)).map((row) => row.sid));
  }

  async createMessagingService(input: { friendlyName: string; inboundRequestUrl: string }) {
    return this.guarded("createMessagingService", input, () => {
      const sid = this.sid("MG");
      this.services.set(sid, {
        sid, account_sid: this.accountSid, friendly_name: input.friendlyName, inbound_request_url: input.inboundRequestUrl,
        use_inbound_webhook_on_number: false, us_app_to_person_registered: false,
      });
      return sid;
    });
  }

  async getMessagingService(sid: string) {
    return this.guarded("getMessagingService", { sid }, () => {
      const row = this.services.get(sid);
      if (!row) throw new IsvApiError("validation", 404, "20404", "fake: not found");
      return { ...row };
    });
  }

  async findCampaigns(messagingServiceSid: string) {
    return this.guarded("findCampaigns", { messagingServiceSid }, () => [...this.campaigns.values()].filter((row) => row.messaging_service_sid === messagingServiceSid).map((row) => row.sid));
  }

  async createCampaign(input: CampaignCreateInput) {
    return this.guarded("createCampaign", input, () => {
      if (!this.services.has(input.messagingServiceSid)) throw new IsvApiError("validation", 404, "20404", "fake: no such messaging service");
      // like Twilio: one campaign per Messaging Service (a failed one must be removed at the provider before another is submitted)
      if ([...this.campaigns.values()].some((row) => row.messaging_service_sid === input.messagingServiceSid)) throw new IsvApiError("validation", 409, "21715", "fake: the service already has a campaign");
      const sid = this.sid("QE");
      this.campaigns.set(sid, {
        sid, account_sid: this.accountSid, messaging_service_sid: input.messagingServiceSid, brand_registration_sid: input.brandSid,
        us_app_to_person_usecase: input.useCase, campaign_status: "IN_PROGRESS", mock: false, errors: "", input,
      });
      return sid;
    });
  }

  async getCampaign(messagingServiceSid: string, campaignSid: string) {
    return this.guarded("getCampaign", { messagingServiceSid, campaignSid }, () => {
      const row = this.campaigns.get(campaignSid);
      if (!row || row.messaging_service_sid !== messagingServiceSid) throw new IsvApiError("validation", 404, "20404", "fake: not found");
      const { input: _input, ...facts } = row;
      void _input;
      return { ...facts };
    });
  }

  // ---- TW-4F F5: release ------------------------------------------------------------------------------------------------------------------------
  async deleteCampaign(input: { messagingServiceSid: string; campaignSid: string }): Promise<ReleaseResult> {
    return this.guarded("deleteCampaign", input, () => {
      const row = this.campaigns.get(input.campaignSid);
      if (!row || row.messaging_service_sid !== input.messagingServiceSid) return "already_absent" as const;
      this.campaigns.delete(input.campaignSid);
      return "released" as const;
    });
  }

  async deleteMessagingService(sid: string): Promise<ReleaseResult> {
    return this.guarded("deleteMessagingService", { sid }, () => {
      if (!this.services.delete(sid)) return "already_absent" as const;
      // like Twilio: deleting the service deletes its campaign
      for (const row of [...this.campaigns.values()]) if (row.messaging_service_sid === sid) this.campaigns.delete(row.sid);
      return "released" as const;
    });
  }

  async campaignPresence(input: { messagingServiceSid: string; campaignSid: string }): Promise<ProviderPresence> {
    return this.guarded("campaignPresence", input, () => {
      const row = this.campaigns.get(input.campaignSid);
      return row && row.messaging_service_sid === input.messagingServiceSid ? ("present" as const) : ("absent" as const);
    });
  }

  async servicePresence(sid: string): Promise<ProviderPresence> {
    return this.guarded("servicePresence", { sid }, () => (this.services.has(sid) ? ("present" as const) : ("absent" as const)));
  }
}

/** One fake adapter per subaccount (resources never cross accounts), like the real world. */
export class FakeProvisioningHub {
  private readonly adapters = new Map<string, FakeProvisioningAdapter>();

  adapterFor(accountSid: string): FakeProvisioningAdapter {
    let adapter = this.adapters.get(accountSid);
    if (!adapter) {
      adapter = new FakeProvisioningAdapter(accountSid);
      this.adapters.set(accountSid, adapter);
    }
    return adapter;
  }
}
