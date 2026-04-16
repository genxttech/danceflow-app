"use server";

import { redirect } from "next/navigation";
import { requirePackageManageAccess } from "@/lib/auth/serverRoleGuard";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getChecked(formData: FormData, key: string) {
  return formData.get(key) === "on";
}

type UsageType = "private_lesson" | "group_class" | "practice_party";

function extractPackageItems(formData: FormData) {
  const usageTypes: UsageType[] = [
    "private_lesson",
    "group_class",
    "practice_party",
  ];

  const items: {
    usage_type: UsageType;
    quantity: number | null;
    is_unlimited: boolean;
  }[] = [];

  for (const usageType of usageTypes) {
    const included = getChecked(formData, `${usageType}_included`);
    const unlimited = getChecked(formData, `${usageType}_unlimited`);
    const quantityRaw = getString(formData, `${usageType}_quantity`);

    if (!included) continue;

    if (unlimited) {
      items.push({
        usage_type: usageType,
        quantity: null,
        is_unlimited: true,
      });
      continue;
    }

    const quantity = Number.parseFloat(quantityRaw);

    if (Number.isNaN(quantity) || quantity < 0) {
      throw new Error(`Quantity for ${usageType} must be 0 or greater.`);
    }

    items.push({
      usage_type: usageType,
      quantity,
      is_unlimited: false,
    });
  }

  if (items.length === 0) {
    throw new Error("At least one package item must be included.");
  }

  return items;
}

function parseExpirationDays(expirationDaysRaw: string) {
  if (expirationDaysRaw === "") {
    return { value: null as number | null, error: null as string | null };
  }

  const parsed = Number.parseInt(expirationDaysRaw, 10);

  if (Number.isNaN(parsed) || parsed < 0) {
    return {
      value: null as number | null,
      error: "Expiration days must be 0 or greater.",
    };
  }

  return { value: parsed, error: null as string | null };
}

export async function createPackageTemplateAction(
  _prevState: { error: string },
  formData: FormData
) {
  try {
    const { supabase, studioId } = await requirePackageManageAccess();

    const name = getString(formData, "name");
    const description = getString(formData, "description");
    const priceRaw = getString(formData, "price");
    const expirationDaysRaw = getString(formData, "expirationDays");

    if (!name) {
      return { error: "Package name is required." };
    }

    const price = Number.parseFloat(priceRaw);

    if (Number.isNaN(price) || price < 0) {
      return { error: "Price must be 0 or greater." };
    }

    const { value: expirationDays, error: expirationError } =
      parseExpirationDays(expirationDaysRaw);

    if (expirationError) {
      return { error: expirationError };
    }

    let items;
    try {
      items = extractPackageItems(formData);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Invalid package items.",
      };
    }

    const { data: pkg, error: packageError } = await supabase
      .from("package_templates")
      .insert({
        studio_id: studioId,
        name,
        description: description || null,
        price,
        expiration_days: expirationDays,
        active: true,
      })
      .select("id")
      .single();

    if (packageError || !pkg) {
      return {
        error: `Package template creation failed: ${
          packageError?.message ?? "Unknown error"
        }`,
      };
    }

    const { error: itemsError } = await supabase
      .from("package_template_items")
      .insert(
        items.map((item) => ({
          studio_id: studioId,
          package_template_id: pkg.id,
          usage_type: item.usage_type,
          quantity: item.quantity,
          is_unlimited: item.is_unlimited,
        }))
      );

    if (itemsError) {
      return {
        error: `Package template items creation failed: ${itemsError.message}`,
      };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  redirect("/app/packages");
}

export async function updatePackageTemplateAction(
  _prevState: { error: string },
  formData: FormData
) {
  try {
    const { supabase, studioId } = await requirePackageManageAccess();

    const packageTemplateId = getString(formData, "packageTemplateId");
    const name = getString(formData, "name");
    const description = getString(formData, "description");
    const priceRaw = getString(formData, "price");
    const expirationDaysRaw = getString(formData, "expirationDays");
    const active = getString(formData, "active");

    if (!packageTemplateId) {
      return { error: "Missing package template ID." };
    }

    if (!name) {
      return { error: "Package name is required." };
    }

    const price = Number.parseFloat(priceRaw);

    if (Number.isNaN(price) || price < 0) {
      return { error: "Price must be 0 or greater." };
    }

    const { value: expirationDays, error: expirationError } =
      parseExpirationDays(expirationDaysRaw);

    if (expirationError) {
      return { error: expirationError };
    }

    let items;
    try {
      items = extractPackageItems(formData);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Invalid package items.",
      };
    }

    const { error: packageError } = await supabase
      .from("package_templates")
      .update({
        name,
        description: description || null,
        price,
        expiration_days: expirationDays,
        active: active === "true",
      })
      .eq("id", packageTemplateId)
      .eq("studio_id", studioId);

    if (packageError) {
      return {
        error: `Package template update failed: ${packageError.message}`,
      };
    }

    const { error: deleteItemsError } = await supabase
      .from("package_template_items")
      .delete()
      .eq("package_template_id", packageTemplateId)
      .eq("studio_id", studioId);

    if (deleteItemsError) {
      return {
        error: `Old package template items cleanup failed: ${deleteItemsError.message}`,
      };
    }

    const { error: insertItemsError } = await supabase
      .from("package_template_items")
      .insert(
        items.map((item) => ({
          studio_id: studioId,
          package_template_id: packageTemplateId,
          usage_type: item.usage_type,
          quantity: item.quantity,
          is_unlimited: item.is_unlimited,
        }))
      );

    if (insertItemsError) {
      return {
        error: `Package template items update failed: ${insertItemsError.message}`,
      };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  redirect("/app/packages");
}

export async function deactivatePackageTemplateAction(formData: FormData) {
  const { supabase, studioId } = await requirePackageManageAccess();

  const packageTemplateId = getString(formData, "packageTemplateId");

  if (!packageTemplateId) {
    throw new Error("Missing package template ID.");
  }

  const { error } = await supabase
    .from("package_templates")
    .update({ active: false })
    .eq("id", packageTemplateId)
    .eq("studio_id", studioId);

  if (error) {
    throw new Error(`Deactivate package template failed: ${error.message}`);
  }

  redirect("/app/packages");
}