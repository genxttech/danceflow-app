"use server";

import { redirect } from "next/navigation";
import { requireBalanceAdjustmentAccess } from "@/lib/auth/serverRoleGuard";
import { reconcileClientPackageLifecycle } from "@/lib/packages/lifecycle";
import { createAdminClient } from "@/lib/supabase/admin";

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
      .select("id, client_id, studio_id")
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

    // Package Refund P0, Slice 2c-2 (concurrency hardening): balance
    // computation, validation, the item update, and its lesson_transactions
    // ledger row now all happen atomically, under an item-row lock, inside
    // apply_package_balance_adjustment -- replacing what was previously a
    // separate, unlocked read-then-.update() followed by a separate ledger
    // insert. Same validation rules, same computed values, same ledger note
    // format; this is a concurrency fix, not a behavior change.
    const adminSupabase = createAdminClient();
    const { error: rpcError } = await adminSupabase.rpc("apply_package_balance_adjustment", {
      p_studio_id: studioId,
      p_client_package_id: clientPackageId,
      p_usage_type: usageType,
      p_adjustment_type: adjustmentType,
      p_quantity: quantity,
      p_notes: notes,
      p_created_by: user.id,
    });

    if (rpcError) {
      return { error: rpcError.message };
    }

    await reconcileClientPackageLifecycle({
      supabase,
      studioId,
      clientId: clientPackage.client_id,
      clientPackageId: clientPackage.id,
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  redirect("/app/packages/client-balances");
}