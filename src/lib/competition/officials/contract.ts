/**
 * E1: officials and round panel assignments (migration 20270101090000). Pure helpers shared by the manager page,
 * the server actions and the judging shell. The database is the authority; this mirrors its codes and rules.
 */

export const OFFICIAL_ROLES = ["judge", "scorer", "chair"] as const;
export type OfficialRole = (typeof OFFICIAL_ROLES)[number];

export const OFFICIAL_ROLE_LABELS: Record<OfficialRole, string> = {
  judge: "Judge",
  scorer: "Scorer",
  chair: "Chair of judges",
};

/** Rounds whose panel can still change. Mirrors guard_competition_panel_assignment. */
export const PANEL_EDITABLE_ROUND_STATES = ["draft", "scheduled"] as const;

export function panelEditable(roundStatus: string | null | undefined) {
  return (PANEL_EDITABLE_ROUND_STATES as readonly string[]).includes(roundStatus ?? "");
}

/** Judge and chair carry a letter; scorers do not. */
export function takesJudgeLetter(role: string) {
  return role === "judge" || role === "chair";
}

export function normalizeJudgeLetter(value: string | null | undefined) {
  const letter = (value ?? "").trim().toUpperCase();
  return /^[A-Z]{1,2}$/.test(letter) ? letter : null;
}

export function nextFreeJudgeLetter(used: Iterable<string | null | undefined>) {
  const taken = new Set(Array.from(used).filter(Boolean));
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i);
    if (!taken.has(letter)) return letter;
  }
  return null;
}

/** Database error codes (message prefix) -> copy shown to the manager. */
export const OFFICIAL_ERROR_COPY: Record<string, string> = {
  COMP_FORBIDDEN: "You do not have permission to manage officials for this competition.",
  COMP_REQUEST_ID_REQUIRED: "The request could not be identified. Reload the page and try again.",
  COMP_REQUEST_REUSED: "That request was already used for a different change. Reload the page and try again.",
  COMP_OFFICIAL_INVALID: "Choose a person and a role.",
  COMP_OFFICIAL_NOT_TEAM_MEMBER: "Officials must be active members of this event's studio or organizer team.",
  COMP_OFFICIAL_ACCOUNT_NOT_VERIFIED: "This person has not verified their email and set a password yet, so they cannot be an official.",
  COMP_OFFICIAL_EXISTS: "This person is already an official for this event with a different role.",
  COMP_OFFICIAL_INACTIVE: "Choose an active official of this event.",
  COMP_OFFICIAL_HAS_ASSIGNMENTS: "Remove this person from their rounds before changing between scorer and judge.",
  COMP_CHAIR_EXISTS: "This event already has a chair. Use Make chair to replace them.",
  COMP_REASON_REQUIRED: "A reason is required.",
  COMP_PANEL_FROZEN: "This round has started, so its panel can no longer be changed.",
  COMP_PANEL_LETTER_TAKEN: "That judge letter is already used in this round.",
  COMP_PANEL_LETTER_INVALID: "Use a letter from A to Z (scorers have no letter).",
  COMP_PANEL_ALREADY_ASSIGNED: "This official is already on the panel. Remove them first to change the letter.",
};

export function officialErrorMessage(raw: string | null | undefined) {
  const message = raw ?? "";
  const code = Object.keys(OFFICIAL_ERROR_COPY).find((key) => message.includes(key));
  return code ? OFFICIAL_ERROR_COPY[code] : "The change could not be saved. Try again.";
}

export type PanelStatus = {
  ready: boolean;
  judge_count?: number;
  min_judges?: number;
  scorer_count?: number;
  chair_designated?: boolean;
  missing?: string[];
};

export function panelStatusLabel(status: PanelStatus | null | undefined) {
  if (!status) return "Unknown";
  if (status.ready) return `Panel ready (${status.judge_count ?? 0} judge${status.judge_count === 1 ? "" : "s"})`;
  const need = Math.max(0, (status.min_judges ?? 1) - (status.judge_count ?? 0));
  return need > 0 ? `Needs ${need} more judge${need === 1 ? "" : "s"}` : "Panel not ready";
}
