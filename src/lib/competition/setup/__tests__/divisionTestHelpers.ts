import { divisionScheme, formatDanceOptions, toggleDivisionValue, toggleFormat, toggleFormatStyle, updateFormat, type SetupAnswers } from "../draft";
import type { FormatKey, ProgramKey, SetupProfileDefaults } from "../types";

/**
 * Test helper: nothing is pre-selected on the Divisions step, so tests that need a complete draft choose
 * divisions explicitly -- "Open" where the axis offers it, otherwise the first value -- on every required
 * axis (or the first axis when none is required, e.g. WSDC contests).
 */
export function withDivisions(answers: SetupAnswers, profile: SetupProfileDefaults): SetupAnswers {
  let next = answers;
  for (const [key, program] of Object.entries(answers.programs)) {
    for (const format of Object.keys(program.formats)) {
      const scheme = divisionScheme(profile, key, format);
      const axes = scheme.axes.some((axis) => axis.required) ? scheme.axes.filter((axis) => axis.required) : scheme.axes.slice(0, 1);
      for (const axis of axes) {
        if ((next.programs[key].formats[format]?.divisions[axis.key] ?? []).length > 0) continue;
        const label = axis.values.find((value) => value.label === "Open")?.label ?? axis.values[0].label;
        next = toggleDivisionValue(next, profile, key, format, axis.key, label);
      }
    }
  }
  return next;
}

/** Dances tests pick when they need a complete draft (the wizard itself pre-selects none). */
export const TEST_DANCES: Record<ProgramKey, string[]> = {
  country: ["triple_two", "nightclub", "waltz", "polka", "cha_cha", "east_coast_swing", "two_step"],
  west_coast_swing: ["west_coast_swing"],
  ballroom: ["std_waltz", "std_quickstep", "latin_cha_cha", "latin_jive", "smooth_waltz", "smooth_tango", "smooth_foxtrot", "rhythm_cha_cha", "rhythm_rumba", "rhythm_swing"],
  custom: ["waltz", "foxtrot", "cha_cha", "rumba", "swing", "two_step"],
};

/**
 * Test helper: the organizer's explicit offering choices. Adds each offering (and, for a styled offering,
 * each given dance style), then picks TEST_DANCES that the offering may use when it has no dances yet.
 */
export function withOfferings(answers: SetupAnswers, profile: SetupProfileDefaults, key: ProgramKey, formats: FormatKey[], styles: string[] = []): SetupAnswers {
  let next = answers;
  for (const format of formats) {
    if (!next.programs[key]?.formats[format]) next = toggleFormat(next, profile, key, format);
    for (const style of styles) {
      if (!next.programs[key].formats[format]?.danceStyles.includes(style)) next = toggleFormatStyle(next, profile, key, format, style);
    }
    const definition = profile.categoryTypes[format];
    if (!definition.uses_dances || (next.programs[key].formats[format]?.dances.length ?? 0) > 0) continue;
    const options = formatDanceOptions(profile, key, next.programs[key], format).map((dance) => dance.key);
    let dances = TEST_DANCES[key].filter((dance) => options.includes(dance));
    if (definition.dance_selection_mode === "prescribed_set") dances = dances.slice(0, 1);
    next = updateFormat(next, key, format, { dances });
  }
  return next;
}
