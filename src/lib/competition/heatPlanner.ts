export const HEAT_PLANNER_VERSION = "danceflow-heat-planner-0.1.0";

export type HeatPlannerInput = {
  eventId: string;
  scheduleVersionId: string;
  seed: string;
  contests: Array<{ id: string; name: string; contest_type: string }>;
  divisions: Array<{ id: string; contest_id: string; name: string }>;
  rounds: Array<{ id: string; division_id: string; name: string; round_type: string; sequence_number: number; target_advancement_count: number | null }>;
  dances: Array<{ id: string; dance_key: string; name: string }>;
  offerings: Array<{ division_id: string; dance_id: string; required: boolean; sort_order: number }>;
  entries: Array<{ id: string; division_id: string; display_name: string; entry_number: string | null }>;
  entryDances: Array<{ entry_id: string; dance_key: string; status: string }>;
  participants: Array<{ entry_id: string; client_id: string | null; instructor_id: string | null; registration_attendee_id: string | null; participant_role: string; display_name: string }>;
  blocks: Array<{ id: string; name: string; starts_at: string; ends_at: string; floor_id: string | null; floor_name_snapshot: string | null; floor_capacity_snapshot: number | null }>;
  assignments: Array<{ block_id: string; contest_id: string; planned_round_type: string | null; sort_order: number }>;
  constraints: Array<{ constraint_type: string; enforcement: string; configuration: Record<string, unknown> }>;
};

export type HeatProposalState = {
  proposal_key: string;
  contest_id: string;
  contest_name: string;
  division_id: string;
  division_name: string;
  round_id: string;
  round_name: string;
  round_type: string;
  heat_number: number;
  name: string;
  schedule_version_id: string;
  schedule_block_id: string;
  schedule_block_name: string;
  floor_id: string | null;
  floor_name: string | null;
  scheduled_at: string;
  estimated_ends_at: string;
  duration_seconds: number;
  expected_entry_count: number;
  entry_ids: string[];
  entry_names: string[];
  dances: Array<{ dance_id: string; dance_key: string; dance_label: string; sequence_number: number; duration_seconds: number }>;
};

type Conflict = {
  conflict_type: string;
  severity: "blocker" | "warning" | "information";
  title: string;
  details: string;
  subjects: Array<Record<string, unknown>>;
  proposed_resolution?: Record<string, unknown>;
};

type Job = {
  key: string;
  contest: HeatPlannerInput["contests"][number];
  division: HeatPlannerInput["divisions"][number];
  round: HeatPlannerInput["rounds"][number];
  block: HeatPlannerInput["blocks"][number];
  dances: HeatProposalState["dances"];
  entries: HeatPlannerInput["entries"];
  expectedCount: number;
  isFirstRound: boolean;
  assignmentOrder: number;
};

function hash(value: string) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function seededShuffle<T>(values: T[], seed: string) {
  const output = [...values];
  let state = hash(seed) || 1;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  for (let index = output.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [output[index], output[target]] = [output[target], output[index]];
  }
  return output;
}

function balancedGroups<T>(values: T[], capacity: number) {
  if (values.length === 0) return [] as T[][];
  const groupCount = Math.ceil(values.length / Math.max(1, capacity));
  const baseSize = Math.floor(values.length / groupCount);
  const remainder = values.length % groupCount;
  const groups: T[][] = [];
  let cursor = 0;
  for (let index = 0; index < groupCount; index += 1) {
    const size = baseSize + (index < remainder ? 1 : 0);
    groups.push(values.slice(cursor, cursor + size));
    cursor += size;
  }
  return groups;
}

function severity(input: HeatPlannerInput, type: string): Conflict["severity"] {
  const rule = input.constraints.find((item) => item.constraint_type === type);
  return rule?.enforcement === "hard" ? "blocker" : rule?.enforcement === "informational" ? "information" : "warning";
}

function numberSetting(input: HeatPlannerInput, type: string, key: string, fallback: number) {
  const value = input.constraints.find((item) => item.constraint_type === type)?.configuration?.[key];
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function participantKeys(input: HeatPlannerInput, entryId: string) {
  const rows = input.participants.filter((item) => item.entry_id === entryId);
  const dancers = new Set<string>();
  const instructors = new Set<string>();
  const partners = new Set<string>();
  for (const row of rows) {
    const identity = row.client_id ? `client:${row.client_id}` : row.instructor_id ? `instructor:${row.instructor_id}` : row.registration_attendee_id ? `attendee:${row.registration_attendee_id}` : `name:${row.display_name.toLowerCase()}`;
    if (["professional", "instructor"].includes(row.participant_role) || row.instructor_id) instructors.add(identity);
    else if (["leader", "follower"].includes(row.participant_role)) partners.add(identity);
    else dancers.add(identity);
  }
  return { dancers, instructors, partners };
}

export function buildHeatPlan(input: HeatPlannerInput) {
  const conflicts: Conflict[] = [];
  const jobs: Job[] = [];
  const danceById = new Map(input.dances.map((dance) => [dance.id, dance]));
  const entriesByDivision = new Map<string, HeatPlannerInput["entries"]>();
  for (const entry of input.entries) entriesByDivision.set(entry.division_id, [...(entriesByDivision.get(entry.division_id) ?? []), entry]);

  for (const contest of input.contests) {
    const contestAssignments = input.assignments
      .filter((item) => item.contest_id === contest.id)
      .map((item) => ({ ...item, block: input.blocks.find((block) => block.id === item.block_id) }))
      .filter((item): item is typeof item & { block: HeatPlannerInput["blocks"][number] } => Boolean(item.block))
      .sort((left, right) => new Date(left.block.starts_at).getTime() - new Date(right.block.starts_at).getTime() || left.sort_order - right.sort_order);

    for (const division of input.divisions.filter((item) => item.contest_id === contest.id)) {
      const divisionRounds = input.rounds.filter((item) => item.division_id === division.id).sort((a, b) => a.sequence_number - b.sequence_number);
      const divisionEntries = entriesByDivision.get(division.id) ?? [];
      const divisionDances = input.offerings
        .filter((item) => item.division_id === division.id)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((item) => danceById.get(item.dance_id))
        .filter((item): item is HeatPlannerInput["dances"][number] => Boolean(item));

      if (divisionRounds.length === 0) continue;
      if (divisionDances.length === 0) {
        conflicts.push({ conflict_type: "unassigned", severity: "blocker", title: `${division.name} has no dances`, details: "Add at least one dance or style offering before planning heats.", subjects: [{ division_id: division.id, division_name: division.name }] });
        continue;
      }
      const offeredDanceKeys = new Set(divisionDances.map((dance) => dance.dance_key));
      for (const entry of divisionEntries) {
        const activeSelections = input.entryDances.filter((item) => item.entry_id === entry.id && !["scratched", "complete"].includes(item.status));
        if (activeSelections.length > 0 && !activeSelections.some((item) => offeredDanceKeys.has(item.dance_key))) conflicts.push({ conflict_type: "unassigned", severity: "blocker", title: `${entry.display_name} selected an unavailable dance`, details: `The selected dance is not offered in ${division.name}. Correct the entry or division offerings.`, subjects: [{ entry_id: entry.id, entry_name: entry.display_name, division_id: division.id }] });
      }

      let expectedCount = divisionEntries.length;
      for (let roundIndex = 0; roundIndex < divisionRounds.length; roundIndex += 1) {
        const round = divisionRounds[roundIndex];
        const exactAssignments = contestAssignments.filter((item) => item.planned_round_type === round.round_type);
        const selectedAssignment = exactAssignments[0] ?? contestAssignments.find((item) => !item.planned_round_type || item.planned_round_type === "all");
        if (!selectedAssignment) {
          conflicts.push({ conflict_type: "unassigned", severity: "blocker", title: `${round.name} is not assigned to a block`, details: `${division.name} cannot be placed until its ${round.round_type} round is assigned.`, subjects: [{ contest_id: contest.id, division_id: division.id, round_id: round.id }] });
          continue;
        }

        const isFirstRound = roundIndex === 0;
        const baseDances = divisionDances.map((dance, index) => ({ dance_id: dance.id, dance_key: dance.dance_key, dance_label: dance.name, sequence_number: index + 1, duration_seconds: numberSetting(input, "estimated_duration", "seconds", 90) }));
        if (contest.contest_type === "single_dance") {
          for (const dance of baseDances) {
            const selectedEntries = isFirstRound ? divisionEntries.filter((entry) => {
              const selections = input.entryDances.filter((item) => item.entry_id === entry.id && !["scratched", "complete"].includes(item.status));
              if (selections.length === 0 && divisionDances.length === 1) return true;
              return selections.some((item) => item.dance_key === dance.dance_key);
            }) : [];
            if (isFirstRound) {
              for (const entry of divisionEntries.filter((item) => !selectedEntries.some((selected) => selected.id === item.id))) {
                const selections = input.entryDances.filter((item) => item.entry_id === entry.id);
                if (selections.length === 0) conflicts.push({ conflict_type: "unassigned", severity: "blocker", title: `${entry.display_name} has no dance selection`, details: `${division.name} offers multiple single dances, so a dance selection is required.`, subjects: [{ entry_id: entry.id, entry_name: entry.display_name, division_id: division.id }] });
              }
            }
            jobs.push({ key: `${round.id}:${dance.dance_key}`, contest, division, round, block: selectedAssignment.block, dances: [{ ...dance, sequence_number: 1 }], entries: selectedEntries, expectedCount: isFirstRound ? selectedEntries.length : expectedCount, isFirstRound, assignmentOrder: selectedAssignment.sort_order });
          }
        } else {
          jobs.push({ key: round.id, contest, division, round, block: selectedAssignment.block, dances: baseDances, entries: isFirstRound ? divisionEntries : [], expectedCount, isFirstRound, assignmentOrder: selectedAssignment.sort_order });
        }
        if (round.target_advancement_count) expectedCount = round.target_advancement_count;
      }
    }
  }

  jobs.sort((left, right) => new Date(left.block.starts_at).getTime() - new Date(right.block.starts_at).getTime() || left.assignmentOrder - right.assignmentOrder || left.round.sequence_number - right.round.sequence_number || left.division.name.localeCompare(right.division.name) || left.key.localeCompare(right.key));
  const blockCursor = new Map<string, number>();
  const roundHeatCounter = new Map<string, number>();
  const proposals: HeatProposalState[] = [];
  const gapSeconds = numberSetting(input, "minimum_gap", "minutes", 0) * 60;

  for (const job of jobs) {
    const capacity = Math.max(1, job.block.floor_capacity_snapshot ?? 1);
    if (!job.block.floor_id) conflicts.push({ conflict_type: "floor", severity: "blocker", title: `${job.block.name} has no floor`, details: `${job.division.name} cannot be heated without a floor and capacity.`, subjects: [{ block_id: job.block.id, block_name: job.block.name }] });
    const randomizedEntries = seededShuffle(job.entries, `${input.seed}:${job.key}`);
    const actualGroups = balancedGroups(randomizedEntries, capacity);
    const expectedHeatCount = Math.max(1, Math.ceil(job.expectedCount / capacity));
    const groups = job.isFirstRound ? actualGroups : Array.from({ length: expectedHeatCount }, () => [] as HeatPlannerInput["entries"]);
    if (groups.length === 0) continue;
    let cursor = blockCursor.get(job.block.id) ?? new Date(job.block.starts_at).getTime();
    const durationSeconds = job.dances.reduce((sum, dance) => sum + dance.duration_seconds, 0);

    groups.forEach((group, index) => {
      const heatNumber = (roundHeatCounter.get(job.round.id) ?? 0) + 1;
      roundHeatCounter.set(job.round.id, heatNumber);
      const scheduledAt = new Date(cursor);
      const endsAt = new Date(cursor + durationSeconds * 1000);
      const danceLabel = job.dances.length === 1 ? ` · ${job.dances[0].dance_label}` : "";
      proposals.push({
        proposal_key: `${job.key}:heat:${heatNumber}`,
        contest_id: job.contest.id,
        contest_name: job.contest.name,
        division_id: job.division.id,
        division_name: job.division.name,
        round_id: job.round.id,
        round_name: job.round.name,
        round_type: job.round.round_type,
        heat_number: heatNumber,
        name: `${job.division.name}${danceLabel} · Heat ${heatNumber}`,
        schedule_version_id: input.scheduleVersionId,
        schedule_block_id: job.block.id,
        schedule_block_name: job.block.name,
        floor_id: job.block.floor_id,
        floor_name: job.block.floor_name_snapshot,
        scheduled_at: scheduledAt.toISOString(),
        estimated_ends_at: endsAt.toISOString(),
        duration_seconds: durationSeconds,
        expected_entry_count: job.isFirstRound ? group.length : Math.min(capacity, Math.max(0, job.expectedCount - index * capacity)),
        entry_ids: group.map((entry) => entry.id),
        entry_names: group.map((entry) => entry.display_name),
        dances: job.dances,
      });
      cursor = endsAt.getTime() + gapSeconds * 1000;
    });
    blockCursor.set(job.block.id, cursor);
  }

  proposals.sort((left, right) => new Date(left.scheduled_at).getTime() - new Date(right.scheduled_at).getTime() || (left.floor_name ?? "").localeCompare(right.floor_name ?? "") || left.name.localeCompare(right.name));
  for (const [index, proposal] of proposals.entries()) {
    const block = input.blocks.find((item) => item.id === proposal.schedule_block_id);
    if (block && new Date(proposal.estimated_ends_at).getTime() > new Date(block.ends_at).getTime()) conflicts.push({ conflict_type: "capacity", severity: "blocker", title: `${block.name} exceeds its scheduled time`, details: `${proposal.name} ends after the contest block. Extend the block, increase capacity, or move events.`, subjects: [{ block_id: block.id, proposal_key: proposal.proposal_key }] });
    (proposal as HeatProposalState & { schedule_sequence: number }).schedule_sequence = index + 1;
  }

  const identityAssignments = new Map<string, Array<{ proposal: HeatProposalState; entryName: string; category: string }>>();
  for (const proposal of proposals) {
    proposal.entry_ids.forEach((entryId, entryIndex) => {
      const identities = participantKeys(input, entryId);
      for (const [category, keys] of Object.entries(identities)) for (const key of keys) identityAssignments.set(`${category}:${key}`, [...(identityAssignments.get(`${category}:${key}`) ?? []), { proposal, entryName: proposal.entry_names[entryIndex] ?? "Entry", category }]);
    });
  }
  for (const assignments of identityAssignments.values()) {
    for (let leftIndex = 0; leftIndex < assignments.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < assignments.length; rightIndex += 1) {
        const left = assignments[leftIndex];
        const right = assignments[rightIndex];
        const leftStart = new Date(left.proposal.scheduled_at).getTime();
        const leftEnd = new Date(left.proposal.estimated_ends_at).getTime();
        const rightStart = new Date(right.proposal.scheduled_at).getTime();
        const rightEnd = new Date(right.proposal.estimated_ends_at).getTime();
        const overlaps = leftStart < rightEnd && rightStart < leftEnd;
        const gap = Math.max(0, Math.max(leftStart, rightStart) - Math.min(leftEnd, rightEnd)) / 60000;
        const ruleType = left.category === "instructors" ? "instructor_conflict" : left.category === "partners" ? "partner_conflict" : "dancer_conflict";
        const minimumGap = numberSetting(input, "minimum_gap", "minutes", 0);
        if (overlaps || (minimumGap > 0 && gap < minimumGap)) conflicts.push({ conflict_type: left.category === "instructors" ? "instructor" : left.category === "partners" ? "partner" : "dancer", severity: severity(input, ruleType), title: `${labelCategory(left.category)} schedule conflict`, details: `${left.entryName} is assigned to ${left.proposal.name} and ${right.proposal.name}${overlaps ? " at overlapping times" : ` with only ${gap} minutes between heats`}.`, subjects: [{ first_proposal_key: left.proposal.proposal_key, second_proposal_key: right.proposal.proposal_key }] });
      }
    }
  }

  return {
    proposals: proposals.map((state, index) => ({ action_type: "create", entity_type: "heat", proposed_state: state, sort_order: index + 1 })),
    conflicts,
    summary: {
      proposed_heat_count: proposals.length,
      scheduled_entry_assignments: proposals.reduce((sum, proposal) => sum + proposal.entry_ids.length, 0),
      blocker_count: conflicts.filter((item) => item.severity === "blocker").length,
      warning_count: conflicts.filter((item) => item.severity === "warning").length,
      information_count: conflicts.filter((item) => item.severity === "information").length,
    },
  };
}

function labelCategory(category: string) {
  if (category === "instructors") return "Instructor";
  if (category === "partners") return "Partner";
  return "Dancer";
}
