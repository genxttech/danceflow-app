import { createAdminClient } from "@/lib/supabase/admin";
import { renderStudioBrandedEmail } from "@/lib/notifications/email-branding";
import { queueOutboundDelivery } from "@/lib/notifications/outbound";

function htmlEscape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

type AssignmentRow = { id: string; studio_id: string; client_id: string | null; template_id: string; assigned_to_email: string | null; due_at: string | null; reminder_sent_at: string | null; overdue_reminder_sent_at: string | null; clients: { first_name: string | null; last_name: string | null; email: string | null } | { first_name: string | null; last_name: string | null; email: string | null }[] | null; document_templates: { title: string | null } | { title: string | null }[] | null; studios: { name: string | null; public_name: string | null; public_logo_url: string | null; slug: string | null } | { name: string | null; public_name: string | null; public_logo_url: string | null; slug: string | null }[] | null };
const one = <T,>(value: T | T[] | null): T | null => Array.isArray(value) ? value[0] ?? null : value;

export async function runDocumentOperations(now = new Date()) {
  const admin = createAdminClient();
  const inThreeDays = new Date(now.getTime() + 3 * 86400000).toISOString();
  const { data, error } = await admin.from("document_assignments").select("id, studio_id, client_id, template_id, assigned_to_email, due_at, reminder_sent_at, overdue_reminder_sent_at, clients(first_name,last_name,email), document_templates(title), studios(name,public_name,public_logo_url,slug)").eq("status", "pending").not("due_at", "is", null).lte("due_at", inThreeDays).limit(500);
  if (error) throw error;
  let queued = 0, skipped = 0, failed = 0;
  for (const row of (data ?? []) as AssignmentRow[]) {
    const due = row.due_at ? new Date(row.due_at) : null;
    if (!due || Number.isNaN(due.getTime())) { skipped++; continue; }
    const overdue = due.getTime() < now.getTime();
    if ((overdue && row.overdue_reminder_sent_at) || (!overdue && row.reminder_sent_at)) { skipped++; continue; }
    const client = one(row.clients); const template = one(row.document_templates); const studio = one(row.studios);
    const email = row.assigned_to_email || client?.email;
    if (!email) { await admin.from("document_operation_events").insert({ studio_id: row.studio_id, assignment_id: row.id, event_type: "delivery_exception", summary: "Document reminder could not be sent because no email address is available." }); skipped++; continue; }
    const studioName = studio?.public_name || studio?.name || "Your studio";
    const clientName = `${client?.first_name ?? ""} ${client?.last_name ?? ""}`.trim() || "Hello";
    const title = template?.title || "Document";
    const portalUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "https://idanceflow.com"}/portal/${encodeURIComponent(studio?.slug || "")}/documents`;
    const kind = overdue ? "overdue" : "due-soon";
    const subject = overdue ? `Past due: ${title} needs your signature` : `Reminder: ${title} is due soon`;
    const bodyText = `${clientName},\n\n${studioName} is reminding you to review and sign ${title}.\n\nOpen your DanceFlow portal: ${portalUrl}\n\nThank you,\n${studioName}`;
    const bodyHtml = renderStudioBrandedEmail(
      {
        name: studioName,
        logoUrl: studio?.public_logo_url ?? null,
      },
      {
        previewText: subject,
        eyebrow: overdue ? "Past Due Document" : "Signature Reminder",
        heading: overdue ? "Your document is past due" : "Your document is due soon",
        greeting: `${clientName},`,
        intro: `${studioName} is reminding you to review and sign ${title}.`,
        bodyText,
        detailRows: [{ label: "Document", value: title }],
        actionLabel: "Open Documents",
        actionUrl: portalUrl,
        footerText: `Sent by ${studioName} through DanceFlow.`,
      },
    );
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
      dedupeKey: `document:${row.id}:${kind}`,
    });
    if (!delivery.queued && delivery.reason !== "duplicate") {
      failed++;
      continue;
    }
    await admin.from("document_assignments").update(overdue ? { overdue_reminder_sent_at: now.toISOString() } : { reminder_sent_at: now.toISOString() }).eq("id", row.id).eq("status", "pending");
    await admin.from("document_operation_events").insert({ studio_id: row.studio_id, assignment_id: row.id, event_type: overdue ? "overdue_reminder_queued" : "due_soon_reminder_queued", summary: overdue ? "Overdue signature reminder queued." : "Due-soon signature reminder queued." });
    queued++;
  }
  return { scanned: data?.length ?? 0, queued, skipped, failed };
}
