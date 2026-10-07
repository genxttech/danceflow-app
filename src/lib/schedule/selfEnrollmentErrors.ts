/*
  Shared classification of self_enroll_class_attendee's bounded database
  messages (gc3d + GC-3.4C) for the portal and the public class flow, so both
  surfaces translate the same outcome the same way and never show raw
  database text.
*/

export type SelfEnrollmentErrorKind =
  | "already_enrolled"
  | "unavailable"
  | "no_funding"
  | "choose_funding"
  | "funding_changed"
  | "full"
  | "cancelled"
  | "started"
  | "not_authorized"
  | "not_found"
  | "failed";

const MESSAGES: Record<SelfEnrollmentErrorKind, string> = {
  already_enrolled: "You are already enrolled in this class.",
  unavailable: "Online enrollment isn't available for this class.",
  no_funding: "You don't currently have an eligible package or membership for this class.",
  choose_funding: "Choose a funding source to join this class.",
  funding_changed: "That funding source is no longer eligible for this class. Choose another.",
  full: "This class is full.",
  cancelled: "This class has been cancelled.",
  started: "This class has already started and can no longer be joined online.",
  not_authorized: "You're not authorized to enroll this client in this class.",
  not_found: "This class could not be found.",
  failed: "Could not join this class. Try again.",
};

export function classifySelfEnrollmentError(message: string | null | undefined): SelfEnrollmentErrorKind {
  const text = message ?? "";
  if (text.includes("already enrolled")) return "already_enrolled";
  // GC-3.4C: self-service enrollment closes when the class starts.
  if (text.includes("GC34C_CLASS_STARTED")) return "started";
  if (text.includes("not open for self-enrollment")) return "unavailable";
  if (text.includes("No eligible package or membership")) return "no_funding";
  if (text.includes("single funding source choice is required")) return "choose_funding";
  if (text.includes("is not an eligible funding source")) return "funding_changed";
  if (text.includes("no available seats remaining")) return "full";
  // GC-S1C-3: the database refuses a booked enrollment into a cancelled class.
  if (text.includes("GCSC3_CLASS_CANCELLED")) return "cancelled";
  if (text.includes("Not authorized")) return "not_authorized";
  if (text.includes("not found")) return "not_found";
  return "failed";
}

export function selfEnrollmentErrorMessage(kind: SelfEnrollmentErrorKind) {
  return MESSAGES[kind];
}

export function isSelfEnrollmentErrorKind(value: unknown): value is SelfEnrollmentErrorKind {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(MESSAGES, value);
}
