import { NextRequest, NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { Resend } from "resend";

export const dynamic = "force-dynamic";

type SubscriptionRow = {
  id: string;
  studio_id: string;
  status: string | null;
  created_at: string;
  current_period_start: string | null;
  cancelled_at: string | null;
  subscription_plans:
    | {
        code: string | null;
        name: string | null;
      }
    | {
        code: string | null;
        name: string | null;
      }[]
    | null;
};

type StudioRow = {
  id: string;
  name: string;
  slug?: string | null;
  public_enabled?: boolean | null;
  created_at?: string | null;
  last_workspace_access_at?: string | null;
  last_workspace_access_user_id?: string | null;
};

type OrganizerRow = {
  id: string;
  name: string | null;
  created_at: string | null;
};

type EventRegistrationRow = {
  id: string;
  payment_status: string | null;
  total_amount: number | null;
  total_price: number | null;
  created_at: string;
};

type StudioInvoiceRow = {
  id: string;
  amount_paid: number | null;
  status: string;
  created_at: string;
};

type EventPaymentRow = {
  id: string;
  amount: number | null;
  platform_fee_amount: number | null;
  status: string | null;
  created_at: string;
};

type PlatformErrorRow = {
  id: string;
  severity: string | null;
  source: string | null;
  message: string | null;
  created_at: string;
};

type PackageDeductionErrorRow = {
  id: string;
  error_message: string | null;
  created_at: string;
};

type SmsMessageLogRow = {
  id: string;
  status: string | null;
  direction: string | null;
  provider: string | null;
  provider_error_code: string | null;
  provider_error_message: string | null;
  created_at: string;
  updated_at: string | null;
};

const PLATFORM_TICKET_FEE_RATE = 0.035;
const PAID_REGISTRATION_STATUSES = new Set(["paid", "completed", "succeeded"]);
const PAID_INVOICE_STATUSES = new Set(["paid", "succeeded"]);
const PAID_EVENT_PAYMENT_STATUSES = new Set(["paid", "completed", "succeeded"]);

function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Missing Supabase admin environment variables.");
  }

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function startOfMonth() {
  const date = new Date();
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date;
}

function startOfYear() {
  const date = new Date();
  date.setMonth(0, 1);
  date.setHours(0, 0, 0, 0);
  return date;
}

function daysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function isOnOrAfter(value: string | null | undefined, start: Date) {
  if (!value) return false;
  return new Date(value).getTime() >= start.getTime();
}

function isBefore(value: string | null | undefined, cutoff: Date) {
  if (!value) return false;
  return new Date(value).getTime() < cutoff.getTime();
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Never";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function getPlan(
  value:
    | { code: string | null; name: string | null }
    | { code: string | null; name: string | null }[]
    | null
) {
  return Array.isArray(value) ? value[0] : value;
}

function hasActiveBillingAccess(status: string | null | undefined) {
  return status === "active" || status === "trialing";
}

function hasPaidPlan(subscription: SubscriptionRow | undefined) {
  if (!subscription) return false;
  const plan = getPlan(subscription.subscription_plans);
  return Boolean(plan?.code || plan?.name);
}

function htmlEscape(value: string | number | null | undefined) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function metricRows(metrics: Array<{ label: string; today: string; month: string; ytd: string }>) {
  return metrics
    .map(
      (metric) => `
        <tr>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;font-weight:600;">${htmlEscape(metric.label)}</td>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${htmlEscape(metric.today)}</td>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${htmlEscape(metric.month)}</td>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${htmlEscape(metric.ytd)}</td>
        </tr>`
    )
    .join("");
}

function simpleList(items: string[], emptyText: string) {
  if (items.length === 0) {
    return `<p style="margin:0;color:#64748b;">${htmlEscape(emptyText)}</p>`;
  }

  return `<ul style="margin:0;padding-left:20px;color:#334155;">${items
    .map((item) => `<li style="margin:6px 0;">${htmlEscape(item)}</li>`)
    .join("")}</ul>`;
}

function actionButton(href: string, label: string, background: string, color = "#ffffff") {
  return `<a href="${htmlEscape(href)}" style="display:inline-block;background:${background};color:${color};text-decoration:none;padding:10px 14px;border-radius:12px;font-weight:700;">${htmlEscape(label)}</a>`;
}

async function fetchEventPayments(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("event_payments")
    .select("id, amount, platform_fee_amount, status, created_at");

  if (!error) {
    return { data: (data ?? []) as EventPaymentRow[], error: null };
  }

  return { data: [] as EventPaymentRow[], error };
}

async function fetchSmsMessageLogs(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("sms_message_logs")
    .select(
      "id, status, direction, provider, provider_error_code, provider_error_message, created_at, updated_at"
    )
    .order("created_at", { ascending: false })
    .limit(250);

  if (!error) {
    return { data: (data ?? []) as SmsMessageLogRow[], error: null };
  }

  // SMS is still being rolled out and should not block the daily digest.
  console.error("Daily digest SMS snapshot skipped:", error.message);
  return { data: [] as SmsMessageLogRow[], error };
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const requestSecret = request.headers.get("authorization")?.replace("Bearer ", "");

  if (!cronSecret || requestSecret !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const resendApiKey = process.env.RESEND_API_KEY;
  const digestTo = process.env.PLATFORM_ADMIN_DIGEST_EMAIL;
  const digestFrom = process.env.PLATFORM_DIGEST_FROM ?? "DanceFlow <onboarding@resend.dev>";
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "";

  if (!resendApiKey || !digestTo) {
    return NextResponse.json(
      { error: "Missing RESEND_API_KEY or PLATFORM_ADMIN_DIGEST_EMAIL." },
      { status: 500 }
    );
  }

  const supabase = getSupabaseAdmin();

  const eventPaymentsResult = await fetchEventPayments(supabase);
  const smsMessageLogsResult = await fetchSmsMessageLogs(supabase);

  const [
    { data: studios, error: studiosError },
    { data: subscriptions, error: subscriptionsError },
    { data: organizers, error: organizersError },
    { data: registrations, error: registrationsError },
    { data: invoices, error: invoicesError },
    { data: platformErrors, error: platformErrorsError },
    { data: packageErrors, error: packageErrorsError },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select(
  "id, name, slug, public_enabled, created_at, last_workspace_access_at, last_workspace_access_user_id"
),
    supabase.from("studio_subscriptions").select(`
      id,
      studio_id,
      status,
      created_at,
      current_period_start,
      cancelled_at,
      subscription_plans (
        code,
        name
      )
    `),
    supabase.from("organizers").select("id, name, created_at"),
    supabase
      .from("event_registrations")
      .select("id, payment_status, total_amount, total_price, created_at"),
    supabase.from("studio_invoices").select("id, amount_paid, status, created_at"),
    supabase
      .from("platform_error_logs")
      .select("id, severity, source, message, created_at")
      .is("resolved_at", null)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("appointment_package_deduction_errors")
      .select("id, error_message, created_at")
      .is("resolved_at", null)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const errors = [
    studiosError,
    subscriptionsError,
    organizersError,
    registrationsError,
    invoicesError,
    platformErrorsError,
    packageErrorsError,
  ].filter(Boolean);

  if (errors.length > 0) {
    return NextResponse.json(
      { error: errors.map((error) => error?.message).join("; ") },
      { status: 500 }
    );
  }

  const typedStudios = (studios ?? []) as StudioRow[];
  const typedSubscriptions = (subscriptions ?? []) as SubscriptionRow[];
  const typedOrganizers = (organizers ?? []) as OrganizerRow[];
  const typedRegistrations = (registrations ?? []) as EventRegistrationRow[];
  const typedInvoices = (invoices ?? []) as StudioInvoiceRow[];
  const typedEventPayments = eventPaymentsResult.data;
  const typedPlatformErrors = (platformErrors ?? []) as PlatformErrorRow[];
  const typedPackageErrors = (packageErrors ?? []) as PackageDeductionErrorRow[];
  const typedSmsMessageLogs = smsMessageLogsResult.data;

  const subscriptionByStudioId = new Map(
    typedSubscriptions.map((subscription) => [subscription.studio_id, subscription])
  );

  const paidAccessWithoutActiveSubscription = typedStudios.filter((studio) => {
    const subscription = subscriptionByStudioId.get(studio.id);
    if (!hasPaidPlan(subscription)) return false;
    return !hasActiveBillingAccess(subscription?.status);
  });

  const activeBillingButHidden = typedStudios.filter((studio) => {
    const subscription = subscriptionByStudioId.get(studio.id);
    return hasActiveBillingAccess(subscription?.status) && studio.public_enabled === false;
  });

  const todayStart = startOfToday();
  const monthStart = startOfMonth();
  const yearStart = startOfYear();
  const staleAccessCutoff = daysAgo(30);

  const paidRegistrationRevenueFor = (start: Date) =>
    typedRegistrations
      .filter((registration) =>
        PAID_REGISTRATION_STATUSES.has((registration.payment_status ?? "").toLowerCase())
      )
      .filter((registration) => isOnOrAfter(registration.created_at, start))
      .reduce((sum, registration) => {
        const amount = Number(registration.total_amount ?? registration.total_price ?? 0);
        return sum + amount;
      }, 0);

  const ticketPlatformFeeRevenueFor = (start: Date) => {
    const eventPaymentPlatformFees = typedEventPayments
      .filter((payment) => PAID_EVENT_PAYMENT_STATUSES.has((payment.status ?? "").toLowerCase()))
      .filter((payment) => isOnOrAfter(payment.created_at, start))
      .reduce((sum, payment) => sum + Number(payment.platform_fee_amount ?? 0), 0);

    if (eventPaymentPlatformFees > 0) {
      return eventPaymentPlatformFees;
    }

    return paidRegistrationRevenueFor(start) * PLATFORM_TICKET_FEE_RATE;
  };

  const subscriptionRevenueFor = (start: Date) =>
    typedInvoices
      .filter((invoice) => PAID_INVOICE_STATUSES.has((invoice.status ?? "").toLowerCase()))
      .filter((invoice) => isOnOrAfter(invoice.created_at, start))
      .reduce((sum, invoice) => sum + Number(invoice.amount_paid ?? 0), 0);

  const newTrialSignupsFor = (start: Date) =>
    typedSubscriptions.filter(
      (subscription) =>
        subscription.status === "trialing" && isOnOrAfter(subscription.created_at, start)
    ).length;

  const newSubscriptionPurchasesFor = (start: Date) =>
    typedSubscriptions.filter(
      (subscription) =>
        subscription.status === "active" &&
        isOnOrAfter(subscription.current_period_start ?? subscription.created_at, start)
    ).length;

  const cancellationsFor = (start: Date) =>
    typedSubscriptions.filter((subscription) => isOnOrAfter(subscription.cancelled_at, start)).length;

  const newStudiosFor = (start: Date) =>
    typedStudios.filter((studio) => isOnOrAfter(studio.created_at, start)).length;

  const newOrganizersFor = (start: Date) =>
    typedOrganizers.filter((organizer) => isOnOrAfter(organizer.created_at, start)).length;

  const neverAccessedStudios = typedStudios.filter((studio) => !studio.last_workspace_access_at);
  const staleAccessStudios = typedStudios.filter((studio) =>
    isBefore(studio.last_workspace_access_at, staleAccessCutoff)
  );
  const recentlyActiveStudios = typedStudios.filter((studio) =>
    isOnOrAfter(studio.last_workspace_access_at, staleAccessCutoff)
  );

  const smsMessagesFor = (start: Date) =>
    typedSmsMessageLogs.filter((message) => isOnOrAfter(message.created_at, start));

  const smsFailedFor = (start: Date) =>
    smsMessagesFor(start).filter((message) =>
      ["failed", "undelivered"].includes((message.status ?? "").toLowerCase())
    );

  const smsQueuedFor = (start: Date) =>
    smsMessagesFor(start).filter((message) =>
      ["queued", "accepted", "scheduled"].includes((message.status ?? "").toLowerCase())
    );

  const metrics = [
    {
      label: "Ticket platform fee revenue",
      today: formatMoney(ticketPlatformFeeRevenueFor(todayStart)),
      month: formatMoney(ticketPlatformFeeRevenueFor(monthStart)),
      ytd: formatMoney(ticketPlatformFeeRevenueFor(yearStart)),
    },
    {
      label: "Subscription revenue",
      today: formatMoney(subscriptionRevenueFor(todayStart)),
      month: formatMoney(subscriptionRevenueFor(monthStart)),
      ytd: formatMoney(subscriptionRevenueFor(yearStart)),
    },
    {
      label: "New trial signups",
      today: newTrialSignupsFor(todayStart).toLocaleString("en-US"),
      month: newTrialSignupsFor(monthStart).toLocaleString("en-US"),
      ytd: newTrialSignupsFor(yearStart).toLocaleString("en-US"),
    },
    {
      label: "New subscription purchases",
      today: newSubscriptionPurchasesFor(todayStart).toLocaleString("en-US"),
      month: newSubscriptionPurchasesFor(monthStart).toLocaleString("en-US"),
      ytd: newSubscriptionPurchasesFor(yearStart).toLocaleString("en-US"),
    },
    {
      label: "Cancellations",
      today: cancellationsFor(todayStart).toLocaleString("en-US"),
      month: cancellationsFor(monthStart).toLocaleString("en-US"),
      ytd: cancellationsFor(yearStart).toLocaleString("en-US"),
    },
    {
      label: "New studio workspaces",
      today: newStudiosFor(todayStart).toLocaleString("en-US"),
      month: newStudiosFor(monthStart).toLocaleString("en-US"),
      ytd: newStudiosFor(yearStart).toLocaleString("en-US"),
    },
    {
      label: "New organizers",
      today: newOrganizersFor(todayStart).toLocaleString("en-US"),
      month: newOrganizersFor(monthStart).toLocaleString("en-US"),
      ytd: newOrganizersFor(yearStart).toLocaleString("en-US"),
    },
    {
      label: "SMS messages queued/sent",
      today: smsMessagesFor(todayStart).length.toLocaleString("en-US"),
      month: smsMessagesFor(monthStart).length.toLocaleString("en-US"),
      ytd: smsMessagesFor(yearStart).length.toLocaleString("en-US"),
    },
    {
      label: "SMS failed/undelivered",
      today: smsFailedFor(todayStart).length.toLocaleString("en-US"),
      month: smsFailedFor(monthStart).length.toLocaleString("en-US"),
      ytd: smsFailedFor(yearStart).length.toLocaleString("en-US"),
    },
  ];

  const unresolvedBackendErrors = typedPlatformErrors.length + typedPackageErrors.length;
  const dashboardUrl = siteUrl ? `${siteUrl}/platform` : "/platform";
  const alertsUrl = siteUrl ? `${siteUrl}/platform/alerts` : "/platform/alerts";
  const billingUrl = siteUrl ? `${siteUrl}/platform/billing` : "/platform/billing";
  const studiosUrl = siteUrl ? `${siteUrl}/platform/studios` : "/platform/studios";
  const smsUrl = siteUrl ? `${siteUrl}/platform/sms` : "/platform/sms";

  const billingRiskItems = paidAccessWithoutActiveSubscription
    .slice(0, 8)
    .map((studio) => {
      const subscription = subscriptionByStudioId.get(studio.id);
      const plan = getPlan(subscription?.subscription_plans ?? null);
      return `${studio.name} — ${plan?.name ?? plan?.code ?? "Paid plan"}, status ${subscription?.status ?? "missing"}`;
    });

  const hiddenActiveItems = activeBillingButHidden
    .slice(0, 5)
    .map((studio) => `${studio.name} — active billing but public discovery is disabled`);

  const errorItems = typedPlatformErrors.slice(0, 5).map((error) => {
    const severity = error.severity ? `${error.severity.toUpperCase()}: ` : "";
    const source = error.source || "Unknown source";
    return `${severity}${source} — ${error.message ?? "No message"}`;
  });

  const packageErrorItems = typedPackageErrors
    .slice(0, 5)
    .map((error) => `${formatDate(error.created_at)} — ${error.error_message ?? "Package deduction issue"}`);

  const neverAccessedItems = neverAccessedStudios
    .slice(0, 5)
    .map((studio) => `${studio.name} — created ${formatDate(studio.created_at)}`);

  const staleAccessItems = staleAccessStudios
    .slice(0, 5)
    .map((studio) => `${studio.name} — last access ${formatDate(studio.last_workspace_access_at)}`);

  const recentSmsFailures = typedSmsMessageLogs
    .filter((message) => ["failed", "undelivered"].includes((message.status ?? "").toLowerCase()))
    .slice(0, 5)
    .map((message) => {
      const errorText = message.provider_error_message || message.provider_error_code || "No provider error message";
      return `${formatDate(message.created_at)} — ${message.status ?? "failed"} — ${errorText}`;
    });

  const recentQueuedSms = typedSmsMessageLogs
    .filter((message) => ["queued", "accepted", "scheduled"].includes((message.status ?? "").toLowerCase()))
    .slice(0, 5)
    .map((message) => `${formatDate(message.created_at)} — ${message.provider ?? "provider"} message still ${message.status ?? "queued"}`);

  const html = `
    <div style="font-family:Arial,sans-serif;background:#f8fafc;padding:24px;color:#0f172a;">
      <div style="max-width:820px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:24px;overflow:hidden;">
        <div style="background:linear-gradient(135deg,#4b2e83,#9d174d);color:#ffffff;padding:28px;">
          <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#f5d0fe;">DanceFlow Platform Admin</p>
          <h1 style="margin:0;font-size:28px;line-height:1.2;">Daily Platform Digest</h1>
          <p style="margin:12px 0 0;color:#fce7f3;">Your 6 AM operating snapshot for billing risk, platform errors, revenue, and workspace activity.</p>
        </div>

        <div style="padding:24px;">
          <h2 style="margin:0 0 12px;font-size:20px;">Needs Attention</h2>
          <table style="width:100%;border-collapse:collapse;margin-bottom:18px;">
            <tr>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;font-weight:700;">Paid-plan access without active subscription</td>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:700;color:#be123c;">${paidAccessWithoutActiveSubscription.length}</td>
            </tr>
            <tr>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;font-weight:700;">Unresolved backend/package errors</td>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:700;color:#b45309;">${unresolvedBackendErrors}</td>
            </tr>
            <tr>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;font-weight:700;">Never accessed workspaces</td>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:700;">${neverAccessedStudios.length}</td>
            </tr>
            <tr>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;font-weight:700;">No workspace access in 30+ days</td>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:700;">${staleAccessStudios.length}</td>
            </tr>
            <tr>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;font-weight:700;">Recently active workspaces</td>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:700;color:#047857;">${recentlyActiveStudios.length}</td>
            </tr>
          </table>

          <div style="display:grid;grid-template-columns:1fr;gap:16px;margin-bottom:24px;">
            <div style="border:1px solid #fecdd3;background:#fff1f2;border-radius:18px;padding:16px;">
              <h3 style="margin:0 0 10px;font-size:16px;color:#9f1239;">Billing risks to review</h3>
              ${simpleList(billingRiskItems, "No paid-access billing risks found.")}
              ${hiddenActiveItems.length ? `<div style="margin-top:12px;">${simpleList(hiddenActiveItems, "")}</div>` : ""}
            </div>

            <div style="border:1px solid #fed7aa;background:#fff7ed;border-radius:18px;padding:16px;">
              <h3 style="margin:0 0 10px;font-size:16px;color:#9a3412;">Latest unresolved backend issues</h3>
              ${simpleList(errorItems, "No unresolved backend errors found.")}
              ${packageErrorItems.length ? `<div style="margin-top:12px;"><p style="margin:0 0 6px;font-weight:700;color:#9a3412;">Package deduction issues</p>${simpleList(packageErrorItems, "")}</div>` : ""}
            </div>

            <div style="border:1px solid #bfdbfe;background:#eff6ff;border-radius:18px;padding:16px;">
              <h3 style="margin:0 0 10px;font-size:16px;color:#1d4ed8;">SMS delivery watch</h3>
              <p style="margin:0 0 8px;color:#334155;"><strong>Recent failed/undelivered:</strong></p>
              ${simpleList(recentSmsFailures, "No recent SMS delivery failures found.")}
              <p style="margin:14px 0 8px;color:#334155;"><strong>Recent queued:</strong></p>
              ${simpleList(recentQueuedSms, "No queued SMS messages found in the latest sample.")}
            </div>

            <div style="border:1px solid #dbeafe;background:#eff6ff;border-radius:18px;padding:16px;">
              <h3 style="margin:0 0 10px;font-size:16px;color:#1d4ed8;">Workspace activity</h3>
              <p style="margin:0 0 8px;color:#334155;"><strong>Never accessed:</strong></p>
              ${simpleList(neverAccessedItems, "Every workspace has at least one recorded access.")}
              <p style="margin:14px 0 8px;color:#334155;"><strong>No access in 30+ days:</strong></p>
              ${simpleList(staleAccessItems, "No stale workspaces found.")}
            </div>
          </div>

          <h2 style="margin:0 0 12px;font-size:20px;">Revenue & Growth Snapshot</h2>
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
            <thead>
              <tr>
                <th style="padding:10px;border-bottom:1px solid #cbd5e1;text-align:left;">Metric</th>
                <th style="padding:10px;border-bottom:1px solid #cbd5e1;text-align:right;">Daily</th>
                <th style="padding:10px;border-bottom:1px solid #cbd5e1;text-align:right;">Monthly</th>
                <th style="padding:10px;border-bottom:1px solid #cbd5e1;text-align:right;">YTD</th>
              </tr>
            </thead>
            <tbody>${metricRows(metrics)}</tbody>
          </table>

          <div style="display:flex;gap:12px;flex-wrap:wrap;">
            ${actionButton(dashboardUrl, "Open Dashboard", "#4b2e83")}
            ${actionButton(alertsUrl, "Review Alerts", "#f59e0b", "#111827")}
            ${actionButton(billingUrl, "Review Billing", "#e11d48")}
            ${actionButton(studiosUrl, "Review Studios", "#0f172a")}
            ${actionButton(smsUrl, "Review SMS", "#7c3aed")}
          </div>
        </div>
      </div>
    </div>
  `;

  const resend = new Resend(resendApiKey);
  await resend.emails.send({
    from: digestFrom,
    to: digestTo,
    subject: `DanceFlow Daily Platform Digest — ${new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date())}`,
    html,
  });

  return NextResponse.json({
    ok: true,
    paidAccessWithoutActiveSubscription: paidAccessWithoutActiveSubscription.length,
    unresolvedBackendErrors,
    neverAccessedStudios: neverAccessedStudios.length,
    staleAccessStudios: staleAccessStudios.length,
    recentlyActiveStudios: recentlyActiveStudios.length,
    smsMessagesToday: smsMessagesFor(todayStart).length,
    smsFailuresToday: smsFailedFor(todayStart).length,
    smsQueuedToday: smsQueuedFor(todayStart).length,
  });
}

