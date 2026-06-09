"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
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
    variables: ["client_first_name", "client_name", "studio_name", "portal_link"],
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
    variables: ["client_first_name", "client_name", "studio_name", "schedule_link", "portal_link"],
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
    variables: ["client_first_name", "client_name", "studio_name", "documents_link", "portal_link"],
  },
  {
    ruleKey: "pending_booking_request",
    subject: "{{studio_name}}: we received your lesson request",
    bodyText: `Hi {{client_first_name}},

We received your lesson request{{requested_time_sentence}}.

Our team is reviewing it and will follow up with you soon. If you need to adjust the requested time, you can reply to this email.

Thank you,
{{studio_name}}`,
    variables: ["client_first_name", "client_name", "studio_name", "requested_time"],
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
    variables: ["client_first_name", "client_name", "studio_name", "schedule_link", "portal_link"],
  },
];

function getAutomationTemplateDefault(ruleKey: string) {
  return AUTOMATION_TEMPLATE_DEFAULTS.find((template) => template.ruleKey === ruleKey) ?? null;
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
    compactName(bookingRequest?.customer_first_name, bookingRequest?.customer_last_name);
  const firstName =
    client?.first_name ||
    bookingRequest?.customer_first_name ||
    clientName.split(" ")[0] ||
    "";
  const portalUrl = getPortalUrl(studio);
  const scheduleUrl = getPortalUrl(studio, "/schedule");
  const documentsUrl = getPortalUrl(studio, "/documents");
  const requestedTime = formatDraftDateTime(bookingRequest?.requested_starts_at) ?? "";
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

function applyAutomationTemplate(content: string, values: Record<string, string>) {
  return content.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    return values[key] ?? "";
  });
}

function getDefinition(ruleKey: string) {
  return AUTOMATION_DEFINITIONS.find((definition) => definition.key === ruleKey);
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
    { onConflict: "studio_id,rule_key" }
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

  await supabase
    .from("automation_actions")
    .update({
      status: "dismissed",
      dismissed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", actionId)
    .eq("studio_id", context.studioId)
    .in("status", ["suggested", "drafted"]);

  revalidatePath("/app/automations");
  revalidatePath("/app/automations/drafts");
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

  await supabase
    .from("automation_actions")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", actionId)
    .eq("studio_id", context.studioId)
    .in("status", ["suggested", "drafted"]);

  revalidatePath("/app/automations");
  revalidatePath("/app/automations/drafts");
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
  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://www.idanceflow.com").replace(/\/$/, "");
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
  const values = getAutomationVariableValues({ client, studio, bookingRequest });
  const defaultTemplate = getAutomationTemplateDefault(action.rule_key);

  const fallbackSubject =
    defaultTemplate?.subject ||
    "{{studio_name}}: follow-up from the studio";
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
    .select("id, studio_id, rule_key, title, body, status, related_table, related_id, client_id")
    .eq("id", actionId)
    .eq("studio_id", context.studioId)
    .maybeSingle();

  if (actionError) {
    redirect(`/app/automations?error=${encodeURIComponent(actionError.message)}`);
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
    redirect(`/app/automations?error=${encodeURIComponent(existingDraftError.message)}`);
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
  if (typedAction.related_table === "booking_requests" && typedAction.related_id) {
    const { data } = await supabase
      .from("booking_requests")
      .select("id, customer_first_name, customer_last_name, customer_email, requested_starts_at")
      .eq("id", typedAction.related_id)
      .eq("studio_id", context.studioId)
      .maybeSingle();

    bookingRequest = (data ?? null) as DraftBookingRequestRow | null;
  }

  const typedClient = (client ?? null) as DraftClientRow | null;
  const typedStudio = (studio ?? null) as DraftStudioRow | null;
  const recipientEmail = typedClient?.email || bookingRequest?.customer_email || null;

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

  const { error: deliveryError } = await supabase.from("outbound_deliveries").insert({
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
      redirect(`/app/automations?error=${encodeURIComponent(deliveryError.message)}`);
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
    redirect(`/app/automations?error=${encodeURIComponent(updateError.message)}`);
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
  const bodyText = getDraftFormValue(formData, ["bodyText", "draftBody", "body"]);
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
    redirect(`/app/automations?error=${encodeURIComponent(draftError.message)}`);
  }

  if (!draft) {
    redirect("/app/automations?error=draft-not-found");
  }

  const typedDraft = draft as { id: string; status: string; related_id: string | null };

  if (typedDraft.status !== "draft") {
    redirect("/app/automations?error=draft-not-editable");
  }

  const { error: deliveryUpdateError } = await supabase
    .from("outbound_deliveries")
    .update({
      subject,
      body_text: bodyText,
      body_html: renderPlainTextAsHtml(bodyText),
      updated_at: new Date().toISOString(),
    })
    .eq("id", deliveryId)
    .eq("studio_id", context.studioId)
    .eq("status", "draft");

  if (deliveryUpdateError) {
    redirect(`/app/automations?error=${encodeURIComponent(deliveryUpdateError.message)}`);
  }

  await supabase
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
  const bodyText = getDraftFormValue(formData, ["bodyText", "draftBody", "body"]);
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
    redirect(`/app/automations?error=${encodeURIComponent(draftError.message)}`);
  }

  if (!draft) {
    redirect("/app/automations?error=draft-not-found");
  }

  const typedDraft = draft as { id: string; status: string; related_id: string | null };

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

  const { error: deliveryUpdateError } = await supabase
    .from("outbound_deliveries")
    .update(updatePayload)
    .eq("id", deliveryId)
    .eq("studio_id", context.studioId)
    .eq("status", "draft");

  if (deliveryUpdateError) {
    redirect(`/app/automations?error=${encodeURIComponent(deliveryUpdateError.message)}`);
  }

  await supabase
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
    | { first_name: string | null; last_name: string | null; email: string | null }
    | { first_name: string | null; last_name: string | null; email: string | null }[]
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
    | { first_name: string | null; last_name: string | null; email: string | null }
    | { first_name: string | null; last_name: string | null; email: string | null }[]
    | null
) {
  const client = Array.isArray(value) ? value[0] : value;
  const name = [client?.first_name, client?.last_name].filter(Boolean).join(" ").trim();
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
    | { first_name: string | null; last_name: string | null; email: string | null }
    | { first_name: string | null; last_name: string | null; email: string | null }[]
    | null;
};

function getSimpleClientName(client: AutomationClientRow) {
  const name = [client.first_name, client.last_name].filter(Boolean).join(" ").trim();
  return name || client.email || "Client";
}

function getBookingRequestClientName(request: PendingBookingRequestAutomationRow) {
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
    | null
) {
  const template = Array.isArray(value) ? value[0] : value;
  return template?.title || template?.document_type || "Document";
}

function getDocumentAssignmentClientName(assignment: UnsignedDocumentAssignmentAutomationRow) {
  const client = Array.isArray(assignment.clients) ? assignment.clients[0] : assignment.clients;
  const name = [client?.first_name, client?.last_name].filter(Boolean).join(" ").trim();
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
    (rule.trigger_config as Record<string, unknown> | null | undefined)?.threshold,
    asNumber(definition.defaultTriggerConfig.threshold, 2)
  );

  const { data: packages, error: packageError } = await supabase
    .from("client_packages")
    .select(`
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
    `)
    .eq("studio_id", context.studioId)
    .eq("active", true);

  if (packageError) {
    throw new Error(packageError.message);
  }

  const typedPackages = (packages ?? []) as ClientPackageBalanceRow[];
  const candidates = typedPackages
    .map((clientPackage) => {
      const lowItems = (clientPackage.client_package_items ?? []).filter((item) => {
        if (item.is_unlimited) return false;
        if (item.quantity_remaining === null || item.quantity_remaining === undefined) return false;
        return Number(item.quantity_remaining) <= threshold;
      });

      if (lowItems.length === 0) return null;

      const lowestRemaining = Math.min(
        ...lowItems.map((item) => Number(item.quantity_remaining ?? threshold))
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
        candidates.map((candidate) => candidate.clientPackage.id)
      )
      .in("status", ["suggested", "drafted", "queued"]);

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
        .map((item) => `${item.quantity_remaining ?? 0} ${item.usage_type ?? "credit"}`)
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
    (rule.trigger_config as Record<string, unknown> | null | undefined)?.lookback_days,
    asNumber(definition.defaultTriggerConfig.lookback_days, 90)
  );

  const now = new Date();
  const nowIso = now.toISOString();
  const lookbackStart = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: clients, error: clientsError }, { data: recentAppointments, error: recentError }, { data: futureAppointments, error: futureError }, { data: pendingRequests, error: pendingError }] =
    await Promise.all([
      supabase
        .from("clients")
        .select("id, first_name, last_name, email, status")
        .eq("studio_id", context.studioId),
      supabase
        .from("appointments")
        .select("id, client_id, appointment_type, status, starts_at, ends_at, title")
        .eq("studio_id", context.studioId)
        .gte("starts_at", lookbackStart)
        .lt("starts_at", nowIso)
        .order("starts_at", { ascending: false }),
      supabase
        .from("appointments")
        .select("id, client_id, appointment_type, status, starts_at, ends_at, title")
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

  const typedClients = ((clients ?? []) as AutomationClientRow[]).filter((client) =>
    isActiveClientStatus(client.status)
  );
  const recentByClient = new Map<string, AppointmentAutomationRow[]>();
  const futureClientIds = new Set<string>();
  const pendingRequestClientIds = new Set<string>();

  for (const appointment of (recentAppointments ?? []) as AppointmentAutomationRow[]) {
    if (!appointment.client_id || !isCountableAppointment(appointment.status)) continue;
    const existing = recentByClient.get(appointment.client_id) ?? [];
    existing.push(appointment);
    recentByClient.set(appointment.client_id, existing);
  }

  for (const appointment of (futureAppointments ?? []) as AppointmentAutomationRow[]) {
    if (!appointment.client_id || !isCountableAppointment(appointment.status)) continue;
    futureClientIds.add(appointment.client_id);
  }

  for (const request of (pendingRequests ?? []) as BookingRequestAutomationRow[]) {
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
        candidates.map((candidate) => candidate.client.id)
      )
      .in("status", ["suggested", "drafted", "queued"]);

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
  rule: { id: string; mode: string | null; trigger_config: unknown; action_config?: unknown };
  runId: string;
  ruleKey: string;
}) {
  const { supabase, context, definition, rule, runId, ruleKey } = params;
  const dueWithinDays = asNumber(
    (rule.trigger_config as Record<string, unknown> | null | undefined)?.due_within_days,
    asNumber(definition.defaultTriggerConfig.due_within_days, 7)
  );

  const now = new Date();
  const dueCutoffIso = new Date(now.getTime() + dueWithinDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: assignments, error: assignmentsError } = await supabase
    .from("document_assignments")
    .select(`
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
    `)
    .eq("studio_id", context.studioId)
    .eq("status", "pending")
    .or(`due_at.is.null,due_at.lte.${dueCutoffIso}`)
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });

  if (assignmentsError) {
    throw new Error(assignmentsError.message);
  }

  const candidates = (assignments ?? []) as UnsignedDocumentAssignmentAutomationRow[];
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
        candidates.map((candidate) => candidate.id)
      )
      .in("status", ["suggested", "drafted", "queued"]);

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
      const documentTitle = getDocumentTemplateTitle(candidate.document_templates);
      const dueDateText = candidate.due_at
        ? `It is due ${formatDueDate(candidate.due_at)}.`
        : "No due date is set, so staff should follow up when appropriate.";
      const priority = candidate.due_at && new Date(candidate.due_at).getTime() < now.getTime()
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
  rule: { id: string; mode: string | null; trigger_config: unknown; action_config?: unknown };
  runId: string;
  ruleKey: string;
}) {
  const { supabase, context, definition, rule, runId, ruleKey } = params;
  const pendingHours = asNumber(
    (rule.trigger_config as Record<string, unknown> | null | undefined)?.pending_hours,
    asNumber(definition.defaultTriggerConfig.pending_hours, 24)
  );

  const now = new Date();
  const cutoffIso = new Date(now.getTime() - pendingHours * 60 * 60 * 1000).toISOString();

  const { data: pendingRequests, error: pendingError } = await supabase
    .from("booking_requests")
    .select(
      "id, client_id, source, status, customer_first_name, customer_last_name, customer_email, requested_starts_at, created_at"
    )
    .eq("studio_id", context.studioId)
    .eq("status", "pending")
    .lte("created_at", cutoffIso)
    .order("created_at", { ascending: true });

  if (pendingError) {
    throw new Error(pendingError.message);
  }

  const candidates = (pendingRequests ?? []) as PendingBookingRequestAutomationRow[];
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
        candidates.map((candidate) => candidate.id)
      )
      .in("status", ["suggested", "drafted", "queued"]);

    if (existingError) {
      throw new Error(existingError.message);
    }

    for (const action of existingActions ?? []) {
      if (action.related_id) existingRelatedIds.add(String(action.related_id));
    }
  }

  const actionStatus = packageActionStatusForMode(rule.mode);
  const dueAt = now.toISOString();
  const configuredPriority =
    (rule.action_config as Record<string, unknown> | null | undefined)?.priority;
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
  rule: { id: string; mode: string | null; trigger_config: unknown; action_config?: unknown };
  runId: string;
  ruleKey: string;
}) {
  const { supabase, context, definition, rule, runId, ruleKey } = params;
  const afterHours = asNumber(
    (rule.trigger_config as Record<string, unknown> | null | undefined)?.after_hours,
    asNumber(definition.defaultTriggerConfig.after_hours, 24)
  );
  const lookbackDays = asNumber(
    (rule.trigger_config as Record<string, unknown> | null | undefined)?.lookback_days,
    asNumber(definition.defaultTriggerConfig.lookback_days, 14)
  );

  const now = new Date();
  const cutoffIso = new Date(now.getTime() - afterHours * 60 * 60 * 1000).toISOString();
  const lookbackStartIso = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

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
      .select("id, client_id, appointment_type, status, starts_at, ends_at, title")
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
  for (const appointment of (attendedAppointments ?? []) as AppointmentAutomationRow[]) {
    if (!appointment.client_id || !activeClients.has(appointment.client_id)) continue;
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
    .filter((candidate): candidate is { client: AutomationClientRow; appointment: AppointmentAutomationRow } => {
      if (!candidate.client) return false;
      const firstLessonTime = new Date(candidate.appointment.starts_at).getTime();
      return firstLessonTime >= new Date(lookbackStartIso).getTime();
    });

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
        candidates.map((candidate) => candidate.appointment.id)
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
      const lessonLabel = candidate.appointment.title || candidate.appointment.appointment_type || "first lesson";

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


export async function evaluateAutomationRuleAction(formData: FormData) {
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

  if (!["low_package_balance", "no_upcoming_lesson", "unsigned_document", "pending_booking_request", "first_lesson_follow_up"].includes(ruleKey)) {
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

  try {
    let result: { candidatesCount: number; createdCount: number };

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
    const message = error instanceof Error ? error.message : "Unknown automation error";
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
    `/app/automations?success=evaluated&created=${createdCount}&candidates=${candidatesCount}`
  );
}


export async function getAutomationTemplateDefaults() {
  return AUTOMATION_TEMPLATE_DEFAULTS;
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
    { onConflict: "studio_id,rule_key" }
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
