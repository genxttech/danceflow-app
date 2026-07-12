import { createAdminClient } from "@/lib/supabase/admin";

function htmlEscape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

type AssignmentRow = { id: string; studio_id: string; client_id: string | null; template_id: string; assigned_to_email: string | null; due_at: string | null; reminder_sent_at: string | null; overdue_reminder_sent_at: string | null; clients: { first_name: string | null; last_name: string | null; email: string | null } | { first_name: string | null; last_name: string | null; email: string | null }[] | null; document_templates: { title: string | null } | { title: string | null }[] | null; studios: { name: string | null; public_name: string | null; slug: string | null } | { name: string | null; public_name: string | null; slug: string | null }[] | null };
const one = <T,>(value: T | T[] | null): T | null => Array.isArray(value) ? value[0] ?? null : value;

export async function runDocumentOperations(now = new Date()) {
  const admin = createAdminClient();
  const inThreeDays = new Date(now.getTime() + 3 * 86400000).toISOString();
  const { data, error } = await admin.from("document_assignments").select("id, studio_id, client_id, template_id, assigned_to_email, due_at, reminder_sent_at, overdue_reminder_sent_at, clients(first_name,last_name,email), document_templates(title), studios(name,public_name,slug)").eq("status", "pending").not("due_at", "is", null).lte("due_at", inThreeDays).limit(500);
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
    const bodyHtml = `<p>${htmlEscape(clientName)},</p><p>${htmlEscape(studioName)} is reminding you to review and sign <strong>${htmlEscape(title)}</strong>.</p><p><a href="${htmlEscape(portalUrl)}">Open your DanceFlow portal</a>.</p><p>Thank you,<br>${htmlEscape(studioName)}</p>`;
    const { error: deliveryError } = await admin.from("outbound_deliveries").insert({ studio_id: row.studio_id, channel: "email", template_key: overdue ? "document_overdue_reminder" : "document_due_soon_reminder", recipient_email: email, subject, body_text: bodyText, body_html: bodyHtml, related_table: "document_assignments", related_id: row.id, dedupe_key: `document:${row.id}:${kind}`, status: "queued", updated_at: now.toISOString() });
    if (deliveryError && deliveryError.code !== "23505") { failed++; continue; }
    await admin.from("document_assignments").update(overdue ? { overdue_reminder_sent_at: now.toISOString() } : { reminder_sent_at: now.toISOString() }).eq("id", row.id).eq("status", "pending");
    await admin.from("document_operation_events").insert({ studio_id: row.studio_id, assignment_id: row.id, event_type: overdue ? "overdue_reminder_queued" : "due_soon_reminder_queued", summary: overdue ? "Overdue signature reminder queued." : "Due-soon signature reminder queued." });
    queued++;
  }
  return { scanned: data?.length ?? 0, queued, skipped, failed };
}
