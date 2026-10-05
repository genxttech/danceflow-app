/**
 * GC-S1E-2: pure wording and change detection for the "enrolled dancers will be notified" messaging on the class edit flows.
 * No server imports, so client components can use it.
 *
 * The count is the number of UNIQUE enrolled (booked) dancers in the classes the edit covers. A dancer in several of those
 * classes counts once, and the copy does not promise a particular channel (email, push or neither).
 */

export type ClassFormMaterialValues = {
  startsAt: string;
  endsAt: string;
  instructorId: string;
  roomId: string;
  locationName: string;
};

function norm(value: string | null | undefined) {
  return String(value ?? "").trim();
}

/** True when the form's date/time, instructor, room or location differs from what was loaded. Notes, capacity and the rest never count. */
export function classFormMaterialChanged(initial: ClassFormMaterialValues, current: ClassFormMaterialValues): boolean {
  return (
    norm(initial.startsAt) !== norm(current.startsAt) ||
    norm(initial.endsAt) !== norm(current.endsAt) ||
    norm(initial.instructorId) !== norm(current.instructorId) ||
    norm(initial.roomId) !== norm(current.roomId) ||
    norm(initial.locationName) !== norm(current.locationName)
  );
}

/** "N enrolled dancers will be notified about these changes." -- null when nobody is enrolled. */
export function dancersNotifiedLine(count: number): string | null {
  if (count <= 0) return null;
  return `${count} enrolled ${count === 1 ? "dancer" : "dancers"} will be notified about these changes.`;
}

/**
 * The single-class edit message. Before any material change it is a quiet standing hint; once the date/time, instructor or
 * room/location is being changed it states the consequence with the count. Null when nobody is enrolled.
 */
export function singleEditNoticeText(enrolledDancers: number, materialChanged: boolean): string | null {
  if (enrolledDancers <= 0) return null;
  if (materialChanged) return dancersNotifiedLine(enrolledDancers);
  return `Enrolled dancers (${enrolledDancers}) are notified automatically if you change the date or time, instructor, or room or location.`;
}
