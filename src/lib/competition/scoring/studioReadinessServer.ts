import type { createClient } from "@/lib/supabase/server";
import { callbackTargetMinimumReadiness, studioScoringReadiness, type CallbackTargetMinimumFinding, type EffectiveRow, type ScoringReadiness } from "./studioReadiness";

type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * Loads everything studioScoringReadiness needs for one event (manager session; RLS applies). Pins are read from the
 * append-only evidence table and joined to the live registry status, exactly as competition_round_scoring_effective does, so the
 * report never invents a pin: a round of a locked program with no pin row is reported as "not pinned".
 */
export async function loadStudioScoringReadiness(supabase: Supabase, eventId: string): Promise<ScoringReadiness> {
  const [programs, divisions, rounds, heats, pins, methods] = await Promise.all([
    supabase.from("event_competition_programs").select("id, name, status, profile_locked_at, advancement_method").eq("event_id", eventId),
    supabase.from("event_competition_divisions").select("id, program_id, name, scoring_method_key, scoring_method_version").eq("event_id", eventId).neq("status", "cancelled"),
    supabase.from("event_competition_rounds").select("id, division_id, name, round_type, scoring_method, status, scoring_override_key, scoring_override_version").eq("event_id", eventId),
    supabase.from("event_competition_heats").select("round_id, schedule_version_id").eq("event_id", eventId).neq("status", "cancelled"),
    supabase.from("event_competition_scoring_pins").select("round_id, method_key, method_version, registry_status").eq("event_id", eventId),
    supabase.from("competition_scoring_methods").select("method_key, method_version, status, engine_id"),
  ]);
  const error = programs.error || divisions.error || rounds.error || heats.error || pins.error || methods.error;
  if (error) throw new Error(`Could not check scoring readiness: ${error.message}`);

  // Heats belong to a schedule version: a round is one-heat or not WITHIN a version, so take the largest per-version count
  // (summing would flag a round that has one heat in each of two versions).
  const perVersion = new Map<string, Map<string, number>>();
  for (const heat of heats.data ?? []) {
    const versions = perVersion.get(heat.round_id) ?? new Map<string, number>();
    const version = String(heat.schedule_version_id ?? "");
    versions.set(version, (versions.get(version) ?? 0) + 1);
    perVersion.set(heat.round_id, versions);
  }
  const heatsByRound = new Map<string, number>([...perVersion].map(([round, versions]) => [round, Math.max(...versions.values())]));

  const methodByKey = new Map((methods.data ?? []).map((m) => [`${m.method_key}@${m.method_version}`, m]));
  const effective = new Map<string, EffectiveRow>();
  for (const pin of pins.data ?? []) {
    const live = pin.method_key ? methodByKey.get(`${pin.method_key}@${pin.method_version}`) : undefined;
    effective.set(pin.round_id, {
      method_key: pin.method_key,
      method_version: pin.method_version,
      pinned: true,
      registry_status: live?.status ?? pin.registry_status,
      selectable: !!live && live.status === "approved" && !!live.engine_id,
    });
  }

  return studioScoringReadiness({
    programs: programs.data ?? [],
    divisions: divisions.data ?? [],
    rounds: rounds.data ?? [],
    heatsByRound,
    effective,
  });
}

/** CF1 OD-21: existing callback targets below two on guarded rounds (read-only; the page shows them as a readiness refusal). */
export async function loadCallbackTargetMinimumFindings(supabase: Supabase, eventId: string): Promise<CallbackTargetMinimumFinding[]> {
  const [programs, divisions, rounds] = await Promise.all([
    supabase.from("event_competition_programs").select("id, advancement_method").eq("event_id", eventId),
    supabase.from("event_competition_divisions").select("id, program_id").eq("event_id", eventId),
    supabase.from("event_competition_rounds").select("id, division_id, name, round_type, sequence_number, target_advancement_count").eq("event_id", eventId).neq("status", "cancelled"),
  ]);
  const error = programs.error || divisions.error || rounds.error;
  if (error) throw new Error(`Could not check callback targets: ${error.message}`);
  const programByDivision = new Map((divisions.data ?? []).map((d) => [d.id as string, d.program_id as string | null]));
  const configured = (rounds.data ?? [])
    .filter((r) => programByDivision.get(r.division_id as string))
    .map((r) => ({ ...r, program_id: programByDivision.get(r.division_id as string) as string }));
  return callbackTargetMinimumReadiness({ rounds: configured, programs: programs.data ?? [] });
}
