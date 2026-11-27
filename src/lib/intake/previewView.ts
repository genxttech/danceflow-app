import { classifyOutcome, type OutcomeClass, type PreviewRow, type ReconcilePreviewRpc, type StudioGateStatus } from "./reconcilePreview";

export const PREVIEW_PAGE_SIZE = 50;

export type AppointmentDetail = { id: string; studio_id: string; starts_at: string; appointment_type: string; client_id: string | null };
export type ClientDetail = { id: string; studio_id: string; first_name: string | null; last_name: string | null };

export type PreviewDisplayRow = {
  appointmentId: string;
  outcome: PreviewRow["outcome"];
  startsAt: string | null;
  appointmentType: string | null;
  clientName: string;
  templateVersion: number | null;
};

export type PreviewView = {
  status: StudioGateStatus;
  rows: PreviewDisplayRow[];
  counts: Partial<Record<OutcomeClass, number>>;
  /** More candidates exist than were examined. */
  truncated: boolean;
  /** Always true: this view reads only and cannot create anything. */
  readOnly: true;
};

function displayName(client: ClientDetail | undefined): string {
  if (!client) return "Student";
  const name = [client.first_name, client.last_name].filter(Boolean).join(" ").trim();
  return name || "Student";
}

/** Pure assembly: only details of this studio are used, so a mixed lookup can never show another studio's data. */
export function buildPreviewView(params: {
  studioId: string;
  status: StudioGateStatus;
  rows: PreviewRow[];
  appointments: AppointmentDetail[];
  clients: ClientDetail[];
  pageSize?: number;
}): PreviewView {
  const { studioId, status, rows } = params;
  const pageSize = params.pageSize ?? PREVIEW_PAGE_SIZE;
  const appointments = new Map(params.appointments.filter((a) => a.studio_id === studioId).map((a) => [a.id, a]));
  const clients = new Map(params.clients.filter((c) => c.studio_id === studioId).map((c) => [c.id, c]));
  const counts: PreviewView["counts"] = {};
  const display = rows.map((row) => {
    const appointment = appointments.get(row.appointmentId);
    const cls = classifyOutcome(row.outcome);
    counts[cls] = (counts[cls] ?? 0) + 1;
    return {
      appointmentId: row.appointmentId,
      outcome: row.outcome,
      startsAt: appointment?.starts_at ?? null,
      appointmentType: appointment?.appointment_type ?? null,
      clientName: displayName(clients.get(row.clientId)),
      templateVersion: row.versionNumber,
    };
  });
  display.sort((a, b) => (a.startsAt ?? "").localeCompare(b.startsAt ?? ""));
  return { status, rows: display, counts, truncated: rows.length >= pageSize, readOnly: true };
}

type DetailClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => { in: (column: string, values: string[]) => PromiseLike<{ data: unknown[] | null; error: unknown }> };
    };
  };
};

/**
 * Loads the read-only preview. `rpc` is the service-role adapter (the preview RPCs are service_role only);
 * `userClient` reads display details under the signed-in user's RLS. The studio id is the caller's own studio.
 */
export async function loadPreviewView(params: {
  studioId: string;
  rpc: ReconcilePreviewRpc;
  userClient: unknown;
}): Promise<PreviewView> {
  const { studioId, rpc } = params;
  const status = await rpc.status(studioId);
  if (!status.enabled || !status.enabledAt) {
    return { status, rows: [], counts: {}, truncated: false, readOnly: true };
  }
  const rows = await rpc.preview(studioId, PREVIEW_PAGE_SIZE, null);
  const db = params.userClient as DetailClient;
  const appointmentIds = rows.map((r) => r.appointmentId);
  const clientIds = Array.from(new Set(rows.map((r) => r.clientId)));
  const [appointments, clients] = await Promise.all([
    appointmentIds.length
      ? db.from("appointments").select("id, studio_id, starts_at, appointment_type, client_id").eq("studio_id", studioId).in("id", appointmentIds)
      : Promise.resolve({ data: [], error: null }),
    clientIds.length
      ? db.from("clients").select("id, studio_id, first_name, last_name").eq("studio_id", studioId).in("id", clientIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (appointments.error || clients.error) throw new Error("Student Intake preview details could not be loaded.");
  return buildPreviewView({
    studioId,
    status,
    rows,
    appointments: (appointments.data ?? []) as AppointmentDetail[],
    clients: (clients.data ?? []) as ClientDetail[],
  });
}
