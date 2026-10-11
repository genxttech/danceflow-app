import { divisionScheme, toggleDivisionValue, type SetupAnswers } from "../draft";
import type { SetupProfileDefaults } from "../types";

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
