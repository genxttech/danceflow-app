import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * BR-3D2b1: proves the new "Download signed document" action in the portal
 * Documents page is (a) only reachable from the already-signed branch, (b)
 * gated on `item.assignment?.sign_envelope_id` so legacy `document_signatures`
 * -only records (no envelope, no signed PDF) never render it, and (c) never
 * rendered for pending/unsigned items.
 *
 * This codebase has no component-rendering harness suited to a single
 * additive conditional like this one -- the established proportionate
 * precedent for exactly this situation is a structural source assertion
 * (see PartialRefundReviewControlsStructure.test.ts), rather than
 * introducing a new full-page render seam for one link.
 */

const pageSource = readFileSync(
  fileURLToPath(new URL("../page.tsx", import.meta.url)),
  "utf8",
);

function extractBlock(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("portal documents page -- signed-document download link (BR-3D2b1)", () => {
  const signedBlock = extractBlock(
    pageSource,
    "{item.isSigned ? (",
    ") : item.assignment?.sign_envelope_id ? (",
  );

  it("renders the download link only inside the already-signed branch, gated on sign_envelope_id", () => {
    expect(signedBlock).toContain("item.assignment?.sign_envelope_id ? (");
    expect(signedBlock).toMatch(/Download signed document/);
  });

  it("links to the new authenticated portal signed-download route with studio/assignment/client scoping", () => {
    expect(signedBlock).toMatch(
      /\/portal\/\$\{encodeURIComponent\(\s*typedStudio\.slug,?\s*\)\}\/documents\/\$\{encodeURIComponent\(\s*item\.assignment\.id,?\s*\)\}\/signed\?client=\$\{encodeURIComponent\(typedClient\.id\)\}/,
    );
  });

  it("does not embed a public signing token in the link", () => {
    expect(signedBlock).not.toMatch(/\/sign\/\$\{/);
    expect(signedBlock).not.toMatch(/token/i);
  });

  it("preserves the existing signer/completion text unchanged", () => {
    expect(signedBlock).toContain("Signature recorded");
    expect(signedBlock).toMatch(/Signed by \{item\.signature\?\.signer_name/);
  });

  it("the pending/unsigned branch (sign_envelope_id present, not yet signed) does not contain the download link", () => {
    const pendingBlock = extractBlock(
      pageSource,
      ") : item.assignment?.sign_envelope_id ? (",
      "renderDocumentCard",
    );
    expect(pendingBlock).not.toMatch(/Download signed document/);
  });

  it("the legacy typed-signature (no sign_envelope_id) branch does not contain the download link", () => {
    const legacyBlock = extractBlock(
      pageSource,
      "<form action={signPortalDocumentAction}",
      "This older document uses DanceFlow's legacy typed-signature flow.",
    );
    expect(legacyBlock).not.toMatch(/Download signed document/);
  });
});
