import "server-only";
import { provisioningCallsAllowed, type IsvConfig } from "./config";
import type { CampaignCreateInput, CampaignFacts, IsvProvisioningAdapter, MessagingServiceFacts } from "./provisioningTypes";
import { TwilioRest } from "./real";
import { IsvApiError } from "./types";

/**
 * TW-4F R2a: the REAL Twilio adapter for Messaging Service and A2P campaign provisioning inside ONE subaccount (its own SID and Auth Token; the parent
 * key never signs these calls). `createScopedProvisioningAdapter` refuses to build one unless `provisioningCallsAllowed()` is true (production build on a
 * production deployment with BOTH TW4_ISV_REAL_CALLS=on and TW4_PROVISIONING_REAL_CALLS=on).
 *
 * STATUS: request shapes follow Twilio's public Messaging Services / Usa2p documentation and are pinned by unit tests with an injected `fetch`. NOT run
 * against live Twilio. Outcome classification is the registration adapter's: only a parsed 4xx is a definite failure; a network error, timeout, 429/5xx,
 * unreadable body or a 2xx without a valid SID is `transient` (the resource may exist) and is reconciled by lookup before anything is repeated.
 */

const MESSAGING = "https://messaging.twilio.com/v1";
const SERVICE_SID = /^MG[0-9a-fA-F]{32}$/;
const CAMPAIGN_SID = /^QE[0-9a-fA-F]{32}$/;
const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;

type FetchLike = ConstructorParameters<typeof RealProvisioningAdapter>[1];

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const checked = (sid: string, pattern: RegExp): string => {
  if (!pattern.test(sid)) throw new IsvApiError("validation", null, null, "malformed resource sid");
  return sid;
};

/** Printable, single-line, bounded: what Twilio said failed, safe to store and show. */
function sanitizeErrors(value: unknown): string {
  const parts: string[] = [];
  const visit = (item: unknown) => {
    if (typeof item === "string") parts.push(item);
    else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object") Object.values(item as Record<string, unknown>).forEach(visit);
  };
  visit(value);
  return parts.join("; ").replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim().slice(0, 450);
}

export class RealProvisioningAdapter extends TwilioRest<IsvConfig> implements IsvProvisioningAdapter {
  get accountSid(): string {
    return this.config.accountSid;
  }

  async findMessagingServices(friendlyNamePrefix: string): Promise<string[]> {
    const rows = await this.listAll(`${MESSAGING}/Services?PageSize=50`, MESSAGING, "services");
    return rows.filter((row) => typeof row.friendly_name === "string" && row.friendly_name.startsWith(friendlyNamePrefix) && row.account_sid === this.accountSid).map((row) => String(row.sid));
  }

  async createMessagingService(input: { friendlyName: string; inboundRequestUrl: string }): Promise<string> {
    // The service routes inbound texts to DanceFlow itself (not to each number), so the route is verifiable on the service.
    const json = await this.request("POST", `${MESSAGING}/Services`, {
      FriendlyName: input.friendlyName, InboundRequestUrl: input.inboundRequestUrl, InboundMethod: "POST", UseInboundWebhookOnNumber: "false",
    });
    return this.sid(json, SERVICE_SID);
  }

  async getMessagingService(sid: string): Promise<MessagingServiceFacts> {
    const b = await this.request("GET", `${MESSAGING}/Services/${checked(sid, SERVICE_SID)}`);
    return {
      sid: str(b.sid), account_sid: str(b.account_sid), friendly_name: str(b.friendly_name), inbound_request_url: str(b.inbound_request_url),
      use_inbound_webhook_on_number: bool(b.use_inbound_webhook_on_number), us_app_to_person_registered: bool(b.us_app_to_person_registered),
    };
  }

  async findCampaigns(messagingServiceSid: string): Promise<string[]> {
    const rows = await this.listAll(`${MESSAGING}/Services/${checked(messagingServiceSid, SERVICE_SID)}/Compliance/Usa2p?PageSize=50`, MESSAGING, "compliance");
    return rows.filter((row) => row.account_sid === this.accountSid).map((row) => String(row.sid));
  }

  async createCampaign(input: CampaignCreateInput): Promise<string> {
    const json = await this.request("POST", `${MESSAGING}/Services/${checked(input.messagingServiceSid, SERVICE_SID)}/Compliance/Usa2p`, {
      BrandRegistrationSid: input.brandSid,
      UsAppToPersonUsecase: input.useCase,
      Description: input.description,
      MessageFlow: input.messageFlow,
      MessageSamples: input.messageSamples,
      HasEmbeddedLinks: String(input.hasEmbeddedLinks),
      HasEmbeddedPhone: String(input.hasEmbeddedPhone),
      SubscriberOptIn: String(input.subscriberOptIn),
      AgeGated: String(input.ageGated),
      DirectLending: String(input.directLending),
      OptInMessage: input.optInMessage,
      OptOutMessage: input.optOutMessage,
      HelpMessage: input.helpMessage,
      OptInKeywords: input.optInKeywords,
      OptOutKeywords: input.optOutKeywords,
      HelpKeywords: input.helpKeywords,
    });
    return this.sid(json, CAMPAIGN_SID);
  }

  async getCampaign(messagingServiceSid: string, campaignSid: string): Promise<CampaignFacts> {
    const b = await this.request("GET", `${MESSAGING}/Services/${checked(messagingServiceSid, SERVICE_SID)}/Compliance/Usa2p/${checked(campaignSid, CAMPAIGN_SID)}`);
    return {
      sid: str(b.sid), account_sid: str(b.account_sid), messaging_service_sid: str(b.messaging_service_sid), brand_registration_sid: str(b.brand_registration_sid),
      us_app_to_person_usecase: str(b.us_app_to_person_usecase), campaign_status: str(b.campaign_status), mock: bool(b.mock), errors: sanitizeErrors(b.errors),
    };
  }
}

/** A provisioning adapter for ONE subaccount, signed with that subaccount's own credentials. The parent's API key is dropped on purpose. */
export function createScopedProvisioningAdapter(
  config: IsvConfig, accountSid: string, authToken: string, env: Record<string, string | undefined> = process.env, fetchImpl?: FetchLike,
): RealProvisioningAdapter {
  const gate = provisioningCallsAllowed(env);
  if (!gate.allowed) throw new IsvApiError("account", null, null, gate.reason);
  if (!ACCOUNT_SID.test(accountSid) || accountSid === config.accountSid) throw new IsvApiError("account", null, null, "not a subaccount sid");
  if (!authToken) throw new IsvApiError("account", null, null, "no subaccount credential");
  return new RealProvisioningAdapter({ ...config, accountSid, authToken, apiKeySid: undefined, apiKeySecret: undefined }, fetchImpl ?? ((url, init) => fetch(url, init)));
}
