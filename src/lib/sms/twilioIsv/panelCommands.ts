import type { EntityStore } from "./entityStore";
import { LVS_CHECKLIST, looksLikeEin, panelErrorMessage, type PanelStore } from "./panel";
import { isRegistrationTier, registrationPath } from "./registrationPath";
import { provisionSubaccount, type SubaccountResult } from "./subaccount";
import type { IsvEnvName, IsvParentAdapter } from "./types";
import { EXCEPTION_SCOPES, scopesForKind, validatePilotEvidence, type EvidenceScope, type PilotEvidence } from "@/lib/sms/pilotApprovalEvidence";

/**
 * TW-4F platform-admin panel commands. Each takes the already-authenticated platform admin's id (the server action calls requirePlatformAdmin
 * first; the database re-checks the actor in every definer function) and a FormData, validates everything before any write, and returns a
 * plain-language result. No command contacts Twilio except `createSubaccount`, which goes through the runner runtime (the in-process fake
 * locally; the real parent client only on a production build with TW4_ISV_REAL_CALLS=on).
 */

export type CommandResult = { ok: boolean; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};
const checked = (form: FormData, name: string) => form.get(name) === "on";
const bad = (message: string): CommandResult => ({ ok: false, message });
const good = (message: string): CommandResult => ({ ok: true, message });
// free text the admin types: printable, single line, bounded
const cleanNote = (value: string, min: number, max: number) => (value.length >= min && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null);
/** Every free-text field is shown to platform admins and kept as evidence: none may carry a full EIN. */
const EIN_FIELDS = ["verificationNote", "note", "approvalRef", "reason"];
function einInForm(form: FormData): boolean {
  return EIN_FIELDS.some((name) => looksLikeEin(field(form, name)));
}
const EIN_REFUSAL = "Do not type an EIN in this field (only the last four digits are ever recorded). Nothing was changed.";
const dollarsToCents = (value: string): number | null => {
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(value)) return null;
  return Math.round(Number(value) * 100);
};

/**
 * U-4: the owner's dated written authorization of a PILOT spend (hash and reference only, never the text). Validated here before any write with the shared validator; the database
 * repeats every rule and compares the amount with the published price (or the ceiling). The sha256 is lower-cased first (PowerShell prints upper case). Nothing the admin typed is echoed.
 */
function readEvidence(form: FormData, allowed: readonly EvidenceScope[], amountCents: number) {
  return validatePilotEvidence({
    authorizedOn: field(form, "authorizedOn"), authorizedByRole: field(form, "authorizedByRole"), scope: field(form, "scope"), amountCents, periodKey: null,
    documentRef: field(form, "documentRef"), documentSha256: field(form, "documentSha256").toLowerCase(),
  }, null, Date.now(), allowed);
}

export async function createEntity(store: PanelStore, actorId: string, form: FormData): Promise<CommandResult> {
  if (einInForm(form)) return bad(EIN_REFUSAL);
  const studioId = field(form, "studioId");
  const note = cleanNote(field(form, "verificationNote"), 10, 300);
  if (!UUID.test(studioId)) return bad("Choose a studio.");
  if (!note) return bad("Record what you verified (10-300 characters, for example the state registry record you checked). Never type the EIN.");
  if (!checked(form, "verified")) return bad("Confirm that you verified the legal business against an official record.");
  try {
    await store.createEntity(studioId, actorId, note);
  } catch (error) {
    return bad(panelErrorMessage("entity", error));
  }
  return good("Legal business created from the owner's submitted setup.");
}

export async function decideLink(store: PanelStore, actorId: string, form: FormData): Promise<CommandResult> {
  if (einInForm(form)) return bad(EIN_REFUSAL);
  const requestId = field(form, "requestId");
  const entityId = field(form, "entityId");
  const decision = field(form, "decision");
  const note = field(form, "note");
  if (!UUID.test(requestId)) return bad("Choose a request.");
  if (decision !== "approve" && decision !== "reject") return bad("Choose approve or reject.");
  if (decision === "approve") {
    if (!UUID.test(entityId)) return bad("Choose the legal business this location belongs to.");
    if (!cleanNote(note, 10, 300)) return bad("Record what you verified for this location (10-300 characters).");
    if (!checked(form, "verified")) return bad("Confirm that you verified the association yourself (the matching name and EIN last four are supporting checks only).");
  } else if (!cleanNote(note, 3, 300)) {
    return bad("Give the reason for rejecting (3-300 characters).");
  }
  try {
    // a rejection names no entity (the store sends null)
    const status = await store.decideLink(requestId, decision === "approve" ? entityId : "", actorId, decision === "approve", note);
    return good(status === "approved" ? "Location linked to the legal business." : "Location request rejected.");
  } catch (error) {
    return bad(panelErrorMessage("link", error));
  }
}

export async function setSpendCap(store: PanelStore, actorId: string, form: FormData): Promise<CommandResult> {
  if (einInForm(form)) return bad(EIN_REFUSAL);
  const entityId = field(form, "entityId");
  const cents = dollarsToCents(field(form, "capDollars"));
  if (!UUID.test(entityId)) return bad("Choose a legal business.");
  if (cents === null) return bad("Enter the setup budget in dollars (for example 150 or 150.00).");
  if (field(form, "confirmCap") !== field(form, "capDollars")) return bad("Type the same amount again to confirm the setup budget.");
  try {
    await store.setSpendCap(entityId, cents, actorId);
  } catch (error) {
    return bad(panelErrorMessage("cap", error));
  }
  return good(`Setup budget set to $${(cents / 100).toFixed(2)}. It is a ceiling only: every fee still needs its own owner approval.`);
}

const FEE_KINDS = new Set(["brand", "brand_low_volume", "campaign_vetting", "number"]);
const BRAND_KINDS = new Set(["brand", "brand_low_volume"]);

/**
 * Records the OWNER's written approval of ONE fee-bearing operation, at the published price, for one location. The database refuses an amount
 * other than the published price, an approval reference used before (ever: one written approval = one operation, so a double submit returns the
 * same unused authorization and a replay after withdrawal, release or use is refused), a fee of the other registration path, anything beyond the setup budget, and a pilot-funded approval outside the pilot exception.
 */
export async function authorizeFee(store: PanelStore, actorId: string, form: FormData, context: { studioTier: string | null; onboardingFound?: boolean }): Promise<CommandResult> {
  if (einInForm(form)) return bad(EIN_REFUSAL);
  const entityId = field(form, "entityId");
  const studioId = field(form, "studioId");
  const kind = field(form, "kind");
  const funding = field(form, "funding") === "pilot" ? "pilot" : field(form, "funding") === "credit" ? "credit" : null;
  const cents = Number(field(form, "amountCents"));
  const approvalRef = cleanNote(field(form, "approvalRef"), 10, 120);
  if (!UUID.test(entityId) || !UUID.test(studioId)) return bad("Choose the legal business and the location the fee is for.");
  if (!FEE_KINDS.has(kind)) return bad("Choose which fee the owner approved.");
  if (!funding) return bad("Choose how it is paid: prepaid credit, or the ConfiDance pilot ceiling.");
  if (!Number.isInteger(cents) || cents <= 0) return bad("The published price is missing: reload the page.");
  if (!approvalRef) return bad("Record the owner's written approval (10-120 characters: who, when, where, e.g. 'Owner email 2026-10-20 approving brand $46').");
  if (!checked(form, "ownerApproved")) return bad("Confirm the owner approved this specific operation and amount in writing. Nothing was authorized.");
  // fail closed: a brand fee is approved only for a location whose registration path could be read (a missing onboarding is not "Standard")
  if (BRAND_KINDS.has(kind) && context.onboardingFound === false) return bad("This location's registration path could not be read, so no brand fee can be approved for it. Nothing was authorized.");
  // the brand fee follows the location's registration path (the database refuses a mismatch too, and checks the path is VERIFIED for a low-volume kind)
  if (BRAND_KINDS.has(kind)) {
    const expected = registrationPath(isRegistrationTier(context.studioTier) ? context.studioTier : "standard").brandPriceKind;
    if (kind !== expected) {
      return bad(expected === "brand_low_volume"
        ? "This location is on Low-Volume Standard: a Standard-price brand approval would be wrong. Nothing was authorized."
        : "This location is on the Standard path: a Low-Volume Standard brand approval does not apply. Nothing was authorized.");
    }
  }
  // a pilot-funded approval needs the owner's dated written authorization as evidence (a reference alone is not authorization); a credit-funded one takes none
  let evidence: PilotEvidence | null = null;
  if (funding === "pilot") {
    const read = readEvidence(form, scopesForKind(kind), cents);
    if (!read.ok) return bad(`${read.message} Nothing was authorized.`);
    evidence = read.value;
  }
  let replayed = false;
  try {
    ({ replayed } = await store.authorizeSpend({ entityId, kind, cents, approvalRef, actorId, funding, studioId, evidence }));
  } catch (error) {
    return bad(panelErrorMessage("spend", error));
  }
  // an identical resubmission of a still-unused approval: the database returned the SAME authorization, nothing new was recorded
  if (replayed) return good("This owner approval was already recorded (unused). Nothing new was authorized.");
  return good(`Owner approval recorded for one ${kind.replaceAll("_", " ")} fee of $${(cents / 100).toFixed(2)} (${funding === "pilot" ? "pilot ceiling" : "prepaid credit"}). It is reserved only when that step runs.`);
}

export async function withdrawFee(store: PanelStore, actorId: string, form: FormData): Promise<CommandResult> {
  if (einInForm(form)) return bad(EIN_REFUSAL);
  const spendEventId = field(form, "spendEventId");
  const note = cleanNote(field(form, "note"), 3, 300);
  if (!UUID.test(spendEventId)) return bad("Choose an approval.");
  if (!note) return bad("Give the reason for withdrawing (3-300 characters).");
  try {
    await store.withdrawSpend(spendEventId, actorId, note);
  } catch (error) {
    return bad(panelErrorMessage("withdraw", error));
  }
  return good("Fee approval withdrawn.");
}

export async function createPilotException(store: PanelStore, actorId: string, form: FormData): Promise<CommandResult> {
  if (einInForm(form)) return bad(EIN_REFUSAL);
  const entityId = field(form, "entityId");
  const cents = dollarsToCents(field(form, "ceilingDollars"));
  const approvalRef = cleanNote(field(form, "approvalRef"), 10, 200);
  if (!UUID.test(entityId)) return bad("Choose the legal business.");
  if (cents === null || cents <= 0 || cents > 15000) return bad("The pilot ceiling is at most $150.00.");
  if (!approvalRef) return bad("Record the founder's written authorization (10+ characters).");
  if (!checked(form, "understood")) return bad("Confirm the ceiling is non-spendable, cumulative, never resets, and each fee still needs its own owner approval.");
  const read = readEvidence(form, EXCEPTION_SCOPES, cents);
  if (!read.ok) return bad(`${read.message} Nothing was recorded.`);
  try {
    const result = await store.createPilotException(entityId, cents, approvalRef, actorId, read.value);
    return good(result.replayed ? "The pilot exception already exists with this ceiling; nothing changed." : "Pilot exception recorded.");
  } catch (error) {
    return bad(panelErrorMessage("pilot", error));
  }
}

export const CREATE_PHRASE = "CREATE SUBACCOUNT";

export type SubaccountDeps = { entities: EntityStore; parent: IsvParentAdapter; envName: IsvEnvName } | { refused: string };

const SUBACCOUNT_TEXT: Record<SubaccountResult["outcome"], string> = {
  subaccount_created: "Twilio subaccount created. No fee was incurred and nothing was registered.",
  subaccount_exists: "The subaccount already exists; nothing was created.",
  waiting_subaccount_confirmation: "No fresh confirmation was available; nothing was created. Confirm again.",
  no_legal_entity: "This studio has no legal business yet; nothing was created.",
  exception: "Stopped for a human to look at; nothing further runs automatically.",
  retry_later: "Twilio did not answer cleanly. The attempt is recorded as unclear; confirm again later and it is looked up first (never created twice).",
};

/**
 * The separately confirmed "Create subaccount": typed phrase + a one-time request key from the rendered form. The runtime is checked BEFORE the
 * confirmation is recorded, so a deployment that cannot create leaves no confirmation behind. A replayed key records nothing new and only
 * re-runs the idempotent provisioning (lookup first, never a second account); an open confirmation by the same admin is reused, never doubled.
 */
export async function createSubaccount(store: PanelStore, actorId: string, form: FormData, deps: SubaccountDeps): Promise<CommandResult> {
  if (einInForm(form)) return bad(EIN_REFUSAL);
  const studioId = field(form, "studioId");
  const requestKey = field(form, "requestKey");
  if (!UUID.test(studioId)) return bad("Choose the studio.");
  if (!UUID.test(requestKey)) return bad("This form has expired: reload the page.");
  if (field(form, "phrase") !== CREATE_PHRASE) return bad(`Type ${CREATE_PHRASE} exactly to create the subaccount. Nothing was created.`);
  if ("refused" in deps) return bad(`${deps.refused} Nothing was created.`);
  try {
    // the database derives the legal business from the studio; provisioning below resolves the same studio, so the two cannot disagree
    await store.confirmSubaccount(requestKey, studioId, actorId);
  } catch (error) {
    return bad(panelErrorMessage("subaccount", error));
  }
  const result = await provisionSubaccount({ entities: deps.entities, parent: deps.parent, studioId, actorId, envName: deps.envName });
  // another admin's creation is running right now: nothing was called or recorded by this attempt
  if (result.outcome === "retry_later" && result.detail === "creation_in_progress") return bad("Another creation for this legal business is running right now. Nothing was called or recorded; check again in a few minutes.");
  const text = SUBACCOUNT_TEXT[result.outcome];
  const detail = result.detail ? ` (${result.detail.replace(/[^A-Za-z0-9_:.-]/g, "").slice(0, 80)})` : "";
  return { ok: result.outcome === "subaccount_created" || result.outcome === "subaccount_exists", message: `${text}${detail}` };
}

export async function decideTier(store: PanelStore, actorId: string, form: FormData): Promise<CommandResult> {
  if (einInForm(form)) return bad(EIN_REFUSAL);
  const studioId = field(form, "studioId");
  const tier = field(form, "tier");
  const reason = cleanNote(field(form, "reason"), 10, 300);
  if (!UUID.test(studioId)) return bad("Choose a studio.");
  if (!isRegistrationTier(tier)) return bad("Choose Standard or Low-Volume Standard.");
  if (!reason) return bad("Document the reason for this choice (10-300 characters).");
  let eligibility: Record<string, boolean> | null = null;
  if (tier === "low_volume_standard") {
    eligibility = Object.fromEntries(LVS_CHECKLIST.map((item) => [item.key, checked(form, `elig_${item.key}`)]));
    const missing = LVS_CHECKLIST.filter((item) => !eligibility![item.key]);
    if (missing.length > 0) return bad(`Low-Volume Standard needs every eligibility check confirmed (missing: ${missing.length}). Nothing was changed.`);
  }
  try {
    const result = await store.decideTier(studioId, actorId, tier, reason, eligibility);
    return good(result.changed ? `Registration path set to ${tier === "standard" ? "Standard" : "Low-Volume Standard"}. Twilio still reviews and decides.` : "That registration path was already set; nothing changed.");
  } catch (error) {
    return bad(panelErrorMessage("tier", error));
  }
}
