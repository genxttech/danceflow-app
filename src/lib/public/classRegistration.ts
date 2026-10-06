import { isUuid, type PublicGroupClass } from "@/lib/public/groupClasses";

/*
  GC-3.4B-1: the authenticated identity step for a public Group Class.

  The route itself is the registration intent; nothing is stored. This step
  only resolves WHO is registering (authentication, verified identity, an
  existing studio relationship and an authorized dancer) and ends at
  "Open Student Portal". It never enrolls, never charges and never creates a
  client, a relationship or a link.

  Pure helpers only (safe to import from the auth-free public class page);
  the server-side reads live in classRegistrationData.ts.
*/

export const classRegisterPath = (studioSlug: string, appointmentId: string, dancerId?: string | null) =>
  `/studios/${encodeURIComponent(studioSlug)}/classes/${appointmentId}/register${
    dancerId ? `?dancer=${encodeURIComponent(dancerId)}` : ""
  }`;

/** Only an upcoming class whose public enrollment state is open may proceed to the identity step. */
export function canProceedToRegister(item: Pick<PublicGroupClass, "publicState" | "enrollmentState">) {
  return item.publicState === "upcoming" && item.enrollmentState === "open";
}

/** Public status copy for a class that cannot proceed (same public truth as the class page). */
export function registerUnavailableMessage(item: Pick<PublicGroupClass, "publicState" | "enrollmentState">) {
  if (item.publicState === "cancelled") return "This class has been cancelled.";
  if (item.publicState === "past") return "This class has already taken place.";
  if (item.enrollmentState === "full") return "This class is full.";
  return "Online registration isn't available for this class. Contact the studio to join.";
}

/*
  GC-3.4C funding display and choice. The candidates always come from the
  canonical preview_self_enrollment_funding_candidates RPC; nothing here
  decides eligibility, and the enrollment RPC re-validates any choice.
*/
export type RegistrationFundingCandidate = {
  fundingType: "package" | "membership";
  sourceId: string;
  label: string;
};

export function toRegistrationFundingCandidates(
  rows: Array<{ funding_type: string; source_id: string; label: string | null }> | null | undefined,
): RegistrationFundingCandidate[] {
  return (rows ?? []).flatMap((row) =>
    (row.funding_type === "package" || row.funding_type === "membership") && isUuid(row.source_id)
      ? [{ fundingType: row.funding_type, sourceId: row.source_id, label: row.label?.trim() || "" }]
      : [],
  );
}

/** "Using your 10-Lesson Package" / "Covered by your Monthly Membership". */
export function fundingSummary(candidate: RegistrationFundingCandidate) {
  if (candidate.fundingType === "membership") {
    return candidate.label ? `Covered by your ${candidate.label}` : "Covered by your membership";
  }
  return candidate.label ? `Using your ${candidate.label}` : "Using your class package";
}

export const fundingChoiceValue = (candidate: RegistrationFundingCandidate) =>
  `${candidate.fundingType}:${candidate.sourceId}`;

/** Parses a submitted "package:<uuid>" / "membership:<uuid>" choice; anything else is no choice. */
export function parseRegistrationFundingChoice(raw: string | null | undefined): {
  clientPackageId: string | null;
  clientMembershipId: string | null;
} {
  const [type, id, ...rest] = String(raw ?? "").trim().split(":");
  if (rest.length === 0 && isUuid(id)) {
    if (type === "package") return { clientPackageId: id, clientMembershipId: null };
    if (type === "membership") return { clientPackageId: null, clientMembershipId: id };
  }
  return { clientPackageId: null, clientMembershipId: null };
}

export type ManageableDancer = {
  clientId: string;
  displayName: string;
  isSelf: boolean;
};

export type RegistrationDancerResolution =
  | { kind: "unlinked" }
  | { kind: "choose"; dancers: ManageableDancer[] }
  | { kind: "ready"; dancer: ManageableDancer; dancers: ManageableDancer[] }
  | { kind: "invalid_selection" };

/**
 * Pure decision over the server-resolved list. A requested dancer id is only
 * ever honoured when it is one of the account's own manageable dancers at this
 * studio; anything else (another studio's client, an unlinked or view-only
 * relationship, garbage) is an invalid selection and selects nothing.
 */
export function resolveRegistrationDancer(
  dancers: ManageableDancer[],
  requestedDancerId: string | null | undefined,
): RegistrationDancerResolution {
  const requested = requestedDancerId?.trim() || null;

  if (requested) {
    const match = isUuid(requested) ? dancers.find((dancer) => dancer.clientId === requested) : undefined;
    return match ? { kind: "ready", dancer: match, dancers } : { kind: "invalid_selection" };
  }

  if (dancers.length === 0) return { kind: "unlinked" };
  if (dancers.length === 1) return { kind: "ready", dancer: dancers[0], dancers };
  return { kind: "choose", dancers };
}
