import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Package Refund P0, Slice 2c-2 UI pre-commit fix: proves
 * PartialRefundReviewControls is actually rendered through the
 * progressive-disclosure QuickActionPanel wrapper, not always-expanded
 * inline content. This codebase has no component-rendering test
 * infrastructure at all (vitest.config.mts uses environment: "node", no
 * jsdom, no @testing-library/react, and `include` only matches
 * `src/**\/*.test.ts`) -- introducing one for a single component would be a
 * disproportionate scope expansion. A structural source assertion is the
 * smallest test that actually proves the wrapper is used, consistent with
 * this codebase's existing preference for testing logic/structure over
 * rendered DOM output.
 */

const componentSource = readFileSync(
  fileURLToPath(new URL("../PartialRefundReviewControls.tsx", import.meta.url)),
  "utf8",
);

describe("PartialRefundReviewControls -- progressive-disclosure wrapper", () => {
  it("imports QuickActionPanel, this billing tab's established disclosure component", () => {
    expect(componentSource).toMatch(/import QuickActionPanel from "@\/components\/ui\/QuickActionPanel"/);
  });

  it("actually renders <QuickActionPanel> around the review content, not just importing it unused", () => {
    expect(componentSource).toMatch(/<QuickActionPanel[\s\S]*?>/);
    expect(componentSource).toMatch(/<\/QuickActionPanel>/);
  });

  it("defaults the panel open -- this component only ever renders when there is real pending_review content to act on", () => {
    const panelOpenTag = componentSource.match(/<QuickActionPanel[\s\S]*?>/)?.[0] ?? "";
    expect(panelOpenTag).toMatch(/defaultOpen/);
    // Explicitly not `defaultOpen={false}` or `defaultOpen={<falsy expression>}`.
    expect(panelOpenTag).not.toMatch(/defaultOpen=\{false\}/);
  });

  it("still preserves the explicit Apply and Decline controls inside the wrapper", () => {
    expect(componentSource).toMatch(/name="intent"\s+value="apply"/);
    expect(componentSource).toMatch(/name="intent"\s+value="decline"/);
  });

  it("still preserves the four distinct financial/reconciliation context fields inside the wrapper", () => {
    expect(componentSource).toMatch(/Refund amount/);
    expect(componentSource).toMatch(/Stripe refund status/);
    expect(componentSource).toMatch(/Package financial state/);
    expect(componentSource).toMatch(/Staff reconciliation state/);
  });
});
