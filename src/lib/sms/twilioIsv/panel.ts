import type { SupabaseClient } from "@supabase/supabase-js";
import { isRegistrationTier, paidBrandSupported, registrationPath, type RegistrationTier } from "./registrationPath";
import { RunnerStoreError } from "./store";

/**
 * TW-4F platform-admin subaccount onboarding panel (supervised pilot): the read model, the stage/blocker derivation and the panel's persistence.
 * Every write goes through a service-role definer function that re-checks the platform-admin actor; this module adds no authority of its own.
 * Nothing here talks to Twilio: subaccount creation is `provisionSubaccount` (subaccount.ts) through the runner runtime (fake locally).
 */

// ----------------------------------------------------------------------------------------------------------------------------------
// read model (tw4_panel_overview), parsed defensively: anything malformed becomes "absent", never a guess
// ----------------------------------------------------------------------------------------------------------------------------------

export type AccountStatus = "creating" | "unknown" | "failed" | "active" | "suspended" | "closed";
export type PanelSpend = {
  id: string; kind: string; amountCents: number; status: "authorized" | "reserved" | "void" | string; funding: "credit" | "pilot" | string;
  studioId: string | null; approvalRef: string; authorizedAt: string; reservationStatus: string | null;
};
export type PanelEntity = {
  id: string; legalName: string; einLast4: string; spendCapCents: number; committedCents: number; createdAt: string;
  account: { status: AccountStatus; accountSid: string | null; updatedAt: string | null } | null;
  openConfirmation: boolean;
  pilot: { ceilingCents: number; usedCents: number; authorizedCents: number } | null;
  credit: { balanceCents: number; reservedCents: number; hold: boolean } | null;
  studios: { studioId: string; name: string; linkKind: "founding" | "additional" | string; linkedAt: string; verificationNote: string; checks: Record<string, unknown> }[];
  spend: PanelSpend[];
};
export type PanelRequest = {
  id: string; studioId: string; studioName: string; claimedLegalName: string; claimedEinLast4: string; status: "pending" | "approved" | "rejected" | string;
  attestedAt: string; decidedAt: string | null; decisionNote: string | null; legalEntityId: string | null; candidateEntityId: string | null;
};
export type PanelTierDecision = { tier: string; previousTier: string | null; reason: string; eligibility: Record<string, boolean> | null; decidedAt: string };
export type PanelOnboarding = {
  studioId: string; studioName: string; onboardingId: string; state: string; tier: RegistrationTier | null; legalName: string | null; einLast4: string | null;
  submittedAt: string | null; legalEntityId: string | null; b1Status: string | null; brandStatus: string | null; registrationStatus: string | null;
  tierDecisions: PanelTierDecision[];
};
export type PanelAudit = { studioId: string | null; action: string; note: string | null; at: string; actorType: string };
export type PanelOverview = { entities: PanelEntity[]; requests: PanelRequest[]; onboardings: PanelOnboarding[]; audit: PanelAudit[]; prices: Record<string, number> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : 0);
const ACCOUNT_STATUSES: AccountStatus[] = ["creating", "unknown", "failed", "active", "suspended", "closed"];

export function parsePanelOverview(raw: unknown): PanelOverview {
  const root = obj(raw);
  const entities: PanelEntity[] = arr(root.entities).flatMap((e0) => {
    const e = obj(e0);
    if (!UUID.test(str(e.id))) return [];
    const account = obj(e.account);
    const pilot = e.pilot ? obj(e.pilot) : null;
    const credit = e.credit ? obj(e.credit) : null;
    return [{
      id: str(e.id), legalName: str(e.legal_name), einLast4: str(e.ein_last4), spendCapCents: num(e.spend_cap_cents), committedCents: num(e.committed_cents), createdAt: str(e.created_at),
      account: ACCOUNT_STATUSES.includes(account.status as AccountStatus)
        ? { status: account.status as AccountStatus, accountSid: strOrNull(account.account_sid), updatedAt: strOrNull(account.updated_at) } : null,
      openConfirmation: e.open_confirmation === true,
      pilot: pilot ? { ceilingCents: num(pilot.ceiling_cents), usedCents: num(pilot.used_cents), authorizedCents: num(pilot.authorized_cents) } : null,
      credit: credit ? { balanceCents: num(credit.balance_cents), reservedCents: num(credit.reserved_cents), hold: credit.hold === true } : null,
      studios: arr(e.studios).map(obj).filter((s) => UUID.test(str(s.studio_id))).map((s) => ({
        studioId: str(s.studio_id), name: str(s.name), linkKind: str(s.link_kind), linkedAt: str(s.linked_at), verificationNote: str(s.verification_note), checks: obj(s.supporting_checks),
      })),
      spend: arr(e.spend).map(obj).filter((s) => UUID.test(str(s.id))).map((s) => ({
        id: str(s.id), kind: str(s.kind), amountCents: num(s.amount_cents), status: str(s.status), funding: str(s.funding), studioId: strOrNull(s.studio_id),
        approvalRef: str(s.approval_ref), authorizedAt: str(s.authorized_at), reservationStatus: strOrNull(s.reservation_status),
      })),
    }];
  });
  const requests: PanelRequest[] = arr(root.requests).map(obj).filter((r) => UUID.test(str(r.id)) && UUID.test(str(r.studio_id))).map((r) => ({
    id: str(r.id), studioId: str(r.studio_id), studioName: str(r.studio_name), claimedLegalName: str(r.claimed_legal_name), claimedEinLast4: str(r.claimed_ein_last4),
    status: str(r.status), attestedAt: str(r.attested_at), decidedAt: strOrNull(r.decided_at), decisionNote: strOrNull(r.decision_note),
    legalEntityId: UUID.test(str(r.legal_entity_id)) ? str(r.legal_entity_id) : null, candidateEntityId: UUID.test(str(r.candidate_entity_id)) ? str(r.candidate_entity_id) : null,
  }));
  const onboardings: PanelOnboarding[] = arr(root.onboardings).map(obj).filter((o) => UUID.test(str(o.studio_id)) && UUID.test(str(o.onboarding_id))).map((o) => ({
    studioId: str(o.studio_id), studioName: str(o.studio_name), onboardingId: str(o.onboarding_id), state: str(o.state),
    tier: isRegistrationTier(o.tier) ? o.tier : null, legalName: strOrNull(o.legal_name), einLast4: strOrNull(o.ein_last4), submittedAt: strOrNull(o.submitted_at),
    legalEntityId: UUID.test(str(o.legal_entity_id)) ? str(o.legal_entity_id) : null, b1Status: strOrNull(o.b1_status), brandStatus: strOrNull(o.brand_status),
    registrationStatus: strOrNull(o.registration_status),
    tierDecisions: arr(o.tier_decisions).map(obj).map((d) => ({
      tier: str(d.tier), previousTier: strOrNull(d.previous_tier), reason: str(d.reason), decidedAt: str(d.decided_at),
      eligibility: d.eligibility && typeof d.eligibility === "object" ? Object.fromEntries(Object.entries(obj(d.eligibility)).map(([k, v]) => [k, v === true])) : null,
    })),
  }));
  const audit: PanelAudit[] = arr(root.audit).map(obj).map((a) => ({ studioId: strOrNull(a.studio_id), action: str(a.action), note: strOrNull(a.note), at: str(a.at), actorType: str(a.actor_type) }));
  const prices = Object.fromEntries(Object.entries(obj(root.prices)).filter(([, v]) => Number.isInteger(v) && (v as number) > 0)) as Record<string, number>;
  return { entities, requests, onboardings, audit, prices };
}

// ----------------------------------------------------------------------------------------------------------------------------------
// stages: what is configured, approved, submitted, active, and what blocks the next step
// ----------------------------------------------------------------------------------------------------------------------------------

/** The four words the panel uses, always in this sense. */
export type StageState = "not_started" | "configured" | "approved" | "submitted" | "active" | "attention";
export const STAGE_STATE_LABELS: Record<StageState, string> = {
  not_started: "Not started",
  configured: "Configured",   // recorded in DanceFlow, nothing approved or sent yet
  approved: "Approved",       // a person approved it (owner fee approval, admin link decision, Twilio review approval)
  submitted: "Submitted",     // sent to Twilio, waiting for its review or answer
  active: "Active",           // in force at Twilio / usable
  attention: "Needs attention",
};

export type Stage = { key: "entity" | "budget" | "subaccount" | "tier" | "registration"; title: string; state: StageState; summary: string };
export type StudioPanel = {
  studioId: string; studioName: string; entity: PanelEntity | null; onboarding: PanelOnboarding | null; stages: Stage[]; blockers: string[]; nextAction: string;
  pilot: boolean; tier: RegistrationTier;
};

export const CONFIDANCE_NAME_KEY = "confidance unlimited llc";
/** Same normalisation as the database's _tw4f3a_name_key. */
export function nameKey(name: string): string {
  return name.replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim().toLowerCase();
}

export const formatCents = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const AUTH_OPEN = new Set(["authorized", "reserved"]);

/** The database treats a 'creating' row older than 10 minutes as interrupted (tw4_subaccount_begin and tw4_panel_subaccount_confirm). */
export const CREATING_STALE_MS = 10 * 60_000;
export function creatingIsStale(updatedAt: string | null, now: number): boolean {
  const at = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  return Number.isFinite(at) && now - at > CREATING_STALE_MS;
}

/** A Create subaccount form is offered only when a confirmation can actually be used. */
export function canConfirmSubaccount(entity: PanelEntity, now: number): boolean {
  if (entity.spendCapCents <= 0) return false;
  const account = entity.account;
  return !account || account.status === "unknown" || account.status === "failed" || (account.status === "creating" && creatingIsStale(account.updatedAt, now));
}

/**
 * Text that looks like a full EIN: exactly nine digits (2 + 3 + 4), optionally split by one space, dash, dot or slash after the 2nd and 5th digit, and
 * not part of a longer run of digits (so phone numbers, dates and ticket numbers are not refused). Free text must never carry one.
 */
export function looksLikeEin(text: string): boolean {
  return /(?<!\d)\d{2}[\s\-‐-―./]?\d{3}[\s\-‐-―./]?\d{4}(?!\d)/.test(text);
}

export function deriveStudioPanel(
  onboarding: PanelOnboarding | null, entity: PanelEntity | null, overview: Pick<PanelOverview, "requests" | "prices">, studio: { id: string; name: string }, now: number = Date.now(),
): StudioPanel {
  const blockers: string[] = [];
  const stages: Stage[] = [];
  const tier: RegistrationTier = onboarding?.tier ?? "standard";
  const pending = overview.requests.find((r) => r.studioId === studio.id && r.status === "pending");

  // 1. legal business
  if (entity) {
    const link = entity.studios.find((s) => s.studioId === studio.id);
    stages.push({ key: "entity", title: "Legal business", state: "approved",
      summary: `${entity.legalName} (EIN …${entity.einLast4}); ${link?.linkKind === "additional" ? "additional location, owner-attested and admin-approved" : "founding location"}` });
  } else if (pending) {
    stages.push({ key: "entity", title: "Legal business", state: "submitted", summary: `Owner attested this location belongs to ${pending.claimedLegalName}; waiting for your decision.` });
    blockers.push("Decide the owner's location request before anything else.");
  } else if (onboarding && onboarding.state !== "draft" && onboarding.legalName && onboarding.einLast4) {
    stages.push({ key: "entity", title: "Legal business", state: "configured", summary: `Owner submitted ${onboarding.legalName}; no legal business record yet.` });
    blockers.push("Create the legal business from the submitted setup (or link this location to an existing one through an owner attestation).");
  } else {
    stages.push({ key: "entity", title: "Legal business", state: "not_started", summary: "The owner has not submitted the texting setup yet." });
    blockers.push("Waiting for the studio owner to submit the texting setup.");
  }

  // 2. setup budget and owner approvals
  const isPilot = Boolean(entity && nameKey(entity.legalName) === CONFIDANCE_NAME_KEY && entity.pilot);
  if (!entity) {
    stages.push({ key: "budget", title: "Setup budget and fee approvals", state: "not_started", summary: "Needs the legal business first." });
  } else {
    const openAuth = entity.spend.filter((s) => AUTH_OPEN.has(s.status));
    const brandAuth = openAuth.find((s) => s.kind === "brand" && (s.studioId === null || s.studioId === studio.id));
    const pilotText = entity.pilot ? ` Pilot ceiling ${formatCents(entity.pilot.usedCents)} used of ${formatCents(entity.pilot.ceilingCents)} (non-spendable, never resets).` : "";
    const summary = `Setup budget ${formatCents(entity.committedCents)} committed of ${formatCents(entity.spendCapCents)}; ${openAuth.length} open fee approval(s).${pilotText}`;
    if (entity.credit?.hold) blockers.push("The legal business's credit is on hold: no fee step can run.");
    if (entity.spendCapCents === 0) {
      stages.push({ key: "budget", title: "Setup budget and fee approvals", state: "configured", summary });
      blockers.push("Set the cumulative setup budget (spend cap) before the subaccount can be created.");
    } else {
      stages.push({ key: "budget", title: "Setup budget and fee approvals", state: brandAuth ? "approved" : "configured", summary });
    }
  }

  // 3. Twilio subaccount
  const account = entity?.account ?? null;
  if (!entity) {
    stages.push({ key: "subaccount", title: "Twilio subaccount", state: "not_started", summary: "Needs the legal business first." });
  } else if (!account) {
    stages.push({ key: "subaccount", title: "Twilio subaccount", state: "not_started", summary: "Not created. Creating it is its own confirmed step (no fee, no registration)." });
    if (entity.spendCapCents > 0) blockers.push("Create the Twilio subaccount (typed confirmation).");
  } else if (account.status === "active") {
    stages.push({ key: "subaccount", title: "Twilio subaccount", state: "active", summary: `Active (${shortSid(account.accountSid)}).` });
  } else if (account.status === "suspended") {
    stages.push({ key: "subaccount", title: "Twilio subaccount", state: "attention", summary: "Suspended at Twilio. Nothing can run until it is active again." });
    blockers.push("The subaccount is suspended.");
  } else if (account.status === "creating") {
    const stale = creatingIsStale(account.updatedAt, now);
    stages.push({ key: "subaccount", title: "Twilio subaccount", state: stale ? "attention" : "submitted",
      summary: stale
        ? "An earlier creation attempt was interrupted. Confirm again: it looks the account up first and never creates a second one."
        : "Creation in progress. Check again in a few minutes." });
    blockers.push(stale ? "Resolve the interrupted subaccount creation (confirm again; it reconciles by lookup first)." : "Subaccount creation has not finished.");
  } else {
    stages.push({ key: "subaccount", title: "Twilio subaccount", state: "attention",
      summary: account.status === "unknown" ? "The last creation attempt had an unclear outcome. A new confirmed attempt looks it up first; nothing is created twice." : `Status: ${account.status}.` });
    blockers.push("Resolve the subaccount: confirm a new attempt (it reconciles by lookup first).");
  }

  // 4. registration tier
  const lastDecision = onboarding?.tierDecisions[0] ?? null;
  if (!onboarding) {
    stages.push({ key: "tier", title: "Registration path", state: "not_started", summary: "No onboarding." });
  } else {
    const path = registrationPath(tier);
    const word = tier === "low_volume_standard" ? "Low-Volume Standard (Low Volume Mixed campaign)" : "Standard (Mixed campaign)";
    const frozen = onboarding.b1Status !== null;
    const state: StageState = onboarding.brandStatus === "approved" ? "active" : frozen ? "submitted" : onboarding.tier ? "configured" : "not_started";
    stages.push({ key: "tier", title: "Registration path", state,
      summary: `${word}${onboarding.tier ? "" : " by default"}${lastDecision ? `, chosen: "${lastDecision.reason}"` : ""}.${frozen ? " Frozen: a brand attempt exists." : ""} Eligibility is DanceFlow's judgement; Twilio reviews and decides.` });
    if (!paidBrandSupported(path)) blockers.push("Low-Volume Standard has no published brand price yet: the paid brand step is refused (use Standard, or wait for the price).");
  }

  // 5. registration run (provider status)
  if (!onboarding) {
    stages.push({ key: "registration", title: "Twilio registration", state: "not_started", summary: "No onboarding." });
  } else {
    const brand = onboarding.brandStatus;
    const reg = onboarding.registrationStatus;
    const state: StageState =
      reg === "approved" ? "active"
        : brand === "approved" ? "approved"
          : brand === "rejected" || brand === "suspended" || ["needs_info", "blocked", "exception", "suspended"].includes(onboarding.state) ? "attention"
            : onboarding.b1Status || ["profile_review", "brand_pending"].includes(onboarding.state) ? "submitted"
              : onboarding.state === "submitted_for_checks" ? "configured" : "not_started";
    stages.push({ key: "registration", title: "Twilio registration", state,
      summary: `Setup state: ${onboarding.state.replaceAll("_", " ")}; brand: ${brand ?? "not created"}; sending: ${reg === "approved" ? "approved" : "not approved"}.` });
    if (state === "attention") blockers.push("The registration needs a human: see the run evidence.");
  }

  const nextAction = blockers[0] ?? (stages.find((s) => s.key === "registration")?.state === "active" ? "Nothing to do: the studio can send." : "Run the next registration steps in the runner below (window, confirmations).");
  return { studioId: studio.id, studioName: studio.name, entity, onboarding, stages, blockers, nextAction, pilot: isPilot, tier };
}

function shortSid(sid: string | null): string {
  return sid ? `${sid.slice(0, 4)}…${sid.slice(-4)}` : "no SID";
}

/** One card per studio that has an onboarding, an entity link or a pending location request. */
export function buildStudioPanels(overview: PanelOverview, now: number = Date.now()): StudioPanel[] {
  const ids = new Map<string, string>();
  for (const o of overview.onboardings) ids.set(o.studioId, o.studioName);
  for (const e of overview.entities) for (const s of e.studios) ids.set(s.studioId, s.name);
  for (const r of overview.requests) if (r.status === "pending") ids.set(r.studioId, r.studioName);
  return [...ids.entries()].map(([id, name]) => {
    const entity = overview.entities.find((e) => e.studios.some((s) => s.studioId === id)) ?? null;
    const onboarding = overview.onboardings.find((o) => o.studioId === id) ?? null;
    return deriveStudioPanel(onboarding, entity, overview, { id, name: name || id }, now);
  }).sort((a, b) => a.studioName.localeCompare(b.studioName));
}

// ----------------------------------------------------------------------------------------------------------------------------------
// eligibility checklist for Low-Volume Standard (all must be confirmed; the database re-checks the same keys)
// ----------------------------------------------------------------------------------------------------------------------------------

export const LVS_CHECKLIST = [
  { key: "ein_registered", label: "The legal business is registered with an EIN (verified against the onboarding and the legal-business record)." },
  { key: "not_sole_proprietor", label: "It is not a sole proprietorship (sole proprietors use a different Twilio brand type)." },
  { key: "low_volume_expected", label: "Expected volume is low (well under 6,000 message segments a day) and the studio accepts Low-Volume throughput limits." },
  { key: "owner_informed_limits", label: "The owner was told the lower sending limits and that moving to Standard later means a new registration." },
  { key: "owner_informed_review", label: "The owner was told Twilio reviews the brand and campaign and may refuse them; DanceFlow cannot guarantee approval." },
] as const;
export type LvsChecklistKey = (typeof LVS_CHECKLIST)[number]["key"];

// ----------------------------------------------------------------------------------------------------------------------------------
// persistence
// ----------------------------------------------------------------------------------------------------------------------------------

export interface PanelStore {
  overview(actorId: string): Promise<PanelOverview>;
  createEntity(studioId: string, actorId: string, verificationNote: string): Promise<string>;
  decideLink(requestId: string, entityId: string, actorId: string, approve: boolean, note: string): Promise<string>;
  setSpendCap(entityId: string, cents: number, actorId: string): Promise<void>;
  authorizeSpend(input: { entityId: string; kind: string; cents: number; approvalRef: string; actorId: string; funding: "credit" | "pilot"; studioId: string }): Promise<string>;
  withdrawSpend(spendEventId: string, actorId: string, note: string): Promise<void>;
  createPilotException(entityId: string, ceilingCents: number, approvalRef: string, actorId: string): Promise<{ replayed: boolean }>;
  /** The confirmation for the STUDIO's legal business: the database derives the entity; it never comes from the form. */
  confirmSubaccount(requestKey: string, studioId: string, actorId: string): Promise<{ replayed: boolean; reused: boolean; legalEntityId: string | null }>;
  decideTier(studioId: string, actorId: string, tier: RegistrationTier, reason: string, eligibility: Record<string, boolean> | null): Promise<{ changed: boolean }>;
}

type Client = Pick<SupabaseClient, "rpc">;

export class SupabasePanelStore implements PanelStore {
  constructor(private readonly admin: Client) {}

  private async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = (await this.admin.rpc(fn, args)) as { data: unknown; error: { code?: string } | null };
    if (error) throw new RunnerStoreError(String(error.code ?? "unknown"));
    return data as T;
  }

  async overview(actorId: string) {
    return parsePanelOverview(await this.call("tw4_panel_overview", { p_actor: actorId }));
  }
  async createEntity(studioId: string, actorId: string, verificationNote: string) {
    return String(obj(await this.call("tw4_entity_create_for_studio", { p_studio_id: studioId, p_actor: actorId, p_verification_note: verificationNote })).legal_entity_id ?? "");
  }
  async decideLink(requestId: string, entityId: string, actorId: string, approve: boolean, note: string) {
    return String(obj(await this.call("tw4_entity_decide_link", { p_request_id: requestId, p_entity_id: approve ? entityId : null, p_actor: actorId, p_approve: approve, p_note: note })).status ?? "");
  }
  async setSpendCap(entityId: string, cents: number, actorId: string) {
    await this.call("tw4_entity_set_spend_cap", { p_entity_id: entityId, p_cents: cents, p_actor: actorId });
  }
  async authorizeSpend(input: { entityId: string; kind: string; cents: number; approvalRef: string; actorId: string; funding: "credit" | "pilot"; studioId: string }) {
    const row = obj(await this.call("tw4_spend_authorize", {
      p_entity_id: input.entityId, p_kind: input.kind, p_amount_cents: input.cents, p_approval_ref: input.approvalRef, p_actor: input.actorId, p_funding: input.funding, p_studio_id: input.studioId,
    }));
    return String(row.spend_event_id ?? "");
  }
  async withdrawSpend(spendEventId: string, actorId: string, note: string) {
    await this.call("tw4_spend_withdraw", { p_spend_event_id: spendEventId, p_actor: actorId, p_note: note });
  }
  async createPilotException(entityId: string, ceilingCents: number, approvalRef: string, actorId: string) {
    return { replayed: obj(await this.call("tw4_pilot_exception_create", { p_entity_id: entityId, p_ceiling_cents: ceilingCents, p_approval_ref: approvalRef, p_actor: actorId })).replayed === true };
  }
  async confirmSubaccount(requestKey: string, studioId: string, actorId: string) {
    const row = obj(await this.call("tw4_panel_subaccount_confirm", { p_request_key: requestKey, p_studio_id: studioId, p_actor: actorId }));
    return { replayed: row.replayed === true, reused: row.reused === true, legalEntityId: UUID.test(str(row.legal_entity_id)) ? str(row.legal_entity_id) : null };
  }
  async decideTier(studioId: string, actorId: string, tier: RegistrationTier, reason: string, eligibility: Record<string, boolean> | null) {
    return { changed: obj(await this.call("tw4_onboarding_decide_tier", { p_studio_id: studioId, p_actor: actorId, p_tier: tier, p_reason: reason, p_eligibility: eligibility })).changed === true };
  }
}

/** Plain wording for the database refusals the panel can meet. The SQLSTATE comes from the definer functions; never the database's own text. */
export function panelErrorMessage(action: string, error: unknown): string {
  const code = error instanceof RunnerStoreError ? error.code : "unexpected";
  const byAction: Record<string, Record<string, string>> = {
    entity: { "23505": "This studio already belongs to a legal business, or a legal business with this name and EIN exists: link the location through an owner attestation instead.", "22023": "The studio has no submitted setup with a legal name and EIN (or it has registration steps from before subaccounts)." },
    link: { "22023": "Refused: the request is not pending, or the checks do not agree (owner of a studio of this business, legal name, EIN last four, the studio's own setup).", "23505": "This studio already belongs to a legal business." },
    cap: { "22023": "Refused: the budget cannot be negative or below what is already authorized or reserved (the ConfiDance pilot business also cannot exceed $150)." },
    spend: { TW008: "Refused: there is no published price for this fee, or the amount is not the published price (it may have changed: reload).", TW004: "Refused: this approval would exceed the setup budget.", "23505": "That approval reference was already used for another open fee approval: each owner approval authorizes one operation.", "22023": "Refused: a pilot-funded approval needs the pilot exception, the location and a written approval reference (10+ characters)." },
    withdraw: { "22023": "Only an approval that has not been reserved by a run can be withdrawn." },
    pilot: { "22023": "Refused: the pilot exception exists only for the verified ConfiDance Unlimited, LLC, with a ceiling of at most $150 within its budget and a written founder approval.", "23505": "The pilot exception already exists with another ceiling (it cannot be changed)." },
    subaccount: {
      "55000": "Nothing to confirm: the subaccount is already active, suspended or closed.",
      TW006: "A creation attempt started less than 10 minutes ago and may still be running. Nothing was recorded; try again in a few minutes (it is then looked up first).",
      "22023": "Refused: this studio has no legal business, or the confirmation request does not match (reload the page and try again).",
    },
    tier: {
      "22023": "Refused: give a documented reason (10+ characters); Low-Volume Standard also needs every eligibility check and the legal business on file with an EIN matching the studio's setup.",
      "55000": "Refused: a brand attempt exists (the path is frozen), or an open Standard-price brand fee approval must be withdrawn before choosing Low-Volume Standard.", "55P03": "A registration run is in progress for this studio; try again in a few minutes." },
  };
  if (code === "42501") return "Only a platform admin can do this.";
  return byAction[action]?.[code] ?? "The change could not be saved. Nothing was changed.";
}
