import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseAdmin } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStripe } from "@/lib/payments/stripe";
import { getBillingPlan, type PlanAudience } from "@/lib/billing/plans";
import { canManageWorkspaceSubscription } from "@/lib/billing/subscriptionAuthority";
import { isFounderPricingActive } from "@/lib/billing/founderPricing";
import { isRegularPricingActivated } from "@/lib/billing/regularPricing";
import {
  selectStudioMonthlyPrice,
  stripePriceMatchesExpected,
} from "@/lib/billing/studioCheckoutPricing";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";
import { hasCurrentBusinessLegalAcceptance } from "@/lib/legal/agreements";
import {
  evaluateProtection,
  legacyProtectedPriceIds,
  loadProtectedRegistry,
  type SubscriptionSnapshot,
} from "@/lib/billing/protectedSubscriptions";
import {
  blocksNewCheckout,
  classifySubscriptionStatus,
  strongestSubscriptionState,
} from "@/lib/billing/subscriptionState";

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

type CheckoutInput = {
  planCodeRaw: string;
  requestedPath: PlanAudience | undefined;
  entryMode: string;
  billingInterval: "month" | "year";
};



type PriceLookupResult = {
  stripePriceId: string | null;
  offerType: "founder" | "standard" | "database";
  // PRICING-P1: set only for monthly studio plans, whose Stripe Price must
  // carry exactly this amount (verified before a Checkout Session is created).
  expectedAmountCents?: number;
};

function getEnvPriceId(name: string) {
  const value = process.env[name]?.trim();
  return value || null;
}

function resolveCheckoutPriceId(params: {
  planCode: string;
  sharedPlan: NonNullable<ReturnType<typeof getBillingPlan>>;
  billingInterval: "month" | "year";
  databaseMonthlyPriceId: string | null;
  databaseYearlyPriceId: string | null;
}): PriceLookupResult {
  if (params.billingInterval === "year") {
    return {
      stripePriceId: params.databaseYearlyPriceId,
      offerType: "database",
    };
  }

  // PRICING-P1: monthly studio plans are fail-closed -- no fallback between
  // Founder, standard and database Price IDs.
  if (params.sharedPlan.audience === "studio") {
    const selection = selectStudioMonthlyPrice({
      plan: params.sharedPlan,
      founderActive: isFounderPricingActive(),
      regularActivated: isRegularPricingActivated(),
      env: process.env,
    });

    if (!selection.ok) return { stripePriceId: null, offerType: "database" };

    return {
      stripePriceId: selection.stripePriceId,
      offerType: selection.offerType,
      expectedAmountCents: selection.expectedAmountCents,
    };
  }

  const normalizedPlanCode = params.planCode.toLowerCase();

  const standardEnvByPlan: Record<string, string> = {
    starter: "STRIPE_PRICE_STUDIO_STARTER_STANDARD",
    growth: "STRIPE_PRICE_STUDIO_GROWTH_STANDARD",
    pro: "STRIPE_PRICE_STUDIO_PRO_STANDARD",
    organizer: "STRIPE_PRICE_ORGANIZER_STANDARD",
  };

  const founderEnvByPlan: Record<string, string> = {
    starter: "STRIPE_PRICE_STUDIO_STARTER_FOUNDER",
    growth: "STRIPE_PRICE_STUDIO_GROWTH_FOUNDER",
    pro: "STRIPE_PRICE_STUDIO_PRO_FOUNDER",
    organizer: "STRIPE_PRICE_ORGANIZER_FOUNDER",
  };

  const founderPriceId = isFounderPricingActive()
    ? getEnvPriceId(founderEnvByPlan[normalizedPlanCode])
    : null;

  if (founderPriceId) {
    return { stripePriceId: founderPriceId, offerType: "founder" };
  }

  const standardPriceId = getEnvPriceId(standardEnvByPlan[normalizedPlanCode]);

  if (standardPriceId) {
    return { stripePriceId: standardPriceId, offerType: "standard" };
  }

  return {
    stripePriceId: params.databaseMonthlyPriceId,
    offerType: "database",
  };
}

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

function parseAudienceValue(value: string | null | undefined): PlanAudience | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();

  return normalized === "studio" || normalized === "organizer"
    ? normalized
    : undefined;
}

function parseEntryValue(value: string | null | undefined) {
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

function parseBillingIntervalValue(value: string | null | undefined) {
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

// D7-3a: the strongest state across the customer's Stripe subscriptions
// (managed, then paused/incomplete "hold", then none). Terminal subscriptions
// (canceled, incomplete_expired) do not count.
async function getStripeSubscriptions(params: {
  stripeCustomerIds: string[];
}): Promise<{ snapshots: SubscriptionSnapshot[]; truncated: boolean }> {
  const stripe = getStripe();
  const snapshots: SubscriptionSnapshot[] = [];
  let truncated = false;

  // Every customer id the studio is known by (D7-4): a legacy subscription on a replaced customer must still be seen.
  for (const stripeCustomerId of params.stripeCustomerIds) {
    const subscriptions = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: "all",
      limit: 100,
    });

    // More than one page: the rest cannot be inspected, so callers must fail closed.
    if (subscriptions.has_more) truncated = true;
    snapshots.push(...toSnapshots(subscriptions.data));
  }

  return { snapshots, truncated };
}

function toSnapshots(
  data: Array<{ id?: string; status: string; items?: { data?: Array<{ price?: { id?: string } | null }> } }>,
): SubscriptionSnapshot[] {
  return data.map((subscription) => ({
    id: subscription.id ?? null,
    status: subscription.status,
    priceIds: (subscription.items?.data ?? [])
      .map((item) => item.price?.id)
      .filter((id): id is string => Boolean(id)),
  }));
}

async function readCheckoutInput(request: NextRequest): Promise<CheckoutInput> {
  if (request.method === "GET") {
    const searchParams = request.nextUrl.searchParams;

    const planCodeRaw =
      (searchParams.get("planKey") ?? searchParams.get("planCode") ?? "").trim();

    return {
      planCodeRaw,
      requestedPath: parseAudienceValue(searchParams.get("path")),
      entryMode: parseEntryValue(searchParams.get("entry")),
      billingInterval: parseBillingIntervalValue(searchParams.get("billingInterval")),
    };
  }

  const formData = await request.formData();

  const planCodeRaw =
    typeof formData.get("planKey") === "string"
      ? String(formData.get("planKey")).trim()
      : typeof formData.get("planCode") === "string"
        ? String(formData.get("planCode")).trim()
        : "";

  return {
    planCodeRaw,
    requestedPath: parseAudienceValue(
      typeof formData.get("path") === "string" ? String(formData.get("path")) : null
    ),
    entryMode: parseEntryValue(
      typeof formData.get("entry") === "string" ? String(formData.get("entry")) : null
    ),
    billingInterval: parseBillingIntervalValue(
      typeof formData.get("billingInterval") === "string"
        ? String(formData.get("billingInterval"))
        : null
    ),
  };
}

async function handleCheckout(request: NextRequest) {
  const { planCodeRaw, requestedPath, entryMode, billingInterval } =
    await readCheckoutInput(request);

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

    const hasCurrentLegalAcceptance =
      await hasCurrentBusinessLegalAcceptance({
        supabase,
        userId: user.id,
      });

    if (!hasCurrentLegalAcceptance) {
      const legalSearch = new URLSearchParams({
        intent: requestedPath ?? sharedPlan.audience,
        plan: sharedPlan.code,
      });

      return billingRedirect(
        request,
        `/legal/accept?${legalSearch.toString()}`,
      );
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

    // LAUNCH-SEC-2A: both branches below (new plan checkout and the billing
    // portal for an existing subscription) are owner-level billing actions.
    if (!canManageWorkspaceSubscription(context.studioRole, context.isPlatformAdmin)) {
      return billingRedirect(
        request,
        buildBillingReturnPath({
          error: "billing_owner_required",
          path: requestedPath ?? sharedPlan.audience,
          entry: entryMode,
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

    const { stripePriceId, offerType, expectedAmountCents } = resolveCheckoutPriceId({
      planCode,
      sharedPlan,
      billingInterval,
      databaseMonthlyPriceId: planRow.stripe_price_id_monthly,
      databaseYearlyPriceId: planRow.stripe_price_id_yearly,
    });

    // PRICING-P1: a missing Price ID no longer blocks the billing portal for an
    // existing subscriber; it is enforced below, before any new Checkout Session.
    const stripe = getStripe();
    let stripeCustomerId =
      existingCustomer?.stripe_customer_id ?? studio.stripe_customer_id ?? null;

    // D7-4 (R36): read the protected-subscription registry BEFORE any Stripe write, so a protected
    // studio is refused without a customer being created. Unknown registry state fails closed.
    const registry = await loadProtectedRegistry(
      supabaseAdmin as unknown as Parameters<typeof loadProtectedRegistry>[0],
      studioId,
    );

    if (registry.status === "error") {
      console.error("billing checkout: protected-subscription registry unreadable", { studioId });
      return billingRedirect(
        request,
        buildBillingReturnPath({
          error: "protection_check_failed",
          path: audience,
          entry: entryMode,
          recommended: planCode,
        })
      );
    }

    if (registry.status === "table_missing") {
      console.warn("billing checkout: protected_subscriptions table is missing; only the legacy-price backstop applies", { studioId });
    }

    if (registry.status === "ok" && registry.activeRows > 0) {
      console.warn("billing checkout: protected subscription routed to support", { studioId, reasons: ["registry"] });
      return billingRedirect(
        request,
        buildBillingReturnPath({
          error: "protected_subscription_needs_support",
          path: audience,
          entry: entryMode,
          recommended: planCode,
        })
      );
    }

    const legacyPriceIds = legacyProtectedPriceIds();

    if (legacyPriceIds.length === 0 && process.env.NODE_ENV === "production") {
      console.warn("billing checkout: no legacy protected Price configured and the registry is empty; the legacy-price backstop is off");
    }

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

    const knownCustomerIds = Array.from(
      new Set(
        [
          stripeCustomerId,
          existingCustomer?.stripe_customer_id,
          studio.stripe_customer_id,
          ...(registry.status === "ok" ? registry.customerIds : []),
        ].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    );
    const { snapshots: stripeSubscriptions, truncated: subscriptionsTruncated } =
      await getStripeSubscriptions({ stripeCustomerIds: knownCustomerIds });
    const stripeState = strongestSubscriptionState(
      stripeSubscriptions.map((subscription) => subscription.status),
    );

    // Truncated subscription lists cannot be fully inspected: fail closed.
    if (subscriptionsTruncated) {
      console.error("billing checkout: subscription list truncated; failing closed", { studioId });
      return billingRedirect(
        request,
        buildBillingReturnPath({
          error: "protection_check_failed",
          path: audience,
          entry: entryMode,
          recommended: planCode,
        })
      );
    }

    const protection = evaluateProtection({
      registry,
      subscriptions: stripeSubscriptions,
      legacyPriceIds,
    });

    if (protection.protected) {
      console.warn("billing checkout: protected subscription routed to support", {
        studioId,
        reasons: protection.reasons,
      });
      return billingRedirect(
        request,
        buildBillingReturnPath({
          error: "protected_subscription_needs_support",
          path: audience,
          entry: entryMode,
          recommended: planCode,
        })
      );
    }

    // The studio row only counts when it names a subscription; a status with no
    // subscription id is the no-card trial, which must still be able to check out.
    const studioState = studio.stripe_subscription_id
      ? classifySubscriptionStatus(studio.subscription_status)
      : "none";

    const subscriptionState = strongestSubscriptionState([
      stripeState === "managed" ? "active" : stripeState === "hold" ? "paused" : null,
      studioState === "managed" ? "active" : studioState === "hold" ? "paused" : null,
    ]);

    // D7-3a (O11): an existing or half-created subscription never starts a new
    // Checkout (no second subscription, no second trial) and never silently
    // reprices. Plan changes go to DanceFlow support; the billing portal button
    // stays available for payment methods and invoices.
    if (blocksNewCheckout(subscriptionState)) {
      return billingRedirect(
        request,
        buildBillingReturnPath({
          error:
            subscriptionState === "managed"
              ? "plan_change_requires_support"
              : "subscription_needs_support",
          path: audience,
          entry: entryMode,
          recommended: planCode,
        })
      );
    }

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

    if (expectedAmountCents !== undefined) {
      const stripePrice = await stripe.prices.retrieve(stripePriceId);

      if (!stripePriceMatchesExpected(stripePrice, expectedAmountCents)) {
        console.error("billing checkout: Stripe Price does not match plan configuration", {
          planCode,
          offerType,
          stripePriceId,
        });

        return billingRedirect(
          request,
          buildBillingReturnPath({
            error: "price_mismatch",
            path: audience,
            entry: entryMode,
            recommended: planCode,
          })
        );
      }
    }

    const successPath =
      entryMode === "trial-complete"
        ? `/get-started/complete?mode=success&intent=${encodeURIComponent(
            audience
          )}&plan=${encodeURIComponent(sharedPlan.code)}`
        : buildBillingReturnPath({
            success: "subscription_updated",
            path: audience,
            entry: entryMode,
            recommended: planCode,
          });

    const cancelPath =
  entryMode === "trial-complete"
    ? `/get-started/complete?intent=${encodeURIComponent(
        audience
      )}&plan=${encodeURIComponent(sharedPlan.code)}&cancelled=1`
    : buildBillingReturnPath({
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
      offerType,
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

export async function GET(request: NextRequest) {
  const rateLimit = checkRateLimit(
    rateLimitKey("billing:checkout", getIpFromRequest(request)),
    { limit: 8, windowMs: 10 * 60 * 1000 },
  );

  if (!rateLimit.allowed) {
    return rateLimitedJson(rateLimit);
  }

  return handleCheckout(request);
}

export async function POST(request: NextRequest) {
  const rateLimit = checkRateLimit(
    rateLimitKey("billing:checkout", getIpFromRequest(request)),
    { limit: 8, windowMs: 10 * 60 * 1000 },
  );

  if (!rateLimit.allowed) {
    return rateLimitedJson(rateLimit);
  }

  return handleCheckout(request);
}
