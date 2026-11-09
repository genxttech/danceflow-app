import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findTransition, RESULT_EVENT_KINDS, RESULT_READER_MATRIX } from "../contract";
import { resultErrorMessage } from "../messages";
import { parsePublications, parseVisibility, publicationControls, type PublicationRecord } from "../publication";

const root = join(__dirname, "..", "..", "..", "..", "..");
const actions = readFileSync(join(root, "src", "app", "app", "events", "[id]", "competition", "results", "actions.ts"), "utf8");
const page = readFileSync(join(root, "src", "app", "app", "events", "[id]", "competition", "results", "[roundId]", "page.tsx"), "utf8");
const migration = readFileSync(join(root, "src", "lib", "supabase", "migrations", "20270122090000_competition_f3_publication.sql"), "utf8");

const V1 = "00000000-0000-0000-0000-0000000000a1";
const V2 = "00000000-0000-0000-0000-0000000000a2";
const P1 = "00000000-0000-0000-0000-0000000000b1";

function pub(over: Partial<PublicationRecord> = {}): PublicationRecord {
  return {
    id: P1,
    publicationVersion: 1,
    resultVersionId: V1,
    visibility: "entrants",
    publishedAt: "2027-01-01T00:00:00Z",
    withdrawnAt: null,
    withdrawnReason: null,
    state: "current",
    ...over,
  };
}
const base = {
  isManager: true,
  roundStatus: "approved",
  latestVersion: { id: V1, status: "approved", stale: false },
  unresolvedTie: false,
  publications: [] as PublicationRecord[],
};

describe("F3 contract alignment", () => {
  it("the K0 edge approved -> published is owned by publish_competition_round_result (manager only)", () => {
    const t = findTransition("approved", "published");
    expect(t?.rpc).toBe("publish_competition_round_result");
    expect(t?.actors).toEqual(["manager"]);
  });
  it("the three F3 audit kinds are in the contract and in the migration kind check", () => {
    for (const kind of ["result_published", "result_superseded", "result_withdrawn"]) {
      expect(RESULT_EVENT_KINDS).toContain(kind);
      expect(migration).toContain(`'${kind}'`);
    }
  });
  it("non-managers never read an unpublished or withdrawn result (reader matrix)", () => {
    for (const reader of ["entrant", "public", "other_tenant", "assigned_judge"] as const) {
      expect(RESULT_READER_MATRIX[reader].unpublished_result).toBe("none");
      expect(RESULT_READER_MATRIX[reader].published_superseded_or_withdrawn).toBe("none");
    }
  });
});

describe("F3 visibility and history parsing", () => {
  it("accepts only entrants or public and never defaults to public", () => {
    expect(parseVisibility("entrants")).toBe("entrants");
    expect(parseVisibility(" public ")).toBe("public");
    for (const bad of ["", "PUBLIC", "all", null, undefined, 1]) expect(parseVisibility(bad)).toBeNull();
  });
  it("drops malformed rows and orders newest first", () => {
    const rows = parsePublications([
      { id: P1, publication_version: 1, result_version_id: V1, visibility: "entrants", state: "superseded", published_at: "x" },
      { id: "b2", publication_version: 2, result_version_id: V2, visibility: "public", state: "current", published_at: "y" },
      { id: "bad", publication_version: "3", result_version_id: V2, visibility: "public", state: "current" },
      { id: "bad2", publication_version: 3, result_version_id: V2, visibility: "everyone", state: "current" },
      null,
    ]);
    expect(rows.map((r) => r.publicationVersion)).toEqual([2, 1]);
    expect(parsePublications("nope")).toEqual([]);
  });
});

describe("F3 controls", () => {
  it("offers publish for an approved, fresh, resolved latest version", () => {
    const c = publicationControls(base);
    expect(c.publishVersionId).toBe(V1);
    expect(c.publishBlockedReason).toBeNull();
    expect(c.withdrawPublicationId).toBeNull();
  });
  it("offers nothing to a non-manager", () => {
    const c = publicationControls({ ...base, isManager: false, publications: [pub()] });
    expect(c.publishVersionId).toBeNull();
    expect(c.withdrawPublicationId).toBeNull();
  });
  it("blocks publish with a reason for a stale version, an undecided tie, a not-approved version or an already published version", () => {
    expect(publicationControls({ ...base, latestVersion: { id: V1, status: "approved", stale: true } }).publishBlockedReason).toMatch(/ballots changed/);
    expect(publicationControls({ ...base, unresolvedTie: true }).publishBlockedReason).toMatch(/tie/);
    expect(publicationControls({ ...base, latestVersion: { id: V1, status: "calculated", stale: false } }).publishVersionId).toBeNull();
    const used = publicationControls({ ...base, publications: [pub({ state: "withdrawn", withdrawnAt: "z", withdrawnReason: "r" })] });
    expect(used.publishBlockedReason).toMatch(/already published/);
    expect(used.publishVersionId).toBeNull();
  });
  it("offers no publish unless the round is approved", () => {
    for (const roundStatus of ["calculated", "ballots_locked", "published", "complete", "active"]) {
      expect(publicationControls({ ...base, roundStatus }).publishVersionId).toBeNull();
    }
  });
  it("offers withdraw only for the current publication and only while published, complete or in correction", () => {
    for (const roundStatus of ["published", "complete", "ballots_locked", "calculated", "approved"]) {
      expect(publicationControls({ ...base, roundStatus, publications: [pub()] }).withdrawPublicationId).toBe(P1);
    }
    for (const roundStatus of ["active", "scheduled", "cancelled"]) {
      expect(publicationControls({ ...base, roundStatus, publications: [pub()] }).withdrawPublicationId).toBeNull();
    }
    expect(publicationControls({ ...base, roundStatus: "complete", isManager: false, publications: [pub()] }).withdrawPublicationId).toBeNull();
    expect(publicationControls({ ...base, roundStatus: "complete", publications: [pub({ state: "withdrawn", withdrawnAt: "z" })] }).withdrawPublicationId).toBeNull();
    const withdrawn = pub({ state: "withdrawn", withdrawnAt: "z" });
    expect(publicationControls({ ...base, roundStatus: "published", publications: [withdrawn] }).withdrawPublicationId).toBeNull();
  });
  it("a withdrawn publication with no replacement points at the correction route, never an un-withdraw", () => {
    const c = publicationControls({
      ...base,
      roundStatus: "published",
      publications: [pub({ state: "withdrawn", withdrawnAt: "z", withdrawnReason: "typo" })],
    });
    expect(c.needsCorrection).toBe(true);
    expect(c.publishVersionId).toBeNull();
  });
});

describe("F3 copy and wiring", () => {
  it("every publication refusal has plain copy", () => {
    for (const code of [
      "COMP_PUBLICATION_VISIBILITY",
      "COMP_PUBLICATION_UNRESOLVED",
      "COMP_PUBLICATION_BLOCKED_BY_EXCEPTION",
      "COMP_PUBLICATION_VERSION_USED",
      "COMP_PUBLICATION_NOT_CURRENT",
      "COMP_PUBLICATION_REQUIRES_APPROVAL",
    ]) {
      const text = resultErrorMessage(code);
      expect(text).not.toMatch(/could not be done/);
      expect(text).not.toMatch(/COMP_/);
    }
  });
  it("actions call the RPCs by contract name and argument name, with a request id", () => {
    expect(actions).toContain('"publish_competition_round_result"');
    expect(actions).toMatch(/p_round_id: roundId,\s*p_result_version_id: versionId,\s*p_visibility: visibility,\s*p_request_id: requestId/);
    expect(actions).toContain('"withdraw_competition_round_result"');
    expect(actions).toMatch(/p_publication_id: publicationId,\s*p_reason: text\(formData, "reason"\),\s*p_request_id: requestId/);
    expect(actions).toMatch(/if \(!visibility\) back\(returnTo/);
  });
  it("the page offers publish and withdraw only through the F3 helpers and never defaults the radio to public", () => {
    expect(page).toContain("publicationControls(");
    expect(page).toContain("publishRoundResultAction");
    expect(page).toContain("withdrawRoundResultAction");
    expect(page).toMatch(/value="entrants" defaultChecked/);
    expect(page).not.toMatch(/value="public" defaultChecked/);
  });
  it("the migration grants only the two public readers to anon", () => {
    const anon = [...migration.matchAll(/grant execute on function public\.(\w+)\([^)]*\) to ([^;]+);/g)]
      .filter((m) => /\banon\b/.test(m[2]))
      .map((m) => m[1]);
    expect(anon.sort()).toEqual(["competition_event_results_public", "competition_round_results_public"]);
  });
});
