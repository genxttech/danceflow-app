"use server";

import { redirect } from "next/navigation";
import { requireBalanceAdjustmentAccess } from "@/lib/auth/serverRoleGuard";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function createBalanceAdjustmentAction(
  prevState: { error: string },
  formData: FormData
) {
  try {
    const { supabase, studioId, user } = await requireBalanceAdjustmentAccess();

    const clientPackageId = getString(formData, "clientPackageId");
    const usageType = getString(formData, "usageType");
    const adjustmentType = getString(formData, "adjustmentType");
    const quantityRaw = getString(formData, "quantity");
    const notes = getString(formData, "notes");

    if (!clientPackageId || !usageType || !adjustmentType || !quantityRaw || !notes) {
      return {
        error:
          "Package, usage type, adjustment type, quantity, and reason are required.",
      };
    }

    const quantity = Number.parseFloat(quantityRaw);

    if (Number.isNaN(quantity) || quantity <= 0) {
      return { error: "Quantity must be greater than 0." };
    }

    if (!["add", "remove"].includes(adjustmentType)) {
      return { error: "Invalid adjustment type." };
    }

    const { data: clientPackage, error: clientPackageError } = await supabase
      .from("client_packages")
      .select("id, client_id, studio_id, name_snapshot")
      .eq("id", clientPackageId)
      .eq("studio_id", studioId)
      .single();

    if (clientPackageError || !clientPackage) {
      return {
        error: `Client package lookup failed: ${
          clientPackageError?.message ?? "Package not found"
        }`,
      };
    }

    const { data: item, error: itemError } = await supabase
      .from("client_package_items")
      .select(`
        id,
        usage_type,
        quantity_total,
        quantity_used,
        quantity_remaining,
        is_unlimited
      `)
      .eq("client_package_id", clientPackageId)
      .eq("studio_id", studioId)
      .eq("usage_type", usageType)
      .single();

    if (itemError || !item) {
      return {
        error: `Package item lookup failed: ${itemError?.message ?? "Package item not found"}`,
      };
    }

    if (item.is_unlimited) {
      return {
        error: "Unlimited package items cannot be adjusted with quantity changes.",
      };
    }

    const delta = adjustmentType === "add" ? quantity : -quantity;
    const currentRemaining = Number(item.quantity_remaining ?? 0);
    const currentTotal = Number(item.quantity_total ?? 0);
    const currentUsed = Number(item.quantity_used ?? 0);

    const nextRemaining = currentRemaining + delta;
    const nextTotal = currentTotal + delta;

    if (nextRemaining < 0) {
      return { error: "This adjustment would make the remaining balance negative." };
    }

    if (nextTotal < 0) {
      return { error: "This adjustment would make the total balance negative." };
    }

    let nextUsed = currentUsed;

    if (nextUsed > nextTotal) {
      nextUsed = nextTotal;
    }

    const { error: updateError } = await supabase
      .from("client_package_items")
      .update({
        quantity_total: nextTotal,
        quantity_used: nextUsed,
        quantity_remaining: nextRemaining,
      })
      .eq("id", item.id)
      .eq("studio_id", studioId);

    if (updateError) {
      return { error: `Balance update failed: ${updateError.message}` };
    }

    const transactionType =
      adjustmentType === "add" ? "manual_credit" : "manual_debit";

    const { error: transactionError } = await supabase
      .from("lesson_transactions")
      .insert({
        studio_id: studioId,
        client_id: clientPackage.client_id,
        client_package_id: clientPackage.id,
        transaction_type: transactionType,
        lessons_delta: delta,
        balance_after: nextRemaining,
        notes: `[${usageType}] ${notes}`,
        created_by: user.id,
      });

    if (transactionError) {
      return {
        error: `Audit entry creation failed: ${transactionError.message}`,
      };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  redirect("/app/packages/client-balances");
}