import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Public Event Document-Checkpoint Remediation: the registration <details>
 * wrapping RegistrationForm must be open (not collapsed) whenever an
 * ?error= query param is present -- part of the "blank form, no visible
 * error" incident symptom (the form was collapsed by default with no `open`
 * attribute at all, so a returning user saw only the banner, not the form
 * or a retry path). This codebase has no component-rendering test
 * infrastructure (vitest.config.mts: environment "node", no jsdom/RTL,
 * `include` only matches src/**\/*.test.ts) -- a structural source
 * assertion is the smallest test that actually proves the fix, consistent
 * with this repo's existing precedent for this exact situation (see
 * PartialRefundReviewControls's own structural test).
 */

const pageSource = readFileSync(
  fileURLToPath(new URL("../page.tsx", import.meta.url)),
  "utf8",
);

describe("public event registration <details> -- open when an error is present", () => {
  it("sets open={Boolean(query.error)} on the registration disclosure element", () => {
    const detailsMatch = pageSource.match(
      /<details\s+className="group rounded-2xl[\s\S]*?>/,
    );
    expect(detailsMatch).not.toBeNull();
    expect(detailsMatch?.[0]).toMatch(/open=\{Boolean\(query\.error\)\}/);
  });
});
