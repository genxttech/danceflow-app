export const REWARD_TRIGGER_TYPES = [
  "referral_converted",
  "attendance_milestone",
  "membership_renewal",
  "intro_completed",
  "spend_milestone",
  "participation_milestone",
  "review_or_feedback_completed",
] as const;

export type RewardTriggerType = (typeof REWARD_TRIGGER_TYPES)[number];

export const REWARD_TYPES = [
  "points",
  "account_credit",
  "fixed_discount",
  "percent_discount",
  "free_class",
  "package_credit",
  "custom_perk",
] as const;

export type RewardType = (typeof REWARD_TYPES)[number];

export const REWARD_EVALUATION_WINDOWS = [
  "lifetime",
  "calendar_month",
  "calendar_year",
  "membership_period",
] as const;

export type RewardEvaluationWindow =
  (typeof REWARD_EVALUATION_WINDOWS)[number];

export type RewardTemplate = {
  key: string;
  name: string;
  description: string;
  triggerType: RewardTriggerType;
  thresholdValue: number;
  thresholdUnit: "count" | "currency";
  evaluationWindow: RewardEvaluationWindow;
  repeatable: boolean;
};

export const REWARD_RULE_TEMPLATES: RewardTemplate[] = [
  {
    key: "attendance_10",
    name: "10-visit milestone",
    description: "Reward a dancer after 10 attended lessons, classes, or eligible studio activities.",
    triggerType: "attendance_milestone",
    thresholdValue: 10,
    thresholdUnit: "count",
    evaluationWindow: "lifetime",
    repeatable: true,
  },
  {
    key: "referral_conversion",
    name: "Successful referral",
    description: "Reward a dancer when their referral becomes an active client.",
    triggerType: "referral_converted",
    thresholdValue: 1,
    thresholdUnit: "count",
    evaluationWindow: "lifetime",
    repeatable: true,
  },
  {
    key: "membership_renewal",
    name: "Membership renewal",
    description: "Reward a dancer for a completed membership renewal.",
    triggerType: "membership_renewal",
    thresholdValue: 1,
    thresholdUnit: "count",
    evaluationWindow: "membership_period",
    repeatable: true,
  },
  {
    key: "intro_completed",
    name: "Intro completed",
    description: "Recognize a dancer after completing their first eligible intro lesson.",
    triggerType: "intro_completed",
    thresholdValue: 1,
    thresholdUnit: "count",
    evaluationWindow: "lifetime",
    repeatable: false,
  },
  {
    key: "annual_spend",
    name: "Annual spend milestone",
    description: "Reward a dancer after reaching a studio-defined annual spend threshold.",
    triggerType: "spend_milestone",
    thresholdValue: 500,
    thresholdUnit: "currency",
    evaluationWindow: "calendar_year",
    repeatable: true,
  },
  {
    key: "participation_5",
    name: "Participation milestone",
    description: "Reward participation across eligible studio activities.",
    triggerType: "participation_milestone",
    thresholdValue: 5,
    thresholdUnit: "count",
    evaluationWindow: "calendar_month",
    repeatable: true,
  },
  {
    key: "feedback_completed",
    name: "Feedback completed",
    description:
      "Reward completion of an eligible feedback or review-request workflow. Eligibility must never depend on rating, sentiment, or a positive review.",
    triggerType: "review_or_feedback_completed",
    thresholdValue: 1,
    thresholdUnit: "count",
    evaluationWindow: "lifetime",
    repeatable: false,
  },
];

export function rewardTriggerLabel(value: RewardTriggerType) {
  if (value === "referral_converted") return "Referral converted";
  if (value === "attendance_milestone") return "Attendance milestone";
  if (value === "membership_renewal") return "Membership renewal";
  if (value === "intro_completed") return "Intro completed";
  if (value === "spend_milestone") return "Spending milestone";
  if (value === "participation_milestone") return "Participation milestone";
  return "Feedback or review workflow completed";
}

export function rewardTypeLabel(value: RewardType) {
  if (value === "points") return "Points";
  if (value === "account_credit") return "Account credit";
  if (value === "fixed_discount") return "Fixed discount";
  if (value === "percent_discount") return "Percent discount";
  if (value === "free_class") return "Free class";
  if (value === "package_credit") return "Bonus lesson / package credit";
  return "Studio-defined perk";
}
