// OD-19 (owner decision 2026-11-23, Option C): display-label layer for the Studio / Custom `custom` formats.
//
// The seeded profile studio_simple@3 is IMMUTABLE once a program references it (see studioCustomV3.ts and the
// profile SQL it mirrors, guarded by a drift test), so the format names there ("Student/Student", "Spotlight",
// "Showdance", ...) cannot be edited. What organizers READ, however, is presentation: this module maps the
// persisted format identifiers (the category-type keys, never changed) to DanceFlow Studio/Custom wording.
//
// It changes ONLY label, description, eligibility_note and the music note of the formats listed below. Format
// ids, entry_format, contest_type, scoring, participant roles, divisions, pricing and every other field are
// passed through untouched. It never says or implies that a governing body certifies, approves or governs
// these formats. Governing-body role enforcement (verified roles for Student/Student, ProAm/ProPro for
// Spotlight and Showcase) belongs to future body profiles: NOT IMPLEMENTED, see
// docs/competition/governance/rule-register (OD19-*) and docs/competition/od19-custom-format-relabel.md.
import type { EntryFormatDefinition, SetupProfileDefaults } from "./types";

export type CustomFormatDisplay = {
  label: string;
  description: string;
  /** Replaces the profile's eligibility_note for the format (always set: a stale body-rule note must not survive). */
  eligibilityNote?: string;
  /** Replaces music_source.note when the profile's note names a governing body. */
  musicNote?: string;
};

/** Shown wherever a Studio/Custom format has no stricter wording of its own. */
export const STUDIO_CUSTOM_NO_BODY_NOTE =
  "Studio/Custom format: you decide who may enter and which rules apply. It is not a governing-body division.";

/** Keyed by the persisted category-type id. These ids are part of saved configurations: never rename them. */
export const STUDIO_CUSTOM_DISPLAY: Readonly<Record<string, CustomFormatDisplay>> = {
  showcase: {
    label: "Studio/Custom: Showcase",
    description:
      "Choreography to set music for each dance; how the dancers interpret that music is judged. DanceFlow does not check which roles the two participants hold.",
    musicNote: "Under Studio/Custom the organizer supplies the set music for each dance.",
  },
  spotlight: {
    label: "Studio/Custom: Spotlight",
    description:
      "A choreographed dance or medley to music the competitors choose, 2½ to 4 minutes. DanceFlow does not check which roles the two participants hold.",
  },
  routine: {
    label: "Studio/Custom: Routine / Showcase",
    description: "A choreographed couple's routine to music the dancers choose.",
  },
  ndca_student_student: {
    label: "Studio/Custom: Student pair",
    description:
      "Two student dancers compete together, in heats that can run alongside ProAm events. DanceFlow does not verify student status for this format.",
    eligibilityNote:
      "Studio/Custom format: you decide who may enter. DanceFlow does not automatically verify student status, age or amateur/professional status for it, and it is not a governing-body division.",
  },
  ndca_showdance: {
    label: "Studio/Custom: Showdance",
    description: "A choreographed show in one style, up to 4 minutes, using that style's regular dances.",
    eligibilityNote: "Studio/Custom format: DanceFlow applies no governing-body showdance rules; you set the rules.",
  },
  ndca_cabaret: {
    label: "Studio/Custom: Cabaret",
    description:
      "A couple's performance with aerial work and artistry, moving on and off the floor, in any genre, to the couple's own music.",
  },
  ndca_theatre_arts: {
    label: "Studio/Custom: Theatre Arts",
    description:
      "All couples dance at the same time to the same preselected music. DanceFlow does not check lift content or any other performance rule.",
  },
  custom_routine: {
    label: "Studio/Custom: Choreographed routine",
    description: "A routine you define, for studios whose terms differ from governing-body names.",
  },
};

/** Persisted format ids whose presentation this layer rewrites (snapshot-tested: ids never change). */
export const STUDIO_CUSTOM_DISPLAY_KEYS = Object.keys(STUDIO_CUSTOM_DISPLAY);

/**
 * Returns the profile with DanceFlow Studio/Custom display wording on the listed `custom` formats. Idempotent,
 * pure, and a no-op for any format that is missing from the profile or is not entry_format "custom".
 */
export function withStudioCustomDisplayLabels(profile: SetupProfileDefaults): SetupProfileDefaults {
  const categoryTypes: Record<string, EntryFormatDefinition> = { ...profile.categoryTypes };
  for (const [key, display] of Object.entries(STUDIO_CUSTOM_DISPLAY)) {
    const definition = categoryTypes[key];
    if (!definition || definition.entry_format !== "custom") continue;
    const next: EntryFormatDefinition = { ...definition, label: display.label, description: display.description };
    if (display.eligibilityNote !== undefined) next.eligibility_note = display.eligibilityNote;
    else delete next.eligibility_note;
    if (display.musicNote !== undefined && definition.music_source) {
      next.music_source = { ...definition.music_source, note: display.musicNote };
    }
    categoryTypes[key] = next;
  }
  return { ...profile, categoryTypes };
}
