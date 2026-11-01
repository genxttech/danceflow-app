/**
 * CF1 A7 / OD-13: read model for a judge-entry correction's co-sign (competition_round_correction).
 * Nothing here decides anything: the RPC cosign_competition_correction is the authority (role, verified email, different person from the
 * opener, no replacement filer). This only works out which line to show.
 */
export type CorrectionCosign = { id: string; cosignedBy: string; role: string; at: string };
export type CorrectionState = {
  correctionOpen: boolean;
  causeId: string | null;
  cause: "judge_entry_error" | "entry_exclusion" | null;
  openedBy: string | null;
  restricted: boolean;
  cosign: CorrectionCosign | null;
};

const EMPTY: CorrectionState = { correctionOpen: false, causeId: null, cause: null, openedBy: null, restricted: false, cosign: null };

export function parseCorrectionState(raw: unknown): CorrectionState {
  const r = raw as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== "object") return EMPTY;
  const cause = r.cause as Record<string, unknown> | null | undefined;
  const cos = r.cosign as Record<string, unknown> | null | undefined;
  const kind = cause && (cause.cause === "judge_entry_error" || cause.cause === "entry_exclusion") ? cause.cause : null;
  return {
    correctionOpen: r.correction_open === true,
    causeId: cause && typeof cause.id === "string" ? cause.id : null,
    cause: kind,
    openedBy: cause && typeof cause.opened_by === "string" ? cause.opened_by : null,
    restricted: r.restricted === true,
    cosign:
      cos && typeof cos.id === "string" && typeof cos.cosigned_by === "string"
        ? { id: cos.id, cosignedBy: cos.cosigned_by, role: typeof cos.role === "string" ? cos.role : "", at: typeof cos.at === "string" ? cos.at : "" }
        : null,
  };
}

export type CorrectionCosignPanel =
  | { kind: "hidden" }
  | { kind: "waiting"; text: string }
  | { kind: "can_cosign"; causeId: string }
  | { kind: "cosigned"; text: string };

export const WAITING_FOR_COSIGN_TEXT = "Waiting for a different manager or chair to co-sign";

export function roleLabel(role: string): string {
  return role === "chair" ? "chair" : role === "manager" ? "manager" : role || "official";
}

/** Shown only for an open judge-entry correction (an exclusion-limited correction takes no co-sign). */
export function correctionCosignPanel(state: CorrectionState, viewerId: string): CorrectionCosignPanel {
  if (!state.correctionOpen || state.cause !== "judge_entry_error" || !state.causeId || state.restricted) return { kind: "hidden" };
  if (state.cosign) {
    const who = state.cosign.cosignedBy === viewerId ? "you" : "a different person";
    return { kind: "cosigned", text: `Correction co-signed by ${who}, as ${roleLabel(state.cosign.role)}. Replacement ballots can now be filed.` };
  }
  if (state.openedBy === viewerId) return { kind: "waiting", text: WAITING_FOR_COSIGN_TEXT };
  return { kind: "can_cosign", causeId: state.causeId };
}
