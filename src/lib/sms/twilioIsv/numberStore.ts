import type { SupabaseClient } from "@supabase/supabase-js";
import { RunnerStoreError, type RunnerAccount, type RunnerTransitionState } from "./store";

/**
 * TW-4F R2b: the number runner's persistence boundary. The Supabase implementation calls ONLY the service-role `tw4_num_*` / `tw4_act_*` functions (and the
 * existing lease-fenced `tw4_runner_*` reads); the ledger tables have no API privileges. Errors carry the SQLSTATE and never the database message text.
 */

export type NumKind = "number_purchase" | "number_attach";
export type NumStatus = "in_flight" | "succeeded" | "failed" | "unknown_outcome" | "abandoned";
export type NumResourceStatus = "owned" | "attached" | "mismatch";

export type NumOperationView = {
  id: string; kind: NumKind; attempt: number; status: NumStatus; provider_sid: string | null; e164: string; fee_bearing: boolean; age_seconds: number; superseded: boolean;
  resource_status: NumResourceStatus | null;
};

export type NumRequirements = {
  blocker: null | "suspended" | "campaign_not_verified" | "unpriced" | "release_current_number_first" | "no_selection" | "selection_expired" | "price_changed" | "selection_stale"
    | "number_taken" | "awaiting_recurring" | "awaiting_authorization" | "awaiting_funding" | "on_hold" | "pilot_ceiling" | "pilot_recurring";
  funding_mode: "credit_recurring" | "pilot";
  price_cents: number | null;
  selection_id: string | null;
  selection_e164: string | null;
  ceiling_remaining_cents: number | null;
};

export type NumContext = {
  state: string; submission_seq: number; studio_id: string; messaging_service_sid: string | null; campaign_sid: string | null;
  requirements: NumRequirements; operations: NumOperationView[];
  /** Every number SID the system accounts for in this business's subaccount (ledger, sender registry, acknowledgements). */
  known_numbers: string[];
};

export type NumClaim = { onboarding_id: string; studio_id: string; state: string; submission_seq: number };
export type NumBeginArgs = { kind: NumKind; friendlyName: string; digest: string; params: Record<string, unknown>; actorId: string };
export type NumBeginResult =
  | { action: "execute"; operation_id: string; attempt: number; fee_kinds: string[]; account_sid: string; e164: string }
  | { action: "skip"; operation_id: string; provider_sid: string; status: NumStatus }
  | { action: "reconcile"; operation_id: string; provider_sid: string | null; status: NumStatus; fee_bearing: boolean; e164: string; age_seconds: number };
export type NumFinishOutcome = { status: "succeeded" | "failed" | "unknown_outcome"; providerSid?: string | null; errorCode?: string | null; errorDetail?: string | null };
export type NumObserveResult = { status: NumResourceStatus; code: string | null; state: string };

export type OfferCandidate = { e164: string; locality: string | null; region: string | null; mms_capable: boolean };
export type OfferRecorded = { offer_id: string; count: number; expires_at: string; candidates: OfferCandidate[] };
export type SelectionRecorded = { selection_id: string; e164: string; price_cents: number; funding_mode: "credit_recurring" | "pilot"; expires_at: string; statement: string };

export interface NumberStore {
  claim(studioId: string, actorId: string, leaseOwner: string, leaseSeconds?: number, mode?: "run" | "refresh"): Promise<NumClaim>;
  release(onboardingId: string, leaseOwner: string): Promise<void>;
  getAccount(onboardingId: string, leaseOwner: string): Promise<RunnerAccount>;
  context(onboardingId: string, leaseOwner: string): Promise<NumContext>;
  begin(onboardingId: string, leaseOwner: string, args: NumBeginArgs): Promise<NumBeginResult>;
  finish(onboardingId: string, leaseOwner: string, operationId: string, outcome: NumFinishOutcome): Promise<{ state: string }>;
  observe(onboardingId: string, leaseOwner: string, operationId: string, facts: Record<string, unknown>, source: "provider_read" | "fake", digest: string): Promise<NumObserveResult>;
  transition(onboardingId: string, leaseOwner: string, to: RunnerTransitionState, step: string, errorCode: string | null): Promise<string>;
  /** The provider inventory seen under this lease; the DATABASE judges it against the numbers it accounts for and tw4_num_begin(number_purchase) requires a clean stamp. */
  inventoryObserve(onboardingId: string, leaseOwner: string, sids: string[], source: "provider_read" | "fake", listedAt: string): Promise<{ listed: number; unknown: number; missing: number }>;
  recordOffer(studioId: string, actorId: string, accountSid: string, search: Record<string, unknown>, candidates: unknown[], source: "provider_read" | "fake", digest: string): Promise<OfferRecorded>;
}

type Client = Pick<SupabaseClient, "rpc">;

export class SupabaseNumberStore implements NumberStore {
  constructor(private readonly admin: Client) {}

  private async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = (await this.admin.rpc(fn, args)) as { data: unknown; error: { code?: string } | null };
    if (error) throw new RunnerStoreError(String(error.code ?? "unknown"));
    return data as T;
  }

  async claim(studioId: string, actorId: string, leaseOwner: string, leaseSeconds = 300, mode: "run" | "refresh" = "run"): Promise<NumClaim> {
    return this.call<NumClaim>("tw4_num_claim", { p_studio_id: studioId, p_actor: actorId, p_lease_owner: leaseOwner, p_lease_seconds: leaseSeconds, p_mode: mode });
  }

  async release(onboardingId: string, leaseOwner: string): Promise<void> {
    await this.call("tw4_runner_release", { p_onboarding_id: onboardingId, p_lease_owner: leaseOwner });
  }

  async getAccount(onboardingId: string, leaseOwner: string): Promise<RunnerAccount> {
    const row = await this.call<{ legal_entity_id: string | null; account_sid: string | null; status: string | null }>("tw4_runner_account", { p_onboarding_id: onboardingId, p_lease_owner: leaseOwner });
    return { legalEntityId: row?.legal_entity_id ?? null, accountSid: row?.account_sid ?? null, status: row?.status ?? null };
  }

  async context(onboardingId: string, leaseOwner: string): Promise<NumContext> {
    return this.call<NumContext>("tw4_num_context", { p_onboarding_id: onboardingId, p_lease_owner: leaseOwner });
  }

  async begin(onboardingId: string, leaseOwner: string, args: NumBeginArgs): Promise<NumBeginResult> {
    return this.call<NumBeginResult>("tw4_num_begin", {
      p_onboarding_id: onboardingId, p_lease_owner: leaseOwner, p_op_kind: args.kind, p_friendly_name: args.friendlyName, p_request_digest: args.digest, p_params: args.params, p_actor: args.actorId,
    });
  }

  async finish(onboardingId: string, leaseOwner: string, operationId: string, outcome: NumFinishOutcome): Promise<{ state: string }> {
    const row = await this.call<{ state?: string }>("tw4_num_finish", {
      p_onboarding_id: onboardingId, p_lease_owner: leaseOwner, p_operation_id: operationId, p_status: outcome.status,
      p_provider_sid: outcome.providerSid ?? null, p_error_code: outcome.errorCode ?? null, p_error_detail: outcome.errorDetail ?? null,
    });
    return { state: String(row?.state ?? "") };
  }

  async observe(onboardingId: string, leaseOwner: string, operationId: string, facts: Record<string, unknown>, source: "provider_read" | "fake", digest: string): Promise<NumObserveResult> {
    const row = await this.call<{ status: NumResourceStatus; code: string | null; state: string }>("tw4_num_observe", {
      p_onboarding_id: onboardingId, p_lease_owner: leaseOwner, p_operation_id: operationId, p_facts: facts, p_source: source, p_digest: digest,
    });
    return { status: row.status, code: row.code ?? null, state: String(row.state ?? "") };
  }

  async transition(onboardingId: string, leaseOwner: string, to: RunnerTransitionState, step: string, errorCode: string | null): Promise<string> {
    const row = await this.call<{ state: string }>("tw4_runner_transition", {
      p_onboarding_id: onboardingId, p_lease_owner: leaseOwner, p_to_state: to, p_step: step, p_error_code: errorCode, p_error_field: null,
    });
    return String(row?.state ?? "");
  }

  async inventoryObserve(onboardingId: string, leaseOwner: string, sids: string[], source: "provider_read" | "fake", listedAt: string): Promise<{ listed: number; unknown: number; missing: number }> {
    const row = await this.call<{ listed: number; unknown: number; missing: number }>("tw4_num_inventory_observe", {
      p_onboarding_id: onboardingId, p_lease_owner: leaseOwner, p_sids: sids, p_source: source, p_listed_at: listedAt,
    });
    // an answer the database did not give is never read as clean
    return { listed: Number(row?.listed ?? 0), unknown: Number(row?.unknown ?? Number.MAX_SAFE_INTEGER), missing: Number(row?.missing ?? Number.MAX_SAFE_INTEGER) };
  }

  async recordOffer(studioId: string, actorId: string, accountSid: string, search: Record<string, unknown>, candidates: unknown[], source: "provider_read" | "fake", digest: string): Promise<OfferRecorded> {
    return this.call<OfferRecorded>("tw4_num_offer_record", {
      p_studio_id: studioId, p_actor: actorId, p_account_sid: accountSid, p_search: search, p_candidates: candidates, p_source: source, p_digest: digest,
    });
  }
}
