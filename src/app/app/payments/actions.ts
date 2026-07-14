"use server";

import { redirect } from "next/navigation";
import { requireClientEditAccess } from "@/lib/auth/serverRoleGuard";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAYMENT_METHODS = new Set(["card", "cash", "check", "ach", "venmo", "zelle", "other"]);
const PAYMENT_STATUSES = new Set(["pending", "paid", "processed", "complete", "completed", "failed", "refunded"]);
const PAYMENT_ACTIONS = new Set(["manual", "charge_now", "send_to_portal", "terminal"]);
const ENTRY_MODES = new Set(["standard", "sell_package_and_pay", "existing_package_payment"]);
const SERVICE_TYPES = new Set(["general", "floor_rental", "event_registration", "other"]);

function cleanText(value: string, maxLength = 1000) {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .slice(0, maxLength);
}

function getString(formData: FormData, key: string, maxLength = 1000) {
  const value = formData.get(key);
  return typeof value === "string" ? cleanText(value, maxLength) : "";
}

function isUuid(value: string) {
  return UUID_PATTERN.test(value);
}

function safeReturnPath(value: string, fallback: string) {
  const cleaned = cleanText(value, 400);
  if (!cleaned || !cleaned.startsWith("/") || cleaned.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(cleaned)) {
    return fallback;
  }
  return cleaned;
}

function isDateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function getReturnTo(formData: FormData, fallback: string, success: string) {
  const returnTo = safeReturnPath(getString(formData, "returnTo", 400), fallback);
  return `${returnTo}${returnTo.includes("?") ? "&" : "?"}success=${success}`;
}

function getCancelledReturnTo(formData: FormData, fallback: string) {
  const returnTo = safeReturnPath(getString(formData, "returnTo", 400), fallback);
  return `${returnTo}${returnTo.includes("?") ? "&" : "?"}error=payment_cancelled`;
}

function formatCurrency(value: number | null) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value ?? 0));
}

function getNumber(value: string) {
  const normalized = value.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100000) return null;
  return Math.round(parsed * 100) / 100;
}

function getDateValueFromIso(value: string) {
  return value.slice(0, 10);
}

function getPaymentDateIso(formData: FormData) {
  const rawPaymentDate = getString(formData, "paymentDate");

  if (!rawPaymentDate) {
    return new Date().toISOString();
  }

  if (!isDateOnly(rawPaymentDate)) {
    return new Date().toISOString();
  }

  const parsed = new Date(`${rawPaymentDate}T12:00:00`);

  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }

  return parsed.toISOString();
}

function isPaidLikeStatus(value: string) {
  return ["paid", "processed", "complete", "completed"].includes(value.toLowerCase());
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

function normalizePaymentAction(value: string) {
  if (PAYMENT_ACTIONS.has(value)) return value;
  return "manual";
}

function getPaymentType(entryMode: string, serviceType: string) {
  if (entryMode === "sell_package_and_pay" || entryMode === "existing_package_payment") {
    return "package_sale";
  }
  if (serviceType === "floor_rental") return "floor_rental";
  if (serviceType === "event_registration") return "event_registration";
  return "general";
}

export async function createPaymentAction(
  prevState: { error: string },
  formData: FormData
) {
  let checkoutRedirectUrl: string | null = null;

  try {
    const { supabase, studioId, user } = await requireClientEditAccess();

    const requestedEntryMode = getString(formData, "entryMode", 80) || "standard";
    const entryMode = ENTRY_MODES.has(requestedEntryMode) ? requestedEntryMode : "standard";
    const requestedServiceType = getString(formData, "serviceType", 80) || "general";
    const serviceType = SERVICE_TYPES.has(requestedServiceType) ? requestedServiceType : "general";
    const paymentAction = normalizePaymentAction(getString(formData, "paymentAction"));
    const clientId = getString(formData, "clientId");
    const clientPackageId = getString(formData, "clientPackageId");
    const packageTemplateId = getString(formData, "packageTemplateId");
    const salePriceRaw = getString(formData, "salePrice");
    const amountRaw = getString(formData, "amount");
    const paymentMethod =
      paymentAction === "manual"
        ? getString(formData, "paymentMethod", 40)
        : paymentAction === "terminal"
          ? "card"
          : "card";
    const requestedStatus = paymentAction === "manual" ? getString(formData, "status", 40) || "paid" : "pending";
    const status = PAYMENT_STATUSES.has(requestedStatus) ? requestedStatus : "paid";
    const notes = getString(formData, "notes", 1200);
    const accountCreditToApplyRaw = getString(formData, "accountCreditToApply");
    const accountCreditToApply = getNumber(accountCreditToApplyRaw || "0") ?? 0;
    const selectedPaymentDateIso = getPaymentDateIso(formData);

    if (
      accountCreditToApply > 0 &&
      (paymentAction !== "manual" || !isPaidLikeStatus(status))
    ) {
      return {
        error:
          "Account credit can currently be applied only when recording a completed manual payment.",
      };
    }

    if (!clientId) {
      return { error: "Client is required." };
    }

    if (!isUuid(clientId)) {
      return { error: "Invalid client selection." };
    }

    if ((clientPackageId && !isUuid(clientPackageId)) || (packageTemplateId && !isUuid(packageTemplateId))) {
      return { error: "Invalid package selection." };
    }

    if (paymentAction === "manual" && !PAYMENT_METHODS.has(paymentMethod)) {
      return { error: "Payment method is invalid." };
    }

    let resolvedClientPackageId: string | null = clientPackageId || null;
    let paymentAmount = getNumber(amountRaw);
    const salePrice = getNumber(salePriceRaw);
    let discountNote: string | null = null;
    let createdPackageName: string | null = null;
    let creditAppliedAmount = 0;

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

      const purchaseDate = getDateValueFromIso(selectedPaymentDateIso);
      const purchaseDateObject = new Date(`${purchaseDate}T12:00:00`);
      const expirationDate =
        packageTemplate.expiration_days != null
          ? new Date(
              purchaseDateObject.getTime() +
                Number(packageTemplate.expiration_days) * 24 * 60 * 60 * 1000
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
          active: paymentAction === "manual" && status === "paid",
          sold_price: resolvedSalePrice,
          price_snapshot: resolvedSalePrice,
          created_by: user.id,
        })
        .select("id, name_snapshot")
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
      createdPackageName = insertedPackage.name_snapshot;

      if (accountCreditToApply > 0) {
        if (accountCreditToApply > resolvedSalePrice) {
          return { error: "Account credit cannot be greater than the package sale price." };
        }

        const { data: clientLedger, error: clientLedgerError } = await supabase
          .from("client_account_ledger")
          .select("direction, amount")
          .eq("studio_id", studioId)
          .eq("client_id", clientId);

        if (clientLedgerError) {
          return { error: `Account credit lookup failed: ${clientLedgerError.message}` };
        }

        const availableCredit = (clientLedger ?? []).reduce((sum, entry) => {
          const amount = Number(entry.amount ?? 0);
          return entry.direction === "credit" ? sum + amount : sum - amount;
        }, 0);

        if (accountCreditToApply > Math.max(availableCredit, 0)) {
          return { error: "Account credit applied cannot exceed the client's available credit." };
        }

        creditAppliedAmount = Number(accountCreditToApply.toFixed(2));
      }

      if (paymentAmount == null) {
        paymentAmount = Math.max(0, Number((resolvedSalePrice - creditAppliedAmount).toFixed(2)));
      }
    } else if (accountCreditToApply > 0) {
      return { error: "Account credit can only be applied while selling a package from this form." };
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

    const paymentType = getPaymentType(entryMode, serviceType);
    const requestNote =
      paymentAction === "charge_now"
        ? "Created for Charge Now Stripe Checkout."
        : paymentAction === "send_to_portal"
          ? "Created as a client portal payment request."
          : paymentAction === "terminal"
            ? "Created for in-person card reader collection."
            : null;
    const finalNotes = [
      notes,
      discountNote,
      requestNote,
      createdPackageName ? `Package: ${createdPackageName}` : null,
      creditAppliedAmount > 0 ? `Account credit applied: ${formatCurrency(creditAppliedAmount)}` : null,
    ]
      .filter(Boolean)
      .join(" | ") || null;

    const { data: insertedPayment, error } = await supabase
      .from("payments")
      .insert({
        studio_id: studioId,
        client_id: clientId,
        client_package_id: resolvedClientPackageId,
        amount: paymentAmount,
        payment_method: paymentMethod,
        status,
        notes: finalNotes,
        paid_at: isPaidLikeStatus(status) ? selectedPaymentDateIso : null,
        created_by: user.id,
        payment_type: paymentType,
        fulfillment_type:
          paymentAction === "terminal" && entryMode === "sell_package_and_pay"
            ? "activate_package"
            : null,
        source: paymentAction === "manual" ? "manual" : "stripe",
        payment_channel:
          paymentAction === "terminal"
            ? "terminal"
            : paymentAction === "manual"
              ? "manual"
              : "online",
        currency: "usd",
      })
      .select("id")
      .single();

    if (error || !insertedPayment) {
      return { error: `Payment creation failed: ${error?.message ?? "Unable to create payment."}` };
    }

    if (creditAppliedAmount > 0 && resolvedClientPackageId) {
      const { error: ledgerInsertError } = await supabase
        .from("client_account_ledger")
        .insert({
          studio_id: studioId,
          client_id: clientId,
          entry_date: getDateValueFromIso(selectedPaymentDateIso),
          entry_type: "credit_applied",
          direction: "debit",
          amount: creditAppliedAmount,
          description: `Account credit applied to package sale${createdPackageName ? `: ${createdPackageName}` : ""}.`,
          reference_type: "client_package",
          reference_id: resolvedClientPackageId,
          created_by: user.id,
        });

      if (ledgerInsertError) {
        return { error: `Account credit application failed: ${ledgerInsertError.message}` };
      }
    }

    if (paymentAction === "charge_now") {
      const returnTo = getReturnTo(formData, "/app/payments", "payment_logged");
      const cancelTo = getCancelledReturnTo(formData, "/app/payments");
      checkoutRedirectUrl = `/api/stripe/client-checkout?paymentId=${encodeURIComponent(
        insertedPayment.id
      )}&returnTo=${encodeURIComponent(returnTo)}&cancelTo=${encodeURIComponent(cancelTo)}`;
    }

    if (paymentAction === "terminal") {
      checkoutRedirectUrl = `/app/payments/terminal/${encodeURIComponent(
        insertedPayment.id
      )}?success=terminal_payment_ready`;
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  if (checkoutRedirectUrl) {
    redirect(checkoutRedirectUrl);
  }

  redirect(getReturnTo(formData, "/app/payments", "payment_logged"));
}



