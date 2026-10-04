import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { queueOutboundDelivery } from "@/lib/notifications/outbound";
import { buildGroupClassSeriesCancellationEmail } from "@/lib/notifications/scheduling-emails";
import { sendGroupClassSeriesCancellationPush } from "@/lib/notifications/schedulePush";
import type { GroupClassSeriesCancelResult } from "@/lib/schedule/groupClassSeriesCancel";

const DEFAULT_TIME_ZONE = "America/New_York";

function formatClassTime(value: string, timeZone: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/**
 * GC-S1C-4: consolidated notifications for "This and following classes". Runs AFTER the cancellation
 * transaction has committed and never throws -- a delivery problem is logged and cannot undo the
 * cancellation. Recipients are exactly the clients the RPC cancelled (never re-derived or client
 * supplied); each distinct email address gets ONE email listing all of that person's cancelled
 * classes, and each portal account gets at most one push. Returns the number of emails queued.
 */
export async function notifySeriesCancellation(params: {
  supabase: SupabaseClient;
  anchorAppointmentId: string;
  result: GroupClassSeriesCancelResult;
}): Promise<number> {
  const { supabase, anchorAppointmentId, result } = params;
  if (result.recipients.length === 0) return 0;
  const studioId = result.studioId;
  let queued = 0;

  try {
    const admin = createAdminClient();
    const clientIds = result.recipients.map((r) => r.clientId);

    const [{ data: clients }, { data: studio }, { data: settings }, { data: anchor }] = await Promise.all([
      admin.from("clients").select("id, first_name, email").eq("studio_id", studioId).in("id", clientIds),
      admin.from("studios").select("name, public_name, public_logo_url, slug").eq("id", studioId).maybeSingle(),
      admin.from("studio_settings").select("timezone").eq("studio_id", studioId).maybeSingle(),
      admin.from("appointments").select("title").eq("id", anchorAppointmentId).eq("studio_id", studioId).maybeSingle(),
    ]);

    const timeZone = (settings as { timezone?: string | null } | null)?.timezone || DEFAULT_TIME_ZONE;
    const classTitle = ((anchor as { title?: string | null } | null)?.title ?? "").trim() || "Group class";
    const startsByClient = new Map(result.recipients.map((r) => [r.clientId, r.classStarts]));

    // Dedupe by normalized email: one letter per address, merging every affected client behind it.
    const byEmail = new Map<string, { firstName: string | null; starts: Set<string> }>();
    for (const client of (clients ?? []) as Array<{ id: string; first_name: string | null; email: string | null }>) {
      const email = client.email?.trim().toLowerCase();
      if (!email) continue;
      const entry = byEmail.get(email) ?? { firstName: client.first_name, starts: new Set<string>() };
      (startsByClient.get(client.id) ?? []).forEach((start) => entry.starts.add(start));
      byEmail.set(email, entry);
    }

    for (const [email, entry] of byEmail) {
      try {
        const classTimes = Array.from(entry.starts)
          .sort()
          .map((start) => formatClassTime(start, timeZone))
          .filter(Boolean);
        if (classTimes.length === 0) continue;
        const built = buildGroupClassSeriesCancellationEmail({
          studio: (studio as Record<string, string | null> | null) ?? {},
          firstName: entry.firstName,
          classTitle,
          classTimes,
        });
        const outcome = await queueOutboundDelivery({
          studioId,
          channel: "email",
          templateKey: "group_class_series_cancelled",
          recipientEmail: email,
          subject: built.subject,
          bodyText: built.bodyText,
          bodyHtml: built.bodyHtml,
          relatedTable: "group_class_series",
          relatedId: result.seriesId,
          dedupeKey: `group_class_series_cancelled:${result.seriesId}:${Array.from(entry.starts).sort()[0]}:${email}`,
        });
        if (outcome.queued) queued += 1;
      } catch (error) {
        console.error("Series cancelled, but one cancellation email could not be queued:", error);
      }
    }
  } catch (error) {
    console.error("Series cancelled, but cancellation emails failed:", error);
  }

  try {
    await sendGroupClassSeriesCancellationPush({
      supabase,
      studioId,
      anchorAppointmentId,
      recipients: result.recipients,
    });
  } catch (error) {
    console.error("Series cancelled, but cancellation push failed:", error);
  }

  return queued;
}
