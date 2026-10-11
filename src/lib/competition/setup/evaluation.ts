import type { FeedbackMode, FeedbackOutputType, JudgingDefinition, ResultOutput, SetupProfileDefaults } from "./types";

/**
 * 10C.5: official competitive results and evaluator feedback are separate outputs.
 *
 * - Official result outputs come only from an Adjudicated judging definition's scoring stages.
 * - Feedback outputs (critique text, grade, numeric score) are evaluation only, whatever the adjudication:
 *   they are never placements, rankings, advancement, medal thresholds or official results.
 *
 * Feedback entry is not built in 10C.5; this is the contract later critique work binds to.
 */

export type OfficialResultOutput = ResultOutput & { official: true };
export type FeedbackOutput = { type: FeedbackOutputType; official: false };

export function officialResultOutputs(judging: JudgingDefinition | undefined): OfficialResultOutput[] {
  if (!judging?.official_result) return [];
  return judging.scoring.stages
    .filter((stage) => stage.family !== "advancement")
    .flatMap((stage) => stage.outputs)
    .filter((output) => output.type !== "none")
    .map((output) => ({ ...output, official: true as const }));
}

/** Feedback modes available with this judging (Non-Adjudicated does not mean "no feedback"). */
export function feedbackModesFor(profile: SetupProfileDefaults, judgingKey: string): FeedbackMode[] {
  const allowed = profile.judging[judgingKey]?.feedback_modes ?? [];
  return profile.feedback.options.map((option) => option.key).filter((key) => allowed.includes(key));
}

export function feedbackOutputs(profile: SetupProfileDefaults, mode: FeedbackMode): FeedbackOutput[] {
  const option = profile.feedback.options.find((item) => item.key === mode);
  return (option?.outputs ?? []).map((type) => ({ type, official: false as const }));
}

/** Everything an offering produces, kept apart: official results vs evaluator feedback. */
export function offeringOutputs(profile: SetupProfileDefaults, judgingKey: string, feedback: FeedbackMode) {
  const judging = profile.judging[judgingKey];
  const mode = feedbackModesFor(profile, judgingKey).includes(feedback) ? feedback : "none";
  return { official: officialResultOutputs(judging), feedback: feedbackOutputs(profile, mode) };
}
