/*
  Competition registration quote -- DISPLAY / PREVIEW ONLY.

  Phase 10C: the authoritative price is computed inside the database by
  public._comp10c_quote (called by start_competition_registration) at the database's now(),
  from the registrable catalog and the fee rules whose window contains that instant. This module
  mirrors that function line for line so the builder can show the same total; it is never sent
  to the server as a price and the server never trusts it. Parity is pinned by
  src/lib/competition/__tests__/pricingParity.phase10c.test.ts against the shared fixtures that
  the SQL suite also prices.

  All money is integer cents internally (JS floats are only used to read numeric(10,2) values).
*/

export type CompetitionRegistrationProgram = {
  id: string;
  name: string;
  discipline_family: string;
};

export type CompetitionRegistrationContest = {
  id: string;
  program_id: string;
  name: string;
  contest_type: string;
  entry_format: string;
};

export type CompetitionRegistrationDivision = {
  id: string;
  program_id: string;
  contest_id: string;
  name: string;
  age_label: string | null;
  skill_label: string | null;
  role_label: string | null;
};

export type CompetitionRegistrationOffering = {
  id: string;
  program_id: string;
  division_id: string;
  dance_id: string;
  entry_fee: number;
  currency: string;
  required: boolean;
  sort_order?: number | null;
  dance: { dance_key: string; name: string; category_label: string | null } | null;
};

export type CompetitionRegistrationRule = {
  id: string;
  program_id: string;
  contest_id: string;
  dance_selection_mode: string;
  pricing_method: string;
  base_entry_fee: number;
  currency: string;
  minimum_dances: number | null;
  maximum_dances: number | null;
  minimum_participants: number;
  maximum_participants: number;
  requires_routine_title: boolean;
  requires_music: boolean;
  requires_duration: boolean;
  public_description: string | null;
  terminology: Record<string, string>;
};

export type CompetitionFeeRule = {
  id: string;
  program_id: string | null;
  contest_id: string | null;
  division_id: string | null;
  name: string;
  calculation_type: string;
  registration_mode: string;
  amount: number;
  percentage: number | null;
  currency: string;
  priority: number;
  starts_at?: string | null;
  ends_at?: string | null;
  active?: boolean;
};

export type CompetitionRegistrationCatalog = {
  programs: CompetitionRegistrationProgram[];
  contests: CompetitionRegistrationContest[];
  divisions: CompetitionRegistrationDivision[];
  offerings: CompetitionRegistrationOffering[];
  rules: CompetitionRegistrationRule[];
  feeRules: CompetitionFeeRule[];
};

export type CompetitionRosterPerson = {
  clientId: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  dateOfBirth?: string;
  personType: string;
  wsdcCompetitorId?: string;
  primaryRole?: "leader" | "follower" | "";
  /** "This is me": anchors the competitor to the signed-in, email-verified account (server-enforced). */
  isSelf?: boolean;
  /** Studio-side registration only (event staff): link to the event studio's own client / instructor. */
  anchorClientId?: string;
  anchorInstructorId?: string;
};

export type CompetitionDraftEntry = {
  clientId: string;
  programId: string;
  contestId: string;
  divisionId: string;
  participantIds: string[];
  participantRoles: Record<string, string>;
  selectedOfferingIds: string[];
  teamName?: string;
  routineTitle?: string;
  routineDurationSeconds?: number;
  musicTitle?: string;
  musicArtist?: string;
  notes?: string;
};

export type CompetitionRegistrationDraft = {
  registrationMode: "individual" | "studio";
  buyerName: string;
  buyerEmail: string;
  buyerPhone?: string;
  registeringStudioName?: string;
  people: CompetitionRosterPerson[];
  entries: CompetitionDraftEntry[];
};

export type CompetitionQuoteLine = {
  clientEntryId: string | null;
  feeRuleId: string | null;
  lineType: "base_entry" | "dance" | "fee" | "discount";
  description: string;
  quantity: number;
  unitCents: number;
  lineCents: number;
  unitAmount: number;
  lineAmount: number;
  currency: string;
  metadata: Record<string, unknown>;
};

export type CompetitionQuote = {
  valid: boolean;
  errors: string[];
  lines: CompetitionQuoteLine[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  subtotal: number;
  discount: number;
  total: number;
  currency: string;
  effectiveOfferingIdsByEntry: Record<string, string[]>;
};

export const PERSON_TYPES = ["dancer", "student", "professional", "instructor", "team_member", "alternate", "other"] as const;

/** Roles each entry format accepts (mirrors public._comp10c_allowed_roles). */
export function allowedRolesForFormat(entryFormat: string): string[] {
  if (entryFormat === "pro_am") return ["student", "professional"];
  if (entryFormat === "pro_pro") return ["professional"];
  if (["couple", "mixed_amateur", "professional"].includes(entryFormat)) return ["leader", "follower"];
  if (entryFormat === "random_partner") return ["leader", "follower"];
  if (entryFormat === "team") return ["team_member"];
  return ["dancer", "leader", "follower", "student", "professional", "instructor", "alternate", "other"];
}

/** numeric(10,2) dollars -> integer cents, never negative (mirrors greatest(0, round(x * 100))). */
export function toCents(value: number | string | null | undefined) {
  return Math.max(0, Math.round(Number(value || 0) * 100));
}

export function centsToMoney(centsValue: number) {
  return Number((centsValue / 100).toFixed(2));
}

/** round(subtotal * pct / 100), half-up, in exact integer arithmetic (pct has 4 decimals). */
export function percentageOfCents(subtotalCents: number, percentage: number | null | undefined) {
  const pctUnits = Math.max(0, Math.round(Number(percentage ?? 0) * 10000));
  return Math.floor((2 * subtotalCents * pctUnits + 1_000_000) / 2_000_000);
}

function byteCompare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function feeRuleInWindow(rule: CompetitionFeeRule, nowMs: number) {
  const startsOk = !rule.starts_at || Date.parse(rule.starts_at) <= nowMs;
  const endsOk = !rule.ends_at || nowMs < Date.parse(rule.ends_at);
  return startsOk && endsOk;
}

function validDuration(value: unknown) {
  if (typeof value === "number") return Number.isInteger(value) && value > 0;
  const text = String(value ?? "");
  return /^\d+$/.test(text) && Number(text) > 0;
}

function line(params: Omit<CompetitionQuoteLine, "unitAmount" | "lineAmount">): CompetitionQuoteLine {
  return { ...params, unitAmount: centsToMoney(params.unitCents), lineAmount: centsToMoney(params.lineCents) };
}

export function calculateCompetitionRegistrationQuote(
  catalog: CompetitionRegistrationCatalog,
  draft: CompetitionRegistrationDraft,
  now: Date = new Date(),
): CompetitionQuote {
  const errors: string[] = [];
  const lines: CompetitionQuoteLine[] = [];
  const effectiveOfferingIdsByEntry: Record<string, string[]> = {};
  const people = Array.isArray(draft.people) ? draft.people : [];
  const entries = Array.isArray(draft.entries) ? draft.entries : [];
  const personIds = people.map((person) => person.clientId);
  let currency = "";

  if (!["individual", "studio"].includes(draft.registrationMode)) errors.push("Choose individual or studio registration.");
  if (!draft.buyerName?.trim()) errors.push("Buyer name is required.");
  if (!draft.buyerEmail?.trim() || !draft.buyerEmail.includes("@")) errors.push("A valid buyer email is required.");
  if (draft.registrationMode === "studio" && !draft.registeringStudioName?.trim()) errors.push("Studio name is required for studio registration.");
  if (people.length === 0) errors.push("Add at least one dancer or instructor.");
  if (entries.length === 0) errors.push("Add at least one competition entry.");
  if (people.length > 100 || entries.length > 100) errors.push("One registration can include at most 100 people and 100 entries.");
  if (new Set(personIds).size !== personIds.length || personIds.some((id) => !id)) errors.push("Each roster person needs a unique id.");
  let selfCount = 0;
  for (const person of people) {
    const first = (person.firstName ?? "").trim().length;
    const last = (person.lastName ?? "").trim().length;
    if (first < 1 || first > 100 || last < 1 || last > 100) errors.push("Each person needs a first and last name.");
    if (!(PERSON_TYPES as readonly string[]).includes(person.personType || "dancer")) errors.push("Choose a valid person type.");
    if (person.dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(person.dateOfBirth)) errors.push("Enter dates of birth as YYYY-MM-DD.");
    if (!["", "leader", "follower"].includes(person.primaryRole ?? "")) errors.push("Choose Leader or Follower as the primary role.");
    if (person.isSelf === true) selfCount += 1;
  }
  if (selfCount > 1) errors.push("Only one roster person can be you.");

  for (const entry of entries) {
    const contest = catalog.contests.find((item) => item.id === entry.contestId && item.program_id === entry.programId);
    const division = contest
      ? catalog.divisions.find((item) => item.id === entry.divisionId && item.contest_id === contest.id && item.program_id === entry.programId)
      : undefined;
    const rule = contest ? catalog.rules.find((item) => item.contest_id === contest.id) : undefined;
    if (!contest || !division || !rule) {
      errors.push("One entry references a competition option that is no longer available.");
      continue;
    }

    const uniqueParticipantIds = [...new Set(entry.participantIds ?? [])].sort(byteCompare);
    if (uniqueParticipantIds.some((id) => !personIds.includes(id))) errors.push(`${division.name}: select valid roster participants.`);
    if (uniqueParticipantIds.length < rule.minimum_participants || uniqueParticipantIds.length > rule.maximum_participants) {
      errors.push(`${division.name}: select ${rule.minimum_participants === rule.maximum_participants ? rule.minimum_participants : `${rule.minimum_participants}-${rule.maximum_participants}`} participants.`);
    }
    const roles = entry.participantRoles ?? {};
    if (contest.entry_format === "random_partner") {
      const selectedRole = uniqueParticipantIds.length === 1 ? roles[uniqueParticipantIds[0]] ?? "" : "";
      if (!["leader", "follower"].includes(selectedRole)) errors.push(`${division.name}: select Leader or Follower for this entry.`);
    }
    const allowedRoles = allowedRolesForFormat(contest.entry_format);
    if (uniqueParticipantIds.some((id) => !allowedRoles.includes(roles[id] ?? "dancer"))) {
      errors.push(`${division.name}: choose a valid role for each participant.`);
    }
    if (contest.entry_format === "team" && !entry.teamName?.trim()) errors.push(`${division.name}: team name is required.`);
    if (rule.requires_routine_title && !entry.routineTitle?.trim()) errors.push(`${division.name}: routine title is required.`);
    if (rule.requires_music && !entry.musicTitle?.trim()) errors.push(`${division.name}: music title is required.`);
    if (rule.requires_duration && !validDuration(entry.routineDurationSeconds)) errors.push(`${division.name}: routine duration is required.`);

    const availableOfferings = catalog.offerings
      .filter((item) => item.division_id === division.id)
      .sort((left, right) => (Number(left.sort_order ?? 0) - Number(right.sort_order ?? 0)) || byteCompare(left.id, right.id));
    const availableIds = availableOfferings.map((item) => item.id);
    const requiredIds = availableOfferings.filter((item) => item.required).map((item) => item.id);
    const submittedIds = [...new Set(entry.selectedOfferingIds ?? [])].filter((id) => availableIds.includes(id));
    let effectiveIds: string[];
    if (["prescribed_set", "routine"].includes(rule.dance_selection_mode)) effectiveIds = availableIds;
    else if (rule.dance_selection_mode === "none") effectiveIds = [];
    else effectiveIds = [...new Set([...requiredIds, ...submittedIds])];
    effectiveOfferingIdsByEntry[entry.clientId] = effectiveIds;

    if (["individual", "choose_count"].includes(rule.dance_selection_mode)) {
      if (rule.minimum_dances != null && effectiveIds.length < rule.minimum_dances) errors.push(`${division.name}: select at least ${rule.minimum_dances} dances.`);
      if (rule.maximum_dances != null && effectiveIds.length > rule.maximum_dances) errors.push(`${division.name}: select no more than ${rule.maximum_dances} dances.`);
    }

    const entryCurrency = (rule.currency || "USD").toUpperCase();
    if (currency && entryCurrency !== currency) errors.push(`${division.name}: all competition entries in one checkout must use ${currency}.`);
    if (!currency) currency = entryCurrency;

    if (["flat_entry", "base_plus_dance", "included_set", "custom"].includes(rule.pricing_method)) {
      const baseCents = toCents(rule.base_entry_fee);
      lines.push(line({ clientEntryId: entry.clientId, feeRuleId: null, lineType: "base_entry", description: `${contest.name} — ${division.name}`, quantity: 1, unitCents: baseCents, lineCents: baseCents, currency, metadata: { contestId: contest.id, divisionId: division.id, ruleId: rule.id, pricingMethod: rule.pricing_method } }));
    }
    if (["per_dance", "base_plus_dance"].includes(rule.pricing_method)) {
      for (const offeringId of effectiveIds) {
        const offering = availableOfferings.find((item) => item.id === offeringId);
        if (!offering) continue;
        if ((offering.currency || currency).toUpperCase() !== currency) errors.push(`${division.name}: all fees must use ${currency}.`);
        const unitCents = toCents(offering.entry_fee);
        lines.push(line({ clientEntryId: entry.clientId, feeRuleId: null, lineType: "dance", description: `${contest.name} — ${division.name} — ${offering.dance?.name ?? "Dance"}`, quantity: 1, unitCents, lineCents: unitCents, currency, metadata: { contestId: contest.id, divisionId: division.id, offeringId } }));
      }
    }
  }

  const nowMs = now.getTime();
  const eligibleFeeRules = catalog.feeRules
    .filter((rule) => rule.active !== false && feeRuleInWindow(rule, nowMs))
    .filter((rule) => rule.registration_mode === "both" || rule.registration_mode === draft.registrationMode)
    .sort((left, right) => (left.priority - right.priority) || byteCompare(left.name, right.name) || byteCompare(left.id, right.id));
  for (const rule of eligibleFeeRules) {
    const matchingEntries = entries.filter((entry) =>
      (!rule.program_id || rule.program_id === entry.programId)
      && (!rule.contest_id || rule.contest_id === entry.contestId)
      && (!rule.division_id || rule.division_id === entry.divisionId));
    const scoped = Boolean(rule.program_id || rule.contest_id || rule.division_id);
    if (scoped && matchingEntries.length === 0) continue;

    const ruleCurrency = (rule.currency || currency || "USD").toUpperCase();
    if (!currency) currency = ruleCurrency;
    if (ruleCurrency !== currency) {
      errors.push(`${rule.name}: all fees must use ${currency}.`);
      continue;
    }
    const matchingIds = new Set(matchingEntries.map((entry) => entry.clientId));
    const matchingDanceCount = matchingEntries.reduce((sum, entry) => sum + (effectiveOfferingIdsByEntry[entry.clientId]?.length ?? 0), 0);
    const matchingPeople = new Set(matchingEntries.flatMap((entry) => entry.participantIds ?? []));
    const currentSubtotalCents = lines
      .filter((item) => item.lineType !== "discount" && (!scoped || (item.clientEntryId != null && matchingIds.has(item.clientEntryId))))
      .reduce((sum, item) => sum + item.lineCents, 0);

    let quantity = 1;
    let unitCents = toCents(rule.amount);
    if (rule.calculation_type === "flat_per_person") quantity = matchingPeople.size || people.length;
    else if (rule.calculation_type === "flat_per_entry") quantity = matchingEntries.length || entries.length;
    else if (rule.calculation_type === "flat_per_dance") quantity = matchingDanceCount;
    else if (["percentage", "discount_percentage"].includes(rule.calculation_type)) {
      unitCents = percentageOfCents(currentSubtotalCents, rule.percentage);
      quantity = 1;
    }
    const lineCents = unitCents * Math.max(0, quantity);
    const lineType: CompetitionQuoteLine["lineType"] = ["discount_flat", "discount_percentage"].includes(rule.calculation_type) ? "discount" : "fee";
    if (lineCents > 0) {
      lines.push(line({ clientEntryId: null, feeRuleId: rule.id, lineType, description: rule.name, quantity: Math.max(1, quantity), unitCents, lineCents, currency, metadata: { calculationType: rule.calculation_type, startsAt: rule.starts_at ?? null, endsAt: rule.ends_at ?? null } }));
    }
  }

  const subtotalCents = lines.filter((item) => item.lineType !== "discount").reduce((sum, item) => sum + item.lineCents, 0);
  const discountCents = Math.min(subtotalCents, lines.filter((item) => item.lineType === "discount").reduce((sum, item) => sum + item.lineCents, 0));
  const totalCents = subtotalCents - discountCents;
  return {
    valid: errors.length === 0,
    errors,
    lines,
    subtotalCents,
    discountCents,
    totalCents,
    subtotal: centsToMoney(subtotalCents),
    discount: centsToMoney(discountCents),
    total: centsToMoney(totalCents),
    currency: currency || "USD",
    effectiveOfferingIdsByEntry,
  };
}
