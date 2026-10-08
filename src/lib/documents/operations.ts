import { createAdminClient } from "@/lib/supabase/admin";
import { renderStudioBrandedEmail } from "@/lib/notifications/email-branding";
import { queueOutboundDelivery } from "@/lib/notifications/outbound";
import { buildAppUrl, resolveStudioDisplayName, sanitizeEmailSubject } from "@/lib/email/brand";
import { studioIdHasFeature } from "@/lib/billing/access";
import { LIVE_SIGN_ENVELOPE_STATUSES, OPEN_SIGN_ENVELOPE_STATUSES } from "@/lib/documents/signing-integrity";

function htmlEscape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

type AssignmentRow = { id: string; studio_id: string; client_id: string | null; template_id: string; assigned_to_email: string | null; due_at: string | null; reminder_sent_at: string | null; overdue_reminder_sent_at: string | null; clients: { first_name: string | null; last_name: string | null; email: string | null } | { first_name: string | null; last_name: string | null; email: string | null }[] | null; document_templates: { title: string | null } | { title: string | null }[] | null; studios: { name: string | null; public_name: string | null; public_logo_url: string | null; slug: string | null } | { name: string | null; public_name: string | null; public_logo_url: string | null; slug: string | null }[] | null };
const one = <T,>(value: T | T[] | null): T | null => Array.isArray(value) ? value[0] ?? null : value;

/** Pure builder: the due-soon / overdue document reminder email sent to a client. */
export function buildDocumentReminderEmail(params: {
  studio: { public_name?: string | null; name?: string | null; public_logo_url?: string | null; slug?: string | null } | null;
  clientName: string | null;
  documentTitle: string | null;
  overdue: boolean;
}) {
  const studioName = resolveStudioDisplayName(params.studio);
  const clientName = params.clientName?.trim() || "Hello";
  const title = params.documentTitle || "Document";
  // Only a real portal slug produces a client CTA/link. No slug -> no CTA and no bare link in the body:
  // never a malformed `/portal//documents` URL.
  const portalUrl = params.studio?.slug
    ? buildAppUrl(`/portal/${encodeURIComponent(params.studio.slug)}/documents`)
    : null;
  const overdue = params.overdue;
  const subject = sanitizeEmailSubject(
    overdue ? `Past due: ${title} needs your signature` : `Reminder: ${title} is due soon`,
  );
  const greeting = `${clientName},`;
  const intro = `${studioName} is reminding you to review and sign ${title}.`;
  const actionLine = portalUrl
    ? `Open your DanceFlow portal: ${portalUrl}`
    : `Contact ${studioName} for next steps on reviewing and signing it.`;
  const bodyText = [
    greeting,
    "",
    intro,
    "",
    actionLine,
    "",
    "Thank you,",
    studioName,
  ].join("\n");
  const bodyHtml = renderStudioBrandedEmail(
    {
      name: studioName,
      logoUrl: params.studio?.public_logo_url ?? null,
    },
    {
      previewText: subject,
      eyebrow: overdue ? "Past Due Document" : "Signature Reminder",
      heading: overdue ? "Your document is past due" : "Your document is due soon",
      greeting,
      intro,
      bodyText,
      detailRows: [{ label: "Document", value: title }],
      actionLabel: portalUrl ? "Open Documents" : null,
      actionUrl: portalUrl,
      dedupeBodyLeadIn: true,
    },
  );

  return { subject, bodyText, bodyHtml };
}

/*
  Phase 8B -- document operations cron.

  1. Expiry sweep: open envelopes past `expires_at` are persisted as `expired` (guarded on their open status, so a
     concurrent completion always wins). The assignment stays `pending`; its effective state is derived from the
     envelope and staff reissue it through a revision.
  2. Abandoned event checkouts: a still-pending checkout waiver whose checkpoint expired / was cancelled (or is still
     `signing` past its window) is voided, after its live envelope is closed. Completed checkouts are never touched,
     and the checkpoint itself is not modified.
  3. Reminders: only pending assignments with a due date, and -- for an envelope-backed request -- only while its
     current envelope is open and unexpired. Eligibility is filtered in the database (never signed / waived / void /
     declined / expired / draft / superseded), ordered by (due_at, id) and bounded; every examined row is either
     flagged or excluded, so ineligible rows can never starve the queue. Studios without the Documents plan feature
     are skipped (excluded from later pages); the lifecycle sweeps above still run for every studio.
*/

export const DOCUMENT_SWEEP_BATCH = 200;
export const DOCUMENT_REMINDER_BATCH = 200;
export const DOCUMENT_REMINDER_MAX_PAGES = 3;
const DUE_SOON_WINDOW_MS = 3 * 86400000;
const CHECKOUT_VOID_REASON = "Event checkout ended before signing was completed.";

type AdminClient = ReturnType<typeof createAdminClient>;
type ReminderKind = "overdue" | "due-soon";
type ReminderRow = AssignmentRow & { sign_envelope_id: string | null };

const REMINDER_COLUMNS =
  "id, studio_id, client_id, template_id, assigned_to_email, due_at, reminder_sent_at, overdue_reminder_sent_at, sign_envelope_id, clients(first_name,last_name,email), document_templates(title), studios(name,public_name,public_logo_url,slug)";
const REMINDER_ENVELOPE_EMBED =
  "document_sign_envelopes!document_assignments_sign_envelope_id_fkey!inner(id,status,expires_at)";
const CHECKOUT_COLUMNS =
  "id, studio_id, sign_envelope_id, event_signing_checkpoints!document_assignments_event_signing_checkpoint_id_fkey!inner(id,status,expires_at)";

export async function expireLapsedSignEnvelopes(admin: AdminClient, now: Date) {
  const nowIso = now.toISOString();
  const { data, error } = await admin
    .from("document_sign_envelopes")
    .select("id")
    .in("status", [...OPEN_SIGN_ENVELOPE_STATUSES])
    .lte("expires_at", nowIso)
    .order("expires_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(DOCUMENT_SWEEP_BATCH);
  if (error) throw error;

  const ids = ((data ?? []) as { id: string }[]).map((row) => row.id);
  if (!ids.length) return { expired: 0 };

  const { data: expired, error: updateError } = await admin
    .from("document_sign_envelopes")
    .update({ status: "expired", updated_at: nowIso })
    .in("id", ids)
    .in("status", [...OPEN_SIGN_ENVELOPE_STATUSES])
    .lte("expires_at", nowIso)
    .select("id");
  if (updateError) throw updateError;

  const expiredIds = ((expired ?? []) as { id: string }[]).map((row) => row.id);
  if (expiredIds.length) {
    await admin.from("document_sign_events").insert(
      expiredIds.map((id) => ({
        envelope_id: id,
        event_type: "expired",
        summary: "Signing request expired before it was completed.",
      })),
    );
  }

  return { expired: expiredIds.length };
}

type CheckoutAssignmentRow = { id: string; studio_id: string | null; sign_envelope_id: string | null };

export async function resolveAbandonedEventCheckoutAssignments(admin: AdminClient, now: Date) {
  const nowIso = now.toISOString();
  const base = () =>
    admin
      .from("document_assignments")
      .select(CHECKOUT_COLUMNS)
      .eq("status", "pending")
      .not("event_signing_checkpoint_id", "is", null);

  const [closedResult, lapsedResult] = await Promise.all([
    base()
      .in("event_signing_checkpoints.status", ["expired", "cancelled"])
      .order("assigned_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(DOCUMENT_SWEEP_BATCH),
    base()
      .eq("event_signing_checkpoints.status", "signing")
      .lte("event_signing_checkpoints.expires_at", nowIso)
      .order("assigned_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(DOCUMENT_SWEEP_BATCH),
  ]);
  if (closedResult.error) throw closedResult.error;
  if (lapsedResult.error) throw lapsedResult.error;

  const rows = new Map<string, CheckoutAssignmentRow>();
  for (const row of [...(closedResult.data ?? []), ...(lapsedResult.data ?? [])] as CheckoutAssignmentRow[]) {
    rows.set(row.id, row);
  }

  let voided = 0;
  let skipped = 0;
  for (const row of rows.values()) {
    if (row.sign_envelope_id) {
      const { data: closedEnvelope } = await admin
        .from("document_sign_envelopes")
        .update({ status: "void", token_hash: null, voided_at: nowIso, revoked_reason: CHECKOUT_VOID_REASON, updated_at: nowIso })
        .eq("id", row.sign_envelope_id)
        .in("status", [...LIVE_SIGN_ENVELOPE_STATUSES])
        .select("id")
        .maybeSingle();

      if (!closedEnvelope) {
        const { data: envelope } = await admin
          .from("document_sign_envelopes")
          .select("id, status")
          .eq("id", row.sign_envelope_id)
          .maybeSingle();
        // A completion that won the race keeps its evidence; its assignment is signed by the sync trigger.
        if (envelope?.status === "completed") {
          skipped++;
          continue;
        }
      }
    }

    const { data: closedAssignment } = await admin
      .from("document_assignments")
      .update({ status: "void", voided_at: nowIso, void_reason: CHECKOUT_VOID_REASON, updated_at: nowIso })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();

    if (!closedAssignment) {
      skipped++;
      continue;
    }

    if (row.studio_id) {
      await admin.from("document_operation_events").insert({
        studio_id: row.studio_id,
        assignment_id: row.id,
        event_type: "voided",
        summary: CHECKOUT_VOID_REASON,
      });
    }
    voided++;
  }

  return { voided, skipped };
}

function reminderCandidates(
  admin: AdminClient,
  params: { kind: ReminderKind; envelopeBacked: boolean; now: Date; excludedStudioIds: string[] },
) {
  const nowIso = params.now.toISOString();
  let query = admin
    .from("document_assignments")
    .select(params.envelopeBacked ? `${REMINDER_COLUMNS}, ${REMINDER_ENVELOPE_EMBED}` : REMINDER_COLUMNS)
    .eq("status", "pending")
    .not("studio_id", "is", null)
    .is("event_signing_checkpoint_id", null);

  query =
    params.kind === "overdue"
      ? query.lt("due_at", nowIso).is("overdue_reminder_sent_at", null)
      : query
          .gte("due_at", nowIso)
          .lte("due_at", new Date(params.now.getTime() + DUE_SOON_WINDOW_MS).toISOString())
          .is("reminder_sent_at", null);

  query = params.envelopeBacked
    ? query
        .not("sign_envelope_id", "is", null)
        .in("document_sign_envelopes.status", [...OPEN_SIGN_ENVELOPE_STATUSES])
        .gt("document_sign_envelopes.expires_at", nowIso)
    : query.is("sign_envelope_id", null);

  if (params.excludedStudioIds.length) {
    query = query.not("studio_id", "in", `(${params.excludedStudioIds.join(",")})`);
  }

  return query.order("due_at", { ascending: true }).order("id", { ascending: true }).limit(DOCUMENT_REMINDER_BATCH);
}

async function sendDocumentReminder(admin: AdminClient, row: ReminderRow, kind: ReminderKind, now: Date) {
  const nowIso = now.toISOString();
  const overdue = kind === "overdue";
  const flagColumn = overdue ? "overdue_reminder_sent_at" : "reminder_sent_at";
  const markSent = () =>
    admin
      .from("document_assignments")
      .update(overdue ? { overdue_reminder_sent_at: nowIso } : { reminder_sent_at: nowIso })
      .eq("id", row.id)
      .eq("status", "pending")
      .is(flagColumn, null)
      .select("id")
      .maybeSingle();

  const client = one(row.clients);
  const template = one(row.document_templates);
  const studio = one(row.studios);
  const email = row.assigned_to_email || client?.email;

  if (!email) {
    // Flag the row (once) so an unreachable client cannot starve the queue; staff see the exception.
    const { data: marked } = await markSent();
    if (marked) {
      await admin.from("document_operation_events").insert({ studio_id: row.studio_id, assignment_id: row.id, event_type: "delivery_exception", summary: "Document reminder could not be sent because no email address is available." });
    }
    return "skipped" as const;
  }

  const clientName = `${client?.first_name ?? ""} ${client?.last_name ?? ""}`.trim() || "Hello";
  const { subject, bodyText, bodyHtml } = buildDocumentReminderEmail({
    studio,
    clientName,
    documentTitle: template?.title ?? null,
    overdue,
  });
  const dueMs = row.due_at ? new Date(row.due_at).getTime() : 0;
  const delivery = await queueOutboundDelivery({
    studioId: row.studio_id,
    channel: "email",
    templateKey: overdue ? "document_overdue_reminder" : "document_due_soon_reminder",
    recipientEmail: email,
    subject,
    bodyText,
    bodyHtml,
    relatedTable: "document_assignments",
    relatedId: row.id,
    // One reminder per kind per (due date, signing request): a changed due date or a revision restarts the cycle.
    dedupeKey: `document:${row.id}:${kind}:${dueMs}:${row.sign_envelope_id ?? "legacy"}`,
  });
  if (!delivery.queued && delivery.reason !== "duplicate") {
    return "failed" as const;
  }

  const { data: marked } = await markSent();
  if (marked) {
    await admin.from("document_operation_events").insert({ studio_id: row.studio_id, assignment_id: row.id, event_type: overdue ? "overdue_reminder_queued" : "due_soon_reminder_queued", summary: overdue ? "Overdue signature reminder queued." : "Due-soon signature reminder queued." });
  }
  return "queued" as const;
}

export async function queueDueDocumentReminders(admin: AdminClient, now: Date) {
  const featureByStudio = new Map<string, boolean>();
  const excludedStudioIds: string[] = [];
  let scanned = 0, queued = 0, skipped = 0, failed = 0, featureSkipped = 0;

  for (const kind of ["overdue", "due-soon"] as const) {
    for (const envelopeBacked of [true, false]) {
      for (let page = 0; page < DOCUMENT_REMINDER_MAX_PAGES; page++) {
        const { data, error } = await reminderCandidates(admin, { kind, envelopeBacked, now, excludedStudioIds });
        if (error) throw error;
        const rows = (data ?? []) as unknown as ReminderRow[];
        let progressed = false;

        for (const row of rows) {
          scanned++;
          let enabled = featureByStudio.get(row.studio_id);
          if (enabled === undefined) {
            enabled = await studioIdHasFeature(admin, row.studio_id, "documents");
            featureByStudio.set(row.studio_id, enabled);
          }
          if (!enabled) {
            if (!excludedStudioIds.includes(row.studio_id)) excludedStudioIds.push(row.studio_id);
            featureSkipped++;
            progressed = true;
            continue;
          }

          const outcome = await sendDocumentReminder(admin, row, kind, now);
          if (outcome === "failed") {
            failed++;
            continue;
          }
          progressed = true;
          if (outcome === "queued") queued++;
          else skipped++;
        }

        // A full page with progress may hide more eligible rows; a short page (or one where every send failed) ends it.
        if (rows.length < DOCUMENT_REMINDER_BATCH || !progressed) break;
      }
    }
  }

  return { scanned, queued, skipped, failed, featureSkipped };
}

export async function runDocumentOperations(now = new Date()) {
  const admin = createAdminClient();
  const expiry = await expireLapsedSignEnvelopes(admin, now);
  const checkouts = await resolveAbandonedEventCheckoutAssignments(admin, now);
  const reminders = await queueDueDocumentReminders(admin, now);
  return {
    ...reminders,
    expiredEnvelopes: expiry.expired,
    voidedCheckoutAssignments: checkouts.voided,
  };
}
