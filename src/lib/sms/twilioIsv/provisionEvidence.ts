import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { IsvProvisioningAdapter } from "./provisioningTypes";
import type { SupabaseProvisionStore } from "./provisionStore";
import { RunnerStoreError } from "./store";

/**
 * TW-4F: provider-listing evidence for FEE-BEARING provisioning operations. This is the only code that turns a provider read into a database record the
 * resolution rules accept. The database (tw4_prov_listing_record) judges every observation: the right subaccount, the ledger's own Messaging Service, a read that
 * started after the previous record, a complete listing, and the 20-minute wait after the attempt. This module never decides that something is absent; it only
 * reports exactly what the provider listed, once per fresh read, under an onboarding lease held for the duration.
 *
 * It performs GET-only reads (the adapter's complete listing, or a throw) and never creates, cancels, buys or pays anything. A read that fails is NOT recorded:
 * a transport error is not evidence either way.
 */

type Client = Pick<SupabaseClient, "rpc">;

export type ListingFacts = {
  account_sid: string;
  scope_sid: string;
  read_id: string;
  read_started_at: string;
  complete: boolean;
  listed: string[];
};

export type ListingResult = { listing_id: string; verdict: "absent" | "present" | "inconclusive" | "premature"; replayed: boolean; orphans?: number };

export class ProvisionEvidenceStore {
  constructor(private readonly admin: Client) {}

  private async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = (await this.admin.rpc(fn, args)) as { data: unknown; error: { code?: string } | null };
    if (error) throw new RunnerStoreError(String(error.code ?? "unknown"));
    return data as T;
  }

  /** An evidence-only lease on the studio's onboarding: works in any non-cancelled state (an unknown fee outcome parks it in `exception`) and permits only reads and evidence records. */
  claim(studioId: string, actorId: string, leaseOwner: string, leaseSeconds = 120): Promise<{ onboarding_id: string; studio_id: string; state: string; submission_seq: number }> {
    return this.call("tw4_prov_evidence_claim", { p_studio_id: studioId, p_actor: actorId, p_lease_owner: leaseOwner, p_lease_seconds: leaseSeconds });
  }

  recordListing(args: { onboardingId: string; leaseOwner: string; operationId: string; facts: ListingFacts; source: "provider_read" | "fake"; digest: string }): Promise<ListingResult> {
    return this.call<ListingResult>("tw4_prov_listing_record", {
      p_onboarding_id: args.onboardingId, p_lease_owner: args.leaseOwner, p_operation_id: args.operationId, p_facts: args.facts, p_source: args.source, p_digest: args.digest,
    });
  }

  /** Platform-admin read (the database re-checks the actor). */
  evidence(studioId: string, actorId: string): Promise<unknown> {
    return this.call("tw4_prov_evidence", { p_studio_id: studioId, p_actor: actorId });
  }

  registerOrphan(orphanId: string, actorId: string): Promise<{ status: string; resource_id: string; replayed: boolean }> {
    return this.call("tw4_prov_orphan_register", { p_orphan_id: orphanId, p_actor: actorId });
  }

  closeOrphan(orphanId: string, actorId: string, note: string): Promise<{ status: string; replayed: boolean }> {
    return this.call("tw4_prov_orphan_close", { p_orphan_id: orphanId, p_actor: actorId, p_note: note });
  }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** The canonical digest of one read: what the provider said, which account and scope it was about, and which read it was. */
export function listingDigest(facts: ListingFacts): string {
  return sha256(JSON.stringify({ a: facts.account_sid, s: facts.scope_sid, r: facts.read_id, t: facts.read_started_at, c: facts.complete, l: [...facts.listed].sort() }));
}

export type AbsenceCheckOutcome =
  | { outcome: "recorded"; results: { operationId: string; verdict: ListingResult["verdict"]; orphans: number }[] }
  | { outcome: "lease_busy" | "not_runnable" | "account_mismatch" | "nothing_to_check" | "retry_later" | "record_failed"; detail?: string };

const storeCode = (error: unknown) => (error instanceof RunnerStoreError ? error.code : "unknown");

/**
 * One fresh, complete listing of the studio's Messaging Service campaigns per fee-bearing campaign operation that still matters (unresolved, abandoned or failed:
 * a late-found resource after a closed operation must never be missed), each recorded for the database to judge. Run it at least twice, 10+ minutes apart and
 * 20+ minutes after the attempt, before an unknown fee outcome can be resolved as not created. Never resolves anything itself.
 */
export async function checkCampaignAbsence(input: {
  store: SupabaseProvisionStore;
  evidence: ProvisionEvidenceStore;
  adapter: IsvProvisioningAdapter;
  studioId: string;
  actorId: string;
  now?: () => Date;
}): Promise<AbsenceCheckOutcome> {
  const { store, evidence, adapter, studioId, actorId } = input;
  const now = input.now ?? (() => new Date());
  const leaseOwner = `prov-evidence-${randomUUID().slice(0, 8)}`;
  let claim;
  try {
    claim = await evidence.claim(studioId, actorId, leaseOwner, 300);
  } catch (error) {
    const code = storeCode(error);
    return { outcome: code === "55P03" ? "lease_busy" : "not_runnable", detail: code };
  }
  const onboardingId = claim.onboarding_id;
  try {
    // the adapter must be the studio's own subaccount: checked before any provider call (the database checks it again on every record)
    const account = await store.getAccount(onboardingId, leaseOwner);
    if (!account.accountSid || account.status !== "active" || account.accountSid !== adapter.accountSid) {
      return { outcome: "account_mismatch" };
    }
    const ctx = await store.context(onboardingId, leaseOwner);
    const service = ctx.operations.find((op) => op.kind === "messaging_service" && !op.superseded && op.status === "succeeded" && op.provider_sid);
    const targets = ctx.operations.filter((op) => op.kind === "campaign" && op.fee_bearing && ["unknown_outcome", "in_flight", "abandoned", "failed"].includes(op.status));
    if (!service?.provider_sid || targets.length === 0) return { outcome: "nothing_to_check" };
    const results: { operationId: string; verdict: ListingResult["verdict"]; orphans: number }[] = [];
    for (const target of targets) {
      const started = now();
      let listed: string[];
      try {
        listed = await adapter.findCampaigns(service.provider_sid); // a complete listing or a throw: never a partial one
      } catch {
        return { outcome: "retry_later", detail: "listing_failed" };
      }
      const facts: ListingFacts = { account_sid: adapter.accountSid, scope_sid: service.provider_sid, read_id: randomUUID(), read_started_at: started.toISOString(), complete: true, listed };
      try {
        const recorded = await evidence.recordListing({ onboardingId, leaseOwner, operationId: target.id, facts, source: adapter.evidenceSource, digest: listingDigest(facts) });
        results.push({ operationId: target.id, verdict: recorded.verdict, orphans: recorded.orphans ?? 0 });
      } catch (error) {
        return { outcome: "record_failed", detail: storeCode(error) };
      }
    }
    return { outcome: "recorded", results };
  } finally {
    try {
      await store.release(onboardingId, leaseOwner);
    } catch {
      /* the lease expires by itself */
    }
  }
}
