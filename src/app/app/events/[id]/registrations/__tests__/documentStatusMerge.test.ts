import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Public Event Document-Checkpoint Remediation: getDocumentStatus() in the
 * Event Registrations dashboard must recognize a waiver as received via
 * EITHER of the two independent signing mechanisms in this codebase --
 * the older, synchronous document_signatures path (still used directly by
 * other flows, e.g. competition checkout) AND the newer DanceFlow Sign
 * envelope-based path (document_assignments.status === 'signed', used by
 * public event-cart checkout, only ever set by
 * sync_document_assignment_from_sign_envelope when the linked envelope
 * genuinely reaches 'completed'). This is what actually fixes the
 * confirmed dashboard-mismatch defect: a completed envelope-driven
 * signature was previously invisible to this page because it only ever
 * queried document_signatures.
 *
 * No component-rendering test infrastructure exists in this codebase for
 * Server Component pages this size (vitest.config.mts: environment "node",
 * no jsdom/RTL) -- a structural source assertion proves the merge is wired
 * up (not just imported/unused), consistent with this repo's established
 * precedent for this exact situation (see
 * PartialRefundReviewControlsStructure.test.ts).
 */

const pageSource = readFileSync(
  fileURLToPath(new URL("../page.tsx", import.meta.url)),
  "utf8",
);

describe("Event Registrations getDocumentStatus -- additive document_assignments source", () => {
  it("queries document_assignments filtered to status='signed', alongside the existing document_signatures query", () => {
    expect(pageSource).toMatch(/\.from\("document_assignments"\)/);
    expect(pageSource).toMatch(/\.eq\("status",\s*"signed"\)/);
    // The older mechanism's own query is preserved, not replaced.
    expect(pageSource).toMatch(/\.from\("document_signatures"\)/);
  });

  it("merges signed template ids from both sources when computing missingRequirements", () => {
    const getDocumentStatusMatch = pageSource.match(
      /const getDocumentStatus = \(registrationId: string\) => \{[\s\S]*?\n {2}\};/,
    );
    expect(getDocumentStatusMatch).not.toBeNull();
    const body = getDocumentStatusMatch?.[0] ?? "";

    expect(body).toMatch(/signaturesByRegistrationId\.get\(registrationId\)/);
    expect(body).toMatch(/signedAssignmentsByRegistrationId\.get\(registrationId\)/);
    // Both sources feed the same signedTemplateIds set -- an additive
    // union, not one replacing the other.
    expect(body).toMatch(/signatures\.map\(\(signature\) => signature\.template_id\)/);
    expect(body).toMatch(/signedAssignments\.map\(\(assignment\) => assignment\.template_id\)/);
  });

  it("checks documentAssignmentsError independently, never silently swallowing a failed query", () => {
    expect(pageSource).toMatch(/if \(documentAssignmentsError\)/);
  });
});
