// Pure classification helpers for the import flow, deliberately kept out
// of actions.ts: that file has "use server" and every top-level export
// from a "use server" module must be an async Server Action (Next.js/
// Turbopack build-time requirement) -- these are plain synchronous
// functions, not actions, and must live in their own module to be
// exported (for direct unit testing) without breaking the build.

export function isBlockingErrorCode(errorCode: string) {
  return [
    "missing_required_field",
    "invalid_email",
    "duplicate_in_file",
    "ambiguous_existing_match",
    "duplicate_source_identity",
    "missing_header",
    "invalid_datetime",
    "missing_related_record",
    "invalid_amount",
    "execution_failed",
    // Landmark 1A Slice 5: a non-instructional/ambiguous source role must
    // block the row from being committed into `instructors` at all, not
    // merely warn after the fact -- see validateInstructorImportBatchAction.
    "staff_role_requires_review",
  ].includes(errorCode);
}

// Landmark 1A Slice 5: a source staff role is deterministically
// instructional only if it positively matches this allow-list. Anything
// else -- including an explicitly non-instructional title like "Front
// Desk" or "Studio Manager", and any genuinely ambiguous title -- falls
// into the same "requires review" bucket (see
// validateInstructorImportBatchAction), which is now blocking: the row
// is skipped, not imported as an instructor roster record.
export function isDeterministicallyInstructionalSourceRole(
  sourceRole: string,
): boolean {
  const normalizedRole = sourceRole.toLowerCase();
  return ["instructor", "teacher", "coach"].some((role) =>
    normalizedRole.includes(role),
  );
}
