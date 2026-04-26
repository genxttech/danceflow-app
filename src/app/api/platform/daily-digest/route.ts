import { NextRequest, NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { Resend } from "resend";

export const dynamic = "force-dynamic";

type SubscriptionRow = {
  id: string;
  studio_id: string;
  status: string;
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

const PLATFORM_TICKET_FEE_RATE = 0.035;
const PAID_REGISTRATION_STATUSES = new Set(["paid", "completed", "succeeded"]);
const PAID_INVOICE_STATUSES = new Set(["paid", "succeeded"]);

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

function isOnOrAfter(value: string | null | undefined, start: Date) {
  if (!value) return false;
  return new Date(value).getTime() >= start.getTime();
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
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

function htmlEscape(value: string) {
  return value
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

  const [
    { data: studios, error: studiosError },
    { data: subscriptions, error: subscriptionsError },
    { data: registrations, error: registrationsError },
    { data: invoices, error: invoicesError },
    { data: platformErrors, error: platformErrorsError },
    { data: packageErrors, error: packageErrorsError },
  ] = await Promise.all([
    supabase.from("studios").select("id, name"),
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
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const errors = [
    studiosError,
    subscriptionsError,
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
  const typedRegistrations = (registrations ?? []) as EventRegistrationRow[];
  const typedInvoices = (invoices ?? []) as StudioInvoiceRow[];
  const typedPlatformErrors = (platformErrors ?? []) as PlatformErrorRow[];
  const typedPackageErrors = (packageErrors ?? []) as PackageDeductionErrorRow[];

  const subscriptionByStudioId = new Map(
    typedSubscriptions.map((subscription) => [subscription.studio_id, subscription])
  );

  const paidAccessWithoutActiveSubscription = typedStudios.filter((studio) => {
    const subscription = subscriptionByStudioId.get(studio.id);
    if (!hasPaidPlan(subscription)) return false;
    return !hasActiveBillingAccess(subscription?.status);
  });

  const todayStart = startOfToday();
  const monthStart = startOfMonth();
  const yearStart = startOfYear();

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

  const metrics = [
    {
      label: "Ticket platform fee revenue",
      today: formatMoney(paidRegistrationRevenueFor(todayStart) * PLATFORM_TICKET_FEE_RATE),
      month: formatMoney(paidRegistrationRevenueFor(monthStart) * PLATFORM_TICKET_FEE_RATE),
      ytd: formatMoney(paidRegistrationRevenueFor(yearStart) * PLATFORM_TICKET_FEE_RATE),
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
  ];

  const unresolvedBackendErrors = typedPlatformErrors.length + typedPackageErrors.length;
  const dashboardUrl = siteUrl ? `${siteUrl}/platform` : "/platform";
  const alertsUrl = siteUrl ? `${siteUrl}/platform/alerts` : "/platform/alerts";
  const billingUrl = siteUrl ? `${siteUrl}/platform/billing` : "/platform/billing";

  const html = `
    <div style="font-family:Arial,sans-serif;background:#f8fafc;padding:24px;color:#0f172a;">
      <div style="max-width:760px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:24px;overflow:hidden;">
        <div style="background:#4b2e83;color:#ffffff;padding:28px;">
          <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#ddd6fe;">DanceFlow Platform Admin</p>
          <h1 style="margin:0;font-size:28px;line-height:1.2;">Daily Platform Digest</h1>
          <p style="margin:12px 0 0;color:#ede9fe;">Proactive launch visibility for alerts, revenue, growth, and cancellations.</p>
        </div>

        <div style="padding:24px;">
          <h2 style="margin:0 0 12px;font-size:20px;">Platform Alerts</h2>
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
            <tr>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;font-weight:600;">Paid-plan access without active subscription</td>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${paidAccessWithoutActiveSubscription.length}</td>
            </tr>
            <tr>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;font-weight:600;">Unresolved backend errors</td>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${unresolvedBackendErrors}</td>
            </tr>
          </table>

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
            <a href="${dashboardUrl}" style="display:inline-block;background:#4b2e83;color:#ffffff;text-decoration:none;padding:10px 14px;border-radius:12px;font-weight:600;">Open Platform Dashboard</a>
            <a href="${alertsUrl}" style="display:inline-block;background:#f59e0b;color:#111827;text-decoration:none;padding:10px 14px;border-radius:12px;font-weight:600;">Review Alerts</a>
            <a href="${billingUrl}" style="display:inline-block;background:#e11d48;color:#ffffff;text-decoration:none;padding:10px 14px;border-radius:12px;font-weight:600;">Review Billing Risks</a>
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
  });
}
