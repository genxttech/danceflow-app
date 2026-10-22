import type { SupabaseClient } from "@supabase/supabase-js";
import type { RunnerInputs } from "./payloads";
import { RunnerStoreError, type RunnerAccount, type RunnerTransitionState } from "./store";
import { parseLocationFeeKinds, type LocationFeeKinds } from "./registrationPath";

/**
 * TW-4F R2a: the provisioning runner's persistence boundary. The Supabase implementation calls ONLY the service-role `tw4_prov_*` functions (and the existing
 * lease-fenced `tw4_runner_*` reads); the ledger tables have no API privileges. Errors carry the SQLSTATE and never the database message text.
 */

export type ProvKind = "messaging_service" | "campaign";
export type ProvStatus = "in_flight" | "succeeded" | "failed" | "unknown_outcome" | "abandoned";
export type ResourceStatus = "pending" | "ready" | "verified" | "failed" | "mismatch";

export type ProvOperationView = {
  id: string; kind: ProvKind; attempt: number; status: ProvStatus; provider_sid: string | null; fee_bearing: boolean; age_seconds: number; superseded: boolean;
  resource_status: ResourceStatus | null; resource_brand: string | null; resource_parent: string | null;
};

export type CampaignRequirements = {
  path: string | null; use_case: "MIXED" | "LOW_VOLUME" | null; pilot: boolean; total_cents?: number;
  blocker: null | "tier_ineligible" | "unpriced" | "awaiting_authorization" | "awaiting_recurring" | "awaiting_funding" | "on_hold" | "pilot_ceiling";
  components: { kind: string; price_cents: number | null; source: "spend" | "recurring"; authorized: boolean }[];
};

export type ProvisionContext = {
  state: string; submission_seq: number; studio_id: string; legal_entity_id: string | null; brand_sid: string | null;
  requirements: CampaignRequirements; operations: ProvOperationView[]; entity_live_elsewhere: ProvKind[];
};

export type ProvClaim = { onboarding_id: string; studio_id: string; state: string; submission_seq: number };

export type BeginArgs = { kind: ProvKind; friendlyName: string; digest: string; params: Record<string, unknown>; actorId: string };
export type BeginResult =
  | { action: "execute"; operation_id: string; attempt: number; fee_kinds: string[]; account_sid: string }
  | { action: "skip"; operation_id: string; provider_sid: string; status: ProvStatus }
  | { action: "reconcile"; operation_id: string; provider_sid: string | null; status: ProvStatus; fee_bearing: boolean; age_seconds: number };

export type FinishOutcome = { status: "succeeded" | "failed" | "unknown_outcome"; providerSid?: string | null; errorCode?: string | null; errorDetail?: string | null };
export type ObserveResult = { status: ResourceStatus; code: string | null; state: string };

export interface ProvisionStore {
  claim(studioId: string, actorId: string, leaseOwner: string, leaseSeconds?: number, mode?: "run" | "refresh"): Promise<ProvClaim>;
  release(onboardingId: string, leaseOwner: string): Promise<void>;
  getAccount(onboardingId: string, leaseOwner: string): Promise<RunnerAccount>;
  getInputs(onboardingId: string, leaseOwner: string): Promise<RunnerInputs>;
  getFeeKinds(onboardingId: string, leaseOwner: string): Promise<LocationFeeKinds>;
  context(onboardingId: string, leaseOwner: string): Promise<ProvisionContext>;
  begin(onboardingId: string, leaseOwner: string, args: BeginArgs): Promise<BeginResult>;
  finish(onboardingId: string, leaseOwner: string, operationId: string, outcome: FinishOutcome): Promise<{ state: string }>;
  observe(onboardingId: string, leaseOwner: string, operationId: string, facts: Record<string, unknown>, expectedInbound: string, source: "provider_read" | "fake", digest: string): Promise<ObserveResult>;
  transition(onboardingId: string, leaseOwner: string, to: RunnerTransitionState, step: string, errorCode: string | null): Promise<string>;
}

type Client = Pick<SupabaseClient, "rpc">;

export class SupabaseProvisionStore implements ProvisionStore {
  constructor(private readonly admin: Client) {}

  private async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = (await this.admin.rpc(fn, args)) as { data: unknown; error: { code?: string } | null };
    if (error) throw new RunnerStoreError(String(error.code ?? "unknown"));
    return data as T;
  }

  async claim(studioId: string, actorId: string, leaseOwner: string, leaseSeconds = 300, mode: "run" | "refresh" = "run"): Promise<ProvClaim> {
    return this.call<ProvClaim>("tw4_prov_claim", { p_studio_id: studioId, p_actor: actorId, p_lease_owner: leaseOwner, p_lease_seconds: leaseSeconds, p_mode: mode });
  }

  async release(onboardingId: string, leaseOwner: string): Promise<void> {
    await this.call("tw4_runner_release", { p_onboarding_id: onboardingId, p_lease_owner: leaseOwner });
  }

  async getAccount(onboardingId: string, leaseOwner: string): Promise<RunnerAccount> {
    const row = await this.call<{ legal_entity_id: string | null; account_sid: string | null; status: string | null }>("tw4_runner_account", { p_onboarding_id: onboardingId, p_lease_owner: leaseOwner });
    return { legalEntityId: row?.legal_entity_id ?? null, accountSid: row?.account_sid ?? null, status: row?.status ?? null };
  }

  async getInputs(onboardingId: string, leaseOwner: string): Promise<RunnerInputs> {
    return this.call<RunnerInputs>("tw4_runner_get_inputs", { p_onboarding_id: onboardingId, p_lease_owner: leaseOwner });
  }

  async getFeeKinds(onboardingId: string, leaseOwner: string): Promise<LocationFeeKinds> {
    return parseLocationFeeKinds(await this.call("tw4_runner_fee_kinds", { p_onboarding_id: onboardingId, p_lease_owner: leaseOwner }));
  }

  async context(onboardingId: string, leaseOwner: string): Promise<ProvisionContext> {
    return this.call<ProvisionContext>("tw4_prov_context", { p_onboarding_id: onboardingId, p_lease_owner: leaseOwner });
  }

  async begin(onboardingId: string, leaseOwner: string, args: BeginArgs): Promise<BeginResult> {
    return this.call<BeginResult>("tw4_prov_begin", {
      p_onboarding_id: onboardingId, p_lease_owner: leaseOwner, p_op_kind: args.kind, p_friendly_name: args.friendlyName, p_request_digest: args.digest, p_params: args.params, p_actor: args.actorId,
    });
  }

  async finish(onboardingId: string, leaseOwner: string, operationId: string, outcome: FinishOutcome): Promise<{ state: string }> {
    const row = await this.call<{ state?: string }>("tw4_prov_finish", {
      p_onboarding_id: onboardingId, p_lease_owner: leaseOwner, p_operation_id: operationId, p_status: outcome.status,
      p_provider_sid: outcome.providerSid ?? null, p_error_code: outcome.errorCode ?? null, p_error_detail: outcome.errorDetail ?? null,
    });
    return { state: String(row?.state ?? "") };
  }

  async observe(onboardingId: string, leaseOwner: string, operationId: string, facts: Record<string, unknown>, expectedInbound: string, source: "provider_read" | "fake", digest: string): Promise<ObserveResult> {
    const row = await this.call<{ status: ResourceStatus; code: string | null; state: string }>("tw4_prov_observe", {
      p_onboarding_id: onboardingId, p_lease_owner: leaseOwner, p_operation_id: operationId, p_facts: facts, p_expected_inbound: expectedInbound, p_source: source, p_digest: digest,
    });
    return { status: row.status, code: row.code ?? null, state: String(row.state ?? "") };
  }

  async transition(onboardingId: string, leaseOwner: string, to: RunnerTransitionState, step: string, errorCode: string | null): Promise<string> {
    const row = await this.call<{ state: string }>("tw4_runner_transition", {
      p_onboarding_id: onboardingId, p_lease_owner: leaseOwner, p_to_state: to, p_step: step, p_error_code: errorCode, p_error_field: null,
    });
    return String(row?.state ?? "");
  }
}
