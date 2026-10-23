import { randomUUID } from "node:crypto";
import type { ProvisionEvidenceStore, AbsenceCheckOutcome } from "@/lib/sms/twilioIsv/provisionEvidence";
import type { SupabaseProvisionStore } from "@/lib/sms/twilioIsv/provisionStore";
import type { IsvProvisioningAdapter } from "@/lib/sms/twilioIsv/provisioningTypes";
import type { CommandResult } from "./provisionCommands";
import type { LedgerSnapshot } from "./provisionLedger";
import type { DeferredRetirement, RegistrationGap, RegistrationKind, RetryOutcome } from "./recoveryStore";

/**
 * TW-4F F4: validation and pre-checks for the platform-administrator recovery commands. Pure over injected ports so every refusal is testable; the server
 * actions (`recoveryActions.ts`, `provisioningActions.ts`) run `requirePlatformAdmin` FIRST and pass the SESSION-derived admin id. The database re-checks the
 * administrator and owns every rule; these pre-checks exist so that
 *   - a browser-supplied studio id or SID is only acted on if the database currently lists it for that action (a forged or stale id is refused before any call),
 *   - every recovery carries an explicit confirmation and a written reason (the reason is audited with the administrator), and
 *   - anything that cannot be verified fails closed.
 * Nothing here charges, releases a held fee, or asks a studio owner for anything. The only provider contact is the evidence console's GET listing, and only
 * through an adapter the environment gates allow (off by default).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PN = /^PN[0-9a-f]{32}$/;

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
};
const checked = (form: FormData, name: string) => ["on", "yes", "true", "1"].includes(field(form, name).toLowerCase());
const printable = (v: string, min: number, max: number) => v.length >= min && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const bad = (message: string): CommandResult => ({ ok: false, message });
const good = (message: string): CommandResult => ({ ok: true, message });

/** Plain-language mapping of a database refusal. Never forwards database text. */
export function recoveryErrorMessage(error: unknown): string {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "unknown";
  switch (code) {
    case "42501": return "Not allowed. Only a platform administrator can do this. Nothing changed.";
    case "55P03": return "A run is working on this studio right now. Try again when it finishes. Nothing changed.";
    case "22023": return "The database refused the input (check the reason and the selection). Nothing changed.";
    case "TW022": return "Release the studio's sender row for this number first. Nothing changed.";
    case "TW034": return "Not possible in the current state: the lifecycle must show the number cancelled, and no number operation may be unresolved. Nothing changed.";
    case "42883":
    case "PGRST202": return "This recovery tool is not available in this environment yet. Nothing changed.";
    default: return "The action failed. Nothing changed; reload and check the current state before trying again.";
  }
}

const RETRY_REFUSAL: Record<string, string> = {
  TW040: "The registration was refused: the location already has a live resource of this kind in the inventory, its subaccount is not the active one, or its registration path is not verified. The attempt and your reason were recorded.",
  TW032: "There is no live, provider-confirmed resource of this kind to register any more. The attempt and your reason were recorded.",
  TW010: "This location is not linked to a verified business. The attempt and your reason were recorded.",
};

export type RecoveryPort = {
  gaps(actorId: string): Promise<RegistrationGap[]>;
  deferred(actorId: string): Promise<DeferredRetirement[]>;
  retryRegistration(studioId: string, actorId: string, kind: RegistrationKind, note: string): Promise<RetryOutcome>;
  retireDeferred(studioId: string, phoneNumberSid: string, actorId: string, note: string): Promise<{ retired: boolean }>;
};

/** Retry registering a provider-confirmed resource in the recurring-fee inventory. Only a gap the database lists now, for that studio and kind, is retried. */
export async function retryRegistration(store: RecoveryPort, actorId: string, form: FormData): Promise<CommandResult> {
  const studioId = field(form, "studioId");
  const kind = field(form, "kind");
  const note = field(form, "note");
  if (!UUID.test(studioId) || (kind !== "number" && kind !== "campaign")) return bad("Choose a registration gap from the list.");
  if (!printable(note, 10, 300)) return bad("Write what you checked before retrying (10-300 characters).");
  if (!checked(form, "confirm")) return bad("Confirm that you checked the inventory before retrying.");
  let gaps: RegistrationGap[];
  try {
    gaps = await store.gaps(actorId);
  } catch (error) {
    return bad(recoveryErrorMessage(error));
  }
  if (!gaps.some((g) => g.studioId === studioId && g.kind === kind)) return bad("That registration gap is not listed any more. Reload the page. Nothing changed.");
  try {
    const out = await store.retryRegistration(studioId, actorId, kind, note);
    if (out.outcome === "registered") return good("Registered in the recurring-fee inventory. Your name and reason were recorded. No charge was taken.");
    if (out.outcome === "already_registered") return good("It was already registered. Your attempt was recorded. Nothing else changed.");
    return bad(RETRY_REFUSAL[out.code ?? ""] ?? "The registration was refused. The attempt and your reason were recorded.");
  } catch (error) {
    return bad(recoveryErrorMessage(error));
  }
}

/** Retire a number the lifecycle already shows cancelled but the number ledger still holds. Only a deferred retirement the database lists now, and reports ready, is attempted. */
export async function retireDeferred(store: RecoveryPort, actorId: string, form: FormData): Promise<CommandResult> {
  const studioId = field(form, "studioId");
  const phoneNumberSid = field(form, "phoneNumberSid");
  const note = field(form, "note");
  if (!UUID.test(studioId) || !PN.test(phoneNumberSid)) return bad("Choose a deferred retirement from the list.");
  if (!printable(note, 10, 300)) return bad("Write why the retirement can proceed (10-300 characters).");
  if (!checked(form, "confirm")) return bad("Confirm that the number was cancelled at the provider and its sender row was released.");
  let list: DeferredRetirement[];
  try {
    list = await store.deferred(actorId);
  } catch (error) {
    return bad(recoveryErrorMessage(error));
  }
  const entry = list.find((d) => d.studioId === studioId && d.phoneNumberSid === phoneNumberSid);
  if (!entry) return bad("That deferred retirement is not listed any more. Reload the page. Nothing changed.");
  if (entry.blockers.senderReleaseRequired) return bad(recoveryErrorMessage({ code: "TW022" }));
  if (!entry.ready) return bad("It is not ready: a run holds the studio or a number operation is unresolved. Nothing changed.");
  try {
    const out = await store.retireDeferred(studioId, phoneNumberSid, actorId, note);
    return good(out.retired ? "Retired from the number ledger. Your name and reason were recorded." : "It was already retired. Nothing changed.");
  } catch (error) {
    return bad(recoveryErrorMessage(error));
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// evidence console: record a provider listing (A-7)
// ---------------------------------------------------------------------------------------------------------------------------------------------
export type EvidencePorts = {
  ledgerStatus(studioId: string, actorId: string): Promise<LedgerSnapshot | null>;
  store: Pick<SupabaseProvisionStore, "getAccount" | "release">;
  evidence: Pick<ProvisionEvidenceStore, "claim">;
  /** Runs the shared absence check (`checkCampaignAbsence`) with the adapter. Injected so tests never reach a provider. */
  check(adapter: IsvProvisioningAdapter): Promise<AbsenceCheckOutcome>;
  runtime: { ok: true; mode: "fake" | "real"; adapterFor(accountSid: string): Promise<IsvProvisioningAdapter> } | { ok: false; reason: string };
};

const CHECK_MESSAGE: Record<string, string> = {
  lease_busy: "A run is working on this studio right now. Try again when it finishes. Nothing was recorded.",
  not_runnable: "Evidence cannot be read for this studio now (no live onboarding, or not allowed). Nothing was recorded.",
  account_mismatch: "The studio's subaccount is not active or does not match. Nothing was recorded.",
  nothing_to_check: "There is no fee-bearing campaign attempt to check, or the studio has no ready Messaging Service. Nothing was recorded.",
  retry_later: "The provider listing could not be read completely. A failed read is not evidence; nothing was recorded. Try again later.",
  record_failed: "The database refused the listing (too early, too close to the previous read, or not of the attempt's own Messaging Service). Nothing was recorded.",
  // #269: the attempt's original subaccount or Messaging Service could not be established, so nothing was read for it (fail closed)
  scope_unavailable: "The attempt's original subaccount or Messaging Service could not be established, so nothing was read or recorded for it. Investigate the ledger before trying again.",
};

/**
 * Takes ONE fresh, complete listing of the studio's campaigns and records it for the database to judge. It never resolves anything and never releases a held
 * fee: two such listings, 10+ minutes apart and 20+ minutes after the attempt, are what the database needs before release could even be considered, and release
 * itself stays switched off in the application (owner decision U-1).
 */
export async function recordProviderListing(ports: EvidencePorts, actorId: string, form: FormData): Promise<CommandResult> {
  const studioId = field(form, "studioId");
  const operationId = field(form, "operationId");
  if (!UUID.test(studioId) || !UUID.test(operationId)) return bad("Choose an operation from the list.");
  if (!checked(form, "confirm")) return bad("Confirm that a read-only provider listing should be taken now.");
  let ledger: LedgerSnapshot | null;
  try {
    ledger = await ports.ledgerStatus(studioId, actorId);
  } catch {
    return bad("The provisioning ledger could not be read. Nothing was recorded.");
  }
  const op = ledger?.operations.find((o) => o.id === operationId);
  if (!ledger || !op) return bad("That operation is not part of this studio's ledger. Nothing was recorded.");
  if (op.kind !== "campaign" || !op.feeBearing || !["unknown_outcome", "in_flight"].includes(op.status) || op.superseded) {
    return bad("Only an unresolved fee-bearing campaign attempt needs provider listings. Nothing was recorded.");
  }
  if (!ports.runtime.ok) return bad(`Provider reads are not available here: ${ports.runtime.reason} Nothing was recorded.`);
  // the studio's subaccount, read under a short evidence lease (the check takes its own lease again; the database re-checks the account on every record)
  const lease = `prov-evidence-acct-${randomUUID().slice(0, 8)}`;
  let accountSid: string | null = null;
  try {
    const claim = await ports.evidence.claim(studioId, actorId, lease, 30);
    try {
      const account = await ports.store.getAccount(claim.onboarding_id, lease);
      accountSid = account.status === "active" ? account.accountSid : null;
    } finally {
      await ports.store.release(claim.onboarding_id, lease).catch(() => undefined);
    }
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
    return bad(CHECK_MESSAGE[code === "55P03" ? "lease_busy" : "not_runnable"]);
  }
  if (!accountSid) return bad(CHECK_MESSAGE.account_mismatch);
  let adapter: IsvProvisioningAdapter;
  try {
    adapter = await ports.runtime.adapterFor(accountSid);
  } catch {
    return bad("The provider could not be reached with this studio's credentials. Nothing was recorded.");
  }
  let out: AbsenceCheckOutcome;
  try {
    out = await ports.check(adapter);
  } catch {
    return bad(CHECK_MESSAGE.retry_later);
  }
  if (out.outcome !== "recorded") return bad(CHECK_MESSAGE[out.outcome] ?? CHECK_MESSAGE.record_failed);
  const mine = out.results.find((r) => r.operationId === operationId);
  if (!mine && (out as { skipped?: { operationId: string }[] }).skipped?.some((s) => s.operationId === operationId)) return bad(CHECK_MESSAGE.scope_unavailable);
  const verdicts = out.results.map((r) => r.verdict).join(", ");
  const orphans = out.results.reduce((n, r) => n + r.orphans, 0);
  return good(
    `Provider listing recorded (${ports.runtime.mode === "fake" ? "local fake provider" : "provider read"}): ${mine ? `this attempt: ${mine.verdict}` : `verdicts: ${verdicts}`}.`
    + (orphans > 0 ? ` ${orphans} unaccounted provider resource(s) were found and are now listed as DanceFlow-borne exposure.` : "")
    + " Nothing was resolved and no held fee was released.",
  );
}
