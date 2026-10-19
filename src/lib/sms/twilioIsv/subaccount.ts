import { RunnerStoreError } from "./store";
import type { EntityStore } from "./entityStore";
import { IsvApiError, type IsvEnvName, type IsvParentAdapter } from "./types";

/**
 * TW-4F-3a (D2): provisions a studio legal entity's Twilio SUBACCOUNT. This is its own run with its own typed confirmation (recorded by
 * `tw4_subaccount_confirm`, consumed once by `tw4_subaccount_begin` in the database). It NEVER continues into profile registration or any fee:
 * the only Twilio effect is "create / find the subaccount", and the only thing it ever calls is the parent account-management surface.
 *
 *  - The database refuses creation without a spend cap for the legal entity and without a fresh one-shot confirmation held by the same admin.
 *  - Idempotent: the subaccount has a deterministic friendly name; the lookup comes first; an ambiguous creation (network, 429/5xx, unreadable reply)
 *    is recorded as `unknown` and reconciled by lookup on the next confirmed run before anything is created again.
 *  - An account that already exists and is active is simply returned (no confirmation consumed, nothing created).
 */

export type SubaccountOutcome =
  | "subaccount_created"
  | "subaccount_exists"
  | "waiting_subaccount_confirmation"
  | "no_legal_entity"
  | "exception"
  | "retry_later";

export type SubaccountResult = { outcome: SubaccountOutcome; accountSid?: string; detail?: string };

export function subaccountFriendlyName(envName: IsvEnvName, legalEntityId: string): string {
  return `df:${envName}:${legalEntityId}`;
}

const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;

function detailOf(error: unknown): string {
  if (error instanceof IsvApiError) return `${error.kind}${error.twilioCode ? `:${error.twilioCode}` : ""}${error.httpStatus ? `:http${error.httpStatus}` : ""}`;
  if (error instanceof RunnerStoreError) return `store:${error.code}`;
  return "unexpected";
}

export async function provisionSubaccount(input: {
  entities: EntityStore;
  parent: IsvParentAdapter;
  studioId: string;
  actorId: string;
  envName: IsvEnvName;
}): Promise<SubaccountResult> {
  const { entities, parent, studioId, actorId, envName } = input;
  let summary;
  try {
    summary = await entities.entityForStudio(studioId, actorId);
  } catch (error) {
    return { outcome: "exception", detail: detailOf(error) };
  }
  const entityId = summary.legal_entity_id;
  if (!entityId) return { outcome: "no_legal_entity" };
  if ((summary.account_status === "active" || summary.account_status === "suspended") && summary.account_sid) {
    return { outcome: "subaccount_exists", accountSid: summary.account_sid };
  }
  const friendly = subaccountFriendlyName(envName, entityId);

  let begun;
  try {
    begun = await entities.beginSubaccount(entityId, actorId, friendly, envName);
  } catch (error) {
    // no fresh confirmation (TW003): nothing was called and nothing was written
    if (error instanceof RunnerStoreError && error.code === "TW003") return { outcome: "waiting_subaccount_confirmation" };
    // another creation for this legal entity is (probably) still running: nothing was called, no confirmation was consumed
    if (error instanceof RunnerStoreError && error.code === "TW006") return { outcome: "retry_later", detail: "creation_in_progress" };
    return { outcome: "exception", detail: detailOf(error) };
  }
  if (begun.action === "skip") return { outcome: "subaccount_exists", accountSid: begun.account_sid ?? undefined };

  // look before creating: a previous attempt (or an unknown one) may already have produced the account
  let existing: string[];
  try {
    existing = await parent.findSubaccount(friendly);
  } catch (error) {
    await entities.finishSubaccount(entityId, actorId, "unknown", null);
    return { outcome: "retry_later", detail: `lookup:${detailOf(error)}` };
  }
  if (existing.length > 1) {
    // several candidates: never guess; a human decides
    await entities.finishSubaccount(entityId, actorId, "unknown", null);
    return { outcome: "exception", detail: "ambiguous_match" };
  }
  if (existing.length === 1) return record(entities, entityId, actorId, existing[0], "subaccount_exists");

  let created: string;
  try {
    created = await parent.createSubaccount(friendly);
  } catch (error) {
    // Only a DEFINITE refusal (a parsed 4xx, bad credentials) is a failure; anything else may have created the account and is reconciled by lookup.
    const definite = error instanceof IsvApiError && (error.kind === "validation" || error.kind === "account");
    await entities.finishSubaccount(entityId, actorId, definite ? "failed" : "unknown", null);
    return { outcome: definite ? "exception" : "retry_later", detail: `create:${detailOf(error)}` };
  }
  return record(entities, entityId, actorId, created, "subaccount_created");
}

async function record(entities: EntityStore, entityId: string, actorId: string, sid: string, outcome: "subaccount_created" | "subaccount_exists"): Promise<SubaccountResult> {
  if (!ACCOUNT_SID.test(sid)) {
    await entities.finishSubaccount(entityId, actorId, "unknown", null);
    return { outcome: "retry_later", detail: "create:no_valid_sid" };
  }
  try {
    await entities.finishSubaccount(entityId, actorId, "active", sid);
  } catch (error) {
    // the account exists at Twilio but could not be recorded: say so plainly; the next confirmed run finds it by name and records it
    return { outcome: "exception", accountSid: sid, detail: `record_failed:${detailOf(error)}` };
  }
  return { outcome, accountSid: sid };
}
