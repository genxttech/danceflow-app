import { describe, expect, it } from "vitest";
import {
  LEGACY_SCORING_MAP,
  SCORING_REGISTRY,
  checkCompatibility,
  checkPanelSize,
  findMethod,
  resolveLegacyScoringMethod,
  resolveMethod,
  resolveRoundMethod,
  sanctioningDisclosure,
  selectableMethods,
} from "../registry";

describe("registry contents", () => {
  it("has unique key@version pairs", () => {
    const ids = SCORING_REGISTRY.map((e) => `${e.key}@${e.version}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("approves exactly the two studio methods", () => {
    expect(
      SCORING_REGISTRY.filter((e) => e.status === "approved")
        .map((e) => `${e.key}@${e.version}`)
        .sort(),
    ).toEqual(["studio_callback_tally@1", "studio_ordinal_majority@1"]);
  });

  it("only approved entries carry an engine id and ballot formats", () => {
    for (const e of SCORING_REGISTRY) {
      if (e.status === "approved") {
        expect(e.engineId).not.toBeNull();
        expect(e.acceptedBallotFormats.length).toBeGreaterThan(0);
        expect(e.panelRule).toBe("studio_x3");
      } else {
        expect(e.engineId).toBeNull();
        expect(e.acceptedBallotFormats).toEqual([]);
        expect(e.resultPurposes).toEqual([]);
      }
    }
  });

  it("pins UCWDC to v16.9b as unavailable and rejects proficiency_rating", () => {
    expect(findMethod("ucwdc_majority_rules", "v16.9b")?.status).toBe("unavailable");
    expect(findMethod("ucwdc_majority_rules", "v16.9b")?.sourcePins[0]?.sha256).toMatch(/^44290a06/);
    expect(findMethod("proficiency_rating", "1")?.status).toBe("rejected");
    expect(findMethod("ndca_skating", "unpinned")?.status).toBe("unavailable");
    expect(findMethod("wsdc_relative_placement", "unpinned")?.status).toBe("unavailable");
  });

  it("is frozen", () => {
    const e = SCORING_REGISTRY[0];
    expect(Object.isFrozen(SCORING_REGISTRY)).toBe(true);
    expect(Object.isFrozen(e)).toBe(true);
    expect(() => {
      (e as { status: string }).status = "draft";
    }).toThrow();
    expect(() => (e.acceptedBallotFormats as string[]).push("x@1")).toThrow();
  });
});

describe("resolveMethod", () => {
  it("resolves approved studio methods to engine ids", () => {
    const a = resolveMethod("studio_ordinal_majority", "1");
    expect(a.ok && a.engineId).toBe("studio_ordinal_majority@1");
    const b = resolveMethod("studio_callback_tally", "1");
    expect(b.ok && b.engineId).toBe("studio_callback_tally@1");
  });

  it.each([
    ["ucwdc_majority_rules", "v16.9b"],
    ["proficiency_rating", "1"],
    ["ndca_skating", "unpinned"],
    ["wsdc_relative_placement", "unpinned"],
  ])("refuses %s@%s with COMP_ENGINE_NOT_AVAILABLE", (key, version) => {
    const r = resolveMethod(key, version);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("COMP_ENGINE_NOT_AVAILABLE");
  });

  it("refuses unknown keys and unknown versions of approved keys", () => {
    for (const [k, v] of [
      ["nope", "1"],
      ["studio_ordinal_majority", "2"],
      ["studio_ordinal_majority", ""],
      ["ucwdc_majority_rules", "1"],
    ]) {
      const r = resolveMethod(k, v);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("COMP_METHOD_UNKNOWN");
    }
  });

  it("selectableMethods lists only approved methods", () => {
    expect(selectableMethods().map((e) => e.key).sort()).toEqual(["studio_callback_tally", "studio_ordinal_majority"]);
  });
});

describe("legacy map (S4-7, no silent rewrite)", () => {
  it("maps the three 10B keys explicitly", () => {
    expect(LEGACY_SCORING_MAP.ordinal_majority).toEqual({ key: "studio_ordinal_majority", version: "1" });
    expect(LEGACY_SCORING_MAP.callback_tally).toEqual({ key: "studio_callback_tally", version: "1" });
    expect(LEGACY_SCORING_MAP.proficiency_rating).toEqual({ key: "proficiency_rating", version: "1" });
  });

  it("proficiency_rating legacy stays fail-closed", () => {
    const r = resolveLegacyScoringMethod("proficiency_rating");
    expect(!r.ok && r.code).toBe("COMP_ENGINE_NOT_AVAILABLE");
  });

  it.each(["majority_rules", "skating", "wsdc_callback", "relative_placement", "custom", "none", "feedback_only", "proficiency"])(
    "leaves legacy %s unmapped (never UCWDC/NDCA/WSDC)",
    (legacy) => {
      const r = resolveLegacyScoringMethod(legacy);
      expect(!r.ok && r.code).toBe("COMP_METHOD_LEGACY_UNMAPPED");
    },
  );
});

describe("resolveRoundMethod", () => {
  it("prefers round override, then division, then legacy", () => {
    const over = resolveRoundMethod({
      roundOverride: { key: "studio_callback_tally", version: "1" },
      divisionSelection: { key: "studio_ordinal_majority", version: "1" },
      legacyScoringMethod: "ordinal_majority",
    });
    expect(over.ok && over.source).toBe("round_override");
    expect(over.ok && over.entry.key).toBe("studio_callback_tally");

    const div = resolveRoundMethod({ divisionSelection: { key: "studio_ordinal_majority", version: "1" }, legacyScoringMethod: "callback_tally" });
    expect(div.ok && div.source).toBe("division");

    const legacy = resolveRoundMethod({ legacyScoringMethod: "callback_tally" });
    expect(legacy.ok && legacy.source).toBe("legacy_map");
  });

  it("does not fall through to a lower layer when a higher selection is unavailable", () => {
    const r = resolveRoundMethod({
      roundOverride: { key: "ucwdc_majority_rules", version: "v16.9b" },
      divisionSelection: { key: "studio_ordinal_majority", version: "1" },
      legacyScoringMethod: "ordinal_majority",
    });
    expect(!r.ok && r.code).toBe("COMP_ENGINE_NOT_AVAILABLE");
  });

  it("fails closed with nothing selected", () => {
    const r = resolveRoundMethod({});
    expect(!r.ok && r.code).toBe("COMP_METHOD_LEGACY_UNMAPPED");
  });
});

describe("compatibility and panel rule", () => {
  const ord = findMethod("studio_ordinal_majority", "1")!;
  const cb = findMethod("studio_callback_tally", "1")!;
  const uc = findMethod("ucwdc_majority_rules", "v16.9b")!;

  it("checks ballot format and purpose", () => {
    expect(checkCompatibility(ord, { ballotFormat: "ordinal_rank@1", purpose: "placement" })).toEqual({ ok: true });
    expect(checkCompatibility(cb, { ballotFormat: "callback_yes@1", purpose: "advancement" })).toEqual({ ok: true });
    const a = checkCompatibility(ord, { ballotFormat: "callback_yes@1", purpose: "placement" });
    expect(!a.ok && a.code).toBe("COMP_METHOD_BALLOT_FORMAT_MISMATCH");
    const b = checkCompatibility(ord, { ballotFormat: "ordinal_rank@1", purpose: "feedback" });
    expect(!b.ok && b.code).toBe("COMP_METHOD_PURPOSE_MISMATCH");
    const c = checkCompatibility(ord, { ballotFormat: "three_band@1", purpose: "placement" });
    expect(!c.ok && c.code).toBe("COMP_METHOD_BALLOT_FORMAT_MISMATCH");
  });

  it("studio X-3: at least 3 and odd", () => {
    for (const n of [3, 5, 7, 9]) expect(checkPanelSize(ord, n)).toEqual({ ok: true });
    for (const n of [0, 1, 2, 4, 6, -3, 2.5, Number.NaN]) {
      const r = checkPanelSize(cb, n);
      expect(!r.ok && r.code).toBe("COMP_PANEL_SIZE_INVALID");
    }
  });

  it("UCWDC panel rule is unverified and refuses every size", () => {
    for (const n of [1, 3, 5, 7]) {
      const r = checkPanelSize(uc, n);
      expect(!r.ok && r.code).toBe("COMP_PANEL_RULE_UNVERIFIED");
    }
  });
});

describe("sanctioning disclosure", () => {
  it("defaults to none and never implies a sanction", () => {
    for (const v of [undefined, null, "", "garbage"]) {
      const d = sanctioningDisclosure(v);
      expect(d.declared).toBe(false);
      expect(d.text).toMatch(/Not sanctioned/);
    }
  });

  it("a declared sanction is the organizer's claim, unverified, and independent of the method", () => {
    const d = sanctioningDisclosure("ucwdc");
    expect(d.declared).toBe(true);
    expect(d.verifiedByDanceFlow).toBe(false);
    expect(d.text).toMatch(/not verified/);
    // Declaring UCWDC does not make the UCWDC method available.
    expect(resolveMethod("ucwdc_majority_rules", "v16.9b").ok).toBe(false);
  });
});
