"use server";

import { redirect } from "next/navigation";
import { requirePackageSellAccess } from "@/lib/auth/serverRoleGuard";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAYMENT_METHODS = new Set(["card", "cash", "check", "ach", "venmo", "zelle", "other"]);
const PAYMENT_ACTIONS = new Set(["manual", "terminal"]);

function cleanText(value: string, maxLength = 500) {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .slice(0, maxLength);
}

function isUuid(value: string) {
  return UUID_PATTERN.test(value);
}

function isDateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? cleanText(value) : "";
}

function addDaysToDate(startDate: Date, days: number) {
  const result = new Date(startDate);
  result.setDate(result.getDate() + days);
  return result;
}

function parseCurrencyToDollars(rawValue: string) {
  const normalized = rawValue.replace(/[$,\s]/g, "");

  if (!normalized) {
    return null;
  }

  if (!/^\d+(\.\d{0,2})?$/.test(normalized)) {
    return null;
  }

  const [wholePart, decimalPart = ""] = normalized.split(".");
  const centsText = `${wholePart}${decimalPart.padEnd(2, "0").slice(0, 2)}`;
  const cents = Number.parseInt(centsText, 10);

  if (!Number.isFinite(cents) || cents < 0) {
    return null;
  }

  const dollars = cents / 100;
  if (dollars > 100000) {
    return null;
  }

  return dollars;
}

function roundCurrency(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function calculateLedgerBalance(
  entries: { direction: string | null; amount: number | string | null }[] | null
) {
  return roundCurrency(
    (entries ?? []).reduce((total, entry) => {
      const amount = Number(entry.amount ?? 0);

      if (!Number.isFinite(amount)) {
        return total;
      }

      return entry.direction === "credit" ? total + amount : total - amount;
    }, 0)
  );
}

export async function sellPackageToClientAction(
  prevState: { error: string },
  formData: FormData
) {
  let terminalPaymentId: string | null = null;

  try {
    const { supabase, user, studioId } = await requirePackageSellAccess();

    const clientId = getString(formData, "clientId");
    const packageTemplateId = getString(formData, "packageTemplateId");
    const purchaseDateRaw = getString(formData, "purchaseDate");
    const requestedPaymentAction = getString(formData, "paymentAction") || "manual";
    const paymentAction = PAYMENT_ACTIONS.has(requestedPaymentAction) ? requestedPaymentAction : "manual";
    const useTerminal = paymentAction === "terminal";
    const requestedPaymentMethod = useTerminal ? "card" : getString(formData, "paymentMethod");
    const paymentMethod = PAYMENT_METHODS.has(requestedPaymentMethod) ? requestedPaymentMethod : "";
    const amountPaidRaw =
      getString(formData, "paymentAmount") || getString(formData, "amountPaid");
    const accountCreditRaw = getString(formData, "accountCreditToApply");
    const notes = cleanText(getString(formData, "notes"), 1000);

    if ((clientId && !isUuid(clientId)) || (packageTemplateId && !isUuid(packageTemplateId))) {
      return { error: "Invalid client or package selection." };
    }

    if (purchaseDateRaw && !isDateOnly(purchaseDateRaw)) {
      return { error: "Purchase date is invalid." };
    }

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

    const amountPaid = parseCurrencyToDollars(amountPaidRaw);
    const accountCreditToApply = accountCreditRaw
      ? parseCurrencyToDollars(accountCreditRaw)
      : 0;

    if (amountPaid === null || amountPaid < 0) {
      return { error: "Amount paid must be a valid amount of $0 or greater." };
    }

    if (accountCreditToApply === null || accountCreditToApply < 0) {
      return { error: "Account credit must be a valid amount of $0 or greater." };
    }

    if (useTerminal && accountCreditToApply > 0) {
      return {
        error:
          "Account credit can currently be applied only to a completed manual package payment.",
      };
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

    const packagePrice = roundCurrency(Number(pkgTemplate.price ?? 0));
    const creditAmount = roundCurrency(accountCreditToApply ?? 0);
    const cashAmount = roundCurrency(amountPaid);

    if (creditAmount > packagePrice) {
      return { error: "Account credit cannot be greater than the package price." };
    }

    const collectedTotal = roundCurrency(creditAmount + cashAmount);

    if (collectedTotal > packagePrice) {
      return {
        error:
          "Payment amount plus account credit cannot be greater than the package price.",
      };
    }

    if (collectedTotal < packagePrice) {
      return {
        error:
          "The collected amount plus account credit must equal the package price. Create a payment arrangement before completing a partially paid sale.",
      };
    }

    if (creditAmount > 0) {
      const { data: ledgerEntries, error: ledgerError } = await supabase
        .from("client_account_ledger")
        .select("direction, amount")
        .eq("studio_id", studioId)
        .eq("client_id", clientId);

      if (ledgerError) {
        return {
          error: `Client account credit lookup failed: ${ledgerError.message}`,
        };
      }

      const availableCredit = calculateLedgerBalance(ledgerEntries);

      if (availableCredit <= 0) {
        return { error: "This client does not have available account credit." };
      }

      if (creditAmount > availableCredit) {
        return {
          error: `Account credit applied cannot exceed the client's available credit of $${availableCredit.toFixed(
            2
          )}.`,
        };
      }
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
        active: !useTerminal,
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

    const paymentNotes = [
      notes || null,
      creditAmount > 0
        ? `Account credit applied: $${creditAmount.toFixed(2)}.`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    const { data: payment, error: paymentError } = await supabase
      .from("payments")
      .insert({
        studio_id: studioId,
        client_id: clientId,
        client_package_id: clientPackage.id,
        amount: cashAmount,
        payment_method: paymentMethod,
        status: useTerminal ? "pending" : "paid",
        notes: [
          paymentNotes || null,
          useTerminal ? "Created for in-person card reader collection." : null,
        ]
          .filter(Boolean)
          .join("\n") || null,
        paid_at: useTerminal ? null : new Date().toISOString(),
        created_by: user.id,
        payment_type: "package_sale",
        fulfillment_type: useTerminal ? "activate_package" : null,
        source: useTerminal ? "stripe" : "manual",
        payment_channel: useTerminal ? "terminal" : "manual",
        currency: "usd",
      })
      .select("id")
      .single();

    if (paymentError) {
      return { error: `Payment creation failed: ${paymentError.message}` };
    }

    if (!payment) {
      return { error: "Payment creation failed: no payment was returned." };
    }

    if (useTerminal) {
      terminalPaymentId = payment.id;
    }

    if (!useTerminal && creditAmount > 0) {
      const { error: creditLedgerError } = await supabase
        .from("client_account_ledger")
        .insert({
          studio_id: studioId,
          client_id: clientId,
          entry_date: purchaseDateRaw,
          entry_type: "credit_applied",
          direction: "debit",
          amount: creditAmount,
          description: `Applied account credit to package purchase: ${pkgTemplate.name}`,
          reference_type: "client_package",
          reference_id: clientPackage.id,
          created_by: user.id,
        });

      if (creditLedgerError) {
        return {
          error: `Account credit application failed: ${creditLedgerError.message}`,
        };
      }
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

    const { error: transactionError } = useTerminal
      ? { error: null }
      : await supabase.from("lesson_transactions").insert({
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

  if (terminalPaymentId) {
    redirect(
      `/app/payments/terminal/${encodeURIComponent(terminalPaymentId)}?success=terminal_payment_ready`
    );
  }

  redirect("/app/packages/client-balances");
}

export async function sellSelectedPackageFromSellPageAction(formData: FormData) {
  const result = await sellPackageToClientAction({ error: "" }, formData);

  if (result?.error) {
    const packageTemplateId = getString(formData, "packageTemplateId");
    const clientId = getString(formData, "clientId");
    const q = getString(formData, "q");
    const params = new URLSearchParams();

    if (packageTemplateId) {
      params.set("template", packageTemplateId);
    }

    if (clientId) {
      params.set("client", clientId);
    }

    if (q) {
      params.set("q", q);
    }

    params.set("error", result.error);
    redirect(`/app/packages/sell?${params.toString()}`);
  }
}
