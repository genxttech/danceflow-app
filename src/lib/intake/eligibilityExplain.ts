import { RECONCILE_OUTCOMES, classifyOutcome, type OutcomeClass, type ReconcileOutcome } from "./reconcilePreview";

export type Tone = "positive" | "neutral" | "attention";

export type OutcomeExplanation = {
  /** Short label for a chip. */
  label: string;
  /** One plain sentence: what would happen. */
  summary: string;
  /** Why, in terms the studio can act on. */
  reason: string;
  /** What the studio can do about it, when there is something to do. */
  nextStep?: string;
  tone: Tone;
};

const EXPLANATIONS: Record<ReconcileOutcome, OutcomeExplanation> = {
  would_create: {
    label: "Qualifies",
    summary: "Would be asked to complete intake.",
    reason: "This is the student’s first qualifying lesson at your studio and the lesson type uses an intake template.",
    tone: "positive",
  },
  would_create_reintake: {
    label: "Qualifies (updated form)",
    summary: "Would be asked to complete the updated intake.",
    reason: "The student completed an older version of this form, and a newer version was required for lessons booked after it was published.",
    tone: "positive",
  },
  would_attach: {
    label: "Joins existing request",
    summary: "Would be added to an intake request that is already open.",
    reason: "The student already has an unfinished intake for this template, so no second form is created.",
    tone: "neutral",
  },
  detached_from_request: {
    label: "Removed from the request",
    summary: "Not added again.",
    reason: "This lesson was taken off the student’s intake request, so it is not added back automatically.",
    tone: "neutral",
  },
  already_attached: {
    label: "Already covered",
    summary: "Already linked to an open intake request.",
    reason: "This lesson is attached to the student’s open request.",
    tone: "neutral",
  },
  already_completed: {
    label: "Already completed",
    summary: "No new form needed.",
    reason: "The student already completed this intake, and the version they completed is still valid.",
    tone: "neutral",
  },
  settling: {
    label: "Waiting a few minutes",
    summary: "Will be evaluated shortly.",
    reason: "Newly booked lessons are checked a few minutes after booking so quick edits and cancellations settle first.",
    tone: "neutral",
  },
  earlier_appointment_pending: {
    label: "Earlier lesson comes first",
    summary: "Not asked separately.",
    reason: "The student has an earlier upcoming lesson. Intake is tied to their first qualifying lesson.",
    tone: "neutral",
  },
  no_template: {
    label: "No template set",
    summary: "Cannot qualify yet.",
    reason: "This lesson type has no active intake template and the studio has no usable default template.",
    nextStep: "Choose a default template or assign one to this lesson type.",
    tone: "attention",
  },
  no_published_version: {
    label: "Template not published",
    summary: "Cannot qualify yet.",
    reason: "The template for this lesson type has no published version, only drafts.",
    nextStep: "Publish the template.",
    tone: "attention",
  },
  studio_not_enabled: {
    label: "Intake is off",
    summary: "Not considered.",
    reason: "Student Intake is turned off for this studio.",
    nextStep: "Turn Student Intake on.",
    tone: "attention",
  },
  appointment_not_found: {
    label: "Not found",
    summary: "Not considered.",
    reason: "This appointment is no longer available for your studio.",
    tone: "neutral",
  },
  appointment_not_live: {
    label: "Not scheduled",
    summary: "Not considered.",
    reason: "Only scheduled, rescheduled or confirmed lessons qualify. Cancelled, attended and no-show lessons do not.",
    tone: "neutral",
  },
  studio_not_entitled: {
    label: "Not available yet",
    summary: "Not considered.",
    reason: "Student Intake has not been activated for this studio, so no lesson is asked for intake.",
    tone: "neutral",
  },
  type_not_selected: {
    label: "Lesson type not selected",
    summary: "Not asked.",
    reason: "Your studio has not chosen to ask for intake for this type of lesson. Having a default form does not select a lesson type.",
    nextStep: "Select this lesson type in the Student Intake settings.",
    tone: "neutral",
  },
  imported_source: {
    label: "Imported booking",
    summary: "Not asked automatically.",
    reason: "Bookings that came from an import or another system never start intake on their own.",
    nextStep: "Request intake manually for this student if you need it.",
    tone: "neutral",
  },
  appointment_started: {
    label: "Already started",
    summary: "Not considered.",
    reason: "Only future lessons qualify.",
    tone: "neutral",
  },
  before_enablement: {
    label: "Booked before intake began",
    summary: "Not asked automatically.",
    reason: "Intake applies only to lessons booked after Student Intake was turned on. Existing bookings are never back-filled.",
    nextStep: "Request intake manually for this student if you need it.",
    tone: "neutral",
  },
  erasure_barrier: {
    label: "Records erased",
    summary: "Not asked.",
    reason: "This student’s intake records were erased, so no new intake can be created for them.",
    tone: "neutral",
  },
  type_not_qualifying: {
    label: "Lesson type not covered",
    summary: "Not asked.",
    reason: "Only private lessons, intro lessons and coaching can use intake. Group classes and other appointment types are outside this version.",
    tone: "neutral",
  },
  predates_reintake_floor: {
    label: "Booked before the update",
    summary: "Not asked again.",
    reason: "This lesson was booked before the newer required version of the form was published, so the student is not asked to redo it.",
    tone: "neutral",
  },
  existing_student: {
    label: "Existing student",
    summary: "Not asked automatically.",
    reason: "The student already has a lesson on record, as a client or as a partner on a couple’s lesson, so this is not their first qualifying lesson.",
    nextStep: "Request intake manually for this student if you need it.",
    tone: "neutral",
  },
};

export function explainOutcome(outcome: ReconcileOutcome): OutcomeExplanation {
  return EXPLANATIONS[outcome];
}

export function explainedOutcomes(): ReconcileOutcome[] {
  return [...RECONCILE_OUTCOMES];
}

export const CLASS_HEADLINE: Record<OutcomeClass, string> = {
  would_create: "Would be asked for intake",
  would_attach: "Join an open request",
  already_satisfied: "Already covered",
  deferred: "Waiting",
  needs_configuration: "Needs setup",
  not_applicable: "Not asked",
};

export const QUALIFICATION_RULES: readonly string[] = [
  "Only lessons actually on the schedule count: scheduled, rescheduled or confirmed. Leads, inquiries and unbooked intro-lesson requests never start intake.",
  "Only private lessons, intro lessons and coaching can use intake. Group classes are not included in this version.",
  "Only lessons booked after Student Intake was turned on are considered. Nothing is back-filled, and imported bookings are never asked automatically.",
  "Each student is asked once, for their first qualifying lesson. A student who already has a lesson on record, including as a partner on a couple’s lesson, is treated as existing.",
  "A completed form stays valid. A newer required version only applies to lessons booked after it was published.",
];

export function outcomeClassOf(outcome: ReconcileOutcome): OutcomeClass {
  return classifyOutcome(outcome);
}
