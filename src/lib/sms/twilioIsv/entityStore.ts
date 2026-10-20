import type { SupabaseClient } from "@supabase/supabase-js";
import { RunnerStoreError } from "./store";

/**
 * TW-4F-3a: persistence for legal entities, location links, spend authorizations and subaccounts. Service-role `tw4_entity_*`, `tw4_spend_*` and
 * `tw4_subaccount_*` functions only (the tables have no API privileges). Errors carry the SQLSTATE, never the database message text.
 */

export type EntitySummary = {
  legal_entity_id: string | null;
  spend_cap_cents?: number;
  committed_cents?: number;
  account_status?: "creating" | "unknown" | "failed" | "active" | "suspended" | "closed" | null;
  account_sid?: string | null;
};

export type BeginSubaccountResult = { action: "skip" | "reconcile" | "execute"; account_sid?: string | null; status?: string };

export interface EntityStore {
  entityForStudio(studioId: string, actorId: string): Promise<EntitySummary>;
  createEntityForStudio(studioId: string, actorId: string, verificationNote: string): Promise<string>;
  decideLink(requestId: string, entityId: string, actorId: string, approve: boolean, note: string): Promise<void>;
  setSpendCap(entityId: string, cents: number, actorId: string): Promise<void>;
  /**
   * Approves ONE fee-bearing operation at the published price. `funding` is the approver's choice: "credit" (settled prepaid credit only, the default) or "pilot"
   * (the founder-authorized ceiling; needs the exception, a written approval reference and the location the operation is for). There is no fallback between them.
   */
  authorizeSpend(entityId: string, kind: "brand" | "brand_low_volume" | "campaign_vetting" | "number" | "monthly" | "monthly_low_volume", cents: number, approvalRef: string, actorId: string, funding?: "credit" | "pilot", studioId?: string | null): Promise<string>;
  confirmSubaccount(entityId: string, actorId: string): Promise<void>;
  beginSubaccount(entityId: string, actorId: string, friendlyName: string, environment: string): Promise<BeginSubaccountResult>;
  finishSubaccount(entityId: string, actorId: string, status: "active" | "failed" | "unknown", accountSid: string | null): Promise<void>;
}

type Client = Pick<SupabaseClient, "rpc">;

export class SupabaseEntityStore implements EntityStore {
  constructor(private readonly admin: Client) {}

  private async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = (await this.admin.rpc(fn, args)) as { data: unknown; error: { code?: string } | null };
    if (error) throw new RunnerStoreError(String(error.code ?? "unknown"));
    return data as T;
  }

  entityForStudio(studioId: string, actorId: string) {
    return this.call<EntitySummary>("tw4_entity_for_studio", { p_studio_id: studioId, p_actor: actorId });
  }
  async createEntityForStudio(studioId: string, actorId: string, verificationNote: string) {
    const row = await this.call<{ legal_entity_id: string }>("tw4_entity_create_for_studio", { p_studio_id: studioId, p_actor: actorId, p_verification_note: verificationNote });
    return row.legal_entity_id;
  }
  async decideLink(requestId: string, entityId: string, actorId: string, approve: boolean, note: string) {
    await this.call("tw4_entity_decide_link", { p_request_id: requestId, p_entity_id: entityId, p_actor: actorId, p_approve: approve, p_note: note });
  }
  async setSpendCap(entityId: string, cents: number, actorId: string) {
    await this.call("tw4_entity_set_spend_cap", { p_entity_id: entityId, p_cents: cents, p_actor: actorId });
  }
  async authorizeSpend(entityId: string, kind: "brand" | "brand_low_volume" | "campaign_vetting" | "number" | "monthly" | "monthly_low_volume", cents: number, approvalRef: string, actorId: string, funding: "credit" | "pilot" = "credit", studioId: string | null = null) {
    const row = await this.call<{ spend_event_id: string }>("tw4_spend_authorize", { p_entity_id: entityId, p_kind: kind, p_amount_cents: cents, p_approval_ref: approvalRef, p_actor: actorId, p_funding: funding, p_studio_id: studioId });
    return row.spend_event_id;
  }
  async confirmSubaccount(entityId: string, actorId: string) {
    await this.call("tw4_subaccount_confirm", { p_entity_id: entityId, p_actor: actorId });
  }
  beginSubaccount(entityId: string, actorId: string, friendlyName: string, environment: string) {
    return this.call<BeginSubaccountResult>("tw4_subaccount_begin", { p_entity_id: entityId, p_actor: actorId, p_friendly_name: friendlyName, p_environment: environment });
  }
  async finishSubaccount(entityId: string, actorId: string, status: "active" | "failed" | "unknown", accountSid: string | null) {
    await this.call("tw4_subaccount_finish", { p_entity_id: entityId, p_actor: actorId, p_status: status, p_account_sid: accountSid });
  }
}
