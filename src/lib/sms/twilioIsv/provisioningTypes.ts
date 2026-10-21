import type { CampaignUseCase } from "./registrationPath";

/**
 * TW-4F R2a: the Twilio side of Messaging Service and campaign provisioning, as an interface. The runner (`provisionRunner.ts`) only ever talks to
 * `IsvProvisioningAdapter`; the real implementation (`realProvisioning.ts`) is the only code that can reach these endpoints, and it cannot be built
 * unless `provisioningCallsAllowed` says so. Tests and local QA use `FakeProvisioningAdapter`. Errors are `IsvApiError` (see types.ts): never carrying
 * request values, only Twilio's own code and text.
 *
 * Read methods return NORMALIZED facts (a few fields), never a raw response: those facts are what the database judges (tw4_prov_observe).
 */

export type MessagingServiceFacts = {
  sid: string | null;
  account_sid: string | null;
  friendly_name: string | null;
  inbound_request_url: string | null;
  use_inbound_webhook_on_number: boolean | null;
  us_app_to_person_registered: boolean | null;
};

export type CampaignFacts = {
  sid: string | null;
  account_sid: string | null;
  messaging_service_sid: string | null;
  brand_registration_sid: string | null;
  us_app_to_person_usecase: string | null;
  /** Twilio's own value: IN_PROGRESS | VERIFIED | FAILED (anything else is unrecognized and is treated as pending, never approved). */
  campaign_status: string | null;
  mock: boolean | null;
  /** Sanitized, printable-only rejection text (what Twilio said failed); empty when none. */
  errors: string;
};

export type CampaignCreateInput = {
  messagingServiceSid: string;
  brandSid: string;
  useCase: CampaignUseCase;
  description: string;
  messageFlow: string;
  messageSamples: string[];
  hasEmbeddedLinks: boolean;
  hasEmbeddedPhone: boolean;
  subscriberOptIn: boolean;
  ageGated: boolean;
  directLending: boolean;
  optInMessage: string;
  optOutMessage: string;
  helpMessage: string;
  optInKeywords: string[];
  optOutKeywords: string[];
  helpKeywords: string[];
};

export interface IsvProvisioningAdapter {
  /** The Twilio account (a legal business's SUBACCOUNT) every call of this adapter runs in. The runner refuses an adapter that is not the recorded one. */
  readonly accountSid: string;

  /** Messaging Services of this account whose friendly name STARTS WITH the prefix (a complete listing or a throw: never a silently partial one). */
  findMessagingServices(friendlyNamePrefix: string): Promise<string[]>;
  createMessagingService(input: { friendlyName: string; inboundRequestUrl: string }): Promise<string>;
  getMessagingService(sid: string): Promise<MessagingServiceFacts>;

  /** Campaign SIDs registered on this Messaging Service (a complete listing or a throw). */
  findCampaigns(messagingServiceSid: string): Promise<string[]>;
  /** FEE-BEARING. Submits the campaign for review. A response is a submission, never an approval. */
  createCampaign(input: CampaignCreateInput): Promise<string>;
  getCampaign(messagingServiceSid: string, campaignSid: string): Promise<CampaignFacts>;
}
