"use server";

import { checkRateLimit, getServerActionRateLimitKey, rateLimitErrorMessage } from "@/lib/security/rate-limit";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { canManageSettings } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type AutomationDefinition = {
  key: string;
  name: string;
  description: string;
  triggerKey: string;
  actionKey: string;
  defaultTriggerConfig: Record<string, unknown>;
  defaultActionConfig: Record<string, unknown>;
};

type AutomationTemplateDefault = {
  ruleKey: string;
  subject: string;
  bodyText: string;
  variables: string[];
};

type AutomationEmailTemplateRow = {
  rule_key: string;
  subject: string | null;
  body_text: string | null;
};

const AUTOMATION_DEFINITIONS: AutomationDefinition[] = [
  {
    key: "low_package_balance",
    name: "Low package balance renewal",
    description:
      "Find clients with low lesson balances and prepare a renewal recommendation before they run out.",
    triggerKey: "package_balance_below_threshold",
    actionKey: "suggest_package_renewal",
    defaultTriggerConfig: { threshold: 2 },
    defaultActionConfig: { channel: "email", approval_required: true },
  },
  {
    key: "no_upcoming_lesson",
    name: "No upcoming lesson rebooking",
    description:
      "Find active clients without a future lesson and suggest a rebooking prompt with their portal schedule link.",
    triggerKey: "client_has_no_future_appointment",
    actionKey: "suggest_rebooking_request",
    defaultTriggerConfig: { lookback_days: 90 },
    defaultActionConfig: { suggest_usual_time: true, approval_required: true },
  },
  {
    key: "unsigned_document",
    name: "Unsigned document reminder",
    description:
      "Find clients or event attendees with required documents still unsigned and create a reminder action.",
    triggerKey: "required_document_unsigned",
    actionKey: "suggest_document_reminder",
    defaultTriggerConfig: { due_within_days: 7 },
    defaultActionConfig: { approval_required: true },
  },
  {
    key: "pending_booking_request",
    name: "Pending booking request reminder",
    description:
      "Alert staff when a public or portal booking request has not been reviewed quickly enough.",
    triggerKey: "booking_request_pending_too_long",
    actionKey: "create_staff_review_reminder",
    defaultTriggerConfig: { pending_hours: 24 },
    defaultActionConfig: { priority: "high" },
  },
  {
    key: "first_lesson_follow_up",
    name: "First lesson follow-up",
    description:
      "Create a follow-up suggestion after a client completes their first lesson.",
    triggerKey: "first_lesson_completed",
    actionKey: "suggest_first_lesson_follow_up",
    defaultTriggerConfig: { after_hours: 24, lookback_days: 14 },
    defaultActionConfig: { approval_required: true },
  },
];

const AUTOMATION_TEMPLATE_DEFAULTS: AutomationTemplateDefault[] = [
  {
    ruleKey: "low_package_balance",
    subject: "{{studio_name}}: renew your lesson package",
    bodyText: `Hi {{client_first_name}},

You are getting close to the end of your current lesson package.

When you are ready, you can renew your package through your client portal or contact us and we can help you choose the best option.

Client portal: {{portal_link}}

Thank you,
{{studio_name}}`,
    variables: [
      "client_first_name",
      "client_name",
      "studio_name",
      "portal_link",
    ],
  },
  {
    ruleKey: "no_upcoming_lesson",
    subject: "{{studio_name}}: request your next lesson time",
    bodyText: `Hi {{client_first_name}},

We noticed you do not currently have your next lesson scheduled.

You can request your next lesson time from your client portal, or reply to this email and we can help you find a time.

Request your next lesson: {{schedule_link}}

Thank you,
{{studio_name}}`,
    variables: [
      "client_first_name",
      "client_name",
      "studio_name",
      "schedule_link",
      "portal_link",
    ],
  },
  {
    ruleKey: "unsigned_document",
    subject: "{{studio_name}}: document signature needed",
    bodyText: `Hi {{client_first_name}},

You have a document that still needs your signature before your next studio activity.

Please open your client portal to review and sign it when you have a moment.

Documents: {{documents_link}}

Thank you,
{{studio_name}}`,
    variables: [
      "client_first_name",
      "client_name",
      "studio_name",
      "documents_link",
      "portal_link",
    ],
  },
  {
    ruleKey: "pending_booking_request",
    subject: "{{studio_name}}: we received your lesson request",
    bodyText: `Hi {{client_first_name}},

We received your lesson request{{requested_time_sentence}}.

Our team is reviewing it and will follow up with you soon. If you need to adjust the requested time, you can reply to this email.

Thank you,
{{studio_name}}`,
    variables: [
      "client_first_name",
      "client_name",
      "studio_name",
      "requested_time",
    ],
  },
  {
    ruleKey: "first_lesson_follow_up",
    subject: "{{studio_name}}: thanks for your first lesson",
    bodyText: `Hi {{client_first_name}},

Thank you for joining us for your first lesson. We hope you had a great time on the floor.

When you are ready, you can request your next lesson from your client portal or reply here and we can help you schedule.

Request your next lesson: {{schedule_link}}

Thank you,
{{studio_name}}`,
    variables: [
      "client_first_name",
      "client_name",
      "studio_name",
      "schedule_link",
      "portal_link",
    ],
  },
];

function getAutomationTemplateDefault(ruleKey: string) {
  return (
    AUTOMATION_TEMPLATE_DEFAULTS.find(
      (template) => template.ruleKey === ruleKey,
    ) ?? null
  );
}

function getAutomationVariableValues(params: {
  client: DraftClientRow | null;
  studio: DraftStudioRow | null;
  bookingRequest?: DraftBookingRequestRow | null;
}) {
  const { client, studio, bookingRequest } = params;
  const studioName = getStudioDisplayName(studio);
  const clientName =
    compactName(client?.first_name, client?.last_name) ||
    compactName(
      bookingRequest?.customer_first_name,
      bookingRequest?.customer_last_name,
    );
  const firstName =
    client?.first_name ||
    bookingRequest?.customer_first_name ||
    clientName.split(" ")[0] ||
    "";
  const portalUrl = getPortalUrl(studio);
  const scheduleUrl = getPortalUrl(studio, "/schedule");
  const documentsUrl = getPortalUrl(studio, "/documents");
  const requestedTime =
    formatDraftDateTime(bookingRequest?.requested_starts_at) ?? "";
  return {
    studio_name: studioName,
    client_name: clientName || "there",
    client_first_name: firstName || "there",
    portal_link: portalUrl,
    schedule_link: scheduleUrl,
    documents_link: documentsUrl,
    requested_time: requestedTime,
    requested_time_sentence: requestedTime ? ` for ${requestedTime}` : "",
  };
}

function applyAutomationTemplate(
  content: string,
  values: Record<string, string>,
) {
  return content.replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (_match, key: string) => {
      return values[key] ?? "";
    },
  );
}

function getDefinition(ruleKey: string) {
  return AUTOMATION_DEFINITIONS.find(
    (definition) => definition.key === ruleKey,
  );
}

export async function updateAutomationRuleAction(formData: FormData) {
  const ruleKey = String(formData.get("ruleKey") ?? "");
  const enabled = formData.get("enabled") === "on";
  const modeInput = String(formData.get("mode") ?? "suggestion");
  const mode = ["suggestion", "draft", "auto_send"].includes(modeInput)
    ? modeInput
    : "suggestion";

  const definition = getDefinition(ruleKey);

  if (!definition) {
    redirect("/app/automations?error=unknown-rule");
  }

  const context = await getCurrentStudioContext();

  if (!canManageSettings(context.studioRole ?? "")) {
    redirect("/app/automations?error=not-authorized");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase.from("automation_rules").upsert(
    {
      studio_id: context.studioId,
      rule_key: definition.key,
      name: definition.name,
      description: definition.description,
      trigger_key: definition.triggerKey,
      action_key: definition.actionKey,
      enabled,
      mode,
      trigger_config: definition.defaultTriggerConfig,
      action_config: definition.defaultActionConfig,
      updated_by: user?.id ?? null,
      created_by: user?.id ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "studio_id,rule_key" },
  );

  if (error) {
    redirect(`/app/automations?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/app/automations");
  revalidatePath("/app/automations/drafts");
  revalidatePath("/app");
  redirect("/app/automations?success=updated");
}

export async function dismissAutomationAction(formData: FormData) {
  const actionId = String(formData.get("actionId") ?? "");

  if (!actionId) {
    return;
  }

  const context = await getCurrentStudioContext();

  if (!canManageSettings(context.studioRole ?? "")) {
    return;
  }

  const supabase = await createClient();
  const now = new Date().toISOString();

  const { data: existingAction } = await supabase
    .from("automation_actions")
    .select("id, status")
    .eq("id", actionId)
    .eq("studio_id", context.studioId)
    .maybeSingle<{ id: string; status: string | null }>();

  await supabase
    .from("automation_actions")
    .update({
      status: "dismissed",
      dismissed_at: now,
      dismissed_by: context.userId,
      reviewed_at: now,
      reviewed_by: context.userId,
      updated_at: now,
    })
    .eq("id", actionId)
    .eq("studio_id", context.studioId)
    .in("status", ["suggested", "drafted", "approved", "queued", "snoozed"]);

  if (existingAction) {
    await supabase.from("automation_action_events").insert({
      studio_id: context.studioId,
      automation_action_id: actionId,
      event_type: "dismissed",
      previous_status: existingAction.status,
      new_status: "dismissed",
      created_by: context.userId,
    });
  }

  revalidatePath("/app/automations");
  revalidatePath("/app/automations/drafts");
  revalidatePath("/app/aria");
  revalidatePath("/app/aria/operations");
}

export async function completeAutomationAction(formData: FormData) {
  const actionId = String(formData.get("actionId") ?? "");

  if (!actionId) {
    return;
  }

  const context = await getCurrentStudioContext();

  if (!canManageSettings(context.studioRole ?? "")) {
    return;
  }

  const supabase = await createClient();
  const now = new Date().toISOString();

  const { data: existingAction } = await supabase
    .from("automation_actions")
    .select("id, status")
    .eq("id", actionId)
    .eq("studio_id", context.studioId)
    .maybeSingle<{ id: string; status: string | null }>();

  await supabase
    .from("automation_actions")
    .update({
      status: "completed",
      completed_at: now,
      completed_by: context.userId,
      reviewed_at: now,
      reviewed_by: context.userId,
      updated_at: now,
    })
    .eq("id", actionId)
    .eq("studio_id", context.studioId)
    .in("status", ["suggested", "drafted", "approved", "queued", "snoozed"]);

  if (existingAction) {
    await supabase.from("automation_action_events").insert({
      studio_id: context.studioId,
      automation_action_id: actionId,
      event_type: "completed",
      previous_status: existingAction.status,
      new_status: "completed",
      created_by: context.userId,
    });
  }

  revalidatePath("/app/automations");
  revalidatePath("/app/automations/drafts");
  revalidatePath("/app/aria");
  revalidatePath("/app/aria/operations");
}

type AutomationActionReviewStatus =
  "approved" | "completed" | "dismissed" | "skipped" | "snoozed";

function getAutomationActionReviewStatus(
  value: FormDataEntryValue | null,
): AutomationActionReviewStatus | null {
  if (
    value === "approved" ||
    value === "completed" ||
    value === "dismissed" ||
    value === "skipped" ||
    value === "snoozed"
  ) {
    return value;
  }

  return null;
}

function getAutomationActionReturnTo(value: FormDataEntryValue | null) {
  if (typeof value !== "string") return null;

  const returnTo = value.trim();

  if (
    returnTo.startsWith("/app/") &&
    !returnTo.startsWith("//") &&
    !returnTo.includes("://")
  ) {
    return returnTo;
  }

  return null;
}

function appendActionResult(
  url: string,
  key: "success" | "error",
  value: string,
) {
  return `${url}${url.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;
}

function getOptionalReviewNote(value: FormDataEntryValue | null) {
  if (typeof value !== "string") return null;
  const note = value.trim();
  return note.length > 0 ? note.slice(0, 1000) : null;
}

function getSnoozedUntil(value: FormDataEntryValue | null) {
  const preset = typeof value === "string" ? value : "tomorrow";
  const now = new Date();

  if (preset === "three_days") {
    return new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
  }

  if (preset === "next_week") {
    return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  }

  return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
}

function automationActionStatusPayload(params: {
  nextStatus: AutomationActionReviewStatus;
  userId: string;
  now: string;
  reviewNote?: string | null;
  snoozedUntil?: string | null;
}) {
  const { nextStatus, userId, now, reviewNote, snoozedUntil } = params;
  const payload: Record<string, unknown> = {
    status: nextStatus,
    reviewed_at: now,
    reviewed_by: userId,
    updated_at: now,
    snoozed_until: null,
  };

  if (reviewNote) {
    payload.review_note = reviewNote;
  }

  if (nextStatus === "approved") {
    payload.approved_at = now;
    payload.approved_by = userId;
  }

  if (nextStatus === "completed") {
    payload.completed_at = now;
    payload.completed_by = userId;
  }

  if (nextStatus === "dismissed") {
    payload.dismissed_at = now;
    payload.dismissed_by = userId;
  }

  if (nextStatus === "skipped") {
    payload.skipped_at = now;
    payload.skipped_by = userId;
  }

  if (nextStatus === "snoozed") {
    payload.snoozed_until = snoozedUntil;
  }

  return payload;
}

function allowedAutomationActionSourceStatuses(
  nextStatus: AutomationActionReviewStatus,
) {
  if (nextStatus === "approved") {
    return ["suggested", "drafted", "snoozed"];
  }

  if (nextStatus === "completed") {
    return ["suggested", "drafted", "approved", "queued", "snoozed"];
  }

  if (nextStatus === "snoozed") {
    return ["suggested", "drafted", "approved", "queued"];
  }

  return ["suggested", "drafted", "approved", "queued", "snoozed"];
}

export async function updateAutomationActionStatusAction(formData: FormData) {
  const actionId = String(formData.get("actionId") ?? "").trim();
  const nextStatus = getAutomationActionReviewStatus(formData.get("status"));
  const returnTo =
    getAutomationActionReturnTo(formData.get("returnTo")) ??
    "/app/aria/operations";
  const reviewNote = getOptionalReviewNote(formData.get("reviewNote"));
  const snoozedUntil =
    nextStatus === "snoozed"
      ? getSnoozedUntil(formData.get("snoozePreset"))
      : null;

  if (!actionId || !nextStatus) {
    redirect(
      appendActionResult(returnTo, "error", "automation_action_update_failed"),
    );
  }

  const context = await getCurrentStudioContext();

  if (!canManageSettings(context.studioRole ?? "")) {
    redirect(appendActionResult(returnTo, "error", "not-authorized"));
  }

  const supabase = await createClient();

  const { data: existingAction, error: existingError } = await supabase
    .from("automation_actions")
    .select("id, status")
    .eq("id", actionId)
    .eq("studio_id", context.studioId)
    .maybeSingle<{ id: string; status: string | null }>();

  if (existingError || !existingAction) {
    console.error(
      "Automation action status update lookup failed",
      existingError,
    );
    redirect(
      appendActionResult(returnTo, "error", "automation_action_not_found"),
    );
  }

  const allowedCurrentStatuses =
    allowedAutomationActionSourceStatuses(nextStatus);
  const currentStatus = existingAction.status ?? "";

  if (!allowedCurrentStatuses.includes(currentStatus)) {
    redirect(
      appendActionResult(returnTo, "error", "automation_action_status_locked"),
    );
  }

  const now = new Date().toISOString();
  const updatePayload = automationActionStatusPayload({
    nextStatus,
    userId: context.userId,
    now,
    reviewNote,
    snoozedUntil,
  });

  const { data: updatedAction, error: updateError } = await supabase
    .from("automation_actions")
    .update(updatePayload)
    .eq("id", actionId)
    .eq("studio_id", context.studioId)
    .eq("status", currentStatus)
    .select("id, status")
    .maybeSingle<{ id: string; status: string | null }>();

  if (updateError || !updatedAction) {
    console.error("Automation action status update failed", updateError);
    redirect(
      appendActionResult(returnTo, "error", "automation_action_update_failed"),
    );
  }

  const { error: eventError } = await supabase
    .from("automation_action_events")
    .insert({
      studio_id: context.studioId,
      automation_action_id: actionId,
      event_type: nextStatus,
      previous_status: currentStatus,
      new_status: nextStatus,
      note: reviewNote,
      metadata: snoozedUntil ? { snoozed_until: snoozedUntil } : {},
      created_by: context.userId,
    });

  if (eventError) {
    console.warn("Automation action event insert failed", eventError);
  }

  revalidatePath("/app/automations");
  revalidatePath("/app/automations/drafts");
  revalidatePath("/app/aria");
  revalidatePath("/app/aria/operations");

  redirect(
    appendActionResult(returnTo, "success", `automation_action_${nextStatus}`),
  );
}

function isUuidLike(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

async function canAssignAutomationActionToUser(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  userId: string;
  actorIsPlatformAdmin: boolean;
  actorUserId: string;
}) {
  const { supabase, studioId, userId, actorIsPlatformAdmin, actorUserId } =
    params;

  if (actorIsPlatformAdmin && userId === actorUserId) {
    return true;
  }

  const { data: studioRole, error: studioRoleError } = await supabase
    .from("user_studio_roles")
    .select("user_id")
    .eq("studio_id", studioId)
    .eq("user_id", userId)
    .eq("active", true)
    .limit(1)
    .maybeSingle();

  if (studioRoleError) {
    throw new Error(studioRoleError.message);
  }

  if (studioRole) {
    return true;
  }

  const { data: organizerRole, error: organizerRoleError } = await supabase
    .from("organizer_users")
    .select("user_id, organizers!inner(studio_id)")
    .eq("user_id", userId)
    .eq("active", true)
    .eq("organizers.studio_id", studioId)
    .limit(1)
    .maybeSingle();

  if (organizerRoleError) {
    throw new Error(organizerRoleError.message);
  }

  return Boolean(organizerRole);
}

export async function assignAutomationActionOwnerAction(formData: FormData) {
  const actionId = String(formData.get("actionId") ?? "").trim();
  const assignedToInput = String(formData.get("assignedTo") ?? "").trim();
  const returnTo =
    getAutomationActionReturnTo(formData.get("returnTo")) ??
    "/app/aria/operations";
  const reviewNote = getOptionalReviewNote(formData.get("reviewNote"));

  if (!actionId) {
    redirect(
      appendActionResult(
        returnTo,
        "error",
        "automation_action_assignment_failed",
      ),
    );
  }

  const context = await getCurrentStudioContext();

  if (!canManageSettings(context.studioRole ?? "")) {
    redirect(appendActionResult(returnTo, "error", "not-authorized"));
  }

  const supabase = await createClient();
  const assignedTo =
    assignedToInput === "__me"
      ? context.userId
      : assignedToInput === "unassigned" || assignedToInput === ""
        ? null
        : assignedToInput;

  if (assignedTo && !isUuidLike(assignedTo)) {
    redirect(
      appendActionResult(
        returnTo,
        "error",
        "automation_action_assignment_failed",
      ),
    );
  }

  if (assignedTo) {
    try {
      const allowed = await canAssignAutomationActionToUser({
        supabase,
        studioId: context.studioId,
        userId: assignedTo,
        actorIsPlatformAdmin: context.isPlatformAdmin,
        actorUserId: context.userId,
      });

      if (!allowed) {
        redirect(
          appendActionResult(
            returnTo,
            "error",
            "automation_action_assignment_not_allowed",
          ),
        );
      }
    } catch (error) {
      console.error("Automation action assignee validation failed", error);
      redirect(
        appendActionResult(
          returnTo,
          "error",
          "automation_action_assignment_failed",
        ),
      );
    }
  }

  const { data: existingAction, error: existingError } = await supabase
    .from("automation_actions")
    .select("id, status, assigned_to")
    .eq("id", actionId)
    .eq("studio_id", context.studioId)
    .maybeSingle<{
      id: string;
      status: string | null;
      assigned_to: string | null;
    }>();

  if (existingError || !existingAction) {
    console.error("Automation action assignment lookup failed", existingError);
    redirect(
      appendActionResult(returnTo, "error", "automation_action_not_found"),
    );
  }

  const now = new Date().toISOString();
  const updatePayload: Record<string, unknown> = {
    assigned_to: assignedTo,
    reviewed_at: now,
    reviewed_by: context.userId,
    updated_at: now,
  };

  if (reviewNote) {
    updatePayload.review_note = reviewNote;
  }

  const { data: updatedAction, error: updateError } = await supabase
    .from("automation_actions")
    .update(updatePayload)
    .eq("id", actionId)
    .eq("studio_id", context.studioId)
    .select("id")
    .maybeSingle<{ id: string }>();

  if (updateError || !updatedAction) {
    console.error("Automation action assignment update failed", updateError);
    redirect(
      appendActionResult(
        returnTo,
        "error",
        "automation_action_assignment_failed",
      ),
    );
  }

  const { error: eventError } = await supabase
    .from("automation_action_events")
    .insert({
      studio_id: context.studioId,
      automation_action_id: actionId,
      event_type: "assigned",
      previous_status: existingAction.status,
      new_status: existingAction.status,
      note: reviewNote,
      metadata: {
        previous_assigned_to: existingAction.assigned_to,
        assigned_to: assignedTo,
      },
      created_by: context.userId,
    });

  if (eventError) {
    console.warn(
      "Automation action assignment event insert failed",
      eventError,
    );
  }

  revalidatePath("/app/automations");
  revalidatePath("/app/automations/drafts");
  revalidatePath("/app/aria");
  revalidatePath("/app/aria/operations");

  redirect(
    appendActionResult(returnTo, "success", "automation_action_assigned"),
  );
}

type AriaOperationalActionCandidate = {
  ruleKey: string;
  ruleName: string;
  ruleDescription: string;
  title: string;
  body: string;
  priority: "urgent" | "high" | "normal" | "low";
  relatedTable: string;
  relatedId: string;
  clientId?: string | null;
  dueAt: string;
};

type AriaActionPriority = AriaOperationalActionCandidate["priority"];

type AriaActionPolicyRow = {
  rule_key: string;
  enabled: boolean | null;
  auto_approve: boolean | null;
  max_auto_approve_priority: string | null;
  default_assigned_to: string | null;
  require_assignment: boolean | null;
};

type AriaActionPolicyMode = "manual" | "auto_approve" | "disabled";

function isOrganizerAutomationRole(role: string | null | undefined) {
  return (
    role === "organizer_owner" ||
    role === "organizer_admin" ||
    role === "organizer_staff"
  );
}

function ariaDateLabel(value: string | null | undefined) {
  if (!value) return "not scheduled";

  const date = new Date(value.includes("T") ? value : `${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "not scheduled";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: value.includes("T") ? "numeric" : undefined,
    minute: value.includes("T") ? "2-digit" : undefined,
  }).format(date);
}

function ariaPersonName(
  firstName?: string | null,
  lastName?: string | null,
  fallback = "Client",
) {
  return [firstName, lastName].filter(Boolean).join(" ").trim() || fallback;
}

function addAriaDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getAriaPolicyReturnTo(value: FormDataEntryValue | null) {
  return getAutomationActionReturnTo(value) ?? "/app/aria/operations";
}

function getAriaActionPolicyMode(
  value: FormDataEntryValue | null,
): AriaActionPolicyMode {
  if (value === "auto_approve") return "auto_approve";
  if (value === "disabled") return "disabled";
  return "manual";
}

function getAriaPolicyPriority(
  value: FormDataEntryValue | null,
): AriaActionPriority {
  if (
    value === "urgent" ||
    value === "high" ||
    value === "normal" ||
    value === "low"
  ) {
    return value;
  }

  return "normal";
}

function priorityRank(
  priority: AriaActionPriority | string | null | undefined,
) {
  if (priority === "urgent") return 4;
  if (priority === "high") return 3;
  if (priority === "normal") return 2;
  return 1;
}

function canAutoApprovePriority(
  priority: AriaActionPriority,
  maxPriority: string | null | undefined,
) {
  const max = getAriaPolicyPriority(maxPriority ?? null);
  return priorityRank(priority) <= priorityRank(max);
}

async function loadAriaActionPolicyMap(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
}) {
  const { supabase, studioId } = params;
  const { data, error } = await supabase
    .from("aria_action_policies")
    .select(
      "rule_key, enabled, auto_approve, max_auto_approve_priority, default_assigned_to, require_assignment",
    )
    .eq("studio_id", studioId);

  if (error) {
    throw new Error(error.message);
  }

  return new Map(
    ((data ?? []) as AriaActionPolicyRow[]).map((policy) => [
      policy.rule_key,
      policy,
    ]),
  );
}

export async function saveAriaActionPolicyAction(formData: FormData) {
  const ruleKey = String(formData.get("ruleKey") ?? "").trim();
  const mode = getAriaActionPolicyMode(formData.get("policyMode"));
  const maxAutoApprovePriority = getAriaPolicyPriority(
    formData.get("maxAutoApprovePriority"),
  );
  const assignedToInput = String(
    formData.get("defaultAssignedTo") ?? "",
  ).trim();
  const requireAssignment = formData.get("requireAssignment") === "on";
  const returnTo = getAriaPolicyReturnTo(formData.get("returnTo"));

  if (!ruleKey) {
    redirect(appendActionResult(returnTo, "error", "aria_policy_missing_rule"));
  }

  const context = await getCurrentStudioContext();

  if (!canManageSettings(context.studioRole ?? "")) {
    redirect(appendActionResult(returnTo, "error", "not-authorized"));
  }

  const supabase = await createClient();
  const defaultAssignedTo =
    assignedToInput === "__me"
      ? context.userId
      : assignedToInput === "unassigned" || assignedToInput === ""
        ? null
        : assignedToInput;

  if (defaultAssignedTo && !isUuidLike(defaultAssignedTo)) {
    redirect(
      appendActionResult(returnTo, "error", "aria_policy_invalid_assignee"),
    );
  }

  if (defaultAssignedTo) {
    try {
      const allowed = await canAssignAutomationActionToUser({
        supabase,
        studioId: context.studioId,
        userId: defaultAssignedTo,
        actorIsPlatformAdmin: context.isPlatformAdmin,
        actorUserId: context.userId,
      });

      if (!allowed) {
        redirect(
          appendActionResult(
            returnTo,
            "error",
            "aria_policy_assignee_not_allowed",
          ),
        );
      }
    } catch (error) {
      console.error("ARIA policy assignee validation failed", error);
      redirect(
        appendActionResult(returnTo, "error", "aria_policy_save_failed"),
      );
    }
  }

  const now = new Date().toISOString();
  const { error } = await supabase.from("aria_action_policies").upsert(
    {
      studio_id: context.studioId,
      rule_key: ruleKey,
      enabled: mode !== "disabled",
      auto_approve: mode === "auto_approve",
      max_auto_approve_priority: maxAutoApprovePriority,
      default_assigned_to: defaultAssignedTo,
      require_assignment: requireAssignment,
      updated_by: context.userId,
      updated_at: now,
    },
    { onConflict: "studio_id,rule_key" },
  );

  if (error) {
    console.error("ARIA action policy save failed", error);
    redirect(appendActionResult(returnTo, "error", "aria_policy_save_failed"));
  }

  revalidatePath("/app/aria");
  revalidatePath("/app/aria/operations");
  revalidatePath("/app/automations");

  redirect(appendActionResult(returnTo, "success", "aria_policy_saved"));
}


type AriaDigestDeliveryChannel = "in_app" | "email";

function getAriaDigestDeliveryChannel(
  value: FormDataEntryValue | null,
): AriaDigestDeliveryChannel {
  return value === "email" ? "email" : "in_app";
}

function getAriaDigestTime(value: FormDataEntryValue | null, fallback: string) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(trimmed) ? trimmed : fallback;
}

export async function saveAriaDigestPreferencesAction(formData: FormData) {
  const returnTo = getAriaPolicyReturnTo(formData.get("returnTo"));
  const morningDigestEnabled = formData.get("morningDigestEnabled") === "on";
  const endOfDayDigestEnabled = formData.get("endOfDayDigestEnabled") === "on";
  const deliveryChannel = getAriaDigestDeliveryChannel(
    formData.get("deliveryChannel"),
  );
  const defaultRecipientInput = String(
    formData.get("defaultRecipientUserId") ?? "",
  ).trim();
  const morningDigestTime = getAriaDigestTime(
    formData.get("morningDigestTime"),
    "08:00",
  );
  const endOfDayDigestTime = getAriaDigestTime(
    formData.get("endOfDayDigestTime"),
    "17:00",
  );

  const context = await getCurrentStudioContext();

  if (!canManageSettings(context.studioRole ?? "")) {
    redirect(appendActionResult(returnTo, "error", "not-authorized"));
  }

  const supabase = await createClient();
  const defaultRecipientUserId =
    defaultRecipientInput === "__me"
      ? context.userId
      : defaultRecipientInput === "unassigned" || defaultRecipientInput === ""
        ? null
        : defaultRecipientInput;

  if (defaultRecipientUserId && !isUuidLike(defaultRecipientUserId)) {
    redirect(
      appendActionResult(returnTo, "error", "aria_digest_invalid_recipient"),
    );
  }

  if (defaultRecipientUserId) {
    try {
      const allowed = await canAssignAutomationActionToUser({
        supabase,
        studioId: context.studioId,
        userId: defaultRecipientUserId,
        actorIsPlatformAdmin: context.isPlatformAdmin,
        actorUserId: context.userId,
      });

      if (!allowed) {
        redirect(
          appendActionResult(
            returnTo,
            "error",
            "aria_digest_recipient_not_allowed",
          ),
        );
      }
    } catch (error) {
      console.error("ARIA digest recipient validation failed", error);
      redirect(
        appendActionResult(returnTo, "error", "aria_digest_preferences_failed"),
      );
    }
  }

  const now = new Date().toISOString();
  const { error } = await supabase.from("aria_digest_preferences").upsert(
    {
      studio_id: context.studioId,
      morning_digest_enabled: morningDigestEnabled,
      end_of_day_digest_enabled: endOfDayDigestEnabled,
      delivery_channel: deliveryChannel,
      default_recipient_user_id: defaultRecipientUserId,
      morning_digest_time: morningDigestTime,
      end_of_day_digest_time: endOfDayDigestTime,
      updated_by: context.userId,
      updated_at: now,
    },
    { onConflict: "studio_id" },
  );

  if (error) {
    console.error("ARIA digest preferences save failed", error);
    redirect(
      appendActionResult(returnTo, "error", "aria_digest_preferences_failed"),
    );
  }

  revalidatePath("/app/aria");
  revalidatePath("/app/aria/operations");

  redirect(
    appendActionResult(returnTo, "success", "aria_digest_preferences_saved"),
  );
}

async function ensureAriaOperationalRule(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  userId: string;
  candidate: AriaOperationalActionCandidate;
}) {
  const { supabase, studioId, userId, candidate } = params;

  const { data: existingRule, error: existingError } = await supabase
    .from("automation_rules")
    .select("id")
    .eq("studio_id", studioId)
    .eq("rule_key", candidate.ruleKey)
    .maybeSingle<{ id: string }>();

  if (existingError) {
    throw new Error(existingError.message);
  }

  if (existingRule?.id) {
    return existingRule.id;
  }

  const now = new Date().toISOString();
  const { data: rule, error } = await supabase
    .from("automation_rules")
    .upsert(
      {
        studio_id: studioId,
        rule_key: candidate.ruleKey,
        name: candidate.ruleName,
        description: candidate.ruleDescription,
        trigger_key: `aria_${candidate.ruleKey}`,
        action_key: "create_aria_operations_action",
        enabled: true,
        mode: "suggestion",
        trigger_config: {},
        action_config: { source: "aria_operations" },
        created_by: userId,
        updated_by: userId,
        updated_at: now,
      },
      { onConflict: "studio_id,rule_key" },
    )
    .select("id")
    .single<{ id: string }>();

  if (error) {
    throw new Error(error.message);
  }

  return rule.id;
}

type ExistingAriaOperationalActionRow = {
  id: string;
  rule_key: string | null;
  related_table: string | null;
  related_id: string | null;
  status: string | null;
  assigned_to: string | null;
};

function ariaOperationalDedupeKey(params: {
  ruleKey: string | null | undefined;
  relatedTable: string | null | undefined;
  relatedId: string | null | undefined;
}) {
  return `${params.ruleKey ?? ""}:${params.relatedTable ?? ""}:${params.relatedId ?? ""}`;
}

async function insertAriaOperationalActions(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  userId: string;
  candidates: AriaOperationalActionCandidate[];
}) {
  const { supabase, studioId, userId, candidates } = params;

  if (candidates.length === 0) {
    return { candidatesCount: 0, createdCount: 0, updatedCount: 0 };
  }

  const activeStatuses = [
    "suggested",
    "drafted",
    "approved",
    "queued",
    "snoozed",
  ];
  const policyByRuleKey = await loadAriaActionPolicyMap({ supabase, studioId });
  const groupedRelatedIds = new Map<string, Set<string>>();
  const ruleKeys = Array.from(
    new Set(candidates.map((candidate) => candidate.ruleKey)),
  );

  for (const candidate of candidates) {
    const current =
      groupedRelatedIds.get(candidate.relatedTable) ?? new Set<string>();
    current.add(candidate.relatedId);
    groupedRelatedIds.set(candidate.relatedTable, current);
  }

  const existingActionByKey = new Map<
    string,
    ExistingAriaOperationalActionRow
  >();

  for (const [relatedTable, relatedIds] of groupedRelatedIds.entries()) {
    const { data: existing, error } = await supabase
      .from("automation_actions")
      .select("id, rule_key, related_table, related_id, status, assigned_to")
      .eq("studio_id", studioId)
      .eq("related_table", relatedTable)
      .in("related_id", Array.from(relatedIds))
      .in("rule_key", ruleKeys)
      .in("status", activeStatuses);

    if (error) {
      throw new Error(error.message);
    }

    for (const row of (existing ?? []) as ExistingAriaOperationalActionRow[]) {
      if (row.rule_key && row.related_table && row.related_id) {
        existingActionByKey.set(
          ariaOperationalDedupeKey({
            ruleKey: row.rule_key,
            relatedTable: row.related_table,
            relatedId: row.related_id,
          }),
          row,
        );
      }
    }
  }

  const ruleIdByKey = new Map<string, string>();
  const actionsToInsert: Array<Record<string, unknown>> = [];
  const existingActionUpdates: Array<{
    action: ExistingAriaOperationalActionRow;
    candidate: AriaOperationalActionCandidate;
    autoApproved: boolean;
    assignTo: string | null;
  }> = [];

  for (const candidate of candidates) {
    const policy = policyByRuleKey.get(candidate.ruleKey);

    if (policy?.enabled === false) {
      continue;
    }

    if (policy?.require_assignment && !policy.default_assigned_to) {
      continue;
    }

    const dedupeKey = ariaOperationalDedupeKey({
      ruleKey: candidate.ruleKey,
      relatedTable: candidate.relatedTable,
      relatedId: candidate.relatedId,
    });
    const existingAction = existingActionByKey.get(dedupeKey);
    const autoApproved = Boolean(
      policy?.auto_approve &&
      canAutoApprovePriority(
        candidate.priority,
        policy.max_auto_approve_priority,
      ),
    );
    const assignTo = policy?.default_assigned_to ?? null;

    if (existingAction) {
      existingActionUpdates.push({
        action: existingAction,
        candidate,
        autoApproved,
        assignTo,
      });
      continue;
    }

    let ruleId = ruleIdByKey.get(candidate.ruleKey);
    if (!ruleId) {
      ruleId = await ensureAriaOperationalRule({
        supabase,
        studioId,
        userId,
        candidate,
      });
      ruleIdByKey.set(candidate.ruleKey, ruleId);
    }

    existingActionByKey.set(dedupeKey, {
      id: "pending-insert",
      rule_key: candidate.ruleKey,
      related_table: candidate.relatedTable,
      related_id: candidate.relatedId,
      status: autoApproved ? "approved" : "suggested",
      assigned_to: assignTo,
    });

    const now = new Date().toISOString();

    actionsToInsert.push({
      studio_id: studioId,
      rule_id: ruleId,
      rule_key: candidate.ruleKey,
      title: candidate.title,
      body: candidate.body,
      status: autoApproved ? "approved" : "suggested",
      priority: candidate.priority,
      related_table: candidate.relatedTable,
      related_id: candidate.relatedId,
      client_id: candidate.clientId ?? null,
      due_at: candidate.dueAt,
      assigned_to: assignTo,
      approved_at: autoApproved ? now : null,
      approved_by: autoApproved ? userId : null,
      reviewed_at: autoApproved ? now : null,
      reviewed_by: autoApproved ? userId : null,
      review_note: autoApproved ? "Auto-approved by ARIA action policy." : null,
    });
  }

  let updatedCount = 0;

  for (const update of existingActionUpdates) {
    const currentStatus = update.action.status ?? "";
    const shouldApprove = update.autoApproved && currentStatus !== "approved";
    const shouldAssign = Boolean(
      update.assignTo && update.action.assigned_to !== update.assignTo,
    );

    if (!shouldApprove && !shouldAssign) {
      continue;
    }

    const now = new Date().toISOString();
    const updatePayload: Record<string, unknown> = {
      updated_at: now,
    };

    if (shouldApprove) {
      updatePayload.status = "approved";
      updatePayload.approved_at = now;
      updatePayload.approved_by = userId;
      updatePayload.reviewed_at = now;
      updatePayload.reviewed_by = userId;
      updatePayload.snoozed_until = null;
      updatePayload.review_note = "Auto-approved by ARIA action policy.";
    }

    if (shouldAssign) {
      updatePayload.assigned_to = update.assignTo;
      updatePayload.reviewed_at = now;
      updatePayload.reviewed_by = userId;
    }

    const { data: updatedAction, error: updateError } = await supabase
      .from("automation_actions")
      .update(updatePayload)
      .eq("id", update.action.id)
      .eq("studio_id", studioId)
      .eq("status", currentStatus)
      .select("id, status")
      .maybeSingle<{ id: string; status: string | null }>();

    if (updateError) {
      throw new Error(updateError.message);
    }

    if (!updatedAction) {
      continue;
    }

    updatedCount += 1;

    const { error: eventError } = await supabase
      .from("automation_action_events")
      .insert({
        studio_id: studioId,
        automation_action_id: update.action.id,
        event_type: shouldApprove ? "auto_approved" : "assigned",
        previous_status: currentStatus,
        new_status: shouldApprove ? "approved" : currentStatus,
        note: shouldApprove ? "Auto-approved by ARIA action policy." : null,
        metadata: {
          rule_key: update.candidate.ruleKey,
          previous_assigned_to: update.action.assigned_to,
          assigned_to: shouldAssign
            ? update.assignTo
            : update.action.assigned_to,
          applied_to_existing_action: true,
        },
        created_by: userId,
      });

    if (eventError) {
      console.warn(
        "ARIA existing action policy event insert failed",
        eventError,
      );
    }
  }

  let insertedActions: Array<{
    id: string;
    status: string | null;
    rule_key: string | null;
  }> = [];

  if (actionsToInsert.length > 0) {
    const { data, error } = await supabase
      .from("automation_actions")
      .insert(actionsToInsert)
      .select("id, status, rule_key");

    if (error) {
      throw new Error(error.message);
    }

    insertedActions = (data ?? []) as Array<{
      id: string;
      status: string | null;
      rule_key: string | null;
    }>;
  }

  const autoApprovedEvents = insertedActions
    .filter((action) => action.status === "approved")
    .map((action) => ({
      studio_id: studioId,
      automation_action_id: action.id,
      event_type: "auto_approved",
      previous_status: null,
      new_status: "approved",
      note: "Auto-approved by ARIA action policy.",
      metadata: { rule_key: action.rule_key },
      created_by: userId,
    }));

  if (autoApprovedEvents.length > 0) {
    const { error: eventError } = await supabase
      .from("automation_action_events")
      .insert(autoApprovedEvents);

    if (eventError) {
      console.warn("ARIA auto-approval event insert failed", eventError);
    }
  }

  return {
    candidatesCount: candidates.length,
    createdCount: actionsToInsert.length,
    updatedCount,
  };
}

type AriaPaymentExceptionRow = {
  id: string;
  client_id: string | null;
  amount: number | string | null;
  status: string | null;
  payment_type: string | null;
  created_at: string;
  clients:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
};

type AriaMembershipAttentionRow = {
  id: string;
  client_id: string | null;
  name_snapshot: string | null;
  status: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
};

type AriaPackageBalanceRow = {
  id: string;
  client_id: string | null;
  name_snapshot: string | null;
  expiration_date: string | null;
  clients:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
  client_package_items: {
    quantity_remaining: number | string | null;
    is_unlimited: boolean | null;
  }[];
};

type AriaClientSignalRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  status: string | null;
  created_at: string;
};

type AriaAppointmentSignalRow = {
  id: string;
  client_id: string | null;
  appointment_type: string | null;
  status: string | null;
  starts_at: string;
};

type AriaBookingRequestSignalRow = {
  id: string;
  client_id: string | null;
  source: string | null;
  status: string | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  customer_email: string | null;
  requested_starts_at: string | null;
  created_at: string;
};

type AriaOrganizerEventSignalRow = {
  id: string;
  name: string;
  status: string | null;
  start_date: string;
};

type AriaOrganizerRegistrationSignalRow = {
  id: string;
  event_id: string | null;
  status: string | null;
  payment_status: string | null;
  quantity: number | string | null;
};

type AriaOrganizerTicketSignalRow = {
  id: string;
  event_id: string | null;
  checked_in_at: string | null;
};

type AriaOrganizerProfitSignalRow = {
  event_id: string | null;
  net_ticket_revenue: number | string | null;
  event_profit_loss: number | string | null;
  event_expenses: number | string | null;
  event_labor_costs: number | string | null;
};

function getAriaRelatedClientName(
  value:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null,
) {
  const client = Array.isArray(value) ? value[0] : value;
  return ariaPersonName(client?.first_name, client?.last_name);
}

function lowestAriaPackageRemaining(pkg: AriaPackageBalanceRow) {
  const remaining = (pkg.client_package_items ?? [])
    .filter((item) => !item.is_unlimited)
    .map((item) => asNumber(item.quantity_remaining, Number.POSITIVE_INFINITY))
    .filter((value) => Number.isFinite(value));

  return remaining.length ? Math.min(...remaining) : null;
}

function isAriaCanceledStatus(status: string | null | undefined) {
  const normalized = `${status ?? ""}`.toLowerCase();
  return (
    normalized.includes("cancel") ||
    normalized.includes("declin") ||
    normalized.includes("no_show")
  );
}

function isAriaCompletedStatus(status: string | null | undefined) {
  const normalized = `${status ?? ""}`.toLowerCase();
  return (
    normalized.includes("attend") ||
    normalized.includes("complete") ||
    normalized.includes("done")
  );
}

function isAriaIntroAppointment(value: string | null | undefined) {
  const normalized = `${value ?? ""}`.toLowerCase();
  return normalized.includes("intro") || normalized.includes("consult");
}

async function buildStudioAriaOperationalCandidates(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
}) {
  const { supabase, studioId } = params;
  const now = new Date();
  const nowIso = now.toISOString();
  const threeDaysAgoIso = addAriaDays(now, -3).toISOString();
  const ninetyDaysAgoIso = addAriaDays(now, -90).toISOString();
  const nextFourteenDaysIso = addAriaDays(now, 14).toISOString();

  const [
    paymentsResult,
    membershipsResult,
    bookingRequestsResult,
    packagesResult,
    clientsResult,
    recentAppointmentsResult,
    futureAppointmentsResult,
  ] = await Promise.all([
    supabase
      .from("payments")
      .select(
        "id, client_id, amount, status, payment_type, created_at, clients ( first_name, last_name )",
      )
      .eq("studio_id", studioId)
      .in("status", ["pending", "failed"])
      .order("created_at", { ascending: true })
      .limit(100),
    supabase
      .from("client_memberships")
      .select(
        "id, client_id, name_snapshot, status, current_period_end, cancel_at_period_end",
      )
      .eq("studio_id", studioId)
      .in("status", ["active", "pending", "past_due", "unpaid"])
      .limit(500),
    supabase
      .from("booking_requests")
      .select(
        "id, client_id, source, status, customer_first_name, customer_last_name, customer_email, requested_starts_at, created_at",
      )
      .eq("studio_id", studioId)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(100),
    supabase
      .from("client_packages")
      .select(
        "id, client_id, name_snapshot, expiration_date, clients ( first_name, last_name ), client_package_items ( quantity_remaining, is_unlimited )",
      )
      .eq("studio_id", studioId)
      .eq("active", true)
      .limit(1000),
    supabase
      .from("clients")
      .select("id, first_name, last_name, email, status, created_at")
      .eq("studio_id", studioId)
      .in("status", ["active", "lead"])
      .limit(1000),
    supabase
      .from("appointments")
      .select("id, client_id, appointment_type, status, starts_at")
      .eq("studio_id", studioId)
      .gte("starts_at", ninetyDaysAgoIso)
      .lt("starts_at", nowIso)
      .order("starts_at", { ascending: false })
      .limit(1500),
    supabase
      .from("appointments")
      .select("id, client_id, appointment_type, status, starts_at")
      .eq("studio_id", studioId)
      .gte("starts_at", nowIso)
      .order("starts_at", { ascending: true })
      .limit(1500),
  ]);

  if (paymentsResult.error) throw new Error(paymentsResult.error.message);
  if (membershipsResult.error) throw new Error(membershipsResult.error.message);
  if (bookingRequestsResult.error)
    throw new Error(bookingRequestsResult.error.message);
  if (packagesResult.error) throw new Error(packagesResult.error.message);
  if (clientsResult.error) throw new Error(clientsResult.error.message);
  if (recentAppointmentsResult.error)
    throw new Error(recentAppointmentsResult.error.message);
  if (futureAppointmentsResult.error)
    throw new Error(futureAppointmentsResult.error.message);

  const candidates: AriaOperationalActionCandidate[] = [];
  const payments = (paymentsResult.data ?? []) as AriaPaymentExceptionRow[];
  const memberships = (membershipsResult.data ??
    []) as AriaMembershipAttentionRow[];
  const bookingRequests = (bookingRequestsResult.data ??
    []) as AriaBookingRequestSignalRow[];
  const packages = (packagesResult.data ?? []) as AriaPackageBalanceRow[];
  const clients = (clientsResult.data ?? []) as AriaClientSignalRow[];
  const recentAppointments = (recentAppointmentsResult.data ??
    []) as AriaAppointmentSignalRow[];
  const futureAppointments = (futureAppointmentsResult.data ??
    []) as AriaAppointmentSignalRow[];
  const clientById = new Map(clients.map((client) => [client.id, client]));

  for (const payment of payments) {
    const clientName = getAriaRelatedClientName(payment.clients);
    candidates.push({
      ruleKey: "aria_payment_exception",
      ruleName: "ARIA payment exception follow-up",
      ruleDescription:
        "Creates ARIA actions for pending or failed payments that need staff review.",
      title: `Payment follow-up needed: ${clientName}`,
      body: `${clientName} has a ${payment.status ?? "pending"} ${payment.payment_type ?? "payment"} for $${asNumber(payment.amount, 0).toLocaleString("en-US")}. Review the payment, retry/collect if appropriate, or mark the situation resolved.`,
      priority: payment.status === "failed" ? "urgent" : "high",
      relatedTable: "payments",
      relatedId: payment.id,
      clientId: payment.client_id,
      dueAt: nowIso,
    } as AriaOperationalActionCandidate);
  }

  for (const membership of memberships) {
    const client = membership.client_id
      ? clientById.get(membership.client_id)
      : null;
    const clientName = ariaPersonName(client?.first_name, client?.last_name);
    const status = `${membership.status ?? ""}`.toLowerCase();
    const needsBilling = status === "past_due" || status === "unpaid";
    const canceling = Boolean(membership.cancel_at_period_end);

    if (!needsBilling && !canceling) continue;

    candidates.push({
      ruleKey: needsBilling
        ? "aria_membership_past_due"
        : "aria_membership_canceling",
      ruleName: needsBilling
        ? "ARIA membership billing follow-up"
        : "ARIA canceling membership follow-up",
      ruleDescription: needsBilling
        ? "Creates ARIA actions for past-due or unpaid memberships."
        : "Creates ARIA actions for memberships set to cancel at period end.",
      title: `${needsBilling ? "Membership billing" : "Membership retention"} follow-up: ${clientName}`,
      body: needsBilling
        ? `${clientName}'s ${membership.name_snapshot ?? "membership"} is ${membership.status}. Review billing and contact the student before access or retention is affected.`
        : `${clientName}'s ${membership.name_snapshot ?? "membership"} is set to cancel at period end${membership.current_period_end ? ` (${ariaDateLabel(membership.current_period_end)})` : ""}. Review whether a save conversation is appropriate.`,
      priority: needsBilling ? "urgent" : "high",
      relatedTable: "client_memberships",
      relatedId: membership.id,
      clientId: membership.client_id,
      dueAt: needsBilling ? nowIso : addAriaDays(now, 2).toISOString(),
    });
  }

  for (const request of bookingRequests) {
    if (new Date(request.created_at) > new Date(threeDaysAgoIso)) continue;
    const name = ariaPersonName(
      request.customer_first_name,
      request.customer_last_name,
      request.customer_email || "Booking request",
    );
    candidates.push({
      ruleKey: "aria_booking_request_aging",
      ruleName: "ARIA aging booking request follow-up",
      ruleDescription:
        "Creates ARIA actions for pending booking requests that have aged without staff review.",
      title: `Aging booking request: ${name}`,
      body: `${name}'s booking request has been pending since ${ariaDateLabel(request.created_at)}. Requested time: ${ariaDateLabel(request.requested_starts_at)}. Approve, decline, or contact them with another option.`,
      priority: "high",
      relatedTable: "booking_requests",
      relatedId: request.id,
      clientId: request.client_id,
      dueAt: nowIso,
    });
  }

  for (const pkg of packages) {
    const remaining = lowestAriaPackageRemaining(pkg);
    const expiringSoon = Boolean(
      pkg.expiration_date &&
      new Date(`${pkg.expiration_date}T00:00:00`) <=
        new Date(nextFourteenDaysIso),
    );
    if (!(typeof remaining === "number" && remaining <= 2) && !expiringSoon)
      continue;
    const clientName = getAriaRelatedClientName(pkg.clients);
    candidates.push({
      ruleKey: "aria_low_package_balance",
      ruleName: "ARIA package renewal opportunity",
      ruleDescription:
        "Creates ARIA actions for low-balance or soon-expiring active packages.",
      title: `Package renewal opportunity: ${clientName}`,
      body: `${clientName}'s ${pkg.name_snapshot ?? "package"} ${typeof remaining === "number" ? `has ${remaining} credit${remaining === 1 ? "" : "s"} remaining` : "is active"}${pkg.expiration_date ? ` and expires ${ariaDateLabel(pkg.expiration_date)}` : ""}. Start the renewal conversation before momentum drops.`,
      priority:
        typeof remaining === "number" && remaining <= 0 ? "urgent" : "high",
      relatedTable: "client_packages",
      relatedId: pkg.id,
      clientId: pkg.client_id,
      dueAt: addAriaDays(now, 1).toISOString(),
    });
  }

  const validRecent = recentAppointments.filter(
    (appointment) =>
      appointment.client_id && !isAriaCanceledStatus(appointment.status),
  );
  const validFutureClientIds = new Set(
    futureAppointments
      .filter(
        (appointment) =>
          appointment.client_id && !isAriaCanceledStatus(appointment.status),
      )
      .map((appointment) => appointment.client_id as string),
  );
  const latestRecentByClient = new Map<string, AriaAppointmentSignalRow>();

  for (const appointment of validRecent) {
    if (
      !appointment.client_id ||
      latestRecentByClient.has(appointment.client_id)
    )
      continue;
    latestRecentByClient.set(appointment.client_id, appointment);
  }

  for (const client of clients.filter((row) => row.status === "active")) {
    if (validFutureClientIds.has(client.id)) continue;
    const latest = latestRecentByClient.get(client.id);
    if (!latest) continue;
    const daysSince = Math.floor(
      (now.getTime() - new Date(latest.starts_at).getTime()) /
        (1000 * 60 * 60 * 24),
    );
    if (daysSince < 14) continue;

    candidates.push({
      ruleKey: "aria_stale_active_student",
      ruleName: "ARIA stale active student follow-up",
      ruleDescription:
        "Creates ARIA actions for active students with recent lesson history but no future appointment.",
      title: `Student momentum follow-up: ${ariaPersonName(client.first_name, client.last_name)}`,
      body: `${ariaPersonName(client.first_name, client.last_name)} last attended around ${ariaDateLabel(latest.starts_at)} and has no future appointment. Reach out with a clear next booking option before momentum fades.`,
      priority: "high",
      relatedTable: "clients",
      relatedId: client.id,
      clientId: client.id,
      dueAt: addAriaDays(now, 1).toISOString(),
    });
  }

  const packageClientIds = new Set(
    packages.map((pkg) => pkg.client_id).filter(Boolean) as string[],
  );
  const membershipClientIds = new Set(
    memberships
      .map((membership) => membership.client_id)
      .filter(Boolean) as string[],
  );
  const completedIntroByClient = new Map<string, AriaAppointmentSignalRow>();

  for (const appointment of validRecent) {
    if (
      !appointment.client_id ||
      !isAriaIntroAppointment(appointment.appointment_type) ||
      !isAriaCompletedStatus(appointment.status)
    )
      continue;
    if (!completedIntroByClient.has(appointment.client_id)) {
      completedIntroByClient.set(appointment.client_id, appointment);
    }
  }

  for (const [clientId, appointment] of completedIntroByClient.entries()) {
    if (packageClientIds.has(clientId) || membershipClientIds.has(clientId))
      continue;
    const daysSince = Math.floor(
      (now.getTime() - new Date(appointment.starts_at).getTime()) /
        (1000 * 60 * 60 * 24),
    );
    if (daysSince < 7) continue;
    const client = clientById.get(clientId);

    candidates.push({
      ruleKey: "aria_intro_no_purchase",
      ruleName: "ARIA intro without purchase follow-up",
      ruleDescription:
        "Creates ARIA actions for completed intro lessons without a package or membership purchase.",
      title: `Intro conversion follow-up: ${ariaPersonName(client?.first_name, client?.last_name)}`,
      body: `${ariaPersonName(client?.first_name, client?.last_name)} completed an intro on ${ariaDateLabel(appointment.starts_at)} but does not have a package or membership on file. Follow up with the recommended next step.`,
      priority: "high",
      relatedTable: "clients",
      relatedId: clientId,
      clientId,
      dueAt: nowIso,
    });
  }

  return candidates;
}

async function buildOrganizerAriaOperationalCandidates(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
}) {
  const { supabase, studioId } = params;
  const now = new Date();
  const nowIso = now.toISOString();

  const { data: eventsData, error: eventsError } = await supabase
    .from("events")
    .select("id, name, status, start_date")
    .eq("studio_id", studioId)
    .order("start_date", { ascending: true })
    .limit(250);

  if (eventsError) throw new Error(eventsError.message);

  const events = (eventsData ?? []) as AriaOrganizerEventSignalRow[];
  const eventIds = events.map((event) => event.id);
  const eventById = new Map(events.map((event) => [event.id, event]));
  const candidates: AriaOperationalActionCandidate[] = [];

  if (eventIds.length === 0) return candidates;

  const [registrationsResult, ticketsResult, profitResult] = await Promise.all([
    supabase
      .from("event_registrations")
      .select("id, event_id, status, payment_status, quantity")
      .in("event_id", eventIds),
    supabase
      .from("event_registration_attendees")
      .select("id, event_id, checked_in_at")
      .in("event_id", eventIds)
      .limit(10000),
    supabase
      .from("v_event_profit_loss")
      .select(
        "event_id, net_ticket_revenue, event_profit_loss, event_expenses, event_labor_costs",
      )
      .in("event_id", eventIds),
  ]);

  if (registrationsResult.error)
    throw new Error(registrationsResult.error.message);

  const registrations = (registrationsResult.data ??
    []) as AriaOrganizerRegistrationSignalRow[];
  const tickets = ticketsResult.error
    ? []
    : ((ticketsResult.data ?? []) as AriaOrganizerTicketSignalRow[]);
  const profitRows = profitResult.error
    ? []
    : ((profitResult.data ?? []) as AriaOrganizerProfitSignalRow[]);
  const ticketsByEventId = new Map<string, AriaOrganizerTicketSignalRow[]>();
  const registrationsByEventId = new Map<
    string,
    AriaOrganizerRegistrationSignalRow[]
  >();

  for (const ticket of tickets) {
    if (!ticket.event_id) continue;
    const current = ticketsByEventId.get(ticket.event_id) ?? [];
    current.push(ticket);
    ticketsByEventId.set(ticket.event_id, current);
  }

  for (const registration of registrations) {
    if (!registration.event_id) continue;
    const current = registrationsByEventId.get(registration.event_id) ?? [];
    current.push(registration);
    registrationsByEventId.set(registration.event_id, current);

    if (
      ["pending", "unpaid", "failed"].includes(
        registration.payment_status ?? "",
      )
    ) {
      const event = eventById.get(registration.event_id);
      candidates.push({
        ruleKey: "aria_event_unpaid_registration",
        ruleName: "ARIA event registration payment follow-up",
        ruleDescription:
          "Creates ARIA actions for event registrations with pending, unpaid, or failed payment status.",
        title: `Event registration payment review: ${event?.name ?? "Event"}`,
        body: `${event?.name ?? "This event"} has a registration with ${registration.payment_status ?? "pending"} payment status. Resolve the payment status before event day or closeout.`,
        priority: "urgent",
        relatedTable: "event_registrations",
        relatedId: registration.id,
        clientId: null,
        dueAt: nowIso,
      });
    }
  }

  for (const profit of profitRows) {
    if (!profit.event_id) continue;
    const event = eventById.get(profit.event_id);
    const revenue = asNumber(profit.net_ticket_revenue, 0);
    const profitLoss = asNumber(profit.event_profit_loss, 0);
    const missingCosts =
      revenue > 0 &&
      (asNumber(profit.event_expenses, 0) <= 0 ||
        asNumber(profit.event_labor_costs, 0) <= 0);

    if (profitLoss < 0) {
      candidates.push({
        ruleKey: "aria_event_loss",
        ruleName: "ARIA event loss review",
        ruleDescription: "Creates ARIA actions for events below break-even.",
        title: `Event loss review: ${event?.name ?? "Event"}`,
        body: `${event?.name ?? "This event"} is currently below break-even. Review refunds, fees, labor, expenses, and pricing before repeating the format.`,
        priority: "urgent",
        relatedTable: "events",
        relatedId: profit.event_id,
        dueAt: nowIso,
      });
    }

    if (missingCosts) {
      candidates.push({
        ruleKey: "aria_event_missing_costs",
        ruleName: "ARIA event missing cost review",
        ruleDescription:
          "Creates ARIA actions for revenue-generating events missing labor or expense data.",
        title: `Add event costs: ${event?.name ?? "Event"}`,
        body: `${event?.name ?? "This event"} has ticket revenue but missing labor or expense attribution. Add costs before trusting event profit/loss.`,
        priority: "high",
        relatedTable: "events",
        relatedId: profit.event_id,
        dueAt: addAriaDays(now, 1).toISOString(),
      });
    }
  }

  for (const event of events) {
    const eventDate = new Date(`${event.start_date}T00:00:00`);
    if (Number.isNaN(eventDate.getTime()) || eventDate >= now) continue;
    const eventTickets = ticketsByEventId.get(event.id) ?? [];
    const eventRegistrations = registrationsByEventId.get(event.id) ?? [];
    const ticketsIssued =
      eventTickets.length ||
      eventRegistrations.reduce(
        (sum, registration) =>
          sum + Math.max(1, asNumber(registration.quantity, 1)),
        0,
      );
    if (ticketsIssued <= 0) continue;
    const checkedIn = eventTickets.filter(
      (ticket) => ticket.checked_in_at,
    ).length;
    const checkInRate = ticketsIssued ? checkedIn / ticketsIssued : 1;

    if (checkInRate < 0.75) {
      candidates.push({
        ruleKey: "aria_event_low_checkin",
        ruleName: "ARIA event check-in quality review",
        ruleDescription:
          "Creates ARIA actions for completed events with low check-in rates.",
        title: `Check-in quality review: ${event.name}`,
        body: `${event.name} checked in ${Math.round(checkInRate * 100)}% of issued tickets. Review whether scans were missed, attendees no-showed, or reminder timing needs improvement.`,
        priority: "high",
        relatedTable: "events",
        relatedId: event.id,
        dueAt: addAriaDays(now, 1).toISOString(),
      });
    }
  }

  return candidates;
}

export async function generateAriaOperationalActionsAction(formData: FormData) {
  const rateLimit = checkRateLimit(
    await getServerActionRateLimitKey("aria:generate-actions", [String(formData.get("ruleKey") ?? "")]),
    { limit: 4, windowMs: 10 * 60 * 1000 },
  );

  if (!rateLimit.allowed) {
    redirect(`/app/aria/operations?error=${encodeURIComponent(rateLimitErrorMessage(rateLimit))}`);
  }

  const returnTo =
    getAutomationActionReturnTo(formData.get("returnTo")) ??
    "/app/aria/operations";
  const context = await getCurrentStudioContext();

  if (!canManageSettings(context.studioRole ?? "")) {
    redirect(appendActionResult(returnTo, "error", "not-authorized"));
  }

  const supabase = await createClient();
  const candidates = isOrganizerAutomationRole(context.studioRole)
    ? await buildOrganizerAriaOperationalCandidates({
        supabase,
        studioId: context.studioId,
      })
    : await buildStudioAriaOperationalCandidates({
        supabase,
        studioId: context.studioId,
      });

  let result: {
    candidatesCount: number;
    createdCount: number;
    updatedCount: number;
  };

  try {
    result = await insertAriaOperationalActions({
      supabase,
      studioId: context.studioId,
      userId: context.userId,
      candidates,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create ARIA actions";
    console.error("ARIA operational action generation failed", error);
    redirect(
      appendActionResult(
        returnTo,
        "error",
        `aria_action_generation_failed:${message}`,
      ),
    );
  }

  revalidatePath("/app/automations");
  revalidatePath("/app/automations/drafts");
  revalidatePath("/app/aria");
  revalidatePath("/app/aria/operations");

  redirect(
    `${appendActionResult(returnTo, "success", "aria_actions_generated")}&created=${result.createdCount}&updated=${result.updatedCount}&candidates=${result.candidatesCount}`,
  );
}



const ARIA_EMAIL_EXECUTABLE_RULE_KEYS = [
  "aria_low_package_balance",
  "aria_stale_active_student",
  "aria_intro_no_purchase",
  "aria_membership_past_due",
  "aria_membership_canceling",
] as const;

type AriaEmailExecutableRuleKey = (typeof ARIA_EMAIL_EXECUTABLE_RULE_KEYS)[number];

type AriaApprovedExecutionActionRow = {
  id: string;
  studio_id: string;
  rule_key: string;
  title: string;
  body: string | null;
  status: string | null;
  related_table: string | null;
  related_id: string | null;
  client_id: string | null;
};

type AriaExecutionClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
};

type AriaExecutionStudioRow = {
  id: string;
  name: string | null;
  public_name: string | null;
  slug: string | null;
};

function isAriaEmailExecutableRuleKey(
  ruleKey: string | null | undefined,
): ruleKey is AriaEmailExecutableRuleKey {
  return ARIA_EMAIL_EXECUTABLE_RULE_KEYS.includes(
    ruleKey as AriaEmailExecutableRuleKey,
  );
}

function getAriaExecutionClientId(action: AriaApprovedExecutionActionRow) {
  if (action.client_id) return action.client_id;

  if (action.related_table === "clients" && action.related_id) {
    return action.related_id;
  }

  return null;
}

function getAriaExecutionSubject(params: {
  action: AriaApprovedExecutionActionRow;
  studioName: string;
}) {
  const { action, studioName } = params;

  if (action.rule_key === "aria_low_package_balance") {
    return `${studioName}: keep your lessons moving`;
  }

  if (action.rule_key === "aria_stale_active_student") {
    return `${studioName}: schedule your next lesson`;
  }

  if (action.rule_key === "aria_intro_no_purchase") {
    return `${studioName}: your next dance step`;
  }

  if (action.rule_key === "aria_membership_past_due") {
    return `${studioName}: membership billing follow-up`;
  }

  if (action.rule_key === "aria_membership_canceling") {
    return `${studioName}: membership follow-up`;
  }

  return `${studioName}: follow-up from the studio`;
}

function getAriaExecutionBody(params: {
  action: AriaApprovedExecutionActionRow;
  client: AriaExecutionClientRow;
  studio: AriaExecutionStudioRow | null;
}) {
  const { action, client, studio } = params;
  const studioName = getStudioDisplayName(studio);
  const firstName = client.first_name || compactName(client.first_name, client.last_name) || "there";
  const portalUrl = getPortalUrl(studio);
  const scheduleUrl = getPortalUrl(studio, "/schedule");
  const actionContext = action.body?.trim();

  if (action.rule_key === "aria_low_package_balance") {
    return `Hi ${firstName},

You are getting close to the end of your current lesson package.

When you are ready, you can renew your package through your client portal or reply here and we can help you choose the best next option.

${actionContext ? `Studio note: ${actionContext}\n\n` : ""}Client portal: ${portalUrl}

Thank you,
${studioName}`;
  }

  if (action.rule_key === "aria_stale_active_student") {
    return `Hi ${firstName},

We noticed you do not currently have your next lesson scheduled.

You can request your next lesson from your client portal, or reply here and we can help you find a time that works.

${actionContext ? `Studio note: ${actionContext}\n\n` : ""}Request your next lesson: ${scheduleUrl}

Thank you,
${studioName}`;
  }

  if (action.rule_key === "aria_intro_no_purchase") {
    return `Hi ${firstName},

Thank you again for starting your dance journey with us. We would love to help you keep that momentum going.

When you are ready, you can request your next lesson from your client portal or reply here and we can help you choose the best next step.

${actionContext ? `Studio note: ${actionContext}\n\n` : ""}Request your next lesson: ${scheduleUrl}

Thank you,
${studioName}`;
  }

  if (action.rule_key === "aria_membership_past_due") {
    return `Hi ${firstName},

We wanted to follow up because your membership needs billing attention.

Please open your client portal or contact us so we can help resolve it and keep your studio access current.

${actionContext ? `Studio note: ${actionContext}\n\n` : ""}Client portal: ${portalUrl}

Thank you,
${studioName}`;
  }

  if (action.rule_key === "aria_membership_canceling") {
    return `Hi ${firstName},

We noticed your membership is set to end soon and wanted to check in before that happens.

If you have questions or want to adjust your plan, reply here and we can help you find the best option.

${actionContext ? `Studio note: ${actionContext}\n\n` : ""}Client portal: ${portalUrl}

Thank you,
${studioName}`;
  }

  return `Hi ${firstName},

We wanted to follow up with you.

${actionContext ? `${actionContext}\n\n` : ""}Client portal: ${portalUrl}

Thank you,
${studioName}`;
}

export async function executeAriaApprovedActionsAction(formData: FormData) {
  const rateLimit = checkRateLimit(
    await getServerActionRateLimitKey("aria:execute-actions", [String(formData.get("ruleKey") ?? "")]),
    { limit: 4, windowMs: 10 * 60 * 1000 },
  );

  if (!rateLimit.allowed) {
    redirect(`/app/aria/operations?error=${encodeURIComponent(rateLimitErrorMessage(rateLimit))}`);
  }

  const returnTo =
    getAutomationActionReturnTo(formData.get("returnTo")) ??
    "/app/aria/operations";
  const context = await getCurrentStudioContext();

  if (!canManageSettings(context.studioRole ?? "")) {
    redirect(appendActionResult(returnTo, "error", "not-authorized"));
  }

  const supabase = await createClient();
  const adminSupabase = createAdminClient();

  const { data: approvedActions, error: actionsError } = await supabase
    .from("automation_actions")
    .select("id, studio_id, rule_key, title, body, status, related_table, related_id, client_id")
    .eq("studio_id", context.studioId)
    .eq("status", "approved")
    .in("rule_key", [...ARIA_EMAIL_EXECUTABLE_RULE_KEYS])
    .order("created_at", { ascending: true })
    .limit(50);

  if (actionsError) {
    console.error("ARIA approved action execution lookup failed", actionsError);
    redirect(
      appendActionResult(returnTo, "error", "aria_execution_lookup_failed"),
    );
  }

  const actions = (approvedActions ?? []) as AriaApprovedExecutionActionRow[];

  if (!actions.length) {
    redirect(
      `${appendActionResult(returnTo, "success", "aria_execution_complete")}&queued=0&skipped=0&failed=0&candidates=0`,
    );
  }

  const { data: studio } = await supabase
    .from("studios")
    .select("id, name, public_name, slug")
    .eq("id", context.studioId)
    .maybeSingle();

  const typedStudio = (studio ?? null) as AriaExecutionStudioRow | null;
  const clientIds = Array.from(
    new Set(
      actions
        .map((action) => getAriaExecutionClientId(action))
        .filter((value): value is string => Boolean(value)),
    ),
  );

  const { data: clients, error: clientsError } = clientIds.length
    ? await supabase
        .from("clients")
        .select("id, first_name, last_name, email")
        .eq("studio_id", context.studioId)
        .in("id", clientIds)
    : { data: [], error: null };

  if (clientsError) {
    console.error("ARIA execution client lookup failed", clientsError);
    redirect(
      appendActionResult(returnTo, "error", "aria_execution_lookup_failed"),
    );
  }

  const clientById = new Map(
    ((clients ?? []) as AriaExecutionClientRow[]).map((client) => [
      client.id,
      client,
    ]),
  );
  let queuedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const action of actions) {
    if (!isAriaEmailExecutableRuleKey(action.rule_key)) {
      skippedCount += 1;
      continue;
    }

    const clientId = getAriaExecutionClientId(action);
    const client = clientId ? clientById.get(clientId) : null;

    if (!client?.email?.trim()) {
      skippedCount += 1;
      await supabase.from("automation_action_events").insert({
        studio_id: context.studioId,
        automation_action_id: action.id,
        event_type: "execution_skipped",
        previous_status: action.status,
        new_status: action.status,
        note: "ARIA execution skipped because no client email was available.",
        metadata: { rule_key: action.rule_key, reason: "missing_client_email" },
        created_by: context.userId,
      });
      continue;
    }

    const studioName = getStudioDisplayName(typedStudio);
    const subject = getAriaExecutionSubject({ action, studioName });
    const bodyText = getAriaExecutionBody({
      action,
      client,
      studio: typedStudio,
    });
    const now = new Date().toISOString();

    try {
      const { data: existingDelivery, error: existingDeliveryError } =
        await adminSupabase
          .from("outbound_deliveries")
          .select("id, status")
          .eq("studio_id", context.studioId)
          .eq("related_table", "automation_actions")
          .eq("related_id", action.id)
          .eq("dedupe_key", `aria-execution:${action.id}:email`)
          .in("status", ["draft", "queued", "sent"])
          .maybeSingle<{ id: string; status: string | null }>();

      if (existingDeliveryError) {
        throw new Error(existingDeliveryError.message);
      }

      let deliveryId = existingDelivery?.id ?? null;

      if (existingDelivery?.status === "draft") {
        const { data: updatedDelivery, error: deliveryUpdateError } =
          await adminSupabase
            .from("outbound_deliveries")
            .update({
              status: "queued",
              subject,
              body_text: bodyText,
              body_html: renderPlainTextAsHtml(bodyText),
              updated_at: now,
            })
            .eq("id", existingDelivery.id)
            .eq("studio_id", context.studioId)
            .select("id")
            .maybeSingle<{ id: string }>();

        if (deliveryUpdateError) {
          throw new Error(deliveryUpdateError.message);
        }

        deliveryId = updatedDelivery?.id ?? existingDelivery.id;
      } else if (!existingDelivery) {
        const { data: insertedDelivery, error: deliveryInsertError } =
          await adminSupabase
            .from("outbound_deliveries")
            .insert({
              studio_id: context.studioId,
              channel: "email",
              template_key: `aria_execution_${action.rule_key}`,
              recipient_email: client.email.trim(),
              recipient_phone: null,
              subject,
              body_text: bodyText,
              body_html: renderPlainTextAsHtml(bodyText),
              related_table: "automation_actions",
              related_id: action.id,
              dedupe_key: `aria-execution:${action.id}:email`,
              status: "queued",
              updated_at: now,
            })
            .select("id")
            .single<{ id: string }>();

        if (deliveryInsertError) {
          throw new Error(deliveryInsertError.message);
        }

        deliveryId = insertedDelivery.id;
      }

      const { data: updatedAction, error: actionUpdateError } =
        await adminSupabase
          .from("automation_actions")
          .update({
            status: "queued",
            reviewed_at: now,
            reviewed_by: context.userId,
            updated_at: now,
            review_note: "ARIA queued an approved email follow-up.",
          })
          .eq("id", action.id)
          .eq("studio_id", context.studioId)
          .eq("status", "approved")
          .select("id")
          .maybeSingle<{ id: string }>();

      if (actionUpdateError) {
        throw new Error(actionUpdateError.message);
      }

      if (!updatedAction) {
        skippedCount += 1;
        continue;
      }

      const { error: eventError } = await supabase
        .from("automation_action_events")
        .insert({
          studio_id: context.studioId,
          automation_action_id: action.id,
          event_type: "execution_queued",
          previous_status: "approved",
          new_status: "queued",
          note: "ARIA queued an approved email follow-up.",
          metadata: {
            rule_key: action.rule_key,
            delivery_id: deliveryId,
            recipient_email: client.email.trim(),
          },
          created_by: context.userId,
        });

      if (eventError) {
        console.warn("ARIA execution event insert failed", eventError);
      }

      queuedCount += 1;
    } catch (error) {
      failedCount += 1;
      const message =
        error instanceof Error ? error.message : "Unknown ARIA execution error";

      console.error("ARIA action execution failed", error);

      await supabase.from("automation_action_events").insert({
        studio_id: context.studioId,
        automation_action_id: action.id,
        event_type: "execution_failed",
        previous_status: action.status,
        new_status: action.status,
        note: message.slice(0, 1000),
        metadata: { rule_key: action.rule_key },
        created_by: context.userId,
      });
    }
  }

  revalidatePath("/app/automations");
  revalidatePath("/app/automations/drafts");
  revalidatePath("/app/aria");
  revalidatePath("/app/aria/operations");

  redirect(
    `${appendActionResult(returnTo, "success", "aria_execution_complete")}&queued=${queuedCount}&skipped=${skippedCount}&failed=${failedCount}&candidates=${actions.length}`,
  );
}


type AutomationActionDraftRow = {
  id: string;
  studio_id: string;
  rule_key: string;
  title: string;
  body: string | null;
  status: string;
  related_table: string | null;
  related_id: string | null;
  client_id: string | null;
};

type DraftClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
};

type DraftStudioRow = {
  id: string;
  name: string | null;
  public_name: string | null;
  slug: string | null;
};

type DraftBookingRequestRow = {
  id: string;
  customer_first_name: string | null;
  customer_last_name: string | null;
  customer_email: string | null;
  requested_starts_at: string | null;
};

function compactName(firstName?: string | null, lastName?: string | null) {
  return [firstName, lastName].filter(Boolean).join(" ").trim();
}

function draftGreeting(clientName: string) {
  return clientName ? `Hi ${clientName},` : "Hi,";
}

function getStudioDisplayName(studio: DraftStudioRow | null | undefined) {
  return studio?.public_name || studio?.name || "your studio";
}

function getPortalUrl(studio: DraftStudioRow | null | undefined, path = "") {
  const siteUrl = (
    process.env.NEXT_PUBLIC_SITE_URL || "https://www.idanceflow.com"
  ).replace(/\/$/, "");
  const slug = studio?.slug;
  if (!slug) return siteUrl;
  return `${siteUrl}/portal/${slug}${path}`;
}

function formatDraftDateTime(value: string | null | undefined) {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function renderAutomationEmailDraft(params: {
  action: AutomationActionDraftRow;
  client: DraftClientRow | null;
  studio: DraftStudioRow | null;
  bookingRequest?: DraftBookingRequestRow | null;
  template?: AutomationEmailTemplateRow | null;
}) {
  const { action, client, studio, bookingRequest, template } = params;
  const values = getAutomationVariableValues({
    client,
    studio,
    bookingRequest,
  });
  const defaultTemplate = getAutomationTemplateDefault(action.rule_key);

  const fallbackSubject =
    defaultTemplate?.subject || "{{studio_name}}: follow-up from the studio";
  const fallbackBody =
    defaultTemplate?.bodyText ||
    `Hi {{client_first_name}},

{{action_body}}

Client portal: {{portal_link}}

Thank you,
{{studio_name}}`;

  const subjectTemplate = template?.subject?.trim() || fallbackSubject;
  const bodyTemplate = template?.body_text?.trim() || fallbackBody;

  const subject = applyAutomationTemplate(subjectTemplate, values);
  const bodyText = applyAutomationTemplate(bodyTemplate, {
    ...values,
    action_body: action.body || "We wanted to follow up with you.",
  });

  return {
    subject,
    bodyText,
    bodyHtml: renderPlainTextAsHtml(bodyText),
  };
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

export async function createAutomationEmailDraftAction(formData: FormData) {
  const actionId = String(formData.get("actionId") ?? "");

  if (!actionId) {
    redirect("/app/automations?error=missing-action");
  }

  const context = await getCurrentStudioContext();

  if (!canManageSettings(context.studioRole ?? "")) {
    redirect("/app/automations?error=not-authorized");
  }

  const supabase = await createClient();

  const { data: action, error: actionError } = await supabase
    .from("automation_actions")
    .select(
      "id, studio_id, rule_key, title, body, status, related_table, related_id, client_id",
    )
    .eq("id", actionId)
    .eq("studio_id", context.studioId)
    .maybeSingle();

  if (actionError) {
    redirect(
      `/app/automations?error=${encodeURIComponent(actionError.message)}`,
    );
  }

  if (!action) {
    redirect("/app/automations?error=action-not-found");
  }

  const typedAction = action as AutomationActionDraftRow;

  if (!["suggested", "drafted"].includes(typedAction.status)) {
    redirect("/app/automations?error=action-not-draftable");
  }

  const { data: existingDraft, error: existingDraftError } = await supabase
    .from("outbound_deliveries")
    .select("id")
    .eq("studio_id", context.studioId)
    .eq("related_table", "automation_actions")
    .eq("related_id", actionId)
    .eq("template_key", `automation_${typedAction.rule_key}`)
    .in("status", ["draft", "queued", "sent"])
    .maybeSingle();

  if (existingDraftError) {
    redirect(
      `/app/automations?error=${encodeURIComponent(existingDraftError.message)}`,
    );
  }

  if (existingDraft) {
    await supabase
      .from("automation_actions")
      .update({ status: "drafted", updated_at: new Date().toISOString() })
      .eq("id", actionId)
      .eq("studio_id", context.studioId);

    revalidatePath("/app/automations");
    revalidatePath("/app/automations/drafts");
    redirect("/app/automations?success=draft-exists");
  }

  const [{ data: studio }, { data: client }] = await Promise.all([
    supabase
      .from("studios")
      .select("id, name, public_name, slug")
      .eq("id", context.studioId)
      .maybeSingle(),
    typedAction.client_id
      ? supabase
          .from("clients")
          .select("id, first_name, last_name, email")
          .eq("id", typedAction.client_id)
          .eq("studio_id", context.studioId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  let bookingRequest: DraftBookingRequestRow | null = null;
  if (
    typedAction.related_table === "booking_requests" &&
    typedAction.related_id
  ) {
    const { data } = await supabase
      .from("booking_requests")
      .select(
        "id, customer_first_name, customer_last_name, customer_email, requested_starts_at",
      )
      .eq("id", typedAction.related_id)
      .eq("studio_id", context.studioId)
      .maybeSingle();

    bookingRequest = (data ?? null) as DraftBookingRequestRow | null;
  }

  const typedClient = (client ?? null) as DraftClientRow | null;
  const typedStudio = (studio ?? null) as DraftStudioRow | null;
  const recipientEmail =
    typedClient?.email || bookingRequest?.customer_email || null;

  if (!recipientEmail) {
    redirect("/app/automations?error=missing-recipient-email");
  }

  const { data: template } = await supabase
    .from("automation_email_templates")
    .select("rule_key, subject, body_text")
    .eq("studio_id", context.studioId)
    .eq("rule_key", typedAction.rule_key)
    .maybeSingle();

  const draft = renderAutomationEmailDraft({
    action: typedAction,
    client: typedClient,
    studio: typedStudio,
    bookingRequest,
    template: (template ?? null) as AutomationEmailTemplateRow | null,
  });

  const { error: deliveryError } = await supabase
    .from("outbound_deliveries")
    .insert({
      studio_id: context.studioId,
      channel: "email",
      template_key: `automation_${typedAction.rule_key}`,
      recipient_email: recipientEmail,
      recipient_phone: null,
      subject: draft.subject,
      body_text: draft.bodyText,
      body_html: draft.bodyHtml,
      related_table: "automation_actions",
      related_id: actionId,
      dedupe_key: `automation:${actionId}:email-draft`,
      status: "draft",
      updated_at: new Date().toISOString(),
    });

  if (deliveryError) {
    if (deliveryError.code !== "23505") {
      redirect(
        `/app/automations?error=${encodeURIComponent(deliveryError.message)}`,
      );
    }
  }

  const { error: updateError } = await supabase
    .from("automation_actions")
    .update({
      status: "drafted",
      updated_at: new Date().toISOString(),
    })
    .eq("id", actionId)
    .eq("studio_id", context.studioId);

  if (updateError) {
    redirect(
      `/app/automations?error=${encodeURIComponent(updateError.message)}`,
    );
  }

  revalidatePath("/app/automations");
  revalidatePath("/app/automations/drafts");
  redirect("/app/automations?success=draft-created");
}

function getDraftFormValue(formData: FormData, keys: string[]): string {
  for (const key of keys) {
    const value = formData.get(key);

    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return "";
}

function getAutomationReturnPath(formData: FormData): string {
  const rawReturnTo = formData.get("returnTo");

  if (typeof rawReturnTo !== "string") {
    return "/app/automations";
  }

  const returnTo = rawReturnTo.trim();

  if (
    returnTo.startsWith("/app/automations") &&
    !returnTo.startsWith("//") &&
    !returnTo.includes("://")
  ) {
    return returnTo;
  }

  return "/app/automations";
}

export async function saveAutomationEmailDraftAction(formData: FormData) {
  const actionId = String(formData.get("actionId") ?? "");
  const deliveryId = String(formData.get("deliveryId") ?? "");
  const subject = getDraftFormValue(formData, ["subject", "draftSubject"]);
  const bodyText = getDraftFormValue(formData, [
    "bodyText",
    "draftBody",
    "body",
  ]);
  const returnPath = getAutomationReturnPath(formData);

  if (!actionId || !deliveryId) {
    redirect("/app/automations?error=missing-draft");
  }

  if (!subject || !bodyText) {
    redirect("/app/automations?error=missing-draft-content");
  }

  const context = await getCurrentStudioContext();

  if (!canManageSettings(context.studioRole ?? "")) {
    redirect("/app/automations?error=not-authorized");
  }

  const supabase = await createClient();

  const { data: draft, error: draftError } = await supabase
    .from("outbound_deliveries")
    .select("id, status, related_id")
    .eq("id", deliveryId)
    .eq("studio_id", context.studioId)
    .eq("related_table", "automation_actions")
    .eq("related_id", actionId)
    .maybeSingle();

  if (draftError) {
    redirect(
      `/app/automations?error=${encodeURIComponent(draftError.message)}`,
    );
  }

  if (!draft) {
    redirect("/app/automations?error=draft-not-found");
  }

  const typedDraft = draft as {
    id: string;
    status: string;
    related_id: string | null;
  };

  if (typedDraft.status !== "draft") {
    redirect("/app/automations?error=draft-not-editable");
  }

  const adminSupabase = createAdminClient();
  const { data: updatedDelivery, error: deliveryUpdateError } =
    await adminSupabase
      .from("outbound_deliveries")
      .update({
        subject,
        body_text: bodyText,
        body_html: renderPlainTextAsHtml(bodyText),
        updated_at: new Date().toISOString(),
      })
      .eq("id", deliveryId)
      .eq("studio_id", context.studioId)
      .eq("status", "draft")
      .select("id")
      .maybeSingle();

  if (deliveryUpdateError) {
    redirect(
      `${returnPath}?error=${encodeURIComponent(deliveryUpdateError.message)}`,
    );
  }

  if (!updatedDelivery) {
    redirect(`${returnPath}?error=draft-update-skipped`);
  }

  await adminSupabase
    .from("automation_actions")
    .update({
      updated_at: new Date().toISOString(),
    })
    .eq("id", actionId)
    .eq("studio_id", context.studioId);

  revalidatePath("/app/automations");
  revalidatePath("/app/automations/drafts");
  redirect(`${returnPath}?success=draft-saved`);
}

export async function queueAutomationEmailDraftAction(formData: FormData) {
  const actionId = String(formData.get("actionId") ?? "");
  const deliveryId = String(formData.get("deliveryId") ?? "");
  const subject = getDraftFormValue(formData, ["subject", "draftSubject"]);
  const bodyText = getDraftFormValue(formData, [
    "bodyText",
    "draftBody",
    "body",
  ]);
  const returnPath = getAutomationReturnPath(formData);

  if (!actionId || !deliveryId) {
    redirect("/app/automations?error=missing-draft");
  }

  const context = await getCurrentStudioContext();

  if (!canManageSettings(context.studioRole ?? "")) {
    redirect("/app/automations?error=not-authorized");
  }

  const supabase = await createClient();

  const { data: draft, error: draftError } = await supabase
    .from("outbound_deliveries")
    .select("id, status, related_id")
    .eq("id", deliveryId)
    .eq("studio_id", context.studioId)
    .eq("related_table", "automation_actions")
    .eq("related_id", actionId)
    .maybeSingle();

  if (draftError) {
    redirect(
      `/app/automations?error=${encodeURIComponent(draftError.message)}`,
    );
  }

  if (!draft) {
    redirect("/app/automations?error=draft-not-found");
  }

  const typedDraft = draft as {
    id: string;
    status: string;
    related_id: string | null;
  };

  if (typedDraft.status !== "draft") {
    redirect("/app/automations?error=draft-not-queueable");
  }

  const updatePayload: Record<string, unknown> = {
    status: "queued",
    updated_at: new Date().toISOString(),
  };

  if (subject && bodyText) {
    updatePayload.subject = subject;
    updatePayload.body_text = bodyText;
    updatePayload.body_html = renderPlainTextAsHtml(bodyText);
  }

  const adminSupabase = createAdminClient();
  const { data: updatedDelivery, error: deliveryUpdateError } =
    await adminSupabase
      .from("outbound_deliveries")
      .update(updatePayload)
      .eq("id", deliveryId)
      .eq("studio_id", context.studioId)
      .eq("status", "draft")
      .select("id")
      .maybeSingle();

  if (deliveryUpdateError) {
    redirect(
      `${returnPath}?error=${encodeURIComponent(deliveryUpdateError.message)}`,
    );
  }

  if (!updatedDelivery) {
    redirect(`${returnPath}?error=draft-update-skipped`);
  }

  await adminSupabase
    .from("automation_actions")
    .update({
      updated_at: new Date().toISOString(),
    })
    .eq("id", actionId)
    .eq("studio_id", context.studioId);

  revalidatePath("/app/automations");
  revalidatePath("/app/automations/drafts");
  redirect(`${returnPath}?success=draft-queued`);
}

type ClientPackageBalanceRow = {
  id: string;
  client_id: string | null;
  name_snapshot: string | null;
  active: boolean | null;
  expiration_date: string | null;
  clients:
    | {
        first_name: string | null;
        last_name: string | null;
        email: string | null;
      }
    | {
        first_name: string | null;
        last_name: string | null;
        email: string | null;
      }[]
    | null;
  client_package_items: {
    id: string;
    usage_type: string | null;
    quantity_remaining: number | null;
    is_unlimited: boolean | null;
  }[];
};

function asNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getClientDisplayName(
  value:
    | {
        first_name: string | null;
        last_name: string | null;
        email: string | null;
      }
    | {
        first_name: string | null;
        last_name: string | null;
        email: string | null;
      }[]
    | null,
) {
  const client = Array.isArray(value) ? value[0] : value;
  const name = [client?.first_name, client?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || client?.email || "Client";
}

function packageActionStatusForMode(mode: string | null | undefined) {
  return mode === "draft" ? "drafted" : "suggested";
}

type AppointmentAutomationRow = {
  id: string;
  client_id: string | null;
  appointment_type: string | null;
  status: string | null;
  starts_at: string;
  ends_at: string | null;
  title: string | null;
};

type AutomationClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  status: string | null;
};

type BookingRequestAutomationRow = {
  id: string;
  client_id: string | null;
  status: string | null;
  requested_starts_at: string | null;
};

type PendingBookingRequestAutomationRow = {
  id: string;
  client_id: string | null;
  source: string | null;
  status: string | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  customer_email: string | null;
  requested_starts_at: string | null;
  created_at: string;
};

type UnsignedDocumentAssignmentAutomationRow = {
  id: string;
  client_id: string | null;
  status: string | null;
  due_at: string | null;
  assigned_to_email: string | null;
  created_at: string;
  document_templates:
    | { title: string | null; document_type: string | null }
    | { title: string | null; document_type: string | null }[]
    | null;
  clients:
    | {
        first_name: string | null;
        last_name: string | null;
        email: string | null;
      }
    | {
        first_name: string | null;
        last_name: string | null;
        email: string | null;
      }[]
    | null;
};

function getSimpleClientName(client: AutomationClientRow) {
  const name = [client.first_name, client.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || client.email || "Client";
}

function getBookingRequestClientName(
  request: PendingBookingRequestAutomationRow,
) {
  const name = [request.customer_first_name, request.customer_last_name]
    .filter(Boolean)
    .join(" ")
    .trim();

  return name || request.customer_email || "Client";
}

function sourceLabel(source: string | null | undefined) {
  if (source === "portal_schedule") return "portal schedule request";
  if (source === "public_intro") return "public intro request";
  return "booking request";
}

function formatRequestedTime(value: string | null | undefined) {
  if (!value) return "No requested time provided";

  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDueDate(value: string | null | undefined) {
  if (!value) return "No due date set";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function getDocumentTemplateTitle(
  value:
    | { title: string | null; document_type: string | null }
    | { title: string | null; document_type: string | null }[]
    | null,
) {
  const template = Array.isArray(value) ? value[0] : value;
  return template?.title || template?.document_type || "Document";
}

function getDocumentAssignmentClientName(
  assignment: UnsignedDocumentAssignmentAutomationRow,
) {
  const client = Array.isArray(assignment.clients)
    ? assignment.clients[0]
    : assignment.clients;
  const name = [client?.first_name, client?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || client?.email || assignment.assigned_to_email || "Client";
}

function isActiveClientStatus(status: string | null | undefined) {
  const normalized = String(status ?? "").toLowerCase();
  return !["archived", "lost"].includes(normalized);
}

function isCountableAppointment(status: string | null | undefined) {
  const normalized = String(status ?? "").toLowerCase();
  return !["cancelled", "canceled", "no_show", "void"].includes(normalized);
}

function getUsualLessonTimeSummary(appointments: AppointmentAutomationRow[]) {
  if (appointments.length === 0) return null;

  const formatter = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
  });

  const bucketCounts = new Map<string, { label: string; count: number }>();

  for (const appointment of appointments) {
    const date = new Date(appointment.starts_at);
    if (Number.isNaN(date.getTime())) continue;

    const label = formatter.format(date);
    const day = date.getUTCDay();
    const hour = date.getUTCHours();
    const minuteBucket = Math.round(date.getUTCMinutes() / 15) * 15;
    const key = `${day}-${hour}-${minuteBucket}`;

    const existing = bucketCounts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      bucketCounts.set(key, { label, count: 1 });
    }
  }

  const sorted = [...bucketCounts.values()].sort((a, b) => b.count - a.count);
  return sorted[0]?.label ?? null;
}

async function evaluateLowPackageBalanceAutomation(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  context: Awaited<ReturnType<typeof getCurrentStudioContext>>;
  definition: AutomationDefinition;
  rule: { id: string; mode: string | null; trigger_config: unknown };
  runId: string;
  ruleKey: string;
}) {
  const { supabase, context, definition, rule, runId, ruleKey } = params;
  let candidatesCount = 0;
  let createdCount = 0;

  const threshold = asNumber(
    (rule.trigger_config as Record<string, unknown> | null | undefined)
      ?.threshold,
    asNumber(definition.defaultTriggerConfig.threshold, 2),
  );

  const { data: packages, error: packageError } = await supabase
    .from("client_packages")
    .select(
      `
      id,
      client_id,
      name_snapshot,
      active,
      expiration_date,
      clients (
        first_name,
        last_name,
        email
      ),
      client_package_items (
        id,
        usage_type,
        quantity_remaining,
        is_unlimited
      )
    `,
    )
    .eq("studio_id", context.studioId)
    .eq("active", true);

  if (packageError) {
    throw new Error(packageError.message);
  }

  const typedPackages = (packages ?? []) as ClientPackageBalanceRow[];
  const candidates = typedPackages
    .map((clientPackage) => {
      const lowItems = (clientPackage.client_package_items ?? []).filter(
        (item) => {
          if (item.is_unlimited) return false;
          if (
            item.quantity_remaining === null ||
            item.quantity_remaining === undefined
          )
            return false;
          return Number(item.quantity_remaining) <= threshold;
        },
      );

      if (lowItems.length === 0) return null;

      const lowestRemaining = Math.min(
        ...lowItems.map((item) => Number(item.quantity_remaining ?? threshold)),
      );

      return {
        clientPackage,
        lowItems,
        lowestRemaining,
      };
    })
    .filter(Boolean) as Array<{
    clientPackage: ClientPackageBalanceRow;
    lowItems: ClientPackageBalanceRow["client_package_items"];
    lowestRemaining: number;
  }>;

  candidatesCount = candidates.length;
  const existingRelatedIds = new Set<string>();

  if (candidates.length > 0) {
    const { data: existingActions, error: existingError } = await supabase
      .from("automation_actions")
      .select("related_id")
      .eq("studio_id", context.studioId)
      .eq("rule_key", ruleKey)
      .eq("related_table", "client_packages")
      .in(
        "related_id",
        candidates.map((candidate) => candidate.clientPackage.id),
      )
      .in("status", [
        "suggested",
        "drafted",
        "approved",
        "queued",
        "snoozed",
        "skipped",
      ]);

    if (existingError) {
      throw new Error(existingError.message);
    }

    for (const action of existingActions ?? []) {
      if (action.related_id) existingRelatedIds.add(String(action.related_id));
    }
  }

  const now = new Date();
  const dueAt = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const actionStatus = packageActionStatusForMode(rule.mode);
  const actionsToCreate = candidates
    .filter((candidate) => !existingRelatedIds.has(candidate.clientPackage.id))
    .map((candidate) => {
      const clientName = getClientDisplayName(candidate.clientPackage.clients);
      const packageName = candidate.clientPackage.name_snapshot || "package";
      const lowItemSummary = candidate.lowItems
        .map(
          (item) =>
            `${item.quantity_remaining ?? 0} ${item.usage_type ?? "credit"}`,
        )
        .join(", ");

      return {
        studio_id: context.studioId,
        rule_id: rule.id,
        rule_key: ruleKey,
        title: `Package renewal suggested: ${clientName}`,
        body: `${clientName} has ${candidate.lowestRemaining} or fewer credits remaining on ${packageName}. Review their balance and send a renewal prompt from the client profile or package sales workflow. Low items: ${lowItemSummary}.`,
        status: actionStatus,
        priority: candidate.lowestRemaining <= 0 ? "urgent" : "high",
        related_table: "client_packages",
        related_id: candidate.clientPackage.id,
        client_id: candidate.clientPackage.client_id,
        due_at: dueAt,
        created_by_run_id: runId,
      };
    });

  createdCount = actionsToCreate.length;

  if (actionsToCreate.length > 0) {
    const { error: actionError } = await supabase
      .from("automation_actions")
      .insert(actionsToCreate);

    if (actionError) {
      throw new Error(actionError.message);
    }
  }

  return { candidatesCount, createdCount };
}

async function evaluateNoUpcomingLessonAutomation(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  context: Awaited<ReturnType<typeof getCurrentStudioContext>>;
  definition: AutomationDefinition;
  rule: { id: string; mode: string | null; trigger_config: unknown };
  runId: string;
  ruleKey: string;
}) {
  const { supabase, context, definition, rule, runId, ruleKey } = params;
  const lookbackDays = asNumber(
    (rule.trigger_config as Record<string, unknown> | null | undefined)
      ?.lookback_days,
    asNumber(definition.defaultTriggerConfig.lookback_days, 90),
  );

  const now = new Date();
  const nowIso = now.toISOString();
  const lookbackStart = new Date(
    now.getTime() - lookbackDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const [
    { data: clients, error: clientsError },
    { data: recentAppointments, error: recentError },
    { data: futureAppointments, error: futureError },
    { data: pendingRequests, error: pendingError },
  ] = await Promise.all([
    supabase
      .from("clients")
      .select("id, first_name, last_name, email, status")
      .eq("studio_id", context.studioId),
    supabase
      .from("appointments")
      .select(
        "id, client_id, appointment_type, status, starts_at, ends_at, title",
      )
      .eq("studio_id", context.studioId)
      .gte("starts_at", lookbackStart)
      .lt("starts_at", nowIso)
      .order("starts_at", { ascending: false }),
    supabase
      .from("appointments")
      .select(
        "id, client_id, appointment_type, status, starts_at, ends_at, title",
      )
      .eq("studio_id", context.studioId)
      .gte("starts_at", nowIso),
    supabase
      .from("booking_requests")
      .select("id, client_id, status, requested_starts_at")
      .eq("studio_id", context.studioId)
      .eq("status", "pending"),
  ]);

  if (clientsError) throw new Error(clientsError.message);
  if (recentError) throw new Error(recentError.message);
  if (futureError) throw new Error(futureError.message);
  if (pendingError) throw new Error(pendingError.message);

  const typedClients = ((clients ?? []) as AutomationClientRow[]).filter(
    (client) => isActiveClientStatus(client.status),
  );
  const recentByClient = new Map<string, AppointmentAutomationRow[]>();
  const futureClientIds = new Set<string>();
  const pendingRequestClientIds = new Set<string>();

  for (const appointment of (recentAppointments ??
    []) as AppointmentAutomationRow[]) {
    if (!appointment.client_id || !isCountableAppointment(appointment.status))
      continue;
    const existing = recentByClient.get(appointment.client_id) ?? [];
    existing.push(appointment);
    recentByClient.set(appointment.client_id, existing);
  }

  for (const appointment of (futureAppointments ??
    []) as AppointmentAutomationRow[]) {
    if (!appointment.client_id || !isCountableAppointment(appointment.status))
      continue;
    futureClientIds.add(appointment.client_id);
  }

  for (const request of (pendingRequests ??
    []) as BookingRequestAutomationRow[]) {
    if (request.client_id) pendingRequestClientIds.add(request.client_id);
  }

  const candidates = typedClients
    .filter((client) => recentByClient.has(client.id))
    .filter((client) => !futureClientIds.has(client.id))
    .filter((client) => !pendingRequestClientIds.has(client.id))
    .map((client) => ({
      client,
      recentAppointments: recentByClient.get(client.id) ?? [],
    }));

  const candidatesCount = candidates.length;
  const existingRelatedIds = new Set<string>();

  if (candidates.length > 0) {
    const { data: existingActions, error: existingError } = await supabase
      .from("automation_actions")
      .select("related_id")
      .eq("studio_id", context.studioId)
      .eq("rule_key", ruleKey)
      .eq("related_table", "clients")
      .in(
        "related_id",
        candidates.map((candidate) => candidate.client.id),
      )
      .in("status", [
        "suggested",
        "drafted",
        "approved",
        "queued",
        "snoozed",
        "skipped",
      ]);

    if (existingError) {
      throw new Error(existingError.message);
    }

    for (const action of existingActions ?? []) {
      if (action.related_id) existingRelatedIds.add(String(action.related_id));
    }
  }

  const actionStatus = packageActionStatusForMode(rule.mode);
  const dueAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  const actionsToCreate = candidates
    .filter((candidate) => !existingRelatedIds.has(candidate.client.id))
    .map((candidate) => {
      const clientName = getSimpleClientName(candidate.client);
      const usualTime = getUsualLessonTimeSummary(candidate.recentAppointments);
      const recentCount = candidate.recentAppointments.length;
      const usualTimeText = usualTime
        ? ` Their recent lessons most often happened around ${usualTime}.`
        : "";
      const portalPrompt =
        "Suggested action: send a rebooking prompt or invite them to request their next lesson from the client portal.";

      return {
        studio_id: context.studioId,
        rule_id: rule.id,
        rule_key: ruleKey,
        title: `Rebooking suggested: ${clientName}`,
        body: `${clientName} has no upcoming lesson scheduled and had ${recentCount} lesson${recentCount === 1 ? "" : "s"} in the last ${lookbackDays} days.${usualTimeText} ${portalPrompt}`,
        status: actionStatus,
        priority: "high",
        related_table: "clients",
        related_id: candidate.client.id,
        client_id: candidate.client.id,
        due_at: dueAt,
        created_by_run_id: runId,
      };
    });

  if (actionsToCreate.length > 0) {
    const { error: actionError } = await supabase
      .from("automation_actions")
      .insert(actionsToCreate);

    if (actionError) {
      throw new Error(actionError.message);
    }
  }

  return { candidatesCount, createdCount: actionsToCreate.length };
}

async function evaluateUnsignedDocumentAutomation(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  context: Awaited<ReturnType<typeof getCurrentStudioContext>>;
  definition: AutomationDefinition;
  rule: {
    id: string;
    mode: string | null;
    trigger_config: unknown;
    action_config?: unknown;
  };
  runId: string;
  ruleKey: string;
}) {
  const { supabase, context, definition, rule, runId, ruleKey } = params;
  const dueWithinDays = asNumber(
    (rule.trigger_config as Record<string, unknown> | null | undefined)
      ?.due_within_days,
    asNumber(definition.defaultTriggerConfig.due_within_days, 7),
  );

  const now = new Date();
  const dueCutoffIso = new Date(
    now.getTime() + dueWithinDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data: assignments, error: assignmentsError } = await supabase
    .from("document_assignments")
    .select(
      `
      id,
      client_id,
      status,
      due_at,
      assigned_to_email,
      created_at,
      document_templates (
        title,
        document_type
      ),
      clients (
        first_name,
        last_name,
        email
      )
    `,
    )
    .eq("studio_id", context.studioId)
    .eq("status", "pending")
    .or(`due_at.is.null,due_at.lte.${dueCutoffIso}`)
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });

  if (assignmentsError) {
    throw new Error(assignmentsError.message);
  }

  const candidates = (assignments ??
    []) as UnsignedDocumentAssignmentAutomationRow[];
  const candidatesCount = candidates.length;
  const existingRelatedIds = new Set<string>();

  if (candidates.length > 0) {
    const { data: existingActions, error: existingError } = await supabase
      .from("automation_actions")
      .select("related_id")
      .eq("studio_id", context.studioId)
      .eq("rule_key", ruleKey)
      .eq("related_table", "document_assignments")
      .in(
        "related_id",
        candidates.map((candidate) => candidate.id),
      )
      .in("status", [
        "suggested",
        "drafted",
        "approved",
        "queued",
        "snoozed",
        "skipped",
      ]);

    if (existingError) {
      throw new Error(existingError.message);
    }

    for (const action of existingActions ?? []) {
      if (action.related_id) existingRelatedIds.add(String(action.related_id));
    }
  }

  const actionStatus = packageActionStatusForMode(rule.mode);
  const dueAt = now.toISOString();

  const actionsToCreate = candidates
    .filter((candidate) => !existingRelatedIds.has(candidate.id))
    .map((candidate) => {
      const clientName = getDocumentAssignmentClientName(candidate);
      const documentTitle = getDocumentTemplateTitle(
        candidate.document_templates,
      );
      const dueDateText = candidate.due_at
        ? `It is due ${formatDueDate(candidate.due_at)}.`
        : "No due date is set, so staff should follow up when appropriate.";
      const priority =
        candidate.due_at && new Date(candidate.due_at).getTime() < now.getTime()
          ? "urgent"
          : "high";

      return {
        studio_id: context.studioId,
        rule_id: rule.id,
        rule_key: ruleKey,
        title: `Unsigned document reminder: ${clientName}`,
        body: `${clientName} still needs to sign ${documentTitle}. ${dueDateText} Suggested action: remind the client to complete the document from their portal or resend the signing link from Documents.`,
        status: actionStatus,
        priority,
        related_table: "document_assignments",
        related_id: candidate.id,
        client_id: candidate.client_id,
        due_at: dueAt,
        created_by_run_id: runId,
      };
    });

  if (actionsToCreate.length > 0) {
    const { error: actionError } = await supabase
      .from("automation_actions")
      .insert(actionsToCreate);

    if (actionError) {
      throw new Error(actionError.message);
    }
  }

  return { candidatesCount, createdCount: actionsToCreate.length };
}

async function evaluatePendingBookingRequestAutomation(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  context: Awaited<ReturnType<typeof getCurrentStudioContext>>;
  definition: AutomationDefinition;
  rule: {
    id: string;
    mode: string | null;
    trigger_config: unknown;
    action_config?: unknown;
  };
  runId: string;
  ruleKey: string;
}) {
  const { supabase, context, definition, rule, runId, ruleKey } = params;
  const pendingHours = asNumber(
    (rule.trigger_config as Record<string, unknown> | null | undefined)
      ?.pending_hours,
    asNumber(definition.defaultTriggerConfig.pending_hours, 24),
  );

  const now = new Date();
  const cutoffIso = new Date(
    now.getTime() - pendingHours * 60 * 60 * 1000,
  ).toISOString();

  const { data: pendingRequests, error: pendingError } = await supabase
    .from("booking_requests")
    .select(
      "id, client_id, source, status, customer_first_name, customer_last_name, customer_email, requested_starts_at, created_at",
    )
    .eq("studio_id", context.studioId)
    .eq("status", "pending")
    .lte("created_at", cutoffIso)
    .order("created_at", { ascending: true });

  if (pendingError) {
    throw new Error(pendingError.message);
  }

  const candidates = (pendingRequests ??
    []) as PendingBookingRequestAutomationRow[];
  const candidatesCount = candidates.length;
  const existingRelatedIds = new Set<string>();

  if (candidates.length > 0) {
    const { data: existingActions, error: existingError } = await supabase
      .from("automation_actions")
      .select("related_id")
      .eq("studio_id", context.studioId)
      .eq("rule_key", ruleKey)
      .eq("related_table", "booking_requests")
      .in(
        "related_id",
        candidates.map((candidate) => candidate.id),
      )
      .in("status", [
        "suggested",
        "drafted",
        "approved",
        "queued",
        "snoozed",
        "skipped",
      ]);

    if (existingError) {
      throw new Error(existingError.message);
    }

    for (const action of existingActions ?? []) {
      if (action.related_id) existingRelatedIds.add(String(action.related_id));
    }
  }

  const actionStatus = packageActionStatusForMode(rule.mode);
  const dueAt = now.toISOString();
  const configuredPriority = (
    rule.action_config as Record<string, unknown> | null | undefined
  )?.priority;
  const priority =
    typeof configuredPriority === "string" && configuredPriority.length > 0
      ? configuredPriority
      : "high";

  const actionsToCreate = candidates
    .filter((candidate) => !existingRelatedIds.has(candidate.id))
    .map((candidate) => {
      const clientName = getBookingRequestClientName(candidate);
      const requestType = sourceLabel(candidate.source);
      const requestedTime = formatRequestedTime(candidate.requested_starts_at);
      const createdAt = formatRequestedTime(candidate.created_at);

      return {
        studio_id: context.studioId,
        rule_id: rule.id,
        rule_key: ruleKey,
        title: `Booking request needs review: ${clientName}`,
        body: `${clientName}'s ${requestType} has been pending since ${createdAt}. Requested time: ${requestedTime}. Suggested action: approve, decline, or contact the client with another option.`,
        status: actionStatus,
        priority,
        related_table: "booking_requests",
        related_id: candidate.id,
        client_id: candidate.client_id,
        due_at: dueAt,
        created_by_run_id: runId,
      };
    });

  if (actionsToCreate.length > 0) {
    const { error: actionError } = await supabase
      .from("automation_actions")
      .insert(actionsToCreate);

    if (actionError) {
      throw new Error(actionError.message);
    }
  }

  return { candidatesCount, createdCount: actionsToCreate.length };
}

async function evaluateFirstLessonFollowUpAutomation(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  context: Awaited<ReturnType<typeof getCurrentStudioContext>>;
  definition: AutomationDefinition;
  rule: {
    id: string;
    mode: string | null;
    trigger_config: unknown;
    action_config?: unknown;
  };
  runId: string;
  ruleKey: string;
}) {
  const { supabase, context, definition, rule, runId, ruleKey } = params;
  const afterHours = asNumber(
    (rule.trigger_config as Record<string, unknown> | null | undefined)
      ?.after_hours,
    asNumber(definition.defaultTriggerConfig.after_hours, 24),
  );
  const lookbackDays = asNumber(
    (rule.trigger_config as Record<string, unknown> | null | undefined)
      ?.lookback_days,
    asNumber(definition.defaultTriggerConfig.lookback_days, 14),
  );

  const now = new Date();
  const cutoffIso = new Date(
    now.getTime() - afterHours * 60 * 60 * 1000,
  ).toISOString();
  const lookbackStartIso = new Date(
    now.getTime() - lookbackDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const [
    { data: clients, error: clientsError },
    { data: attendedAppointments, error: appointmentsError },
  ] = await Promise.all([
    supabase
      .from("clients")
      .select("id, first_name, last_name, email, status")
      .eq("studio_id", context.studioId),
    supabase
      .from("appointments")
      .select(
        "id, client_id, appointment_type, status, starts_at, ends_at, title",
      )
      .eq("studio_id", context.studioId)
      .eq("status", "attended")
      .lte("starts_at", cutoffIso)
      .order("starts_at", { ascending: true }),
  ]);

  if (clientsError) throw new Error(clientsError.message);
  if (appointmentsError) throw new Error(appointmentsError.message);

  const activeClients = new Map<string, AutomationClientRow>();
  for (const client of (clients ?? []) as AutomationClientRow[]) {
    if (isActiveClientStatus(client.status)) {
      activeClients.set(client.id, client);
    }
  }

  const firstAttendedByClient = new Map<string, AppointmentAutomationRow>();
  for (const appointment of (attendedAppointments ??
    []) as AppointmentAutomationRow[]) {
    if (!appointment.client_id || !activeClients.has(appointment.client_id))
      continue;
    if (!isCountableAppointment(appointment.status)) continue;
    if (!firstAttendedByClient.has(appointment.client_id)) {
      firstAttendedByClient.set(appointment.client_id, appointment);
    }
  }

  const candidates = [...firstAttendedByClient.entries()]
    .map(([clientId, appointment]) => ({
      client: activeClients.get(clientId),
      appointment,
    }))
    .filter(
      (
        candidate,
      ): candidate is {
        client: AutomationClientRow;
        appointment: AppointmentAutomationRow;
      } => {
        if (!candidate.client) return false;
        const firstLessonTime = new Date(
          candidate.appointment.starts_at,
        ).getTime();
        return firstLessonTime >= new Date(lookbackStartIso).getTime();
      },
    );

  const candidatesCount = candidates.length;
  const existingRelatedIds = new Set<string>();

  if (candidates.length > 0) {
    const { data: existingActions, error: existingError } = await supabase
      .from("automation_actions")
      .select("related_id")
      .eq("studio_id", context.studioId)
      .eq("rule_key", ruleKey)
      .eq("related_table", "appointments")
      .in(
        "related_id",
        candidates.map((candidate) => candidate.appointment.id),
      );

    if (existingError) {
      throw new Error(existingError.message);
    }

    for (const action of existingActions ?? []) {
      if (action.related_id) existingRelatedIds.add(String(action.related_id));
    }
  }

  const actionStatus = packageActionStatusForMode(rule.mode);
  const dueAt = now.toISOString();

  const actionsToCreate = candidates
    .filter((candidate) => !existingRelatedIds.has(candidate.appointment.id))
    .map((candidate) => {
      const clientName = getSimpleClientName(candidate.client);
      const lessonTime = formatRequestedTime(candidate.appointment.starts_at);
      const lessonLabel =
        candidate.appointment.title ||
        candidate.appointment.appointment_type ||
        "first lesson";

      return {
        studio_id: context.studioId,
        rule_id: rule.id,
        rule_key: ruleKey,
        title: `First lesson follow-up suggested: ${clientName}`,
        body: `${clientName} completed their first lesson (${lessonLabel}) on ${lessonTime}. Suggested action: send a warm follow-up, ask about their experience, and invite them to request or schedule their next lesson from the client portal.`,
        status: actionStatus,
        priority: "normal",
        related_table: "appointments",
        related_id: candidate.appointment.id,
        client_id: candidate.client.id,
        due_at: dueAt,
        created_by_run_id: runId,
      };
    });

  if (actionsToCreate.length > 0) {
    const { error: actionError } = await supabase
      .from("automation_actions")
      .insert(actionsToCreate);

    if (actionError) {
      throw new Error(actionError.message);
    }
  }

  return { candidatesCount, createdCount: actionsToCreate.length };
}


async function queueAutomaticAutomationEmailsForRun(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  runId: string;
  ruleKey: string;
}) {
  const { supabase, studioId, runId, ruleKey } = params;

  const { data: actions, error: actionsError } = await supabase
    .from("automation_actions")
    .select(
      "id, studio_id, rule_key, title, body, status, related_table, related_id, client_id",
    )
    .eq("studio_id", studioId)
    .eq("created_by_run_id", runId)
    .eq("rule_key", ruleKey)
    .eq("status", "suggested");

  if (actionsError) {
    throw new Error(actionsError.message);
  }

  const typedActions = (actions ?? []) as AutomationActionDraftRow[];
  if (typedActions.length === 0) {
    return { queuedCount: 0, skippedCount: 0 };
  }

  const clientIds = Array.from(
    new Set(
      typedActions
        .map((action) => action.client_id)
        .filter((value): value is string => Boolean(value)),
    ),
  );
  const bookingRequestIds = Array.from(
    new Set(
      typedActions
        .filter(
          (action) =>
            action.related_table === "booking_requests" && action.related_id,
        )
        .map((action) => action.related_id as string),
    ),
  );

  const [
    { data: studio, error: studioError },
    { data: clients, error: clientsError },
    { data: bookingRequests, error: bookingRequestsError },
    { data: template, error: templateError },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select("id, name, public_name, slug")
      .eq("id", studioId)
      .maybeSingle(),
    clientIds.length
      ? supabase
          .from("clients")
          .select("id, first_name, last_name, email")
          .eq("studio_id", studioId)
          .in("id", clientIds)
      : Promise.resolve({ data: [], error: null }),
    bookingRequestIds.length
      ? supabase
          .from("booking_requests")
          .select(
            "id, customer_first_name, customer_last_name, customer_email, requested_starts_at",
          )
          .eq("studio_id", studioId)
          .in("id", bookingRequestIds)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("automation_email_templates")
      .select("rule_key, subject, body_text")
      .eq("studio_id", studioId)
      .eq("rule_key", ruleKey)
      .maybeSingle(),
  ]);

  if (studioError || clientsError || bookingRequestsError || templateError) {
    throw new Error(
      studioError?.message ||
        clientsError?.message ||
        bookingRequestsError?.message ||
        templateError?.message ||
        "Automatic follow-up data could not be loaded.",
    );
  }

  const clientById = new Map(
    ((clients ?? []) as DraftClientRow[]).map((client) => [client.id, client]),
  );
  const bookingRequestById = new Map(
    ((bookingRequests ?? []) as DraftBookingRequestRow[]).map((request) => [
      request.id,
      request,
    ]),
  );
  const typedStudio = (studio ?? null) as DraftStudioRow | null;
  const typedTemplate = (template ??
    null) as AutomationEmailTemplateRow | null;

  let queuedCount = 0;
  let skippedCount = 0;

  for (const action of typedActions) {
    const client = action.client_id
      ? clientById.get(action.client_id) ?? null
      : null;
    const bookingRequest =
      action.related_table === "booking_requests" && action.related_id
        ? bookingRequestById.get(action.related_id) ?? null
        : null;
    const recipientEmail =
      client?.email?.trim() || bookingRequest?.customer_email?.trim() || null;

    if (!recipientEmail) {
      skippedCount += 1;
      continue;
    }

    const rendered = renderAutomationEmailDraft({
      action,
      client,
      studio: typedStudio,
      bookingRequest,
      template: typedTemplate,
    });
    const now = new Date().toISOString();

    const { error: deliveryError } = await supabase
      .from("outbound_deliveries")
      .insert({
        studio_id: studioId,
        channel: "email",
        template_key: `automation_${action.rule_key}`,
        recipient_email: recipientEmail,
        recipient_phone: null,
        subject: rendered.subject,
        body_text: rendered.bodyText,
        body_html: rendered.bodyHtml,
        related_table: "automation_actions",
        related_id: action.id,
        dedupe_key: `automation:${action.id}:email-auto-send`,
        status: "queued",
        updated_at: now,
      });

    if (deliveryError && deliveryError.code !== "23505") {
      throw new Error(deliveryError.message);
    }

    const { error: updateError } = await supabase
      .from("automation_actions")
      .update({
        status: "queued",
        reviewed_at: now,
        reviewed_by: null,
        review_note: "Queued automatically by the studio automation rule.",
        updated_at: now,
      })
      .eq("id", action.id)
      .eq("studio_id", studioId)
      .eq("status", "suggested");

    if (updateError) {
      throw new Error(updateError.message);
    }

    queuedCount += 1;
  }

  return { queuedCount, skippedCount };
}

export async function evaluateAutomationRuleAction(formData: FormData) {
  const rateLimit = checkRateLimit(
    await getServerActionRateLimitKey("automation:evaluate-rule", [String(formData.get("ruleKey") ?? "")]),
    { limit: 8, windowMs: 10 * 60 * 1000 },
  );

  if (!rateLimit.allowed) {
    redirect(`/app/automations?error=${encodeURIComponent(rateLimitErrorMessage(rateLimit))}`);
  }

  const ruleKey = String(formData.get("ruleKey") ?? "");
  const context = await getCurrentStudioContext();

  if (!canManageSettings(context.studioRole ?? "")) {
    redirect("/app/automations?error=not-authorized");
  }

  const supabase = await createClient();
  const definition = getDefinition(ruleKey);

  if (!definition) {
    redirect("/app/automations?error=unknown-rule");
  }

  if (
    ![
      "low_package_balance",
      "no_upcoming_lesson",
      "unsigned_document",
      "pending_booking_request",
      "first_lesson_follow_up",
    ].includes(ruleKey)
  ) {
    redirect("/app/automations?error=rule-not-implemented-yet");
  }

  const { data: rule, error: ruleError } = await supabase
    .from("automation_rules")
    .select("id, enabled, mode, trigger_config, action_config")
    .eq("studio_id", context.studioId)
    .eq("rule_key", ruleKey)
    .maybeSingle();

  if (ruleError) {
    redirect(`/app/automations?error=${encodeURIComponent(ruleError.message)}`);
  }

  if (!rule?.enabled) {
    redirect("/app/automations?error=enable-rule-first");
  }

  const startedAt = new Date().toISOString();
  const { data: run, error: runError } = await supabase
    .from("automation_runs")
    .insert({
      studio_id: context.studioId,
      rule_id: rule.id,
      rule_key: ruleKey,
      status: "running",
      started_at: startedAt,
    })
    .select("id")
    .single();

  if (runError) {
    redirect(`/app/automations?error=${encodeURIComponent(runError.message)}`);
  }

  let candidatesCount = 0;
  let createdCount = 0;
  let updatedCount = 0;

  try {
    let result: {
      candidatesCount: number;
      createdCount: number;
      updatedCount?: number;
    };

    if (ruleKey === "low_package_balance") {
      result = await evaluateLowPackageBalanceAutomation({
        supabase,
        context,
        definition,
        rule,
        runId: run.id,
        ruleKey,
      });
    } else if (ruleKey === "no_upcoming_lesson") {
      result = await evaluateNoUpcomingLessonAutomation({
        supabase,
        context,
        definition,
        rule,
        runId: run.id,
        ruleKey,
      });
    } else if (ruleKey === "unsigned_document") {
      result = await evaluateUnsignedDocumentAutomation({
        supabase,
        context,
        definition,
        rule,
        runId: run.id,
        ruleKey,
      });
    } else if (ruleKey === "pending_booking_request") {
      result = await evaluatePendingBookingRequestAutomation({
        supabase,
        context,
        definition,
        rule,
        runId: run.id,
        ruleKey,
      });
    } else {
      result = await evaluateFirstLessonFollowUpAutomation({
        supabase,
        context,
        definition,
        rule,
        runId: run.id,
        ruleKey,
      });
    }

    candidatesCount = result.candidatesCount;
    createdCount = result.createdCount;
    updatedCount = result.updatedCount ?? 0;

    if (rule.mode === "auto_send" && createdCount > 0) {
      await queueAutomaticAutomationEmailsForRun({
        supabase,
        studioId: context.studioId,
        runId: run.id,
        ruleKey,
      });
    }

    const finishedAt = new Date().toISOString();

    await Promise.all([
      supabase
        .from("automation_runs")
        .update({
          status: "completed",
          candidates_count: candidatesCount,
          actions_created_count: createdCount,
          finished_at: finishedAt,
        })
        .eq("id", run.id)
        .eq("studio_id", context.studioId),
      supabase
        .from("automation_rules")
        .update({
          last_evaluated_at: finishedAt,
          updated_at: finishedAt,
        })
        .eq("id", rule.id)
        .eq("studio_id", context.studioId),
    ]);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown automation error";
    const finishedAt = new Date().toISOString();

    await supabase
      .from("automation_runs")
      .update({
        status: "failed",
        error_message: message,
        finished_at: finishedAt,
      })
      .eq("id", run.id)
      .eq("studio_id", context.studioId);

    await supabase
      .from("automation_rules")
      .update({
        last_evaluated_at: finishedAt,
        updated_at: finishedAt,
      })
      .eq("id", rule.id)
      .eq("studio_id", context.studioId);

    revalidatePath("/app/automations");
    revalidatePath("/app/automations/drafts");
    redirect(`/app/automations?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/app/automations");
  revalidatePath("/app/automations/drafts");
  revalidatePath("/app");
  revalidatePath("/app/packages/client-balances");
  revalidatePath("/app/clients");
  redirect(
    `/app/automations?success=evaluated&created=${createdCount}&updated=${updatedCount}&candidates=${candidatesCount}`,
  );
}

export async function getAutomationTemplateDefaults() {
  return AUTOMATION_TEMPLATE_DEFAULTS;
}

export async function queueSelectedAutomationEmailDraftsAction(
  formData: FormData,
) {
  const deliveryIds = Array.from(
    new Set(
      formData
        .getAll("deliveryIds")
        .map((value) => String(value))
        .filter((value) => value.length > 0),
    ),
  );
  const returnPath = getAutomationReturnPath(formData);

  if (deliveryIds.length === 0) {
    redirect(`${returnPath}?error=no-drafts-selected`);
  }

  const context = await getCurrentStudioContext();

  if (!canManageSettings(context.studioRole ?? "")) {
    redirect(`${returnPath}?error=not-authorized`);
  }

  const supabase = await createClient();

  const { data: drafts, error: draftsError } = await supabase
    .from("outbound_deliveries")
    .select("id, status, related_id, recipient_email, subject, body_text")
    .eq("studio_id", context.studioId)
    .eq("related_table", "automation_actions")
    .in("id", deliveryIds);

  if (draftsError) {
    redirect(`${returnPath}?error=${encodeURIComponent(draftsError.message)}`);
  }

  const typedDrafts = (drafts ?? []) as Array<{
    id: string;
    status: string;
    related_id: string | null;
    recipient_email: string | null;
    subject: string | null;
    body_text: string | null;
  }>;

  const queueableDrafts = typedDrafts.filter(
    (draft) =>
      draft.status === "draft" &&
      Boolean(draft.recipient_email?.trim()) &&
      Boolean(draft.subject?.trim()) &&
      Boolean(draft.body_text?.trim()),
  );

  if (queueableDrafts.length === 0) {
    redirect(`${returnPath}?error=no-queueable-drafts`);
  }

  const queueableIds = queueableDrafts.map((draft) => draft.id);
  const relatedActionIds = Array.from(
    new Set(
      queueableDrafts
        .map((draft) => draft.related_id)
        .filter(Boolean) as string[],
    ),
  );

  const adminSupabase = createAdminClient();
  const { data: updatedDrafts, error: updateError } = await adminSupabase
    .from("outbound_deliveries")
    .update({
      status: "queued",
      updated_at: new Date().toISOString(),
    })
    .eq("studio_id", context.studioId)
    .eq("related_table", "automation_actions")
    .eq("status", "draft")
    .in("id", queueableIds)
    .select("id");

  if (updateError) {
    redirect(`${returnPath}?error=${encodeURIComponent(updateError.message)}`);
  }

  const updatedCount = updatedDrafts?.length ?? 0;

  if (updatedCount === 0) {
    redirect(`${returnPath}?error=no-drafts-updated`);
  }

  if (relatedActionIds.length > 0) {
    await adminSupabase
      .from("automation_actions")
      .update({
        updated_at: new Date().toISOString(),
      })
      .eq("studio_id", context.studioId)
      .in("id", relatedActionIds);
  }

  revalidatePath("/app/automations");
  revalidatePath("/app/automations/drafts");

  const skippedCount = deliveryIds.length - queueableIds.length;
  redirect(
    `${returnPath}?success=batch-queued&queued=${updatedCount}&skipped=${skippedCount}`,
  );
}

export async function saveAutomationEmailTemplateAction(formData: FormData) {
  const ruleKey = String(formData.get("ruleKey") ?? "");
  const subject = String(formData.get("subject") ?? "").trim();
  const bodyText = String(formData.get("bodyText") ?? "").trim();

  if (!ruleKey) {
    redirect("/app/automations?error=missing-template-rule");
  }

  if (!subject || !bodyText) {
    redirect("/app/automations?error=missing-template-content");
  }

  const definition = getDefinition(ruleKey);

  if (!definition) {
    redirect("/app/automations?error=unknown-rule");
  }

  const context = await getCurrentStudioContext();

  if (!canManageSettings(context.studioRole ?? "")) {
    redirect("/app/automations?error=not-authorized");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase.from("automation_email_templates").upsert(
    {
      studio_id: context.studioId,
      rule_key: ruleKey,
      subject,
      body_text: bodyText,
      updated_by: user?.id ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "studio_id,rule_key" },
  );

  if (error) {
    redirect(`/app/automations?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/app/automations");
  revalidatePath("/app/automations/drafts");
  redirect("/app/automations?success=template-saved");
}

export async function getAutomationDefinitions() {
  return AUTOMATION_DEFINITIONS;
}
