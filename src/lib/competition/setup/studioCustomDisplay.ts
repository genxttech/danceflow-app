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

/** The label of the seeded Studio / Custom profile (studio_simple@3); the display layer applies to it only. */
export const STUDIO_CUSTOM_PROFILE_LABEL = "Studio / Custom Rules";

export type CustomFormatDisplay = {
  /** The persisted entry_format the profile must carry for the override to apply (default "custom"; OD-28 adds "team"). */
  entryFormat?: string;
  label: string;
  description: string;
  /** Replaces the profile's eligibility_note for the format (when omitted the profile note is removed: a stale body-rule note must not survive). */
  eligibilityNote?: string;
  /** Replaces music_source.note when the profile's note names a governing body. */
  musicNote?: string;
};

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
    eligibilityNote: "DanceFlow applies no governing-body showdance rules to this format; you decide who may enter and which rules apply.",
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

// R-02 (owner ratified 2026-11-23): Studio/Custom partnership formats and the 'Other / Studio-defined' style carry no
// NDCA/UCWDC/WSDC compliance claim. Text is neutral: it describes the DanceFlow format and makes no statement about what
// any governing body does or does not define.
export const STUDIO_PARTNERSHIP_DISPLAY: Readonly<Record<string, CustomFormatDisplay>> = {
  wcs_couples: { entryFormat: "couple", label: "Studio/Custom: Couples", description: "A couple contest you define, as a DanceFlow Studio/Custom format." },
  wcs_pro_am: { entryFormat: "pro_am", label: "Studio/Custom: Pro-Am", description: "A student dances with a professional, as a DanceFlow Studio/Custom format." },
  studio_pro_am: { entryFormat: "pro_am", label: "Studio/Custom: Pro-Am", description: "A student dances with a professional, as a DanceFlow Studio/Custom format." },
  studio_pro_pro: { entryFormat: "pro_pro", label: "Studio/Custom: Pro-Pro", description: "A competing professional dances with an instructing professional, as a DanceFlow Studio/Custom format." },
  studio_couples: { entryFormat: "couple", label: "Studio/Custom: Couples", description: "Two dancers compete as a couple, as a DanceFlow Studio/Custom format." },
  studio_professional: { entryFormat: "professional", label: "Studio/Custom: Professional couples", description: "Two professionals compete as a couple, as a DanceFlow Studio/Custom format." },
  studio_jack_and_jill: { entryFormat: "random_partner", label: "Studio/Custom: Jack & Jill", description: "Dancers enter alone and are paired with a random partner, as a DanceFlow Studio/Custom format." },
  studio_solo: { entryFormat: "solo", label: "Studio/Custom: Solo", description: "One dancer performs a routine, as a DanceFlow Studio/Custom format." },
  solo: { entryFormat: "solo", label: "Studio/Custom: Solo routine", description: "One dancer performs a routine, as a DanceFlow Studio/Custom format." },
};

/**
 * Division scheme wording. `append` adds to the profile's axis note, `replace` replaces it. Only axis notes (the text the
 * wizard renders) and scheme notes are touched; axis values (division names, ids, stored configurations) are never changed.
 * Studio age terms (Youth, Adult, Senior) carry no thresholds and do not map to any governing-body class (audit AE-26,
 * FD-26, FD-37). The UCWDC Masters/Open under-18 partner exception is NOT available under OD-02 (audit AE-08).
 */
export const STUDIO_DIVISION_DISPLAY: Readonly<Record<string, { note?: string; axes?: Record<string, { append?: string; replace?: string }> }>> = {
  studio_wcs: { note: "Studio/Custom levels for the DanceFlow Studio/Custom West Coast Swing formats." },
  studio_generic: {
    axes: {
      age_group: {
        replace:
          "Studio/Custom age labels: Youth, Adult and Senior carry no age thresholds in DanceFlow and do not correspond to any governing-body class. DanceFlow does not check age against these labels, and DanceFlow's initial-release policy (OD-02) is that all competitors must be 18 or older whatever the label. Define your own labels if you prefer.",
      },
    },
  },
  country_couples: {
    axes: {
      age_group: {
        append:
          "UCWDC Couples II.D.3.a-b document a partner exception for Open and Masters (an adult may dance with a partner aged 16 or above). That exception is NOT available in this DanceFlow release: DanceFlow's initial-release policy (OD-02) prohibits all competitors under 18, and DanceFlow does not enforce UCWDC age eligibility.",
      },
    },
  },
};

/** Persisted format ids whose presentation this layer rewrites (snapshot-tested: ids never change). */
export const STUDIO_CUSTOM_DISPLAY_KEYS = Object.keys(STUDIO_CUSTOM_DISPLAY);
export const STUDIO_PARTNERSHIP_DISPLAY_KEYS = Object.keys(STUDIO_PARTNERSHIP_DISPLAY);

/**
 * Returns the profile with DanceFlow Studio/Custom display wording on the listed `custom` formats. Idempotent,
 * pure, and a no-op for any format that is missing from the profile or whose entry_format differs from the one its display entry names ("custom" by default). Applies only to the Studio / Custom profile.
 */
export function withStudioCustomDisplayLabels(profile: SetupProfileDefaults): SetupProfileDefaults {
  // Only the Studio / Custom profile: a future governing-body profile reusing generic keys must never be relabelled.
  if (profile.label !== STUDIO_CUSTOM_PROFILE_LABEL) return profile;
  const categoryTypes: Record<string, EntryFormatDefinition> = { ...profile.categoryTypes };
  for (const [key, display] of Object.entries({ ...STUDIO_CUSTOM_DISPLAY, ...STUDIO_PARTNERSHIP_DISPLAY })) {
    const definition = categoryTypes[key];
    if (!definition || definition.entry_format !== (display.entryFormat ?? "custom")) continue;
    const next: EntryFormatDefinition = { ...definition, label: display.label, description: display.description };
    if (display.eligibilityNote !== undefined) next.eligibility_note = display.eligibilityNote;
    else delete next.eligibility_note;
    if (display.musicNote !== undefined && definition.music_source) {
      next.music_source = { ...definition.music_source, note: display.musicNote };
    }
    categoryTypes[key] = next;
  }
  const divisionSchemes = { ...profile.divisionSchemes };
  for (const [key, display] of Object.entries(STUDIO_DIVISION_DISPLAY)) {
    const scheme = divisionSchemes[key];
    if (!scheme) continue;
    divisionSchemes[key] = {
      ...scheme,
      ...(display.note !== undefined ? { note: display.note } : {}),
      axes: scheme.axes.map((axis) => {
        const change = display.axes?.[axis.key];
        if (!change) return axis;
        const base = change.replace ?? axis.note ?? "";
        const note = change.append && !base.includes(change.append) ? `${base} ${change.append}`.trim() : base;
        return { ...axis, note };
      }),
    };
  }
  return { ...profile, categoryTypes, divisionSchemes };
}
