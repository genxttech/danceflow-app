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

function currentDateKey(now: Date) {
  return now.toISOString().slice(0, 10);
}

function currentTimeValue(now: Date) {
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function timeToMinutes(value: string | null | undefined) {
  if (!value || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function isDigestDue(params: {
  preference: DigestPreferenceRow;
  digestType: DigestType;
  now: Date;
  forceDigestType: DigestType | null;
}) {
  const { preference, digestType, now, forceDigestType } = params;

  if (forceDigestType) {
    return forceDigestType === digestType;
  }

  const enabled =
    digestType === "morning"
      ? preference.morning_digest_enabled !== false
      : preference.end_of_day_digest_enabled !== false;

  if (!enabled) return false;

  const configuredTime =
    digestType === "morning"
      ? preference.morning_digest_time ?? "08:00"
      : preference.end_of_day_digest_time ?? "17:00";
  const targetMinutes = timeToMinutes(configuredTime);
  const currentMinutes = timeToMinutes(currentTimeValue(now));

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

function renderPlainTextAsHtml(bodyText: string) {
  const escaped = bodyText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return escaped
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br />")}</p>`)
    .join("");
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
        .select("id, name, public_name")
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
          body_html: renderPlainTextAsHtml(bodyText),
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
  const now = new Date();
  const digestDate = currentDateKey(now);
  const adminSupabase = createAdminClient();

  const { data: preferences, error } = await adminSupabase
    .from("aria_digest_preferences")
    .select(
      "studio_id, morning_digest_enabled, end_of_day_digest_enabled, delivery_channel, default_recipient_user_id, morning_digest_time, end_of_day_digest_time",
    );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const dueJobs = ((preferences ?? []) as DigestPreferenceRow[]).flatMap((preference) => {
    const jobs: Array<{ preference: DigestPreferenceRow; digestType: DigestType }> = [];

    if (isDigestDue({ preference, digestType: "morning", now, forceDigestType })) {
      jobs.push({ preference, digestType: "morning" });
    }

    if (isDigestDue({ preference, digestType: "end_of_day", now, forceDigestType })) {
      jobs.push({ preference, digestType: "end_of_day" });
    }

    return jobs;
  });

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
        digestDate,
        now,
      });

      if (result.status === "prepared") totals.prepared += 1;
      if (result.status === "queued") totals.queued += 1;
      if (result.status === "skipped") totals.skipped += 1;
      if (result.status === "duplicate") totals.duplicates += 1;
    } catch (error) {
      totals.failed += 1;
      console.error("ARIA digest delivery failed", error);
    }
  }

  return NextResponse.json({ ok: true, digestDate, force: forceDigestType, totals });
}

export async function GET(request: NextRequest) {
  return handleDigestRequest(request);
}

export async function POST(request: NextRequest) {
  return handleDigestRequest(request);
}
