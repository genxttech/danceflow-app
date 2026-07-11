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
};

export type CompetitionDraftEntry = {
  clientId: string;
  programId: string;
  contestId: string;
  divisionId: string;
  participantIds: string[];
  participantRoles: Record<string, string>;
  selectedOfferingIds: string[];
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
  unitAmount: number;
  lineAmount: number;
  currency: string;
  metadata: Record<string, unknown>;
};

export type CompetitionQuote = {
  valid: boolean;
  errors: string[];
  lines: CompetitionQuoteLine[];
  subtotal: number;
  discount: number;
  total: number;
  currency: string;
  effectiveOfferingIdsByEntry: Record<string, string[]>;
};

function cents(value: number) {
  return Math.max(0, Math.round(Number(value || 0) * 100));
}

function money(centsValue: number) {
  return Number((centsValue / 100).toFixed(2));
}

function matchesFeeRule(rule: CompetitionFeeRule, entry: CompetitionDraftEntry) {
  return (!rule.program_id || rule.program_id === entry.programId)
    && (!rule.contest_id || rule.contest_id === entry.contestId)
    && (!rule.division_id || rule.division_id === entry.divisionId);
}

export function calculateCompetitionRegistrationQuote(
  catalog: CompetitionRegistrationCatalog,
  draft: CompetitionRegistrationDraft,
): CompetitionQuote {
  const errors: string[] = [];
  const lines: CompetitionQuoteLine[] = [];
  const effectiveOfferingIdsByEntry: Record<string, string[]> = {};
  const peopleById = new Map(draft.people.map((person) => [person.clientId, person]));
  let currency = "";

  if (!draft.buyerName.trim()) errors.push("Buyer name is required.");
  if (!draft.buyerEmail.trim() || !draft.buyerEmail.includes("@")) errors.push("A valid buyer email is required.");
  if (draft.registrationMode === "studio" && !draft.registeringStudioName?.trim()) errors.push("Studio name is required for studio registration.");
  if (draft.people.length === 0) errors.push("Add at least one dancer or instructor.");
  if (draft.entries.length === 0) errors.push("Add at least one competition entry.");

  for (const entry of draft.entries) {
    const contest = catalog.contests.find((item) => item.id === entry.contestId && item.program_id === entry.programId);
    const division = catalog.divisions.find((item) => item.id === entry.divisionId && item.contest_id === entry.contestId && item.program_id === entry.programId);
    const rule = catalog.rules.find((item) => item.contest_id === entry.contestId && item.program_id === entry.programId);
    if (!contest || !division || !rule) {
      errors.push("One entry references a competition option that is no longer available.");
      continue;
    }

    const uniqueParticipantIds = [...new Set(entry.participantIds)];
    if (uniqueParticipantIds.some((id) => !peopleById.has(id))) errors.push(`${division.name}: select valid roster participants.`);
    if (uniqueParticipantIds.length < rule.minimum_participants || uniqueParticipantIds.length > rule.maximum_participants) errors.push(`${division.name}: select ${rule.minimum_participants === rule.maximum_participants ? rule.minimum_participants : `${rule.minimum_participants}-${rule.maximum_participants}`} participants.`);
    if (contest.entry_format === "random_partner") {
      const selectedRole = uniqueParticipantIds.length === 1 ? entry.participantRoles[uniqueParticipantIds[0]] : "";
      if (!["leader", "follower"].includes(selectedRole)) errors.push(`${division.name}: select Leader or Follower for this entry.`);
    }
    if (rule.requires_routine_title && !entry.routineTitle?.trim()) errors.push(`${division.name}: routine title is required.`);
    if (rule.requires_music && !entry.musicTitle?.trim()) errors.push(`${division.name}: music title is required.`);
    if (rule.requires_duration && !(Number(entry.routineDurationSeconds) > 0)) errors.push(`${division.name}: routine duration is required.`);

    const availableOfferings = catalog.offerings.filter((item) => item.division_id === division.id);
    const availableIds = new Set(availableOfferings.map((item) => item.id));
    const requiredIds = availableOfferings.filter((item) => item.required).map((item) => item.id);
    const submittedIds = [...new Set(entry.selectedOfferingIds)].filter((id) => availableIds.has(id));
    let effectiveIds: string[] = [];
    if (["prescribed_set", "routine"].includes(rule.dance_selection_mode)) effectiveIds = availableOfferings.map((item) => item.id);
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
    const includeBase = ["flat_entry", "base_plus_dance", "included_set", "custom"].includes(rule.pricing_method);
    const includeDances = ["per_dance", "base_plus_dance"].includes(rule.pricing_method);
    if (includeBase) lines.push({ clientEntryId: entry.clientId, feeRuleId: null, lineType: "base_entry", description: `${contest.name} — ${division.name}`, quantity: 1, unitAmount: money(cents(Number(rule.base_entry_fee))), lineAmount: money(cents(Number(rule.base_entry_fee))), currency, metadata: { contestId: contest.id, divisionId: division.id } });
    if (includeDances) for (const offeringId of effectiveIds) {
      const offering = availableOfferings.find((item) => item.id === offeringId);
      if (!offering) continue;
      const offeringCurrency = (offering.currency || currency).toUpperCase();
      if (offeringCurrency !== currency) errors.push(`${division.name}: all fees must use ${currency}.`);
      lines.push({ clientEntryId: entry.clientId, feeRuleId: null, lineType: "dance", description: `${contest.name} — ${division.name} — ${offering.dance?.name ?? "Dance"}`, quantity: 1, unitAmount: money(cents(Number(offering.entry_fee))), lineAmount: money(cents(Number(offering.entry_fee))), currency, metadata: { contestId: contest.id, divisionId: division.id, offeringId } });
    }
  }

  const eligibleFeeRules = catalog.feeRules
    .filter((rule) => rule.registration_mode === "both" || rule.registration_mode === draft.registrationMode)
    .sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name));
  for (const rule of eligibleFeeRules) {
    const matchingEntries = draft.entries.filter((entry) => matchesFeeRule(rule, entry));
    if (rule.program_id || rule.contest_id || rule.division_id) {
      if (matchingEntries.length === 0) continue;
    }
    const ruleCurrency = (rule.currency || currency || "USD").toUpperCase();
    if (!currency) currency = ruleCurrency;
    if (ruleCurrency !== currency) {
      errors.push(`${rule.name}: all fees must use ${currency}.`);
      continue;
    }
    const matchingDanceCount = matchingEntries.reduce((sum, entry) => sum + (effectiveOfferingIdsByEntry[entry.clientId]?.length ?? 0), 0);
    const matchingPeople = new Set(matchingEntries.flatMap((entry) => entry.participantIds));
    const scopedRule = Boolean(rule.program_id || rule.contest_id || rule.division_id);
    const matchingEntryIds = new Set(matchingEntries.map((entry) => entry.clientId));
    const currentSubtotalCents = lines
      .filter((line) => line.lineType !== "discount" && (!scopedRule || (line.clientEntryId != null && matchingEntryIds.has(line.clientEntryId))))
      .reduce((sum, line) => sum + cents(line.lineAmount), 0);
    let quantity = 1;
    let unitCents = cents(Number(rule.amount));
    let lineCents = unitCents;
    let lineType: CompetitionQuoteLine["lineType"] = "fee";
    if (rule.calculation_type === "flat_per_person") quantity = matchingPeople.size || draft.people.length;
    if (rule.calculation_type === "flat_per_entry") quantity = matchingEntries.length || draft.entries.length;
    if (rule.calculation_type === "flat_per_dance") quantity = matchingDanceCount;
    if (["percentage", "discount_percentage"].includes(rule.calculation_type)) {
      unitCents = Math.round(currentSubtotalCents * Math.max(0, Number(rule.percentage ?? 0)) / 100);
      quantity = 1;
    }
    lineCents = unitCents * Math.max(0, quantity);
    if (["discount_flat", "discount_percentage"].includes(rule.calculation_type)) lineType = "discount";
    if (lineCents > 0) lines.push({ clientEntryId: null, feeRuleId: rule.id, lineType, description: rule.name, quantity: Math.max(1, quantity), unitAmount: money(unitCents), lineAmount: money(lineCents), currency, metadata: {} });
  }

  const subtotalCents = lines.filter((line) => line.lineType !== "discount").reduce((sum, line) => sum + cents(line.lineAmount), 0);
  const discountCents = Math.min(subtotalCents, lines.filter((line) => line.lineType === "discount").reduce((sum, line) => sum + cents(line.lineAmount), 0));
  return { valid: errors.length === 0, errors, lines, subtotal: money(subtotalCents), discount: money(discountCents), total: money(subtotalCents - discountCents), currency: currency || "USD", effectiveOfferingIdsByEntry };
}
