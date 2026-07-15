import { createAdminClient } from "@/lib/supabase/admin";
import { getCronAuthFailure } from "@/lib/security/cron";
import {
  createAndQueueAccountantDelivery,
  getAccountantPeriodKey,
  getNextScheduleRun,
  type AccountantDeliveryRange,
} from "@/lib/accountant-deliveries/deliveries";

export async function POST(request: Request) {
  const authFailure = getCronAuthFailure(request);
  if (authFailure) return authFailure;

  const supabase = createAdminClient();
  const now = new Date();
  const nowIso = now.toISOString();
  const { data: schedules, error } = await supabase
    .from("studio_accountant_delivery_schedules")
    .select("id,studio_id,accountant_profile_id,cadence,report_types,report_range,next_run_at,consecutive_failures")
    .eq("enabled", true)
    .eq("first_send_approved", true)
    .lte("next_run_at", nowIso)
    .order("next_run_at", { ascending: true })
    .limit(50);

  if (error) return Response.json({ ok: false, error: "Failed to load accountant delivery schedules." }, { status: 500 });

  let queued = 0;
  let skipped = 0;
  let failed = 0;

  for (const schedule of schedules ?? []) {
    const range = schedule.report_range as AccountantDeliveryRange;
    const periodKey = getAccountantPeriodKey(range, now);
    try {
      const { data: existing } = await supabase
        .from("studio_accountant_deliveries")
        .select("id")
        .eq("schedule_id", schedule.id)
        .eq("period_key", periodKey)
        .maybeSingle();

      if (existing) {
        skipped += 1;
      } else {
        const { data: profile, error: profileError } = await supabase
          .from("studio_accountant_profiles")
          .select("id,accountant_name,email,active,authorized_to_receive_exports,preferred_export_types")
          .eq("id", schedule.accountant_profile_id)
          .eq("studio_id", schedule.studio_id)
          .maybeSingle();
        if (profileError || !profile) throw new Error("Accountant profile is unavailable.");

        const deliveryId = await createAndQueueAccountantDelivery({
          supabase,
          studioId: schedule.studio_id,
          profile,
          reportTypes: schedule.report_types ?? [],
          reportRange: range,
          scheduleId: schedule.id,
          periodKey,
        });
        queued += 1;
        await supabase.from("studio_accountant_delivery_schedules").update({
          last_delivery_id: deliveryId,
          last_run_at: nowIso,
          last_error: null,
          consecutive_failures: 0,
          next_run_at: getNextScheduleRun(schedule.cadence, now).toISOString(),
          updated_at: nowIso,
        }).eq("id", schedule.id);
        continue;
      }

      await supabase.from("studio_accountant_delivery_schedules").update({
        last_run_at: nowIso,
        last_error: null,
        next_run_at: getNextScheduleRun(schedule.cadence, now).toISOString(),
        updated_at: nowIso,
      }).eq("id", schedule.id);
    } catch (caught) {
      failed += 1;
      const message = caught instanceof Error ? caught.message.slice(0, 1000) : "Unknown accountant delivery schedule failure.";
      const failures = Number((schedule as { consecutive_failures?: number }).consecutive_failures ?? 0) + 1;
      await supabase.from("studio_accountant_delivery_schedules").update({
        last_run_at: nowIso,
        last_error: message,
        consecutive_failures: failures,
        next_run_at: new Date(now.getTime() + Math.min(failures, 6) * 60 * 60 * 1000).toISOString(),
        updated_at: nowIso,
      }).eq("id", schedule.id);
    }
  }

  return Response.json({ ok: true, processed: (schedules ?? []).length, queued, skipped, failed });
}

export async function GET(request: Request) {
  return POST(request);
}
