import { competitionWorkspaceHref } from "@/lib/competition/workspaceLink";

/**
 * The lifecycle the Overview walks an organizer through. It answers: where am I, what is missing,
 * and what is the one thing to do next. Only stages that work today are actionable; the rest are
 * shown as upcoming and never pretend to work.
 */

export type StageKey =
  | "create"
  | "divisions"
  | "publish"
  | "open_registration"
  | "close_registration"
  | "build_heats"
  | "assign_officials"
  | "run"
  | "review_results"
  | "publish_results";

export type StageState = "done" | "current" | "upcoming";

export type LifecycleStage = {
  key: StageKey;
  label: string;
  state: StageState;
  /** Whether the organizer can act on this stage today. */
  actionable: boolean;
  note?: string;
};

export type LifecycleProgram = {
  id: string;
  name: string;
  status: string;
  rulesProfileKey: string | null;
  rulesProfileVersion: number | null;
  profileLocked: boolean;
  /** Phase 10C canonical registration lifecycle (event_competition_programs.registration_status). */
  registrationStatus?: "open" | "closed";
  registrationOpenedAt?: string | null;
};

export type LifecycleInput = {
  eventId: string;
  program: LifecycleProgram | null;
  categoryCount: number;
  categoriesWithoutDivisions: number;
  divisionCount: number;
  divisionsWithoutRound: number;
  divisionsMissingDances: number;
  registrationOpen: boolean;
  /** Registration was opened at least once (so "closed" means closed, not "not yet opened"). */
  registrationEverOpened: boolean;
  entryCount: number;
  heatCount: number;
};

export type PrimaryAction =
  | { kind: "link"; label: string; href: string; description: string }
  | { kind: "publish"; label: string; programId: string; description: string }
  | { kind: "registration"; mode: "open" | "close"; label: string; programId: string; description: string }
  | { kind: "info"; label: string; description: string };

export type Lifecycle = {
  stages: LifecycleStage[];
  problems: string[];
  structureReady: boolean;
  published: boolean;
  primaryAction: PrimaryAction;
};

const LATER = "Available in a later Competition OS release.";

export type StructureRows = {
  contests: Array<{ id: string }>;
  divisions: Array<{ id: string; contest_id: string | null }>;
  rounds: Array<{ division_id: string }>;
  rules: Array<{ contest_id: string; dance_selection_mode: string; registration_open: boolean }>;
  offerings: Array<{ division_id: string }>;
};

const DANCE_MODES = ["individual", "choose_count", "prescribed_set"];

/** Derives the readiness counts from the program's canonical rows (mirrors the checks publish_competition_program enforces). */
export function buildLifecycleInput(args: {
  eventId: string;
  program: LifecycleProgram | null;
  rows: StructureRows;
  entryCount: number;
  heatCount: number;
}): LifecycleInput {
  const { rows } = args;
  const roundDivisions = new Set(rows.rounds.map((round) => round.division_id));
  const offeredDivisions = new Set(rows.offerings.map((offering) => offering.division_id));
  const danceContests = new Set(rows.rules.filter((rule) => DANCE_MODES.includes(rule.dance_selection_mode)).map((rule) => rule.contest_id));
  const contestsWithDivisions = new Set(rows.divisions.map((division) => division.contest_id).filter(Boolean) as string[]);
  return {
    eventId: args.eventId,
    program: args.program,
    categoryCount: rows.contests.length,
    categoriesWithoutDivisions: rows.contests.filter((contest) => !contestsWithDivisions.has(contest.id)).length,
    divisionCount: rows.divisions.length,
    divisionsWithoutRound: rows.divisions.filter((division) => !roundDivisions.has(division.id)).length,
    divisionsMissingDances: rows.divisions.filter((division) => division.contest_id && danceContests.has(division.contest_id) && !offeredDivisions.has(division.id)).length,
    // Phase 10C: open means the program's canonical registration lifecycle is open (written only by
    // open_/close_competition_registration), not merely that some contest rule is toggled on.
    registrationOpen: args.program?.registrationStatus === "open",
    registrationEverOpened: Boolean(args.program?.registrationOpenedAt),
    entryCount: args.entryCount,
    heatCount: args.heatCount,
  };
}

export function structureProblems(
  input: Pick<LifecycleInput, "categoryCount" | "categoriesWithoutDivisions" | "divisionsWithoutRound" | "divisionsMissingDances">,
) {
  const problems: string[] = [];
  if (input.categoryCount < 1) problems.push("Add at least one category.");
  if (input.categoriesWithoutDivisions > 0) {
    problems.push(`${input.categoriesWithoutDivisions} ${input.categoriesWithoutDivisions === 1 ? "category needs" : "categories need"} a division.`);
  }
  if (input.divisionsWithoutRound > 0) {
    problems.push(`${input.divisionsWithoutRound} ${input.divisionsWithoutRound === 1 ? "division needs" : "divisions need"} a round.`);
  }
  if (input.divisionsMissingDances > 0) {
    problems.push(`${input.divisionsMissingDances} ${input.divisionsMissingDances === 1 ? "division needs" : "divisions need"} a dance.`);
  }
  return problems;
}

export function computeLifecycle(input: LifecycleInput): Lifecycle {
  const base = competitionWorkspaceHref(input.eventId);
  const program = input.program;
  const problems = program ? structureProblems(input) : [];
  const structureReady = Boolean(program) && problems.length === 0;
  const profiled = Boolean(program?.rulesProfileKey);
  const published = Boolean(program) && (program!.profileLocked || (!profiled && program!.status !== "draft"));

  const definitions: Array<{ key: StageKey; label: string; done: boolean; actionable: boolean; note?: string }> = [
    { key: "create", label: "Create competition", done: Boolean(program), actionable: true },
    { key: "divisions", label: "Configure divisions", done: structureReady, actionable: true },
    { key: "publish", label: "Publish", done: published, actionable: profiled },
    { key: "open_registration", label: "Open registration", done: input.registrationOpen || input.registrationEverOpened, actionable: published && !input.registrationOpen },
    { key: "close_registration", label: "Close registration", done: input.registrationEverOpened && !input.registrationOpen, actionable: input.registrationOpen },
    { key: "build_heats", label: "Build heats", done: input.heatCount > 0, actionable: published },
    { key: "assign_officials", label: "Assign officials", done: false, actionable: false, note: LATER },
    { key: "run", label: "Run competition", done: false, actionable: false, note: LATER },
    { key: "review_results", label: "Review results", done: false, actionable: false, note: LATER },
    { key: "publish_results", label: "Publish results", done: false, actionable: false, note: LATER },
  ];

  let currentAssigned = false;
  const stages: LifecycleStage[] = definitions.map((definition) => {
    let state: StageState = "upcoming";
    if (definition.done) state = "done";
    else if (!currentAssigned) {
      state = "current";
      currentAssigned = true;
    }
    return { key: definition.key, label: definition.label, state, actionable: definition.actionable, note: definition.note };
  });

  return {
    stages,
    problems,
    structureReady,
    published,
    primaryAction: primaryAction(input, { profiled, published, structureReady, problems, base }),
  };
}

function primaryAction(
  input: LifecycleInput,
  context: { profiled: boolean; published: boolean; structureReady: boolean; problems: string[]; base: string },
): PrimaryAction {
  const program = input.program;
  if (!program) {
    return {
      kind: "link",
      label: "Create competition",
      href: `${context.base}/new`,
      description: "Answer a few questions and DanceFlow builds the categories, divisions and final rounds for you.",
    };
  }
  if (!context.profiled) {
    return {
      kind: "link",
      label: "Continue in Advanced settings",
      href: `${context.base}/advanced`,
      description: "This competition was set up with Advanced settings, so it is managed there.",
    };
  }
  if (!context.published) {
    if (!context.structureReady) {
      return {
        kind: "link",
        label: "Complete setup",
        href: `${context.base}/divisions`,
        description: context.problems.slice(0, 2).join(" "),
      };
    }
    return {
      kind: "publish",
      label: "Publish competition",
      programId: program.id,
      description: "Publishing locks the rules profile and configuration so they cannot change underneath your entrants.",
    };
  }
  if (["complete", "archived"].includes(program.status)) {
    return { kind: "info", label: "Competition complete", description: "This competition has finished." };
  }
  if (!input.registrationOpen && !input.registrationEverOpened) {
    return {
      kind: "registration",
      mode: "open",
      label: "Open registration",
      programId: program.id,
      description: "Opening registration makes your published categories and divisions available to entrants during the event's registration window.",
    };
  }
  if (input.registrationOpen) {
    return {
      kind: "registration",
      mode: "close",
      label: "Close registration",
      programId: program.id,
      description: "Registration is open. Close it when entries are final; you can reopen it later.",
    };
  }
  return {
    kind: "link",
    label: "Plan schedule & heats",
    href: `${context.base}/schedule`,
    description: "Registration is closed. Plan the schedule and heats from your confirmed entries.",
  };
}
