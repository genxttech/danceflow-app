import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/payments/stripe";
import { getStudentApiUser, normalizeStudentApiUuid } from "@/lib/auth/studentApiAuth";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";

type Params = { params: Promise<{ catalogItemId: string }> };

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function one<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimit = checkRateLimit(
    rateLimitKey("checkout:student-marketplace", getIpFromRequest(request)),
    { limit: 6, windowMs: 15 * 60 * 1000 },
  );
  if (!rateLimit.allowed) return rateLimitedJson(rateLimit);

  const { catalogItemId } = await params;
  const id = normalizeStudentApiUuid(catalogItemId);
  if (!id) return jsonError("Marketplace item was not found.", 404);

  const user = await getStudentApiUser(request);
  if (!user?.email) return jsonError("Sign in before purchasing content.", 401);

  const admin = createAdminClient();
  const stripe = getStripe();

  const { data: item, error } = await admin
    .from("commerce_catalog_items")
    .select(`
      id, studio_id, name, description, item_type, price, currency,
      active, published, marketplace_visible,
      studios:studio_id (
        subscription_status,
        stripe_connected_account_id,
        stripe_connect_charges_enabled,
        stripe_connect_payouts_enabled,
        stripe_connect_onboarding_complete
      ),
      commerce_digital_content (status, release_at, mux_upload_status)
    `)
    .eq("id", id)
    .maybeSingle();

  const studio = one((item as any)?.studios);
  const content = one((item as any)?.commerce_digital_content);
  const available =
    item?.active === true &&
    item?.published === true &&
    item?.marketplace_visible === true &&
    ["digital_video", "video_series"].includes(item?.item_type ?? "") &&
    content?.status === "published" &&
    (!content.release_at || new Date(content.release_at).getTime() <= Date.now()) &&
    (item?.item_type === "video_series" || content?.mux_upload_status === "ready") &&
    ["active", "trialing"].includes(studio?.subscription_status ?? "") &&
    studio?.stripe_connect_charges_enabled === true &&
    studio?.stripe_connect_payouts_enabled === true &&
    studio?.stripe_connect_onboarding_complete === true &&
    Boolean(studio?.stripe_connected_account_id);

  if (error || !item || !available) {
    return jsonError("Marketplace item is not available.", 404);
  }

  const { data: existingEntitlement } = await admin
    .from("commerce_entitlements")
    .select("id")
    .eq("user_id", user.id)
    .eq("catalog_item_id", item.id)
    .in("status", ["active", "refunded_access_retained"])
    .maybeSingle();

  if (existingEntitlement) {
    return jsonError("You already own this content.", 409);
  }

  const normalizedEmail = user.email.trim().toLowerCase();
  const userMetadata =
    user.user_metadata && typeof user.user_metadata === "object"
      ? (user.user_metadata as Record<string, unknown>)
      : {};
  const metadataFirstName =
    typeof userMetadata.first_name === "string"
      ? userMetadata.first_name.trim()
      : "";
  const metadataLastName =
    typeof userMetadata.last_name === "string"
      ? userMetadata.last_name.trim()
      : "";
  const metadataFullName =
    typeof userMetadata.full_name === "string"
      ? userMetadata.full_name.trim()
      : "";
  const fullNameParts = metadataFullName.split(/\s+/).filter(Boolean);
  const firstName = metadataFirstName || fullNameParts[0] || "Marketplace";
  const lastName =
    metadataLastName || fullNameParts.slice(1).join(" ") || "Customer";
  const now = new Date().toISOString();

  const { data: existingSelfLink, error: existingSelfLinkError } = await admin
    .from("client_account_links")
    .select("id, client_id")
    .eq("user_id", user.id)
    .eq("studio_id", item.studio_id)
    .eq("status", "linked")
    .eq("relationship_type", "self")
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (existingSelfLinkError) {
    return jsonError("Your studio relationship could not be verified.", 500);
  }

  let clientId = existingSelfLink?.client_id ?? null;

  if (!clientId) {
    const { data: matchingClients, error: matchingClientError } = await admin
      .from("clients")
      .select("id")
      .eq("studio_id", item.studio_id)
      .ilike("email", normalizedEmail)
      .order("created_at", { ascending: true })
      .limit(2);

    if (matchingClientError) {
      return jsonError("Your customer record could not be resolved.", 500);
    }

    if ((matchingClients ?? []).length > 1) {
      return jsonError(
        "This studio has duplicate customer records for your email. Contact the studio before purchasing.",
        409,
      );
    }

    clientId = matchingClients?.[0]?.id ?? null;

    if (clientId) {
      const { data: conflictingLink, error: conflictingLinkError } = await admin
        .from("client_account_links")
        .select("id, user_id")
        .eq("studio_id", item.studio_id)
        .eq("client_id", clientId)
        .eq("status", "linked")
        .eq("relationship_type", "self")
        .neq("user_id", user.id)
        .limit(1)
        .maybeSingle();

      if (conflictingLinkError) {
        return jsonError("The customer relationship could not be verified.", 500);
      }

      if (conflictingLink) {
        return jsonError(
          "A different DanceFlow account is already connected to this studio customer record. Contact the studio before purchasing.",
          409,
        );
      }
    } else {
      const { data: insertedClient, error: clientInsertError } = await admin
        .from("clients")
        .insert({
          studio_id: item.studio_id,
          first_name: firstName,
          last_name: lastName,
          email: normalizedEmail,
          status: "lead",
          referral_source: "DanceFlow Marketplace",
          source_system: "student_marketplace",
          notes: "Created automatically from a public DanceFlow Marketplace purchase.",
        })
        .select("id")
        .single();

      if (clientInsertError || !insertedClient) {
        return jsonError(
          clientInsertError?.message ||
            "A customer record could not be created for this purchase.",
          500,
        );
      }

      clientId = insertedClient.id;
    }

    const { data: priorLink, error: priorLinkError } = await admin
      .from("client_account_links")
      .select("id")
      .eq("studio_id", item.studio_id)
      .eq("client_id", clientId)
      .eq("user_id", user.id)
      .eq("relationship_type", "self")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (priorLinkError) {
      return jsonError("The customer relationship could not be prepared.", 500);
    }

    const linkPayload = {
      studio_id: item.studio_id,
      client_id: clientId,
      user_id: user.id,
      status: "linked",
      relationship_type: "self",
      initiated_by: "student",
      invited_email: normalizedEmail,
      can_view_schedule: true,
      can_view_billing: true,
      can_manage_bookings: true,
      can_sign_documents: true,
      is_primary: true,
      claimed_at: now,
      linked_at: now,
      accepted_at: now,
      disconnected_at: null,
      disconnected_by: null,
      disconnect_reason: null,
      conflict_details: null,
      updated_at: now,
    };

    const { error: linkSaveError } = priorLink?.id
      ? await admin
          .from("client_account_links")
          .update(linkPayload)
          .eq("id", priorLink.id)
      : await admin.from("client_account_links").insert(linkPayload);

    if (linkSaveError) {
      return jsonError(
        `Your studio relationship could not be created: ${linkSaveError.message}`,
        500,
      );
    }
  }

  const amount = Number(item.price ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return jsonError("This item is not configured for paid checkout.");
  }

  const currency = String(item.currency ?? "usd").toLowerCase();

  const { data: order, error: orderError } = await admin
    .from("commerce_orders")
    .insert({
      studio_id: item.studio_id,
      order_number: `COM-${crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`,
      client_id: clientId,
      customer_type: "client",
      status: "open",
      payment_status: "pending",
      fulfillment_status: "unfulfilled",
      subtotal: amount,
      discount_total: 0,
      tax_total: 0,
      refund_total: 0,
      total: amount,
      currency,
      notes: "Student marketplace checkout",
      metadata: {
        source: "student_marketplace",
        student_user_id: user.id,
        buyer_email: user.email.toLowerCase(),
        catalog_item_id: item.id,
      },
      created_by: user.id,
      updated_by: user.id,
    })
    .select("id")
    .single();

  if (orderError || !order) return jsonError("Checkout order could not be created.", 500);

  try {
    const { error: itemError } = await admin.from("commerce_order_items").insert({
      order_id: order.id,
      studio_id: item.studio_id,
      catalog_item_id: item.id,
      item_type: item.item_type,
      name_snapshot: item.name,
      quantity: 1,
      unit_price: amount,
      discount_total: 0,
      tax_total: 0,
      line_total: amount,
      fulfillment_status: "unfulfilled",
      metadata: { fulfillment_type: "digital_entitlement" },
    });
    if (itemError) throw new Error(itemError.message);

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: Math.round(amount * 100),
        currency,
        receipt_email: user.email,
        automatic_payment_methods: { enabled: true },
        metadata: {
          source: "commerce_digital_marketplace",
          order_id: order.id,
          studio_id: item.studio_id,
          catalog_item_id: item.id,
          client_id: clientId,
          user_id: user.id,
          connected_account_id: studio.stripe_connected_account_id,
        },
      },
      { stripeAccount: studio.stripe_connected_account_id },
    );

    if (!paymentIntent.client_secret) {
      throw new Error("Stripe did not return a payment secret.");
    }

    const { error: updateError } = await admin
      .from("commerce_orders")
      .update({
        metadata: {
          source: "student_marketplace",
          student_user_id: user.id,
          buyer_email: user.email.toLowerCase(),
          catalog_item_id: item.id,
          stripe_payment_intent_id: paymentIntent.id,
          stripe_connected_account_id: studio.stripe_connected_account_id,
          prepared_at: now,
        },
        updated_at: now,
      })
      .eq("id", order.id);
    if (updateError) throw new Error(updateError.message);

    return NextResponse.json({
      clientSecret: paymentIntent.client_secret,
      orderId: order.id,
      publishableKey:
        process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ||
        process.env.STRIPE_PUBLISHABLE_KEY ||
        "",
    });
  } catch (caught) {
    await admin
      .from("commerce_orders")
      .update({
        status: "cancelled",
        payment_status: "failed",
        cancelled_at: new Date().toISOString(),
      })
      .eq("id", order.id);

    return jsonError(
      caught instanceof Error ? caught.message : "Checkout could not be started.",
      500,
    );
  }
}
