import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * BR-3B2 defect E: `getAriaExecutionEmail()` correctly computes shell-branded HTML, but the two
 * "insert a brand-new outbound_deliveries row" branches were discarding it -- one hardcoded `body_html:
 * null`, the other substituted a bare `renderPlainTextAsHtml(bodyText)` fragment. Both now persist the
 * already-computed `bodyHtml` variable, matching the "update an existing draft" branch that was already
 * correct. This is a source-level characterization test (not a full DB-mocked execution test) because the
 * fix is a two-line persistence change, not a content-generation change -- the actual email content
 * (studioName/firstName/portalUrl/etc.) is unchanged and out of scope for this defect.
 */
const source = readFileSync(
  join(process.cwd(), "src/app/app/automations/actions.ts"),
  "utf8",
);

// The two "insert a brand-new outbound_deliveries row" branches (one per execution entry point) are
// uniquely identifiable by their `dedupe_key: getAriaExecutionDedupeKey(...)` call -- the "update an
// existing draft" branches and the unrelated draft-creation/draft-editing paths never call it.
const INSERT_BRANCH_PATTERN =
  /body_text:\s*bodyText,\s*\n\s*body_html:\s*([\w().]+),\s*\n\s*related_table:\s*"automation_actions",\s*\n\s*related_id:\s*action\.id,\s*\n\s*dedupe_key:\s*getAriaExecutionDedupeKey/g;

function insertBranchBodyHtmlValues(): string[] {
  return Array.from(source.matchAll(INSERT_BRANCH_PATTERN)).map((match) => match[1]);
}

describe("automation execution email persistence (BR-3B2 defect E)", () => {
  it("finds both aria_execution 'insert new delivery' branches", () => {
    expect(insertBranchBodyHtmlValues().length).toBe(2);
  });

  it("neither insert branch hardcodes body_html: null", () => {
    for (const value of insertBranchBodyHtmlValues()) {
      expect(value).not.toBe("null");
    }
  });

  it("neither insert branch substitutes the bare renderPlainTextAsHtml(bodyText) fragment", () => {
    for (const value of insertBranchBodyHtmlValues()) {
      expect(value).not.toBe("renderPlainTextAsHtml(bodyText)");
    }
  });

  it("both insert branches persist the already-computed bodyHtml variable", () => {
    for (const value of insertBranchBodyHtmlValues()) {
      expect(value).toBe("bodyHtml");
    }
  });

  it("matches the already-correct 'update existing draft' branches (same body_html value)", () => {
    const updateBranchMatches = Array.from(
      source.matchAll(/status:\s*"queued",\s*\n\s*subject,\s*\n\s*body_text:\s*bodyText,\s*\n\s*body_html:\s*([\w().]+),\s*\n\s*updated_at:\s*now,/g),
    );
    expect(updateBranchMatches.length).toBe(2);
    for (const match of updateBranchMatches) {
      expect(match[1]).toBe("bodyHtml");
    }
  });
});

describe("automation draft-preview characterization stays green (deliberate exclusion, BR-3B2 finding F)", () => {
  it("ClientCommunicationWorkspace.tsx still never reads delivery body_html/body_text", () => {
    const workspaceSource = readFileSync(
      join(process.cwd(), "src/app/app/clients/[id]/ClientCommunicationWorkspace.tsx"),
      "utf8",
    );
    expect(workspaceSource).not.toContain("body_html");
    expect(workspaceSource).not.toContain(".body_text");
  });

  it("automations/drafts/page.tsx still only reads/edits body_text, never body_html", () => {
    const draftsPageSource = readFileSync(
      join(process.cwd(), "src/app/app/automations/drafts/page.tsx"),
      "utf8",
    );
    expect(draftsPageSource).not.toContain("body_html");
    expect(draftsPageSource).not.toContain("dangerouslySetInnerHTML");
    expect(draftsPageSource).toContain("body_text");
  });

  it("renderAutomationEmailDraft's own draft-only body_html remains a deliberately unmigrated bare fragment", () => {
    // Confirms the deliberate exclusion: the draft-creation path was intentionally left alone because
    // nothing reads its body_html and it is fully overwritten by getAriaExecutionEmail's correct output
    // before any real send. If this ever changes, the exclusion should be revisited, not silently kept.
    expect(source).toMatch(/bodyHtml:\s*renderPlainTextAsHtml\(bodyText\),\s*\n\s*\};\s*\n\}/);
  });
});
