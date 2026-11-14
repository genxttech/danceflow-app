import type { SupabaseClient } from "@supabase/supabase-js";
import { canViewClients } from "@/lib/auth/permissions";
import { resolveViewerInstructorId } from "@/lib/auth/instructorIdentity";
import { localDateInTimeZone, toIsoUtc } from "@/lib/staff/instructorToday";

/**
 * Staff API client lookup. Two scopes, chosen by role and never widened:
 *  - broad (owner, admin, front desk: canViewClients): the studio's clients, read through RLS with the caller's own token;
 *  - teaching (instructor): only clients from get_teaching_clients_for_instructor, the same relationship rule the web uses
 *    for instructors (FC-1B5D). Instructors cannot read client rows, so their status and package balances are not returned.
 * Projections carry no money and no contact details.
 */

export type ClientLookupScope = "broad" | "teaching";

export function clientLookupScope(role: string): ClientLookupScope | null {
  if (canViewClients(role)) return "broad";
  if (role === "instructor") return "teaching";
  return null;
}

export type ClientListItem = { id: string; firstName: string; lastName: string; status: string | null };

type Cursor = { l: string; f: string; i: string };

export function encodeCursor(item: { lastName: string; firstName: string; id: string }) {
  return Buffer.from(JSON.stringify({ l: item.lastName, f: item.firstName, i: item.id } satisfies Cursor)).toString("base64url");
}

export function decodeCursor(value: string | null): Cursor | null | "invalid" {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof parsed.l === "string" && typeof parsed.f === "string" && typeof parsed.i === "string" && parsed.i.length <= 64) {
      return { l: parsed.l, f: parsed.f, i: parsed.i };
    }
  } catch {
    // fall through
  }
  return "invalid";
}

// A value inside a PostgREST logic-tree filter, double-quoted so commas, dots and parentheses are data. Inside the quotes a backslash
// escapes the next character.
function quoted(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// A LIKE pattern that matches `q` literally anywhere: % and _ (and the escape character itself) lose their wildcard meaning.
function containsPattern(q: string) {
  return `%${q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
}

// Code-unit order, the same on both paths so cursors are stable: last name, first name, id.
function compareKey(a: { lastName: string; firstName: string; id: string }, b: Cursor) {
  if (a.lastName !== b.l) return a.lastName < b.l ? -1 : 1;
  if (a.firstName !== b.f) return a.firstName < b.f ? -1 : 1;
  if (a.id !== b.i) return a.id < b.i ? -1 : 1;
  return 0;
}

type ClientRow = { id: string; first_name: string | null; last_name: string | null; status?: string | null };

const toItem = (row: ClientRow, withStatus: boolean): ClientListItem => ({
  id: row.id,
  firstName: row.first_name ?? "",
  lastName: row.last_name ?? "",
  status: withStatus ? (row.status ?? null) : null,
});

async function teachingClients(supabase: SupabaseClient, studioId: string, clientId?: string) {
  const { data, error } = await supabase.rpc("get_teaching_clients_for_instructor", {
    target_studio_id: studioId,
    ...(clientId ? { target_client_id: clientId } : {}),
  });
  if (error) throw new Error(`Teaching clients lookup failed: ${error.message}`);
  return (data ?? []) as ClientRow[];
}

export async function searchClients(params: {
  supabase: SupabaseClient;
  studioId: string;
  scope: ClientLookupScope;
  q: string;
  cursor: Cursor | null;
  limit: number;
}) {
  const { supabase, studioId, scope, q, cursor, limit } = params;

  if (scope === "teaching") {
    const needle = q.toLocaleLowerCase();
    const all = (await teachingClients(supabase, studioId))
      .map((row) => toItem(row, false))
      .filter((item) => !needle || item.firstName.toLocaleLowerCase().includes(needle) || item.lastName.toLocaleLowerCase().includes(needle))
      .sort((a, b) => compareKey(a, { l: b.lastName, f: b.firstName, i: b.id }))
      .filter((item) => !cursor || compareKey(item, cursor) > 0);
    const page = all.slice(0, limit);
    return { clients: page, nextCursor: all.length > limit ? encodeCursor(page[page.length - 1]) : null };
  }

  let query = supabase
    .from("clients")
    .select("id, first_name, last_name, status")
    .eq("studio_id", studioId)
    .eq("status", "active");

  if (q) {
    const pattern = quoted(containsPattern(q));
    query = query.or(`first_name.ilike.${pattern},last_name.ilike.${pattern}`);
  }
  if (cursor) {
    const l = quoted(cursor.l);
    const f = quoted(cursor.f);
    const i = quoted(cursor.i);
    query = query.or(`last_name.gt.${l},and(last_name.eq.${l},first_name.gt.${f}),and(last_name.eq.${l},first_name.eq.${f},id.gt.${i})`);
  }

  const { data, error } = await query
    .order("last_name", { ascending: true })
    .order("first_name", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit + 1);
  if (error) throw new Error(`Client search failed: ${error.message}`);

  const rows = ((data ?? []) as ClientRow[]).map((row) => toItem(row, true));
  const page = rows.slice(0, limit);
  return { clients: page, nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null };
}

const UPCOMING_STATUSES = ["scheduled", "confirmed", "rescheduled"];

type AppointmentRow = { id: string; appointment_type: string; title: string | null; starts_at: string; ends_at: string };

const toNext = (row: AppointmentRow | null | undefined) =>
  row
    ? { id: row.id, appointmentType: row.appointment_type, title: row.title, startsAt: toIsoUtc(row.starts_at), endsAt: toIsoUtc(row.ends_at) }
    : null;

async function nextAppointmentFor(params: {
  supabase: SupabaseClient;
  studioId: string;
  clientId: string;
  instructorId: string | null;
}) {
  const { supabase, studioId, clientId, instructorId } = params;
  const nowIso = new Date().toISOString();
  const fields = "id, appointment_type, title, starts_at, ends_at";

  let lessons = supabase
    .from("appointments")
    .select(fields)
    .eq("studio_id", studioId)
    .or(`client_id.eq.${clientId},partner_client_id.eq.${clientId}`)
    .in("status", UPCOMING_STATUSES)
    .gt("starts_at", nowIso);
  // appointment_attendees has a single foreign key to appointments, so this embed is unambiguous.
  let classes = supabase
    .from("appointments")
    .select(`${fields}, appointment_attendees!inner ( client_id, status )`)
    .eq("studio_id", studioId)
    .eq("appointment_attendees.client_id", clientId)
    .eq("appointment_attendees.status", "booked")
    .in("status", UPCOMING_STATUSES)
    .gt("starts_at", nowIso);
  if (instructorId) {
    lessons = lessons.eq("instructor_id", instructorId);
    classes = classes.eq("instructor_id", instructorId);
  }

  const [lessonResult, classResult] = await Promise.all([
    lessons.order("starts_at", { ascending: true }).limit(1),
    classes.order("starts_at", { ascending: true }).limit(1),
  ]);
  if (lessonResult.error) throw new Error(`Next lesson lookup failed: ${lessonResult.error.message}`);
  if (classResult.error) throw new Error(`Next class lookup failed: ${classResult.error.message}`);

  const candidates = [...((lessonResult.data ?? []) as AppointmentRow[]), ...((classResult.data ?? []) as AppointmentRow[])];
  candidates.sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
  return toNext(candidates[0]);
}

type PackageRow = {
  id: string;
  name_snapshot: string | null;
  expiration_date: string | null;
  client_package_items: { usage_type: string; quantity_remaining: number | null; is_unlimited: boolean | null }[] | null;
};

async function activePackagesFor(supabase: SupabaseClient, studioId: string, clientId: string, timeZone: string) {
  const { data, error } = await supabase
    .from("client_packages")
    .select("id, name_snapshot, expiration_date, client_package_items ( usage_type, quantity_remaining, is_unlimited )")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("active", true)
    .is("archived_at", null)
    .order("expiration_date", { ascending: true, nullsFirst: false });
  if (error) throw new Error(`Package lookup failed: ${error.message}`);

  const today = localDateInTimeZone(new Date(), timeZone);
  return ((data ?? []) as PackageRow[])
    .filter((row) => !row.expiration_date || row.expiration_date >= today)
    .map((row) => ({
      id: row.id,
      name: row.name_snapshot ?? "",
      expiresOn: row.expiration_date,
      items: (row.client_package_items ?? []).map((item) => ({
        usageType: item.usage_type,
        remaining: item.quantity_remaining,
        unlimited: Boolean(item.is_unlimited),
      })),
    }));
}

/** One client's summary, or null when the caller may not see that client (missing, another studio, or not taught by this instructor). */
export async function loadClientSummary(params: {
  supabase: SupabaseClient;
  studioId: string;
  scope: ClientLookupScope;
  userId: string;
  clientId: string;
  timeZone: string;
}) {
  const { supabase, studioId, scope, userId, clientId, timeZone } = params;

  if (scope === "teaching") {
    const [row] = await teachingClients(supabase, studioId, clientId);
    if (!row || row.id !== clientId) return null;
    const instructorId = await resolveViewerInstructorId(supabase, studioId, userId);
    if (!instructorId) return null;
    return {
      client: toItem(row, false),
      timeZone,
      activePackages: null,
      nextAppointment: await nextAppointmentFor({ supabase, studioId, clientId, instructorId }),
    };
  }

  const { data: row, error } = await supabase
    .from("clients")
    .select("id, first_name, last_name, status")
    .eq("studio_id", studioId)
    .eq("id", clientId)
    .maybeSingle<ClientRow>();
  if (error) throw new Error(`Client lookup failed: ${error.message}`);
  if (!row) return null;

  const [activePackages, nextAppointment] = await Promise.all([
    activePackagesFor(supabase, studioId, clientId, timeZone),
    nextAppointmentFor({ supabase, studioId, clientId, instructorId: null }),
  ]);

  return { client: toItem(row, true), timeZone, activePackages, nextAppointment };
}
