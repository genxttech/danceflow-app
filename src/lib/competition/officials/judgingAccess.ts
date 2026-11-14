import "server-only";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth/platform";
import { getCurrentStudioRole } from "@/lib/auth/studio";

/**
 * OJ-1 (owner decision 2026-11-10): judging access for officials who are NOT studio staff (for example a user who is only on an organizer team).
 *
 * - Studio staff and platform admins keep the existing path unchanged: the studio layout renders and E2's round-keyed RPCs decide.
 * - Anyone else is an "official" viewer whose ONLY source of judging access is E1's my_competition_judging_assignments(): the caller's own
 *   assignments, active only (a revoked or ended assignment disappears at once), verified email, and still a team member of the event's studio or
 *   organizer. Organizer-team membership alone grants nothing.
 * - Event pages need an assignment for THAT event; ballot actions need a panel assignment for THAT round; desk pages and actions need the round-keyed
 *   desk RPC (E2 _compe2_round_role) to resolve the caller as chair or scorer, and a chair/scorer assignment. The database stays the authority:
 *   these checks only refuse earlier, never grant.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JUDGING_ROLES = new Set(["judge", "chair", "scorer"]);
const DESK_ROLES = new Set(["chair", "scorer"]);

export type JudgingAssignment = { event_id: string; official_role: string; round_id: string | null };
export type JudgingViewer = { kind: "studio" } | { kind: "official"; assignments: JudgingAssignment[] };

type Rpc = { rpc: (name: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> };

export async function resolveJudgingViewer(supabase: Rpc): Promise<JudgingViewer> {
  const profile = await requireAuthenticatedUser();
  if (profile.platform_role === "platform_admin") return { kind: "studio" };
  if (await getCurrentStudioRole()) return { kind: "studio" };
  const { data, error } = await supabase.rpc("my_competition_judging_assignments");
  if (error || !Array.isArray(data)) return { kind: "official", assignments: [] };
  const assignments = (data as Array<Record<string, unknown>>)
    .filter((row) => typeof row.event_id === "string" && UUID.test(row.event_id) && JUDGING_ROLES.has(String(row.official_role)))
    .map((row) => ({
      event_id: String(row.event_id),
      official_role: String(row.official_role),
      round_id: typeof row.round_id === "string" && UUID.test(row.round_id) ? row.round_id : null,
    }));
  return { kind: "official", assignments };
}

export function officialMayOpenEvent(viewer: JudgingViewer, eventId: string): boolean {
  if (viewer.kind === "studio") return true;
  return UUID.test(eventId) && viewer.assignments.some((a) => a.event_id === eventId);
}

/** /app layout decision for /app/judging paths: the studio layout (staff), the minimal judging shell (an assigned official), or refuse. */
export function judgingLayoutDecision(pathname: string, viewer: JudgingViewer): "studio-layout" | "judging-shell" | "refuse" {
  if (viewer.kind === "studio") return "studio-layout";
  const parts = pathname.split("/").filter(Boolean); // ["app", "judging", eventId?, ...]
  if (parts[0] !== "app" || parts[1] !== "judging") return "refuse";
  if (parts.length === 2) return viewer.assignments.length > 0 ? "judging-shell" : "refuse";
  return officialMayOpenEvent(viewer, parts[2]) ? "judging-shell" : "refuse";
}

/** Page loaders under /app/judging/[eventId]: an official needs an assignment for that event. */
export async function requireJudgingEvent(eventId: string): Promise<void> {
  const supabase = await createClient();
  const viewer = await resolveJudgingViewer(supabase);
  if (!officialMayOpenEvent(viewer, eventId)) notFound();
}

/**
 * Judging server actions and the ballot / desk pages: "ballot" needs a panel assignment for the round; "desk" needs the round-keyed desk RPC to
 * resolve the caller as chair or scorer (never manager) plus a chair/scorer assignment. Studio staff: no change.
 */
export async function requireJudgingRound(roundId: string, kind: "ballot" | "desk"): Promise<void> {
  const supabase = await createClient();
  const viewer = await resolveJudgingViewer(supabase);
  if (viewer.kind === "studio") return;
  if (!UUID.test(roundId)) notFound();
  if (kind === "ballot") {
    if (!viewer.assignments.some((a) => a.round_id === roundId)) notFound();
    return;
  }
  if (!viewer.assignments.some((a) => DESK_ROLES.has(a.official_role))) notFound();
  const { data, error } = await supabase.rpc("competition_round_ballot_status", { p_round_id: roundId });
  const role = !error && data && typeof data === "object" ? String((data as { viewer_role?: unknown }).viewer_role ?? "") : "";
  if (!DESK_ROLES.has(role)) notFound();
}
