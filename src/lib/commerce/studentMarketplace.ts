import { SupabaseClient } from "@supabase/supabase-js";
import { queueOutboundDelivery } from "@/lib/notifications/outbound";
import { renderStudioBrandedEmail } from "@/lib/notifications/email-branding";
import { buildAppUrl, resolveStudioDisplayName } from "@/lib/email/brand";

/** Pure builder for the digital-purchase confirmation email (exported for deterministic tests). */
export function buildMarketplacePurchaseEmail(params: {
  studio: { name?: string | null; public_name?: string | null; public_logo_url?: string | null };
  firstName: string | null;
  itemName: string;
  orderNumber: string;
  total: string;
}) {
  const studioName = resolveStudioDisplayName(params.studio);
  const firstName = params.firstName?.trim() || "there";
  const accountUrl = buildAppUrl("/account");
  const greeting = `Hi ${firstName},`;
  const intro = `Your purchase from ${studioName} is complete.`;

  const bodyText = [
    greeting,
    "",
    `Your purchase of ${params.itemName} from ${studioName} is complete.`,
    `Order: ${params.orderNumber}`,
    `Total: ${params.total}`,
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
    { name: studioName, logoUrl: params.studio.public_logo_url ?? null },
    {
      previewText: `${params.itemName} is now available in your DanceFlow account.`,
      eyebrow: "Purchase Complete",
      heading: "Your content is ready",
      greeting,
      intro,
      bodyText,
      detailRows: [
        { label: "Item", value: params.itemName },
        { label: "Order", value: params.orderNumber },
        { label: "Total", value: params.total },
      ],
      actionLabel: "Open DanceFlow",
      actionUrl: accountUrl,
      dedupeBodyLeadIn: true,
    },
  );

  return { subject: `Your ${params.itemName} purchase is ready`, bodyText, bodyHtml };
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

  const itemName = orderItem?.name_snapshot?.trim() || "Digital content";
  const total = formatMoney(Number(order.total ?? 0), order.currency || "USD");
  const { subject, bodyText, bodyHtml } = buildMarketplacePurchaseEmail({
    studio: studio ?? {},
    firstName: client?.first_name ?? null,
    itemName,
    orderNumber: order.order_number || order.id,
    total,
  });

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
