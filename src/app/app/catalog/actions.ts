"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canManageCommerce } from "@/lib/auth/permissions";

const ITEM_TYPES = new Set([
  "physical_product",
  "digital_video",
  "video_series",
  "digital_download",
  "service",
  "linked_package",
  "linked_membership",
  "linked_event_offer",
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function clean(value: FormDataEntryValue | null, max = 1000) {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
        .trim()
        .slice(0, max)
    : "";
}

function parseMoney(value: string) {
  const normalized = value.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 && amount <= 100000
    ? Math.round(amount * 100) / 100
    : null;
}

async function requireCommerceManager() {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (
    !context.studioId ||
    (!context.isPlatformAdmin && !canManageCommerce(context.studioRole))
  ) {
    redirect("/app");
  }

  return { supabase, context };
}

export async function createCatalogItemAction(formData: FormData) {
  const { supabase, context } = await requireCommerceManager();
  const name = clean(formData.get("name"), 160);
  const description = clean(formData.get("description"), 2000);
  const itemType = clean(formData.get("itemType"), 60);
  const sku = clean(formData.get("sku"), 80);
  const price = parseMoney(clean(formData.get("price"), 40));
  const taxable = formData.get("taxable") === "on";
  const published = formData.get("published") === "on";

  if (!name || !ITEM_TYPES.has(itemType) || price == null) {
    redirect("/app/catalog?error=invalid_catalog_item");
  }

  const { data: item, error } = await supabase
    .from("commerce_catalog_items")
    .insert({
      studio_id: context.studioId,
      name,
      description: description || null,
      item_type: itemType,
      sku: sku || null,
      price,
      currency: "usd",
      taxable,
      active: true,
      published,
      marketplace_visible: published,
      created_by: context.userId,
      updated_by: context.userId,
    })
    .select("id, item_type")
    .single();

  if (error || !item) {
    redirect(
      `/app/catalog?error=${encodeURIComponent(
        error?.message ?? "Catalog item could not be created.",
      )}`,
    );
  }

  revalidatePath("/app/catalog");

  if (item.item_type === "physical_product") {
    redirect(`/app/catalog/${item.id}?success=item_created`);
  }

  if (
    ["digital_video", "video_series", "digital_download"].includes(
      item.item_type,
    )
  ) {
    redirect(`/app/catalog/${item.id}/digital?success=item_created`);
  }

  redirect("/app/catalog?success=item_created");
}

export async function setCatalogItemActiveAction(formData: FormData) {
  const { supabase, context } = await requireCommerceManager();
  const itemId = clean(formData.get("itemId"), 60);
  const active = clean(formData.get("active"), 10) === "true";

  if (!UUID_PATTERN.test(itemId)) {
    redirect("/app/catalog?error=invalid_catalog_item");
  }

  const { error } = await supabase
    .from("commerce_catalog_items")
    .update({
      active,
      updated_by: context.userId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", itemId)
    .eq("studio_id", context.studioId);

  if (error) {
    redirect(`/app/catalog?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/app/catalog");
  redirect(`/app/catalog?success=${active ? "item_reactivated" : "item_archived"}`);
}


function getInteger(value: string, options?: { min?: number; max?: number }) {
  const parsed = Number.parseInt(value, 10);
  const min = options?.min ?? Number.MIN_SAFE_INTEGER;
  const max = options?.max ?? Number.MAX_SAFE_INTEGER;

  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : null;
}

function getOptionalMoney(value: string) {
  if (!value) return null;
  return parseMoney(value);
}

function safeCatalogReturn(itemId: string, success: string) {
  return `/app/catalog/${itemId}?success=${encodeURIComponent(success)}`;
}

export async function createProductVariantAction(formData: FormData) {
  const { supabase, context } = await requireCommerceManager();
  const catalogItemId = clean(formData.get("catalogItemId"), 60);
  const name = clean(formData.get("name"), 120);
  const sku = clean(formData.get("sku"), 80);
  const barcode = clean(formData.get("barcode"), 120);
  const size = clean(formData.get("size"), 80);
  const color = clean(formData.get("color"), 80);
  const reorderThreshold = getInteger(
    clean(formData.get("reorderThreshold"), 20) || "0",
    { min: 0, max: 100000 },
  );
  const unitCost = getOptionalMoney(clean(formData.get("unitCost"), 40));
  const priceOverride = getOptionalMoney(clean(formData.get("priceOverride"), 40));

  if (
    !UUID_PATTERN.test(catalogItemId) ||
    !name ||
    reorderThreshold == null
  ) {
    redirect(`/app/catalog/${catalogItemId}?error=invalid_variant`);
  }

  const { data: item, error: itemError } = await supabase
    .from("commerce_catalog_items")
    .select("id, item_type")
    .eq("id", catalogItemId)
    .eq("studio_id", context.studioId)
    .single();

  if (itemError || !item || item.item_type !== "physical_product") {
    redirect(`/app/catalog/${catalogItemId}?error=physical_item_not_found`);
  }

  const { error } = await supabase.from("commerce_product_variants").insert({
    studio_id: context.studioId,
    catalog_item_id: catalogItemId,
    name,
    sku: sku || null,
    barcode: barcode || null,
    size: size || null,
    color: color || null,
    unit_cost: unitCost,
    price_override: priceOverride,
    reorder_threshold: reorderThreshold,
    active: true,
    created_by: context.userId,
    updated_by: context.userId,
  });

  if (error) {
    redirect(
      `/app/catalog/${catalogItemId}?error=${encodeURIComponent(error.message)}`,
    );
  }

  revalidatePath("/app/catalog");
  revalidatePath(`/app/catalog/${catalogItemId}`);
  redirect(safeCatalogReturn(catalogItemId, "variant_created"));
}

export async function adjustInventoryAction(formData: FormData) {
  const { supabase, context } = await requireCommerceManager();
  const catalogItemId = clean(formData.get("catalogItemId"), 60);
  const variantId = clean(formData.get("variantId"), 60);
  const reason = clean(formData.get("reason"), 60);
  const notes = clean(formData.get("notes"), 500);
  const quantityDelta = getInteger(clean(formData.get("quantityDelta"), 20), {
    min: -100000,
    max: 100000,
  });

  const allowedReasons = new Set([
    "received",
    "sale",
    "return",
    "exchange",
    "damaged",
    "lost",
    "correction",
    "opening_balance",
  ]);

  if (
    !UUID_PATTERN.test(catalogItemId) ||
    !UUID_PATTERN.test(variantId) ||
    quantityDelta == null ||
    quantityDelta === 0 ||
    !allowedReasons.has(reason)
  ) {
    redirect(`/app/catalog/${catalogItemId}?error=invalid_inventory_adjustment`);
  }

  const { data: variant, error: variantError } = await supabase
    .from("commerce_product_variants")
    .select("id, catalog_item_id, active")
    .eq("id", variantId)
    .eq("catalog_item_id", catalogItemId)
    .eq("studio_id", context.studioId)
    .single();

  if (variantError || !variant) {
    redirect(`/app/catalog/${catalogItemId}?error=variant_not_found`);
  }

  const { error } = await supabase.rpc("commerce_adjust_inventory", {
    p_studio_id: context.studioId,
    p_catalog_item_id: catalogItemId,
    p_variant_id: variantId,
    p_quantity_delta: quantityDelta,
    p_reason: reason,
    p_notes: notes || null,
    p_actor_user_id: context.userId,
  });

  if (error) {
    redirect(
      `/app/catalog/${catalogItemId}?error=${encodeURIComponent(error.message)}`,
    );
  }

  revalidatePath("/app/catalog");
  revalidatePath(`/app/catalog/${catalogItemId}`);
  redirect(safeCatalogReturn(catalogItemId, "inventory_adjusted"));
}

export async function setProductVariantActiveAction(formData: FormData) {
  const { supabase, context } = await requireCommerceManager();
  const catalogItemId = clean(formData.get("catalogItemId"), 60);
  const variantId = clean(formData.get("variantId"), 60);
  const active = clean(formData.get("active"), 10) === "true";

  if (
    !UUID_PATTERN.test(catalogItemId) ||
    !UUID_PATTERN.test(variantId)
  ) {
    redirect(`/app/catalog/${catalogItemId}?error=invalid_variant`);
  }

  const { error } = await supabase
    .from("commerce_product_variants")
    .update({
      active,
      updated_by: context.userId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", variantId)
    .eq("catalog_item_id", catalogItemId)
    .eq("studio_id", context.studioId);

  if (error) {
    redirect(
      `/app/catalog/${catalogItemId}?error=${encodeURIComponent(error.message)}`,
    );
  }

  revalidatePath("/app/catalog");
  revalidatePath(`/app/catalog/${catalogItemId}`);
  redirect(
    safeCatalogReturn(
      catalogItemId,
      active ? "variant_reactivated" : "variant_archived",
    ),
  );
}
