/**
 * TW-4F F5: the Twilio side of a controlled CANCELLATION, as two small interfaces kept apart from the provisioning ones (`IsvNumberAdapter`,
 * `IsvProvisioningAdapter`), so nothing that only provisions can release. The real implementations are the new methods of `RealNumberAdapter` and
 * `RealProvisioningAdapter` (real.ts, behind TW4_NUMBER_REAL_CALLS / TW4_PROVISIONING_REAL_CALLS on a production deployment); tests and local QA use the
 * fakes. Only `cancelRunner.ts` calls the release methods, and only after the database granted the single claim (`tw4_rfl_cancel_begin` = execute).
 *
 * Every release is IRREVERSIBLE. A release method answers "released" (Twilio accepted the delete) or "already_absent" (Twilio's documented 404/20404);
 * anything else throws an `IsvApiError`, and a transient one means the outcome is UNKNOWN: the runner records it and never repeats it by itself.
 * Presence reads are free and are what the evidence digest is made of: a cancellation is confirmed only by a read showing the resource gone.
 */

export type ReleaseResult = "released" | "already_absent";
export type ProviderPresence = "present" | "absent";

export interface NumberReleaseAdapter {
  readonly accountSid: string;
  readonly evidenceSource: "provider_read" | "fake";
  /** IRREVERSIBLE. Releases the number from this account. */
  releaseNumber(phoneNumberSid: string): Promise<ReleaseResult>;
  /** Removes the number from a service's sender pool; does NOT release it. */
  detachNumber(input: { messagingServiceSid: string; phoneNumberSid: string }): Promise<ReleaseResult>;
  numberPresence(phoneNumberSid: string): Promise<ProviderPresence>;
}

export interface ProvisioningReleaseAdapter {
  readonly accountSid: string;
  readonly evidenceSource: "provider_read" | "fake";
  /** IRREVERSIBLE. Deletes the A2P campaign of the service. */
  deleteCampaign(input: { messagingServiceSid: string; campaignSid: string }): Promise<ReleaseResult>;
  /** IRREVERSIBLE. Deletes the Messaging Service (and its campaign with it). */
  deleteMessagingService(sid: string): Promise<ReleaseResult>;
  campaignPresence(input: { messagingServiceSid: string; campaignSid: string }): Promise<ProviderPresence>;
  servicePresence(sid: string): Promise<ProviderPresence>;
  /** Free, read-only, evidence-grade (complete or a throw): campaigns registered on the service AT THE PROVIDER (deleting the service would delete them). */
  findCampaigns(messagingServiceSid: string): Promise<string[]>;
}
