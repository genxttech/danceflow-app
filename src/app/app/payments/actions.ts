"use server";

import { redirect } from "next/navigation";
import { requireClientEditAccess } from "@/lib/auth/serverRoleGuard";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getReturnTo(formData: FormData, fallback: string, success: string) {
  const returnTo = getString(formData, "returnTo");
  if (!returnTo) return `${fallback}?success=${success}`;
  return `${returnTo}${returnTo.includes("?") ? "&" : "?"}success=${success}`;
}

function formatCurrency(value: number | null) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value ?? 0));
}

function getNumber(value: string) {
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function getFloorRentalDiscountNote(discountPercent: number | null, discountAmount: number | null) {
  if (discountPercent != null && discountPercent > 0) {
    return `Membership floor rental discount applied: ${discountPercent}% off`;
  }
  if (discountAmount != null && discountAmount > 0) {
    return `Membership floor rental discount applied: ${formatCurrency(discountAmount)} off`;
  }
  return null;
}

function applyDiscount(baseAmount: number, discountPercent: number | null, discountAmount: number | null) {
  if (discountPercent != null && discountPercent > 0) {
    return Math.max(0, Number((baseAmount - baseAmount * (discountPercent / 100)).toFixed(2)));
  }
  if (discountAmount != null && discountAmount > 0) {
    return Math.max(0, Number((baseAmount - discountAmount).toFixed(2)));
  }
  return baseAmount;
}

export async function createPaymentAction(
  prevState: { error: string },
  formData: FormData
) {
  try {
    const { supabase, studioId, user } = await requireClientEditAccess();

    const entryMode = getString(formData, "entryMode");
    const serviceType = getString(formData, "serviceType");
    const clientId = getString(formData, "clientId");
    const clientPackageId = getString(formData, "clientPackageId");
    const packageTemplateId = getString(formData, "packageTemplateId");
    const salePriceRaw = getString(formData, "salePrice");
    const amountRaw = getString(formData, "amount");
    const paymentMethod = getString(formData, "paymentMethod");
    const status = getString(formData, "status");
    const notes = getString(formData, "notes");

    if (!clientId) {
      return { error: "Client is required." };
    }

    let resolvedClientPackageId: string | null = clientPackageId || null;
    let paymentAmount = getNumber(amountRaw);
    let salePrice = getNumber(salePriceRaw);
    let discountNote: string | null = null;

    if (entryMode === "sell_package_and_pay") {
      if (!packageTemplateId) {
        return { error: "Package template is required." };
      }

      const { data: packageTemplate, error: packageTemplateError } = await supabase
        .from("package_templates")
        .select(`
          id,
          name,
          price,
          expiration_days
        `)
        .eq("id", packageTemplateId)
        .eq("studio_id", studioId)
        .single();

      if (packageTemplateError || !packageTemplate) {
        return { error: "Selected package template was not found." };
      }

      const { data: templateItems, error: templateItemsError } = await supabase
        .from("package_template_items")
        .select(`
          usage_type,
          quantity,
          is_unlimited
        `)
        .eq("studio_id", studioId)
        .eq("package_template_id", packageTemplateId);

      if (templateItemsError) {
        return { error: `Package template items failed to load: ${templateItemsError.message}` };
      }

      if (!templateItems || templateItems.length === 0) {
        return { error: "Selected package template has no items." };
      }

      const purchaseDate = new Date().toISOString().slice(0, 10);
      const expirationDate =
        packageTemplate.expiration_days != null
          ? new Date(
              Date.now() + Number(packageTemplate.expiration_days) * 24 * 60 * 60 * 1000
            )
              .toISOString()
              .slice(0, 10)
          : null;

      const resolvedSalePrice =
        salePrice != null && salePrice >= 0
          ? salePrice
          : Number(packageTemplate.price ?? 0);

      const { data: insertedPackage, error: packageInsertError } = await supabase
        .from("client_packages")
        .insert({
          studio_id: studioId,
          client_id: clientId,
          package_template_id: packageTemplate.id,
          name_snapshot: packageTemplate.name,
          purchase_date: purchaseDate,
          expiration_date: expirationDate,
          active: true,
          sold_price: resolvedSalePrice,
          created_by: user.id,
        })
        .select("id")
        .single();

      if (packageInsertError || !insertedPackage) {
        return {
          error: `Package sale failed: ${
            packageInsertError?.message ?? "Unable to create sold package."
          }`,
        };
      }

      const packageItemsPayload = templateItems.map((item) => ({
        studio_id: studioId,
        client_package_id: insertedPackage.id,
        usage_type: item.usage_type,
        quantity_total: item.is_unlimited ? null : item.quantity,
        quantity_used: 0,
        quantity_remaining: item.is_unlimited ? null : item.quantity,
        is_unlimited: item.is_unlimited,
      }));

      const { error: itemsError } = await supabase
        .from("client_package_items")
        .insert(packageItemsPayload);

      if (itemsError) {
        return {
          error: `Package item creation failed: ${itemsError.message}`,
        };
      }

      resolvedClientPackageId = insertedPackage.id;

      if (paymentAmount == null) {
        paymentAmount = resolvedSalePrice;
      }
    }

    if (paymentAmount == null || paymentAmount < 0) {
      return { error: "Payment amount must be a valid number." };
    }

    if (!paymentMethod) {
      return { error: "Payment method is required." };
    }

    if (!status) {
      return { error: "Payment status is required." };
    }

    if (serviceType === "floor_rental") {
      const { data: membership, error: membershipError } = await supabase
        .from("client_memberships")
        .select("id, membership_plan_id")
        .eq("studio_id", studioId)
        .eq("client_id", clientId)
        .eq("status", "active")
        .maybeSingle();

      if (membershipError) {
        return { error: `Membership lookup failed: ${membershipError.message}` };
      }

      if (membership) {
        const { data: discountBenefit, error: discountError } = await supabase
          .from("membership_plan_benefits")
          .select("discount_percent, discount_amount")
          .eq("membership_plan_id", membership.membership_plan_id)
          .eq("benefit_type", "floor_rental_discount_percent")
          .maybeSingle();

        if (discountError) {
          return { error: `Membership discount lookup failed: ${discountError.message}` };
        }

        if (discountBenefit) {
          paymentAmount = applyDiscount(
            paymentAmount,
            discountBenefit.discount_percent,
            discountBenefit.discount_amount
          );

          discountNote = getFloorRentalDiscountNote(
            discountBenefit.discount_percent,
            discountBenefit.discount_amount
          );
        }
      }
    }

    const finalNotes = [notes, discountNote].filter(Boolean).join(" | ") || null;

    const { error } = await supabase.from("payments").insert({
      studio_id: studioId,
      client_id: clientId,
      client_package_id: resolvedClientPackageId,
      amount: paymentAmount,
      payment_method: paymentMethod,
      status,
      notes: finalNotes,
    });

    if (error) {
      return { error: `Payment creation failed: ${error.message}` };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  redirect(getReturnTo(formData, "/app/payments", "payment_logged"));
}