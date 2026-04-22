import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseAdmin } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStripe } from "@/lib/payments/stripe";
import { getBillingPlan, type PlanAudience } from "@/lib/billing/plans";

type StudioRow = {
  id: string;
  name: string | null;
  subscription_status: string | null;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
};

type PlanRow = {
  id: string;
  code: string;
  name: string;
  stripe_price_id_monthly: string | null;
  stripe_price_id_yearly: string | null;
};

type BillingCustomerRow = {
  id: string;
  stripe_customer_id: string | null;
};

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Missing Supabase admin environment variables.");
  }

  return createSupabaseAdmin(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

function buildAppUrl(request: NextRequest) {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    request.nextUrl.origin
  ).replace(/\/$/, "");
}

function billingRedirect(request: NextRequest, path: string) {
  return NextResponse.redirect(new URL(path, request.url), { status: 303 });
}

function parseAudience(value: FormDataEntryValue | null): PlanAudience | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "studio" || normalized === "organizer"
    ? normalized
    : undefined;
}

function parseEntry(value: FormDataEntryValue | null) {
  if (typeof value !== "string") return "default";
  const normalized = value.trim().toLowerCase();

  if (
    normalized === "trial-complete" ||
    normalized === "chooser" ||
    normalized === "no-card-trial"
  ) {
    return normalized;
  }

  return "default";
}

function parseBillingInterval(value: FormDataEntryValue | null) {
  if (typeof value !== "string") return "month";
  const normalized = value.trim().toLowerCase();
  return normalized === "year" ? "year" : "month";
}

function isOrganizerWorkspaceName(value: string | null | undefined) {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return false;

  return (
    normalized.endsWith(" organizer") ||
    normalized.includes(" organizer ") ||
    normalized.endsWith(" events") ||
    normalized.includes(" festival")
  );
}

function buildBillingReturnPath(params: {
  success?: string;
  error?: string;
  path?: PlanAudience;
  entry?: string;
  recommended?: string;
}) {
  const search = new URLSearchParams();

  if (params.success) search.set("success", params.success);
  if (params.error) search.set("error", params.error);
  if (params.path) search.set("path", params.path);
  if (params.entry && params.entry !== "default") search.set("entry", params.entry);
  if (params.recommended) search.set("recommended", params.recommended);

  const query = search.toString();
  return `/app/settings/billing${query ? `?${query}` : ""}`;
}

function buildSourceValue(audience: PlanAudience) {
  return audience === "organizer" ? "organizer_subscription" : "studio_subscription";
}

function isManagedSubscriptionStatus(status: string | null | undefined) {
  return ["active", "trialing", "past_due", "unpaid"].includes(status ?? "");
}

async function getManagedStripeSubscription(params: {
  stripeCustomerId: string;
}) {
  const stripe = getStripe();

  const subscriptions = await stripe.subscriptions.list({
    customer: params.stripeCustomerId,
    status: "all",
    limit: 20,
  });

  return (
    subscriptions.data.find((subscription) =>
      isManagedSubscriptionStatus(subscription.status)
    ) ?? null
  );
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();

  const planCodeRaw =
    typeof formData.get("planKey") === "string"
      ? String(formData.get("planKey")).trim()
      : typeof formData.get("planCode") === "string"
        ? String(formData.get("planCode")).trim()
        : "";

  const requestedPath = parseAudience(formData.get("path"));
  const entryMode = parseEntry(formData.get("entry"));
  const billingInterval = parseBillingInterval(formData.get("billingInterval"));
  const planCode = planCodeRaw.toLowerCase();

  if (!planCode) {
    return billingRedirect(
      request,
      buildBillingReturnPath({
        error: "plan_not_found",
        path: requestedPath,
        entry: entryMode,
      })
    );
  }

  const sharedPlan = getBillingPlan(planCode);

  if (!sharedPlan) {
    return billingRedirect(
      request,
      buildBillingReturnPath({
        error: "plan_not_found",
        path: requestedPath,
        entry: entryMode,
      })
    );
  }

  if (requestedPath && requestedPath !== sharedPlan.audience) {
    return billingRedirect(
      request,
      buildBillingReturnPath({
        error: "plan_not_found",
        path: requestedPath,
        entry: entryMode,
      })
    );
  }

  try {
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return billingRedirect(request, "/login");
    }

    const context = await getCurrentStudioContext();

    if (!context?.studioId) {
      return billingRedirect(
        request,
        buildBillingReturnPath({
          error: "no_studio_context",
          path: requestedPath ?? sharedPlan.audience,
          entry: entryMode,
          recommended: sharedPlan.code,
        })
      );
    }

    const studioId = context.studioId;
    const supabaseAdmin = getSupabaseAdmin();

    const [
      { data: studio, error: studioError },
      { data: planRow, error: planError },
      { data: existingCustomer, error: customerLookupError },
    ] = await Promise.all([
      supabaseAdmin
        .from("studios")
        .select("id, name, subscription_status, stripe_subscription_id, stripe_customer_id")
        .eq("id", studioId)
        .single<StudioRow>(),
      supabaseAdmin
        .from("subscription_plans")
        .select(
          `
            id,
            code,
            name,
            stripe_price_id_monthly,
            stripe_price_id_yearly
          `
        )
        .eq("code", planCode)
        .eq("active", true)
        .single<PlanRow>(),
      supabaseAdmin
        .from("studio_billing_customers")
        .select("id, stripe_customer_id")
        .eq("studio_id", studioId)
        .maybeSingle<BillingCustomerRow>(),
    ]);

    if (studioError || !studio) {
      return billingRedirect(
        request,
        buildBillingReturnPath({
          error: "studio_not_found",
          path: requestedPath ?? sharedPlan.audience,
          entry: entryMode,
          recommended: sharedPlan.code,
        })
      );
    }

    if (planError || !planRow) {
      return billingRedirect(
        request,
        buildBillingReturnPath({
          error: "plan_not_found",
          path: requestedPath ?? sharedPlan.audience,
          entry: entryMode,
        })
      );
    }

    if (customerLookupError) {
      throw new Error(customerLookupError.message);
    }

    const inferredAudience: PlanAudience = isOrganizerWorkspaceName(studio.name)
      ? "organizer"
      : "studio";

    const audience: PlanAudience = requestedPath ?? inferredAudience ?? sharedPlan.audience;

    if (audience !== sharedPlan.audience) {
      return billingRedirect(
        request,
        buildBillingReturnPath({
          error: "plan_not_found",
          path: audience,
          entry: entryMode,
          recommended: sharedPlan.code,
        })
      );
    }

    const stripePriceId =
      billingInterval === "year"
        ? planRow.stripe_price_id_yearly
        : planRow.stripe_price_id_monthly;

    if (!stripePriceId) {
      return billingRedirect(
        request,
        buildBillingReturnPath({
          error: "missing_price_id",
          path: audience,
          entry: entryMode,
          recommended: planCode,
        })
      );
    }

    const stripe = getStripe();
    let stripeCustomerId =
      existingCustomer?.stripe_customer_id ?? studio.stripe_customer_id ?? null;

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        name: studio.name ?? undefined,
        metadata: {
          workspaceId: studioId,
          workspaceName: studio.name ?? "",
          source: "danceflow_billing",
          audience,
          planCode: planRow.code,
        },
      });

      stripeCustomerId = customer.id;

      const [{ error: insertCustomerError }, { error: studioUpdateError }] =
        await Promise.all([
          supabaseAdmin.from("studio_billing_customers").upsert(
            {
              studio_id: studioId,
              stripe_customer_id: stripeCustomerId,
              billing_email: user.email ?? null,
              contact_name: studio.name ?? null,
            },
            { onConflict: "studio_id" }
          ),
          supabaseAdmin
            .from("studios")
            .update({ stripe_customer_id: stripeCustomerId })
            .eq("id", studioId),
        ]);

      if (insertCustomerError) {
        throw new Error(insertCustomerError.message);
      }

      if (studioUpdateError) {
        throw new Error(studioUpdateError.message);
      }
    }

    const appUrl = buildAppUrl(request);

    const stripeManagedSubscription = stripeCustomerId
      ? await getManagedStripeSubscription({
          stripeCustomerId,
        })
      : null;

    const hasManagedSubscription =
      Boolean(stripeManagedSubscription) ||
      (Boolean(studio.stripe_subscription_id) &&
        isManagedSubscriptionStatus(studio.subscription_status));

    if (stripeCustomerId && hasManagedSubscription) {
      const successCode =
        stripeManagedSubscription?.items.data.some(
          (item) => item.price.id === stripePriceId
        ) || studio.subscription_status === "trialing" || studio.subscription_status === "active"
          ? "current_plan"
          : "manage_subscription";

      const portalSession = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: `${appUrl}${buildBillingReturnPath({
          success: successCode,
          path: audience,
          entry: entryMode,
          recommended: planCode,
        })}`,
      });

      return NextResponse.redirect(portalSession.url, { status: 303 });
    }

    const successPath = buildBillingReturnPath({
      success: "subscription_checkout_started",
      path: audience,
      entry: entryMode,
      recommended: planCode,
    });

    const cancelPath = buildBillingReturnPath({
      error: "checkout_cancelled",
      path: audience,
      entry: entryMode,
      recommended: planCode,
    });

    const metadata = {
      source: buildSourceValue(audience),
      studioId,
      workspaceId: studioId,
      workspaceName: studio.name ?? "",
      planCode: planRow.code,
      billingInterval,
      audience,
      entry: entryMode,
    };

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      payment_method_collection: "always",
      line_items: [
        {
          price: stripePriceId,
          quantity: 1,
        },
      ],
      success_url: `${appUrl}${successPath}`,
      cancel_url: `${appUrl}${cancelPath}`,
      allow_promotion_codes: true,
      metadata,
      subscription_data: {
        metadata,
        ...(sharedPlan.trialDays > 0
          ? { trial_period_days: sharedPlan.trialDays }
          : {}),
      },
    });

    if (!checkoutSession.url) {
      return billingRedirect(
        request,
        buildBillingReturnPath({
          error: "checkout_failed",
          path: audience,
          entry: entryMode,
          recommended: planCode,
        })
      );
    }

    return NextResponse.redirect(checkoutSession.url, { status: 303 });
  } catch (error) {
    console.error("billing checkout failed", error);

    return billingRedirect(
      request,
      buildBillingReturnPath({
        error: "checkout_failed",
        path: requestedPath ?? sharedPlan.audience,
        entry: entryMode,
        recommended: planCode,
      })
    );
  }
}