"use server";

import { redirect } from "next/navigation";
import { requirePackageSellAccess } from "@/lib/auth/serverRoleGuard";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function addDaysToDate(startDate: Date, days: number) {
  const result = new Date(startDate);
  result.setDate(result.getDate() + days);
  return result;
}

export async function sellPackageToClientAction(
  prevState: { error: string },
  formData: FormData
) {
  try {
    const { supabase, user, studioId } = await requirePackageSellAccess();

    const clientId = getString(formData, "clientId");
    const packageTemplateId = getString(formData, "packageTemplateId");
    const purchaseDateRaw = getString(formData, "purchaseDate");
    const paymentMethod = getString(formData, "paymentMethod");
    const amountPaidRaw = getString(formData, "amountPaid");
    const notes = getString(formData, "notes");

    if (
      !clientId ||
      !packageTemplateId ||
      !purchaseDateRaw ||
      !paymentMethod ||
      !amountPaidRaw
    ) {
      return {
        error:
          "Client, package, purchase date, payment method, and amount paid are required.",
      };
    }

    const amountPaid = Number.parseFloat(amountPaidRaw);

    if (Number.isNaN(amountPaid) || amountPaid < 0) {
      return { error: "Amount paid must be 0 or greater." };
    }

    const { data: pkgTemplate, error: pkgTemplateError } = await supabase
      .from("package_templates")
      .select("id, name, price, expiration_days, active")
      .eq("id", packageTemplateId)
      .eq("studio_id", studioId)
      .eq("active", true)
      .single();

    if (pkgTemplateError || !pkgTemplate) {
      return {
        error: `Package template lookup failed: ${
          pkgTemplateError?.message ?? "Package not found"
        }`,
      };
    }

    const { data: templateItems, error: templateItemsError } = await supabase
      .from("package_template_items")
      .select("usage_type, quantity, is_unlimited")
      .eq("package_template_id", packageTemplateId)
      .eq("studio_id", studioId);

    if (templateItemsError) {
      return {
        error: `Package template items lookup failed: ${templateItemsError.message}`,
      };
    }

    if (!templateItems || templateItems.length === 0) {
      return { error: "This package template has no included items." };
    }

    const purchaseDate = new Date(`${purchaseDateRaw}T00:00:00`);
    if (Number.isNaN(purchaseDate.getTime())) {
      return { error: "Purchase date is invalid." };
    }

    let expirationDate: string | null = null;
    if (
      pkgTemplate.expiration_days !== null &&
      pkgTemplate.expiration_days !== undefined
    ) {
      expirationDate = addDaysToDate(purchaseDate, pkgTemplate.expiration_days)
        .toISOString()
        .slice(0, 10);
    }

    const { data: clientPackage, error: clientPackageError } = await supabase
      .from("client_packages")
      .insert({
        studio_id: studioId,
        client_id: clientId,
        package_template_id: pkgTemplate.id,
        name_snapshot: pkgTemplate.name,
        price_snapshot: pkgTemplate.price,
        purchase_date: purchaseDateRaw,
        expiration_date: expirationDate,
        active: true,
      })
      .select("id")
      .single();

    if (clientPackageError || !clientPackage) {
      return {
        error: `Client package creation failed: ${
          clientPackageError?.message ?? "Unknown error"
        }`,
      };
    }

    const packageItemRows = templateItems.map((item) => ({
      studio_id: studioId,
      client_package_id: clientPackage.id,
      usage_type: item.usage_type,
      quantity_total: item.is_unlimited ? null : item.quantity,
      quantity_used: 0,
      quantity_remaining: item.is_unlimited ? null : item.quantity,
      is_unlimited: item.is_unlimited,
    }));

    const { error: clientPackageItemsError } = await supabase
      .from("client_package_items")
      .insert(packageItemRows);

    if (clientPackageItemsError) {
      return {
        error: `Client package items creation failed: ${clientPackageItemsError.message}`,
      };
    }

    const { error: paymentError } = await supabase.from("payments").insert({
      studio_id: studioId,
      client_id: clientId,
      client_package_id: clientPackage.id,
      amount: amountPaid,
      payment_method: paymentMethod,
      status: "paid",
      notes: notes || null,
      created_by: user.id,
    });

    if (paymentError) {
      return { error: `Payment creation failed: ${paymentError.message}` };
    }

    const summary = templateItems
      .map((item) => {
        const label =
          item.usage_type === "private_lesson"
            ? "Private"
            : item.usage_type === "group_class"
            ? "Group"
            : "Practice";

        return item.is_unlimited
          ? `${label}: Unlimited`
          : `${label}: ${item.quantity}`;
      })
      .join(" | ");

    const { error: transactionError } = await supabase
      .from("lesson_transactions")
      .insert({
        studio_id: studioId,
        client_id: clientId,
        client_package_id: clientPackage.id,
        transaction_type: "package_purchase",
        lessons_delta: null,
        balance_after: null,
        notes: `Package purchased: ${pkgTemplate.name} (${summary})`,
        created_by: user.id,
      });

    if (transactionError) {
      return {
        error: `Lesson transaction creation failed: ${transactionError.message}`,
      };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  redirect("/app/packages/client-balances");
}