"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canSellCommerce } from "@/lib/auth/permissions";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PAYMENT_METHODS = new Set([
  "cash",
  "check",
  "card",
  "ach",
  "venmo",
  "zelle",
  "other",
]);

function clean(value: FormDataEntryValue | null, maxLength = 1000) {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .trim()
        .slice(0, maxLength)
    : "";
}

function isUuid(value: string) {
  return UUID_PATTERN.test(value);
}

function parseQuantity(value: string) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 1000
    ? parsed
    : null;
}

function parseMoney(value: string) {
  const normalized = value.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100000
    ? Math.round(parsed * 100) / 100
    : null;
}

async function requireSeller() {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (
    !context.studioId ||
    (!context.isPlatformAdmin && !canSellCommerce(context.studioRole))
  ) {
    redirect("/app");
  }

  return { supabase, context };
}

function errorRedirect(message: string) {
  redirect(`/app/sell?type=physical_product&error=${encodeURIComponent(message)}`);
}

export async function completePhysicalProductSaleAction(formData: FormData) {
  const { supabase, context } = await requireSeller();

  const clientId = clean(formData.get("clientId"), 60);
  const guestName = clean(formData.get("guestName"), 120);
  const variantId = clean(formData.get("variantId"), 60);
  const quantity = parseQuantity(clean(formData.get("quantity"), 20));
  const paymentMethod = clean(formData.get("paymentMethod"), 40);
  const externalReference = clean(formData.get("externalReference"), 180);
  const notes = clean(formData.get("notes"), 500);
  const discountTotal = parseMoney(
    clean(formData.get("discountTotal"), 40) || "0",
  );

  if (
    !isUuid(variantId) ||
    quantity == null ||
    discountTotal == null ||
    !PAYMENT_METHODS.has(paymentMethod)
  ) {
    errorRedirect("Choose a valid product, quantity, payment method, and discount.");
  }

  if (clientId && !isUuid(clientId)) {
    errorRedirect("Choose a valid client.");
  }

  if (!clientId && !guestName) {
    errorRedirect("Choose a client or enter a walk-in name.");
  }

  if (
    externalReference &&
    !/^[a-zA-Z0-9_:.#\-\s]{1,180}$/.test(externalReference)
  ) {
    errorRedirect("External reference contains invalid characters.");
  }

  const { data: orderId, error } = await supabase.rpc(
    "commerce_complete_manual_physical_sale",
    {
      p_studio_id: context.studioId,
      p_variant_id: variantId,
      p_quantity: quantity,
      p_client_id: clientId || null,
      p_guest_name: guestName || null,
      p_payment_method: paymentMethod,
      p_external_reference: externalReference || null,
      p_discount_total: discountTotal,
      p_notes: notes || null,
      p_actor_user_id: context.userId,
    },
  );

  if (error || !orderId) {
    errorRedirect(error?.message ?? "The product sale could not be completed.");
  }

  redirect(`/app/orders/${orderId}?success=order_completed`);
}

export async function startPhysicalProductTerminalSaleAction(formData: FormData) {
  const { supabase, context } = await requireSeller();

  const clientId = clean(formData.get("clientId"), 60);
  const guestName = clean(formData.get("guestName"), 120);
  const variantId = clean(formData.get("variantId"), 60);
  const quantity = parseQuantity(clean(formData.get("quantity"), 20));
  const notes = clean(formData.get("notes"), 500);
  const discountTotal = parseMoney(
    clean(formData.get("discountTotal"), 40) || "0",
  );

  if (!isUuid(variantId) || quantity == null || discountTotal == null) {
    errorRedirect("Choose a valid product, quantity, and discount.");
  }

  if (clientId && !isUuid(clientId)) {
    errorRedirect("Choose a valid client.");
  }

  if (!clientId && !guestName) {
    errorRedirect("Choose a client or enter a walk-in name.");
  }

  const { data: orderId, error } = await supabase.rpc(
    "commerce_create_pending_terminal_order",
    {
      p_studio_id: context.studioId,
      p_variant_id: variantId,
      p_quantity: quantity,
      p_client_id: clientId || null,
      p_guest_name: guestName || null,
      p_discount_total: discountTotal,
      p_notes: notes || null,
      p_actor_user_id: context.userId,
    },
  );

  if (error || !orderId) {
    errorRedirect(
      error?.message ?? "The card-reader order could not be prepared.",
    );
  }

  redirect(`/app/orders/${orderId}/terminal`);
}


export async function completeDigitalProductSaleAction(formData: FormData) {
  const { supabase, context } = await requireSeller();

  const clientId = clean(formData.get("clientId"), 60);
  const catalogItemId = clean(formData.get("catalogItemId"), 60);
  const paymentMethod = clean(formData.get("paymentMethod"), 40);
  const externalReference = clean(formData.get("externalReference"), 180);
  const notes = clean(formData.get("notes"), 500);

  if (
    !isUuid(clientId) ||
    !isUuid(catalogItemId) ||
    !PAYMENT_METHODS.has(paymentMethod)
  ) {
    errorRedirect("Choose a valid linked student, digital product, and payment method.");
  }

  const { data: orderId, error } = await supabase.rpc(
    "commerce_complete_manual_digital_sale",
    {
      p_studio_id: context.studioId,
      p_catalog_item_id: catalogItemId,
      p_client_id: clientId,
      p_payment_method: paymentMethod,
      p_external_reference: externalReference || null,
      p_notes: notes || null,
      p_actor_user_id: context.userId,
    },
  );

  if (error || !orderId) {
    redirect(
      `/app/sell?type=digital_product&error=${encodeURIComponent(
        error?.message ?? "The digital sale could not be completed.",
      )}`,
    );
  }

  redirect(`/app/orders/${orderId}?success=digital_access_granted`);
}
