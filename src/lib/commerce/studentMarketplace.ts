import { SupabaseClient } from "@supabase/supabase-js";
import { queueOutboundDelivery } from "@/lib/notifications/outbound";
import { renderStudioBrandedEmail } from "@/lib/notifications/email-branding";

function getSiteUrl() {
  return (process.env.NEXT_PUBLIC_SITE_URL || "https://idanceflow.com").replace(
    /\/$/,
    "",
  );
}

function formatMoney(value: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: (currency || "USD").toUpperCase(),
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${(currency || "USD").toUpperCase()}`;
  }
}

async function queueStudentMarketplacePurchaseConfirmation(params: {
  supabase: SupabaseClient;
  orderId: string;
  entitlementId: string;
}) {
  const { data: order, error: orderError } = await params.supabase
    .from("commerce_orders")
    .select(
      "id, studio_id, client_id, order_number, total, currency, metadata, payment_status",
    )
    .eq("id", params.orderId)
    .maybeSingle();

  if (orderError || !order) {
    throw new Error(
      orderError?.message || "Marketplace order could not be loaded for email.",
    );
  }

  const [{ data: orderItem }, { data: studio }, { data: client }] =
    await Promise.all([
      params.supabase
        .from("commerce_order_items")
        .select("name_snapshot, catalog_item_id")
        .eq("order_id", order.id)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
      params.supabase
        .from("studios")
        .select("name, public_name, public_logo_url")
        .eq("id", order.studio_id)
        .maybeSingle(),
      order.client_id
        ? params.supabase
            .from("clients")
            .select("first_name, email")
            .eq("id", order.client_id)
            .eq("studio_id", order.studio_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

  const metadata =
    order.metadata && typeof order.metadata === "object"
      ? (order.metadata as Record<string, unknown>)
      : {};
  const metadataEmail =
    typeof metadata.buyer_email === "string" ? metadata.buyer_email.trim() : "";
  const recipientEmail = client?.email?.trim() || metadataEmail;

  if (!recipientEmail) return;

  const studioName =
    studio?.public_name?.trim() || studio?.name || "Your dance studio";
  const studioLogoUrl = studio?.public_logo_url ?? null;
  const itemName = orderItem?.name_snapshot?.trim() || "Digital content";
  const firstName = client?.first_name?.trim() || "there";
  const total = formatMoney(Number(order.total ?? 0), order.currency || "USD");
  const accountUrl = `${getSiteUrl()}/account`;

  const subject = `Your ${itemName} purchase is ready`;
  const bodyText = [
    `Hi ${firstName},`,
    "",
    `Your purchase of ${itemName} from ${studioName} is complete.`,
    `Order: ${order.order_number || order.id}`,
    `Total: ${total}`,
    "",
    "Your access has been added to your DanceFlow account.",
    `Open DanceFlow: ${accountUrl}`,
    "",
    "Need help with the content or your purchase? Reply to this email to contact the studio.",
    "",
    "Thanks,",
    studioName,
  ].join("\n");

  const bodyHtml = renderStudioBrandedEmail(
    {
      name: studioName,
      logoUrl: studioLogoUrl,
    },
    {
      previewText: `${itemName} is now available in your DanceFlow account.`,
      eyebrow: "Purchase Complete",
      heading: "Your content is ready",
      greeting: `Hi ${firstName},`,
      intro: `Your purchase from ${studioName} is complete.`,
      bodyText,
      detailRows: [
        { label: "Item", value: itemName },
        { label: "Order", value: order.order_number || order.id },
        { label: "Total", value: total },
      ],
      actionLabel: "Open DanceFlow",
      actionUrl: accountUrl,
      footerText: `Sent by ${studioName} through DanceFlow.`,
    },
  );

  await queueOutboundDelivery({
    studioId: order.studio_id,
    channel: "email",
    templateKey: "commerce_digital_purchase_confirmed",
    recipientEmail,
    subject,
    bodyText,
    bodyHtml,
    relatedTable: "commerce_entitlements",
    relatedId: params.entitlementId,
    dedupeKey: `commerce_digital_purchase_confirmed:${order.id}`,
  });
}

export async function finalizeStudentMarketplacePayment(input: {
  supabase: SupabaseClient;
  orderId: string;
  paymentIntentId: string;
  amount: number;
  currency: string;
}) {
  const { data, error } = await input.supabase.rpc(
    "commerce_finalize_student_digital_order",
    {
      p_order_id: input.orderId,
      p_stripe_payment_intent_id: input.paymentIntentId,
      p_amount: input.amount,
      p_currency: input.currency,
    },
  );

  if (error) {
    throw new Error(error.message);
  }

  const entitlementId = String(data);

  try {
    await queueStudentMarketplacePurchaseConfirmation({
      supabase: input.supabase,
      orderId: input.orderId,
      entitlementId,
    });
  } catch (emailError) {
    console.error(
      "Marketplace purchase confirmation queue failed",
      emailError instanceof Error ? emailError.message : emailError,
    );
  }

  return entitlementId;
}
