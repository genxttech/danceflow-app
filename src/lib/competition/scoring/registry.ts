/**
 * Scoring-method REGISTRY (REG, Stage 4 decisions S4-1..S4-7; docs/competition/scoring-method-registry.md).
 *
 * A scoring method is chosen per division (optionally overridden per round) from this versioned, READ-ONLY registry.
 * Sanctioning, format, ballot format and result purpose are independent dimensions; this module only encodes the
 * scoring-method dimension and the compatibility it declares with the other three.
 *
 * Rules enforced here (and mirrored by the SQL registry table and its guard trigger):
 *  - Only `approved` methods can be resolved. draft / unavailable / rejected / unknown all fail closed.
 *  - Official methods are exact or unavailable: nothing here approximates UCWDC, NDCA or WSDC.
 *  - Engines are referenced by id only. Engine modules live under results/engines (owned by F1); this file never imports them.
 *  - Entries are frozen; a published version is never edited. A change is a new version.
 */

export type MethodStatus = "approved" | "draft" | "unavailable" | "rejected";

export type ResultPurpose = "feedback" | "placement" | "advancement";

export type PanelRuleId = "studio_x3" | "ucwdc_unverified" | "none_unverified";

export type RegistryFailureCode =
  | "COMP_METHOD_UNKNOWN"
  | "COMP_ENGINE_NOT_AVAILABLE"
  | "COMP_METHOD_BALLOT_FORMAT_MISMATCH"
  | "COMP_METHOD_PURPOSE_MISMATCH"
  | "COMP_PANEL_RULE_UNVERIFIED"
  | "COMP_PANEL_SIZE_INVALID"
  | "COMP_METHOD_LEGACY_UNMAPPED";

export type RegistryEntry = {
  key: string;
  /** Opaque version label. Studio methods use "1"; UCWDC uses its pinned edition label. */
  version: string;
  status: MethodStatus;
  label: string;
  /** Official sources the method is pinned to. Empty for studio methods (no governing body). */
  sourcePins: ReadonlyArray<{ document: string; sha256?: string; note?: string }>;
  /** Ballot format keys ("id@version", see ballots/formats.ts) this method accepts. */
  acceptedBallotFormats: readonly string[];
  resultPurposes: readonly ResultPurpose[];
  panelRule: PanelRuleId;
  /** Engine id implemented by F1 under results/engines. Null while no engine may exist. */
  engineId: string | null;
  /** Spec section holding the golden fixtures. Null when none are approved. */
  fixtureSet: string | null;
  /** Why the status is what it is (decision ids / pending questions). */
  statusReason: string;
};

const freeze = <T extends RegistryEntry>(e: T): Readonly<T> =>
  Object.freeze({
    ...e,
    sourcePins: Object.freeze(e.sourcePins.map((p) => Object.freeze({ ...p }))),
    acceptedBallotFormats: Object.freeze([...e.acceptedBallotFormats]),
    resultPurposes: Object.freeze([...e.resultPurposes]),
  });

export const SCORING_REGISTRY: readonly Readonly<RegistryEntry>[] = Object.freeze([
  freeze({
    key: "studio_callback_tally",
    version: "1",
    status: "approved",
    label: "Studio callback tally",
    sourcePins: [],
    acceptedBallotFormats: ["callback_yes@1"],
    resultPurposes: ["advancement"],
    panelRule: "studio_x3",
    engineId: "studio_callback_tally@1",
    fixtureSet: "engine-spec-callback-tally.md §9 (F-CT-*)",
    statusReason: "Approved Stage 2 (D-CT-1..10) and X-1..X-7. Studio method; carries no sanctioning claim.",
  }),
  freeze({
    key: "studio_ordinal_majority",
    version: "1",
    status: "approved",
    label: "Studio ordinal majority",
    sourcePins: [],
    acceptedBallotFormats: ["ordinal_rank@1"],
    resultPurposes: ["placement"],
    panelRule: "studio_x3",
    engineId: "studio_ordinal_majority@1",
    fixtureSet: "engine-spec-ordinal-majority.md §9 (F-OM-*)",
    statusReason: "Approved Stage 3 (D-OM-1..5, D-OM-3b) and X-1..X-7. Studio method; carries no sanctioning claim.",
  }),
  freeze({
    key: "ucwdc_majority_rules",
    version: "v16.9b",
    status: "unavailable",
    label: "UCWDC Majority Rules",
    sourcePins: [
      {
        document: "2026-Scoring-Format-v16.9b-1.pdf",
        sha256: "44290a06d14c308087039bce8d57258629ae103734cce08eb21f41bdb667b02f",
        note: "Pinned edition; a March 2026 edition is unconfirmed.",
      },
    ],
    acceptedBallotFormats: [],
    resultPurposes: [],
    panelRule: "ucwdc_unverified",
    engineId: null,
    fixtureSet: null,
    statusReason:
      "K1-U DRAFT. UNAVAILABLE pending UCWDC Q1-Q5 and independent verification (S4-5). Panel eligibility (Q4) unverified.",
  }),
  freeze({
    key: "proficiency_rating",
    version: "1",
    status: "rejected",
    label: "Proficiency rating (three-band)",
    sourcePins: [],
    acceptedBallotFormats: [],
    resultPurposes: [],
    panelRule: "none_unverified",
    engineId: null,
    fixtureSet: null,
    statusReason:
      "REJECTED as a universal studio method (Stage 4 §1.6). Key kept, not deleted, so existing rows stay fail-closed.",
  }),
  freeze({
    key: "ndca_skating",
    version: "unpinned",
    status: "unavailable",
    label: "NDCA Skating System",
    sourcePins: [],
    acceptedBallotFormats: [],
    resultPurposes: [],
    panelRule: "none_unverified",
    engineId: null,
    fixtureSet: null,
    statusReason: "No authoritative algorithm source. Placeholder only.",
  }),
  freeze({
    key: "wsdc_relative_placement",
    version: "unpinned",
    status: "unavailable",
    label: "WSDC Relative Placement",
    sourcePins: [],
    acceptedBallotFormats: [],
    resultPurposes: [],
    panelRule: "none_unverified",
    engineId: null,
    fixtureSet: null,
    statusReason: "No authoritative algorithm source. Placeholder only.",
  }),
]);

export function methodId(key: string, version: string): string {
  return `${key}@${version}`;
}

export function findMethod(key: string, version: string): Readonly<RegistryEntry> | null {
  return SCORING_REGISTRY.find((e) => e.key === key && e.version === version) ?? null;
}

/**
 * Legacy round/program `scoring_method` values (10B/10C.5) and the registry version each maps to. The mapping is explicit
 * and read-only (S4-7): nothing is rewritten in storage; a legacy value is only *interpreted* through this table.
 * Every legacy value not listed is unmapped and fails closed (including `majority_rules`, which is NOT UCWDC).
 */
export const LEGACY_SCORING_MAP: Readonly<Record<string, { key: string; version: string }>> = Object.freeze({
  ordinal_majority: { key: "studio_ordinal_majority", version: "1" },
  callback_tally: { key: "studio_callback_tally", version: "1" },
  proficiency_rating: { key: "proficiency_rating", version: "1" },
});

export type Fail = { ok: false; code: RegistryFailureCode; detail: string };
export type ResolveOk = { ok: true; entry: Readonly<RegistryEntry>; engineId: string };
export type ResolveResult = ResolveOk | Fail;

const fail = (code: RegistryFailureCode, detail: string): Fail => ({ ok: false, code, detail });

/** Resolves a method for use. Anything that is not `approved` (or has no engine id) is refused. */
export function resolveMethod(key: string, version: string): ResolveResult {
  const entry = findMethod(key, version);
  if (!entry) return fail("COMP_METHOD_UNKNOWN", `${methodId(key, version)} is not in the registry`);
  if (entry.status !== "approved" || !entry.engineId) {
    return fail("COMP_ENGINE_NOT_AVAILABLE", `${methodId(key, version)} is ${entry.status}: ${entry.statusReason}`);
  }
  return { ok: true, entry, engineId: entry.engineId };
}

/** Interprets a stored legacy `scoring_method` through the explicit map, then resolves it. Never rewrites storage. */
export function resolveLegacyScoringMethod(legacy: string): ResolveResult {
  const mapped = Object.hasOwn(LEGACY_SCORING_MAP, legacy) ? LEGACY_SCORING_MAP[legacy] : undefined;
  if (!mapped) return fail("COMP_METHOD_LEGACY_UNMAPPED", `legacy scoring_method '${legacy}' has no registry mapping`);
  return resolveMethod(mapped.key, mapped.version);
}

export type Selection = { key: string; version: string } | null | undefined;

/** Effective method for a round: round override, else division selection, else the explicit legacy map, else fail-closed. */
export function resolveRoundMethod(input: {
  roundOverride?: Selection;
  divisionSelection?: Selection;
  legacyScoringMethod?: string | null;
}): (ResolveOk & { source: "round_override" | "division" | "legacy_map" }) | Fail {
  const sel = input.roundOverride ?? input.divisionSelection ?? null;
  if (sel) {
    const r = resolveMethod(sel.key, sel.version);
    return r.ok ? { ...r, source: input.roundOverride ? "round_override" : "division" } : r;
  }
  if (!input.legacyScoringMethod) {
    return fail("COMP_METHOD_LEGACY_UNMAPPED", "no registry selection and no legacy scoring_method");
  }
  const r = resolveLegacyScoringMethod(input.legacyScoringMethod);
  return r.ok ? { ...r, source: "legacy_map" } : r;
}

/** Checks that the resolved method accepts the ballot format and result purpose a division asks for. */
export function checkCompatibility(
  entry: Readonly<RegistryEntry>,
  input: { ballotFormat: string; purpose: ResultPurpose },
): { ok: true } | Fail {
  if (!entry.acceptedBallotFormats.includes(input.ballotFormat)) {
    return fail("COMP_METHOD_BALLOT_FORMAT_MISMATCH", `${methodId(entry.key, entry.version)} does not accept ${input.ballotFormat}`);
  }
  if (!entry.resultPurposes.includes(input.purpose)) {
    return fail("COMP_METHOD_PURPOSE_MISMATCH", `${methodId(entry.key, entry.version)} does not produce ${input.purpose}`);
  }
  return { ok: true };
}

/**
 * Panel-size rule of a method. Studio X-3: at least 3 judges and an odd number. UCWDC panel eligibility (Q4) is
 * UNVERIFIED, so it refuses rather than guess; so does any method without a verified rule.
 */
export function checkPanelSize(entry: Readonly<RegistryEntry>, judgeCount: number): { ok: true } | Fail {
  switch (entry.panelRule) {
    case "studio_x3":
      if (!Number.isInteger(judgeCount) || judgeCount < 3 || judgeCount % 2 === 0) {
        return fail("COMP_PANEL_SIZE_INVALID", `X-3 requires an odd panel of at least 3 judges, got ${judgeCount}`);
      }
      return { ok: true };
    case "ucwdc_unverified":
    case "none_unverified":
      return fail("COMP_PANEL_RULE_UNVERIFIED", `${methodId(entry.key, entry.version)} has no verified panel rule`);
  }
}

/** Methods a manager may pick for a NEW configuration. Mirrors the SQL guard (status = approved). */
export function selectableMethods(): readonly Readonly<RegistryEntry>[] {
  return SCORING_REGISTRY.filter((e) => e.status === "approved" && e.engineId !== null);
}

// ---------------------------------------------------------------------------------------------------------------
// Sanctioning (S4-1, S4-2): a disclosure field independent of the method. "none" is the default and never implied.
// ---------------------------------------------------------------------------------------------------------------

export const SANCTIONING_VALUES = ["none", "ucwdc", "ndca", "wsdc", "other"] as const;
export type Sanctioning = (typeof SANCTIONING_VALUES)[number];

/**
 * Structured disclosure. `text` is PROVISIONAL: S4-2 wording is still open with the owner. The declaration is the
 * organizer's own claim; DanceFlow does not verify or imply a sanction, and selecting a method never changes it.
 */
export function sanctioningDisclosure(value: string | null | undefined): {
  declared: boolean;
  verifiedByDanceFlow: false;
  text: string;
} {
  const v = (SANCTIONING_VALUES as readonly string[]).includes(value ?? "") ? (value as Sanctioning) : "none";
  if (v === "none") return { declared: false, verifiedByDanceFlow: false, text: "Not sanctioned by any governing body." };
  const body = v === "other" ? "another organization" : v.toUpperCase();
  return {
    declared: true,
    verifiedByDanceFlow: false,
    text: `The organizer states this event is sanctioned by ${body}. DanceFlow has not verified this.`,
  };
}
