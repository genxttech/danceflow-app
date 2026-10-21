/**
 * TW-4F R2b: the Twilio side of phone-number provisioning, as an interface. The runner (`numberRunner.ts`) only ever talks to `IsvNumberAdapter`; the real
 * implementation (`RealNumberAdapter` in real.ts) is the only code that can reach these endpoints, and it cannot be built unless `numberCallsAllowed` says so.
 * Tests and local QA use `FakeNumberAdapter`. Errors are `IsvApiError` (see types.ts): never carrying request values, only Twilio's own code and text.
 *
 * Read methods return NORMALIZED facts (a few fields), never a raw response: those facts are what the database judges (tw4_num_observe, tw4_act_compliance_record).
 * Only `purchaseNumber` costs money; search and every read are free.
 */

export type AvailableNumber = {
  e164: string;
  locality: string | null;
  region: string | null;
  sms_capable: boolean;
  mms_capable: boolean;
  /** Twilio's own value ("none" = no regulatory address needed). The database offers only "none". */
  address_requirements: string | null;
};

export type OwnedNumberFacts = {
  sid: string | null;
  account_sid: string | null;
  phone_number: string | null;
  sms_capable: boolean | null;
};

export type ServiceNumbersFacts = {
  service_sid: string | null;
  account_sid: string | null;
  number_sids: string[];
};

export type CampaignComplianceFacts = {
  sid: string | null;
  account_sid: string | null;
  messaging_service_sid: string | null;
  campaign_status: string | null;
  mock: boolean | null;
  opt_in_keywords: string[];
  opt_out_keywords: string[];
  help_keywords: string[];
  opt_in_message: string | null;
  opt_out_message: string | null;
  help_message: string | null;
};

export type ServiceRouteFacts = {
  sid: string | null;
  account_sid: string | null;
  inbound_request_url: string | null;
  use_inbound_webhook_on_number: boolean | null;
};

export interface IsvNumberAdapter {
  /** The Twilio account (a legal business's SUBACCOUNT) every call of this adapter runs in. The runner refuses an adapter that is not the recorded one. */
  readonly accountSid: string;
  /** Where this adapter's read-back facts come from. Derived from the adapter itself, never chosen by the caller: the fake can never claim to be a provider read. */
  readonly evidenceSource: "provider_read" | "fake";

  /** FREE, read-only. US local SMS-enabled numbers, optionally in one area code. Buys and reserves nothing. */
  searchAvailableNumbers(query: { areaCode?: string; limit: number }): Promise<AvailableNumber[]>;
  /** Incoming numbers of THIS account with exactly this E.164 (a complete listing or a throw: never a silently partial one). */
  findOwnedNumbers(e164: string): Promise<string[]>;
  /** FEE-BEARING. Buys the number in this account. A response is a purchase, confirmed only by a later read (`getNumber`). */
  purchaseNumber(input: { e164: string; friendlyName: string }): Promise<string>;
  getNumber(sid: string): Promise<OwnedNumberFacts>;

  /** Number SIDs attached to this Messaging Service (a complete listing or a throw). */
  listServiceNumbers(messagingServiceSid: string): Promise<string[]>;
  /** Free. Adds the number to the Messaging Service sender pool. */
  attachNumber(input: { messagingServiceSid: string; phoneNumberSid: string }): Promise<string>;
  getServiceNumbers(messagingServiceSid: string): Promise<ServiceNumbersFacts>;

  /** Free, read-only: the campaign's opt-in / opt-out / help keywords and reply messages (compliance validation) and the service's inbound route. */
  getCampaignCompliance(messagingServiceSid: string, campaignSid: string): Promise<CampaignComplianceFacts>;
  getServiceRoute(messagingServiceSid: string): Promise<ServiceRouteFacts>;
}
