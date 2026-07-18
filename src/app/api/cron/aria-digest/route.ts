import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCronAuthFailure } from "@/lib/security/cron";

type DigestType = "morning" | "end_of_day";
type DigestPreferenceRow = {
  studio_id: string;
  morning_digest_enabled: boolean | null;
  end_of_day_digest_enabled: boolean | null;
  delivery_channel: string | null;
  default_recipient_user_id: string | null;
  morning_digest_time: string | null;
  end_of_day_digest_time: string | null;
};

type DigestActionRow = {
  id: string;
  title: string;
  body: string | null;
  status: string | null;
  priority: string | null;
  rule_key: string | null;
  due_at: string | null;
  assigned_to: string | null;
  created_at: string;
};

type DigestStudioRow = {
  id: string;
  name: string | null;
  public_name: string | null;
  timezone: string | null;
};

type DigestProfileRow = {
  id: string;
  full_name: string | null;
  email: string | null;
};

const ACTIVE_ACTION_STATUSES = [
  "suggested",
  "drafted",
  "approved",
  "queued",
  "snoozed",
] as const;

function getLocalDateTimeParts(now: Date, timezone: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);

    const valueByType = new Map(
      parts.map((part) => [part.type, part.value]),
    );
    const year = valueByType.get("year");
    const month = valueByType.get("month");
    const day = valueByType.get("day");
    const hour = valueByType.get("hour");
    const minute = valueByType.get("minute");

    if (!year || !month || !day || !hour || !minute) {
      throw new Error("Timezone parts were incomplete.");
    }

    return {
      dateKey: `${year}-${month}-${day}`,
      timeValue: `${hour}:${minute}`,
    };
  } catch {
    const utcYear = now.getUTCFullYear();
    const utcMonth = String(now.getUTCMonth() + 1).padStart(2, "0");
    const utcDay = String(now.getUTCDate()).padStart(2, "0");
    const utcHour = String(now.getUTCHours()).padStart(2, "0");
    const utcMinute = String(now.getUTCMinutes()).padStart(2, "0");

    return {
      dateKey: `${utcYear}-${utcMonth}-${utcDay}`,
      timeValue: `${utcHour}:${utcMinute}`,
    };
  }
}

function timeToMinutes(value: string | null | undefined) {
  if (!value || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function isDigestDue(params: {
  preference: DigestPreferenceRow;
  digestType: DigestType;
  localTimeValue: string;
  forceDigestType: DigestType | null;
}) {
  const { preference, digestType, localTimeValue, forceDigestType } = params;

  if (forceDigestType) {
    return forceDigestType === digestType;
  }

  const enabled =
    digestType === "morning"
      ? preference.morning_digest_enabled === true
      : preference.end_of_day_digest_enabled === true;

  if (!enabled) return false;

  const configuredTime =
    digestType === "morning"
      ? preference.morning_digest_time ?? "08:00"
      : preference.end_of_day_digest_time ?? "17:00";
  const targetMinutes = timeToMinutes(configuredTime);
  const currentMinutes = timeToMinutes(localTimeValue);

  if (targetMinutes === null || currentMinutes === null) return false;

  const elapsed = currentMinutes - targetMinutes;
  return elapsed >= 0 && elapsed < 30;
}

function isOverdueAction(action: DigestActionRow, now: Date) {
  const value = action.due_at ?? action.created_at;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const actionDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return actionDay < today;
}

function studioDisplayName(studio: DigestStudioRow | null) {
  return studio?.public_name || studio?.name || "your studio";
}

function digestTypeLabel(digestType: DigestType) {
  return digestType === "morning" ? "Morning briefing" : "End-of-day carryover";
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildDigestSummary(params: {
  actions: DigestActionRow[];
  recipientUserId: string | null;
  digestType: DigestType;
  now: Date;
}) {
  const { actions, recipientUserId, digestType, now } = params;
  const overdueActions = actions.filter((action) => isOverdueAction(action, now));
  const assignedActions = recipientUserId
    ? actions.filter((action) => action.assigned_to === recipientUserId)
    : [];
  const queuedActions = actions.filter((action) => action.status === "queued");
  const urgentActions = actions.filter((action) => action.priority === "urgent");
  const highPriorityActions = actions.filter((action) => action.priority === "high");
  const topActions = [...overdueActions, ...urgentActions, ...highPriorityActions, ...actions]
    .filter((action, index, list) => list.findIndex((candidate) => candidate.id === action.id) === index)
    .slice(0, 6)
    .map((action) => ({
      id: action.id,
      title: action.title,
      status: action.status,
      priority: action.priority,
      rule_key: action.rule_key,
      due_at: action.due_at,
    }));

  return {
    digest_type: digestType,
    open_actions: actions.length,
    overdue_actions: overdueActions.length,
    assigned_to_recipient: assignedActions.length,
    queued_followups: queuedActions.length,
    urgent_actions: urgentActions.length,
    high_priority_actions: highPriorityActions.length,
    top_actions: topActions,
  };
}

function buildDigestBody(params: {
  studioName: string;
  digestType: DigestType;
  summary: ReturnType<typeof buildDigestSummary>;
}) {
  const { studioName, digestType, summary } = params;
  const topActionLines = summary.top_actions.length
    ? summary.top_actions
        .map((action, index) => `${index + 1}. ${action.title} (${action.priority ?? "normal"}, ${action.status ?? "open"})`)
        .join("\n")
    : "No open ARIA actions are currently standing out.";

  return `${digestTypeLabel(digestType)} for ${studioName}

ARIA operations summary:
- Open actions: ${summary.open_actions}
- Overdue actions: ${summary.overdue_actions}
- Assigned to recipient: ${summary.assigned_to_recipient}
- Queued follow-ups: ${summary.queued_followups}
- Urgent actions: ${summary.urgent_actions}
- High-priority actions: ${summary.high_priority_actions}

Top actions:
${topActionLines}

Open ARIA Operations:
${(process.env.NEXT_PUBLIC_SITE_URL || "https://www.idanceflow.com").replace(/\/$/, "")}/app/aria/operations`;
}

function buildDigestHtml(params: {
  studioName: string;
  digestType: DigestType;
  summary: ReturnType<typeof buildDigestSummary>;
}) {
  const { studioName, digestType, summary } = params;
  const operationsUrl = `${(process.env.NEXT_PUBLIC_SITE_URL || "https://www.idanceflow.com").replace(/\/$/, "")}/app/aria/operations`;
  const briefingLabel = digestTypeLabel(digestType);
  const intro =
    digestType === "morning"
      ? "Here is the studio work that deserves attention today."
      : "Here is what remains open and should carry into the next workday.";


  const actionRows = summary.top_actions.length
    ? summary.top_actions
        .map(
          (action, index) => `
            <tr>
              <td style="padding:12px 0;border-bottom:1px solid #e2e8f0;vertical-align:top;">
                <div style="display:inline-block;width:26px;height:26px;border-radius:999px;background:#fce7f3;color:#9d174d;text-align:center;line-height:26px;font-size:12px;font-weight:800;">
                  ${index + 1}
                </div>
              </td>
              <td style="padding:12px 0 12px 10px;border-bottom:1px solid #e2e8f0;">
                <div style="font-size:14px;font-weight:700;color:#0f172a;">
                  ${escapeHtml(action.title)}
                </div>
                <div style="margin-top:4px;font-size:12px;color:#64748b;">
                  ${escapeHtml(action.priority ?? "normal")} priority · ${escapeHtml(action.status ?? "open")}
                </div>
              </td>
            </tr>`,
        )
        .join("")
    : `
      <tr>
        <td style="padding:18px;border:1px dashed #cbd5e1;border-radius:14px;background:#f8fafc;font-size:14px;color:#64748b;">
          No open ARIA actions are currently standing out.
        </td>
      </tr>`;

  return `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #e2e8f0;border-radius:20px;overflow:hidden;">
            <tr>
              <td style="padding:28px;background:linear-gradient(135deg,#4c1d95,#be185d);color:#ffffff;">
                <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.14em;opacity:.88;">
                  ARIA Operations
                </div>
                <h1 style="margin:10px 0 0;font-size:28px;line-height:1.2;color:#ffffff;">
                  ${escapeHtml(briefingLabel)}
                </h1>
                <p style="margin:8px 0 0;font-size:15px;line-height:1.6;color:#fdf2f8;">
                  ${escapeHtml(studioName)}
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:26px 28px 8px;">
                <p style="margin:0;font-size:16px;line-height:1.65;color:#334155;">
                  ${escapeHtml(intro)}
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:10px 22px 18px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    ${[
                      { label: "Open actions", value: summary.open_actions },
                      { label: "Overdue", value: summary.overdue_actions },
                    ].map((metric) => `
                      <td style="width:50%;padding:6px;">
                        <div style="border:1px solid #e2e8f0;border-radius:14px;background:#ffffff;padding:16px;">
                          <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#64748b;">${escapeHtml(metric.label)}</div>
                          <div style="margin-top:6px;font-size:28px;line-height:1;font-weight:800;color:#0f172a;">${metric.value}</div>
                        </div>
                      </td>`).join("")}
                  </tr>
                  <tr>
                    ${[
                      { label: "Assigned to you", value: summary.assigned_to_recipient },
                      { label: "Queued follow-ups", value: summary.queued_followups },
                    ].map((metric) => `
                      <td style="width:50%;padding:6px;">
                        <div style="border:1px solid #e2e8f0;border-radius:14px;background:#ffffff;padding:16px;">
                          <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#64748b;">${escapeHtml(metric.label)}</div>
                          <div style="margin-top:6px;font-size:28px;line-height:1;font-weight:800;color:#0f172a;">${metric.value}</div>
                        </div>
                      </td>`).join("")}
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:6px 28px 12px;">
                <div style="border-radius:14px;background:#fff7ed;border:1px solid #fed7aa;padding:14px 16px;font-size:13px;color:#9a3412;">
                  <strong>${summary.urgent_actions} urgent</strong> · ${summary.high_priority_actions} high-priority
                </div>
              </td>
            </tr>

            <tr>
              <td style="padding:16px 28px 8px;">
                <h2 style="margin:0;font-size:18px;color:#0f172a;">Top actions</h2>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:8px;">
                  ${actionRows}
                </table>
              </td>
            </tr>

            <tr>
              <td align="center" style="padding:24px 28px 30px;">
                <a href="${operationsUrl}" style="display:inline-block;border-radius:12px;background:#be185d;color:#ffffff;text-decoration:none;font-size:14px;font-weight:800;padding:13px 20px;">
                  Open ARIA Operations
                </a>
              </td>
            </tr>

            <tr>
              <td style="padding:18px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;line-height:1.6;color:#64748b;">
                This briefing was prepared automatically from your current DanceFlow operations data.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function processDigestRun(params: {
  preference: DigestPreferenceRow;
  digestType: DigestType;
  digestDate: string;
  now: Date;
}) {
  const { preference, digestType, digestDate, now } = params;
  const adminSupabase = createAdminClient();
  const deliveryChannel = preference.delivery_channel === "email" ? "email" : "in_app";
  const recipientUserId = preference.default_recipient_user_id ?? null;

  const { data: insertedRun, error: runInsertError } = await adminSupabase
    .from("aria_digest_runs")
    .insert({
      studio_id: preference.studio_id,
      digest_type: digestType,
      digest_date: digestDate,
      delivery_channel: deliveryChannel,
      recipient_user_id: recipientUserId,
      status: "processing",
      summary: {},
    })
    .select("id")
    .single<{ id: string }>();

  if (runInsertError) {
    if (runInsertError.code === "23505") {
      return { status: "duplicate" as const };
    }

    throw new Error(runInsertError.message);
  }

  const runId = insertedRun.id;

  try {
    const [{ data: studio }, { data: actions, error: actionsError }, { data: profile }] = await Promise.all([
      adminSupabase
        .from("studios")
        .select("id, name, public_name, timezone")
        .eq("id", preference.studio_id)
        .maybeSingle<DigestStudioRow>(),
      adminSupabase
        .from("automation_actions")
        .select("id, title, body, status, priority, rule_key, due_at, assigned_to, created_at")
        .eq("studio_id", preference.studio_id)
        .in("status", [...ACTIVE_ACTION_STATUSES])
        .order("due_at", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: true })
        .limit(200),
      recipientUserId
        ? adminSupabase
            .from("profiles")
            .select("id, full_name, email")
            .eq("id", recipientUserId)
            .maybeSingle<DigestProfileRow>()
        : Promise.resolve({ data: null }),
    ]);

    if (actionsError) {
      throw new Error(actionsError.message);
    }

    const typedActions = (actions ?? []) as DigestActionRow[];
    const summary = buildDigestSummary({
      actions: typedActions,
      recipientUserId,
      digestType,
      now,
    });
    const recipientEmail = (profile as DigestProfileRow | null)?.email?.trim() || null;
    const studioName = studioDisplayName((studio ?? null) as DigestStudioRow | null);

    if (deliveryChannel === "email") {
      if (!recipientEmail) {
        await adminSupabase
          .from("aria_digest_runs")
          .update({
            status: "skipped",
            summary,
            error_message: "Email digest skipped because no recipient email was available.",
            processed_at: now.toISOString(),
          })
          .eq("id", runId);

        return { status: "skipped" as const };
      }

      const subject = `${studioName}: ${digestTypeLabel(digestType)}`;
      const bodyText = buildDigestBody({ studioName, digestType, summary });
      const { data: delivery, error: deliveryError } = await adminSupabase
        .from("outbound_deliveries")
        .insert({
          studio_id: preference.studio_id,
          channel: "email",
          template_key: `aria_digest_${digestType}`,
          recipient_email: recipientEmail,
          recipient_phone: null,
          subject,
          body_text: bodyText,
          body_html: buildDigestHtml({ studioName, digestType, summary }),
          related_table: null,
          related_id: null,
          dedupe_key: `aria-digest:${preference.studio_id}:${digestDate}:${digestType}`,
          status: "queued",
          updated_at: now.toISOString(),
        })
        .select("id")
        .single<{ id: string }>();

      if (deliveryError) {
        throw new Error(deliveryError.message);
      }

      await adminSupabase
        .from("aria_digest_runs")
        .update({
          status: "queued",
          summary,
          recipient_email: recipientEmail,
          delivery_id: delivery.id,
          retry_count: 0,
          last_attempt_at: null,
          next_attempt_at: now.toISOString(),
          processed_at: now.toISOString(),
        })
        .eq("id", runId);

      return { status: "queued" as const };
    }

    await adminSupabase
      .from("aria_digest_runs")
      .update({
        status: "prepared",
        summary,
        recipient_email: recipientEmail,
        processed_at: now.toISOString(),
      })
      .eq("id", runId);

    return { status: "prepared" as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : "ARIA digest delivery failed";
    await adminSupabase
      .from("aria_digest_runs")
      .update({
        status: "failed",
        error_message: message.slice(0, 1000),
        processed_at: now.toISOString(),
      })
      .eq("id", runId);

    throw error;
  }
}

async function handleDigestRequest(request: NextRequest) {
  const authFailure = getCronAuthFailure(request);
  if (authFailure) return authFailure;

  const url = new URL(request.url);
  const forceParam = url.searchParams.get("force");
  const forceDigestType: DigestType | null =
    forceParam === "morning" || forceParam === "end_of_day" ? forceParam : null;
  const forceStudioId = url.searchParams.get("studio_id")?.trim() || null;
  const now = new Date();
  const adminSupabase = createAdminClient();

  const [
    { data: preferences, error: preferencesError },
    { data: studios, error: studiosError },
  ] = await Promise.all([
    adminSupabase
      .from("aria_digest_preferences")
      .select(
        "studio_id, morning_digest_enabled, end_of_day_digest_enabled, delivery_channel, default_recipient_user_id, morning_digest_time, end_of_day_digest_time",
      ),
    adminSupabase.from("studios").select("id, timezone"),
  ]);

  if (preferencesError || studiosError) {
    return NextResponse.json(
      {
        error:
          preferencesError?.message ||
          studiosError?.message ||
          "Failed to load ARIA digest schedule inputs.",
      },
      { status: 500 },
    );
  }

  const timezoneByStudioId = new Map(
    ((studios ?? []) as Array<{ id: string; timezone: string | null }>).map(
      (studio) => [studio.id, studio.timezone || "UTC"],
    ),
  );

  const dueJobs = ((preferences ?? []) as DigestPreferenceRow[])
    .filter((preference) => !forceStudioId || preference.studio_id === forceStudioId)
    .flatMap((preference) => {
      const timezone = timezoneByStudioId.get(preference.studio_id) || "UTC";
      const local = getLocalDateTimeParts(now, timezone);
      const jobs: Array<{
        preference: DigestPreferenceRow;
        digestType: DigestType;
        digestDate: string;
        timezone: string;
      }> = [];

      if (
        isDigestDue({
          preference,
          digestType: "morning",
          localTimeValue: local.timeValue,
          forceDigestType,
        })
      ) {
        jobs.push({
          preference,
          digestType: "morning",
          digestDate: local.dateKey,
          timezone,
        });
      }

      if (
        isDigestDue({
          preference,
          digestType: "end_of_day",
          localTimeValue: local.timeValue,
          forceDigestType,
        })
      ) {
        jobs.push({
          preference,
          digestType: "end_of_day",
          digestDate: local.dateKey,
          timezone,
        });
      }

      return jobs;
    },
  );

  const totals = {
    due: dueJobs.length,
    prepared: 0,
    queued: 0,
    skipped: 0,
    duplicates: 0,
    failed: 0,
  };

  for (const job of dueJobs) {
    try {
      const result = await processDigestRun({
        preference: job.preference,
        digestType: job.digestType,
        digestDate: job.digestDate,
        now,
      });

      if (result.status === "prepared") totals.prepared += 1;
      if (result.status === "queued") totals.queued += 1;
      if (result.status === "skipped") totals.skipped += 1;
      if (result.status === "duplicate") totals.duplicates += 1;
    } catch (error) {
      totals.failed += 1;
      console.error("ARIA digest delivery failed", {
        error,
        studioId: job.preference.studio_id,
        digestType: job.digestType,
        digestDate: job.digestDate,
        timezone: job.timezone,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    force: forceDigestType,
    forceStudioId,
    evaluatedAt: now.toISOString(),
    totals,
  });
}

export async function GET(request: NextRequest) {
  return handleDigestRequest(request);
}

export async function POST(request: NextRequest) {
  return handleDigestRequest(request);
}