"use server";

import { canCancelGroupClass } from "@/lib/auth/permissions";
import { resolveViewerInstructorId } from "@/lib/auth/instructorIdentity";
import { requireAppointmentEditAccess } from "@/lib/auth/serverRoleGuard";

/**
 * GC-S1D-1: read-only helpers for the class-detail "Add dancer" panel. They only discover dancers and show funding
 * choices; the enrollment itself is always `enroll_class_attendee` (database authority: duplicate prevention, capacity,
 * cancelled-class refusal, funding eligibility, studio / client ownership). Every lookup is scoped to the caller's
 * studio and to a group class of that studio, and runs on the caller's session client (never an admin client).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RosterClientResult = {
  id: string;
  name: string;
  alreadyEnrolled: boolean;
};

export type RosterFundingSource = {
  type: "package" | "membership";
  id: string;
  label: string;
  remainingLabel: string;
};

export type RosterFundingOptions =
  | { mode: "auto" }
  | {
      mode: "choose";
      eligible: RosterFundingSource[];
      packages: Array<{ id: string; label: string }>;
      memberships: Array<{ id: string; label: string }>;
    };

function isBroad(ctx: { isPlatformAdmin: boolean; studioRole: string | null | undefined }) {
  return ctx.isPlatformAdmin || canCancelGroupClass(ctx.studioRole);
}

async function loadClass(ctx: Awaited<ReturnType<typeof requireAppointmentEditAccess>>, appointmentId: string) {
  if (!UUID_RE.test(appointmentId)) return null;
  const { data } = await ctx.supabase
    .from("appointments")
    .select("id, appointment_type, instructor_id")
    .eq("id", appointmentId)
    .eq("studio_id", ctx.studioId)
    .maybeSingle();
  if (!data || data.appointment_type !== "group_class") return null;

  // The assigned instructor may only discover dancers for THEIR OWN class (the enrollment RPC enforces the same rule;
  // this keeps the discovery helpers from answering "is X enrolled in another instructor's class").
  if (!isBroad(ctx)) {
    const viewerInstructorId = await resolveViewerInstructorId(ctx.supabase, ctx.studioId, ctx.user.id);
    if (!viewerInstructorId || viewerInstructorId !== data.instructor_id) return null;
  }

  return data;
}

/** Characters that would alter a PostgREST filter expression are dropped from the search token. */
function safeToken(value: string) {
  return value.replace(/[%,()*\\:"'\u0000-\u001f]/g, " ").trim();
}

export async function searchRosterClientsAction(appointmentId: string, searchText: string): Promise<RosterClientResult[]> {
  const ctx = await requireAppointmentEditAccess();
  const text = String(searchText ?? "").trim().slice(0, 60);
  if (text.length < 2) return [];
  if (!(await loadClass(ctx, appointmentId))) return [];

  let rows: Array<{ id: string; first_name: string | null; last_name: string | null }> = [];

  if (isBroad(ctx)) {
    const tokens = safeToken(text).split(/\s+/).filter(Boolean).slice(0, 3);
    if (tokens.length === 0) return [];
    let query = ctx.supabase
      .from("clients")
      .select("id, first_name, last_name")
      .eq("studio_id", ctx.studioId)
      .or("status.is.null,status.neq.archived");
    for (const token of tokens) {
      query = query.or(`first_name.ilike.%${token}%,last_name.ilike.%${token}%`);
    }
    const { data, error } = await query.order("first_name", { ascending: true }).limit(12);
    if (error) return [];
    rows = (data ?? []) as typeof rows;
  } else {
    // The assigned instructor uses the existing minimal, field-limited booking-discovery interface.
    const { data, error } = await ctx.supabase.rpc("search_bookable_clients_for_instructor", {
      target_studio_id: ctx.studioId,
      search_text: text,
      limit_count: 12,
    });
    if (error) return [];
    rows = (data ?? []) as typeof rows;
  }

  if (rows.length === 0) return [];

  const { data: booked } = await ctx.supabase
    .from("appointment_attendees")
    .select("client_id")
    .eq("studio_id", ctx.studioId)
    .eq("appointment_id", appointmentId)
    .eq("status", "booked")
    .in("client_id", rows.map((row) => row.id));

  const enrolled = new Set((booked ?? []).map((row: { client_id: string }) => row.client_id));

  return rows.map((row) => ({
    id: row.id,
    name: `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || "Unnamed dancer",
    alreadyEnrolled: enrolled.has(row.id),
  }));
}

type FundingCandidateRow = {
  funding_type: "package" | "membership";
  source_id: string;
  label: string;
  is_unlimited: boolean;
  quantity_total: number | null;
  used: number | null;
  remaining: number | null;
};

export async function getRosterFundingOptionsAction(appointmentId: string, clientId: string): Promise<RosterFundingOptions> {
  const ctx = await requireAppointmentEditAccess();

  // The assigned instructor never sees funding choices: the database resolves it automatically (exactly one eligible
  // source) or asks front desk to complete the enrollment.
  if (!isBroad(ctx)) return { mode: "auto" };

  if (!UUID_RE.test(clientId) || !(await loadClass(ctx, appointmentId))) {
    return { mode: "choose", eligible: [], packages: [], memberships: [] };
  }

  const [candidates, packages, memberships] = await Promise.all([
    ctx.supabase.rpc("get_eligible_group_class_funding_candidates", {
      p_studio_id: ctx.studioId,
      p_client_id: clientId,
      p_appointment_id: appointmentId,
    }),
    ctx.supabase
      .from("client_packages")
      .select("id, name_snapshot, client_package_items(usage_type, quantity_remaining, is_unlimited)")
      .eq("studio_id", ctx.studioId)
      .eq("client_id", clientId)
      .eq("active", true),
    ctx.supabase
      .from("client_memberships")
      .select("id, name_snapshot")
      .eq("studio_id", ctx.studioId)
      .eq("client_id", clientId)
      .eq("status", "active"),
  ]);

  const eligible: RosterFundingSource[] = ((candidates.data ?? []) as FundingCandidateRow[]).map((row) => ({
    type: row.funding_type,
    id: row.source_id,
    label: row.label,
    remainingLabel: row.is_unlimited
      ? "Unlimited"
      : row.funding_type === "package"
        ? `${row.remaining ?? 0} remaining`
        : `${row.used ?? 0} of ${row.quantity_total ?? 0} used`,
  }));

  type PackageRow = {
    id: string;
    name_snapshot: string | null;
    client_package_items: Array<{ usage_type: string | null; quantity_remaining: number | null; is_unlimited: boolean | null }> | null;
  };

  return {
    mode: "choose",
    eligible,
    packages: ((packages.data ?? []) as PackageRow[])
      .flatMap((pkg) => {
        const item = (pkg.client_package_items ?? []).find((i) => i.usage_type === "group_class");
        if (!item) return [];
        const remaining = item.is_unlimited ? "Unlimited" : `${item.quantity_remaining ?? 0} remaining`;
        return [{ id: pkg.id, label: `${pkg.name_snapshot?.trim() || "Package"} — ${remaining}` }];
      }),
    memberships: ((memberships.data ?? []) as Array<{ id: string; name_snapshot: string | null }>).map((m) => ({
      id: m.id,
      label: m.name_snapshot?.trim() || "Membership",
    })),
  };
}
