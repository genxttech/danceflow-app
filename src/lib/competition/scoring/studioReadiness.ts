/**
 * Studio scoring READINESS (SS1). Pure: reports, never writes.
 *
 * Severity rules (S4-7 "no silent rewrite"):
 *  - BLOCKER: something the organizer can still fix, or an anomaly that would give wrong results. Blocks publishing (draft
 *    programs) and heat planning (multi-heat ordinal rounds).
 *  - NOTICE: a locked/published competition, or a round that never asked for a registry method (Medal Marks "custom", and so
 *    on). Locked configurations are never rewritten; they stay fail-closed, so a notice says results cannot be calculated.
 * Callback targets (W4, callbackTarget.ts) are reported by their own readiness row and are not duplicated here.
 */

import { ballotFormatForScoring } from "../ballots/formats";
import { checkCompatibility, findMethod, methodId, resolveRoundMethod } from "./registry";
import { legacyValueFor } from "./studioSetup";

export type ReadinessProgram = { id: string; name: string; status: string; profile_locked_at: string | null; advancement_method?: string | null };
export type ReadinessDivision = { id: string; program_id: string | null; name: string; scoring_method_key: string | null; scoring_method_version: string | null };
export type ReadinessRound = {
  id: string;
  division_id: string;
  name: string;
  round_type: string;
  scoring_method: string;
  status: string;
  scoring_override_key: string | null;
  scoring_override_version: string | null;
};
/** competition_round_scoring_effective rows (managers only), for rounds of locked programs. */
export type EffectiveRow = { method_key: string | null; method_version: string | null; selectable: boolean; pinned: boolean; registry_status: string | null };

export type ScoringFindingCode =
  | "COMP_ENGINE_NOT_AVAILABLE"
  | "COMP_METHOD_UNKNOWN"
  | "COMP_SCORING_LEGACY_MISMATCH"
  | "COMP_METHOD_PURPOSE_MISMATCH"
  | "COMP_METHOD_BALLOT_FORMAT_MISMATCH"
  | "COMP_ORDINAL_MULTI_HEAT"
  | "COMP_SCORING_NOT_PINNED"
  | "COMP_SCORING_CALLBACK_CONFIG"
  | "COMP_SCORING_LOCKED_UNSUPPORTED"
  | "COMP_SCORING_NO_METHOD";

export type ScoringFinding = {
  severity: "blocker" | "notice";
  code: ScoringFindingCode;
  programId: string | null;
  divisionId: string;
  divisionName: string;
  roundId: string;
  roundName: string;
  detail: string;
};

export type ScoringReadiness = { blockers: ScoringFinding[]; notices: ScoringFinding[]; configuredRounds: number };

/** Legacy values that mean "this round is not scored" (no result is expected, so no method is required). */
const UNSCORED_LEGACY = new Set(["none", "feedback_only"]);

export function studioScoringReadiness(input: {
  programs: readonly ReadinessProgram[];
  divisions: readonly ReadinessDivision[];
  rounds: readonly ReadinessRound[];
  /** Heats per round (planned or operational). */
  heatsByRound: ReadonlyMap<string, number>;
  /** Effective/pinned rows keyed by round id (locked programs only). */
  effective?: ReadonlyMap<string, EffectiveRow>;
}): ScoringReadiness {
  const programById = new Map(input.programs.map((p) => [p.id, p]));
  const divisionById = new Map(input.divisions.map((d) => [d.id, d]));
  const out: ScoringReadiness = { blockers: [], notices: [], configuredRounds: 0 };

  for (const round of input.rounds) {
    if (round.status === "cancelled") continue;
    const division = divisionById.get(round.division_id);
    if (!division) continue;
    const program = division.program_id ? programById.get(division.program_id) : undefined;
    const locked = !!program && (program.profile_locked_at !== null || program.status !== "draft");
    const add = (severity: ScoringFinding["severity"], code: ScoringFindingCode, detail: string) =>
      out[severity === "blocker" ? "blockers" : "notices"].push({
        severity, code, programId: division.program_id, divisionId: division.id, divisionName: division.name, roundId: round.id, roundName: round.name, detail,
      });

    const explicit = !!(round.scoring_override_key || division.scoring_method_key);
    const live = resolveRoundMethod({
      roundOverride: round.scoring_override_key ? { key: round.scoring_override_key, version: round.scoring_override_version ?? "" } : null,
      divisionSelection: division.scoring_method_key ? { key: division.scoring_method_key, version: division.scoring_method_version ?? "" } : null,
      legacyScoringMethod: round.scoring_method,
    });

    if (!explicit && UNSCORED_LEGACY.has(round.scoring_method)) continue; // nothing to calculate

    if (!explicit && !live.ok) {
      // Never asked for a registry method (custom / Medal Marks / proficiency / governing-body labels): fail closed, not a blocker.
      add("notice", locked ? "COMP_SCORING_LOCKED_UNSUPPORTED" : "COMP_SCORING_NO_METHOD",
        locked
          ? `${round.name}: this competition was published before studio scoring methods existed or without one, so results cannot be calculated for this round. Published scoring is never rewritten.`
          : `${round.name}: no approved scoring method is selected (${round.scoring_method}), so results cannot be calculated. Use Studio scoring on this division.`);
      continue;
    }

    out.configuredRounds += 1;
    const eff = locked ? input.effective?.get(round.id) : undefined;
    // For a locked program the pin is the truth F2 calculates with; live columns can still be edited, so compare against the pin.
    let methodKey: string | null = live.ok ? live.entry.key : null;
    let methodVersion: string | null = live.ok ? live.entry.version : null;
    if (locked) {
      if (!eff || !eff.pinned) {
        add("notice", "COMP_SCORING_NOT_PINNED", `${round.name}: no scoring pin was recorded when this competition was published, so results cannot be calculated. Published scoring is never rewritten.`);
        continue;
      }
      if (!eff.selectable) {
        add("notice", "COMP_ENGINE_NOT_AVAILABLE", `${round.name}: the pinned method ${eff.method_key ? methodId(eff.method_key, eff.method_version ?? "") : "(none)"} is ${eff.registry_status ?? "unavailable"}, so results cannot be calculated.`);
        continue;
      }
      methodKey = eff.method_key;
      methodVersion = eff.method_version;
    } else if (!live.ok) {
      add("blocker", live.code === "COMP_METHOD_UNKNOWN" ? "COMP_METHOD_UNKNOWN" : "COMP_ENGINE_NOT_AVAILABLE", `${round.name}: ${live.detail}`);
      continue;
    }

    const entry = methodKey && methodVersion ? findMethod(methodKey, methodVersion) : null;
    if (!entry) continue;
    const severity: ScoringFinding["severity"] = "blocker"; // anomalies below are blockers on locked programs too (wrong results)

    const expectedLegacy = legacyValueFor(entry.key, entry.version);
    if (expectedLegacy !== round.scoring_method) {
      add(severity, "COMP_SCORING_LEGACY_MISMATCH",
        `${round.name}: the ballot format follows the round's scoring value (${round.scoring_method}) but the selected method is ${methodId(entry.key, entry.version)}. ${locked ? "This competition is published and cannot be changed; contact support before scoring it." : "Re-apply Studio scoring on this division."}`);
    } else {
      const format = ballotFormatForScoring(round.scoring_method);
      const formatKey = format ? `${format.id}@${format.version}` : "";
      const purpose = round.round_type === "final" ? "placement" : "advancement";
      const compat = checkCompatibility(entry, { ballotFormat: formatKey, purpose });
      if (!compat.ok) {
        add(severity, compat.code === "COMP_METHOD_BALLOT_FORMAT_MISMATCH" ? "COMP_METHOD_BALLOT_FORMAT_MISMATCH" : "COMP_METHOD_PURPOSE_MISMATCH",
          `${round.name}: ${methodId(entry.key, entry.version)} cannot score a ${round.round_type === "final" ? "Final (placements)" : "non-final round (advancement)"}.`);
      }
    }

    // The callback engine only accepts a preliminary round of a program whose advancement_method is promote_callback (F1 V2 /
    // F2 reads the program row). A draft can be fixed (blocker); a published program is never rewritten (notice).
    if (entry.key === "studio_callback_tally" && (round.round_type !== "preliminary" || program?.advancement_method !== "promote_callback")) {
      add(locked ? "notice" : "blocker", "COMP_SCORING_CALLBACK_CONFIG",
        `${round.name}: the callback tally needs a preliminary round in a competition whose advancement is "promote callback", otherwise results cannot be calculated. ${locked ? "This competition is published and is not rewritten." : "Re-apply Studio scoring on this division."}`);
    }

    // Ordinal majority is a single-heat method by spec (X-7): a multi-heat round fails closed.
    if (entry.key === "studio_ordinal_majority" && (input.heatsByRound.get(round.id) ?? 0) > 1) {
      add("blocker", "COMP_ORDINAL_MULTI_HEAT", `${round.name} has ${input.heatsByRound.get(round.id)} heats. Ordinal majority scores one heat only; increase the floor capacity or lower the callback target so the Final fits one heat, then regenerate the heats.`);
    }
  }
  return out;
}

/** Blockers that stop a program from being published (heats do not exist yet, so only configuration problems appear). */
export function publishScoringBlockers(report: ScoringReadiness, programId: string): ScoringFinding[] {
  return report.blockers.filter((f) => f.programId === programId);
}
