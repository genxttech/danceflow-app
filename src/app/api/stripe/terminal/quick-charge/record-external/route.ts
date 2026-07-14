import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentStudioContext } from "@/lib/auth/studio";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CATEGORY_LABELS: Record<string, string> = {
  group_class: "Group Class",
  social_party: "Social Party",
  practice_party: "Practice Party",
  floor_fee: "Floor Fee",
  private_lesson_ad_hoc: "Private Lesson",
  merchandise: "Merchandise",
  other: "Other",
};

function clean(value: unknown, maxLength = 500) {
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

function canRecordPayment(role: string | null | undefined, isPlatformAdmin: boolean) {
  if (isPlatformAdmin) return true;
  return ["studio_owner", "studio_admin", "front_desk"].includes(role ?? "");
}

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

function parseAmount(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100000) return null;
  return Math.round(parsed * 100) / 100;
}

async function getRequestJson(request: NextRequest) {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function POST(request: NextRequest) {
  try {
    const userSupabase = await createClient();
    const supabase = createAdminClient();

    const {
      data: { user },
      error: authError,
    } = await userSupabase.auth.getUser();

    if (authError || !user) {
      return jsonError("Please sign in before recording a payment.", 401);
    }

    const context = await getCurrentStudioContext();
    if (!context?.studioId) {
      return jsonError("No studio workspace is selected.", 400);
    }

    if (!canRecordPayment(context.studioRole, context.isPlatformAdmin)) {
      return jsonError("You do not have permission to record in-person payments.", 403);
    }

    const body = await getRequestJson(request);
    const category = clean(body.category, 80) || "other";
    const categoryLabel = CATEGORY_LABELS[category] ?? CATEGORY_LABELS.other;
    const amount = parseAmount(body.amount);
    const guestName = clean(body.guestName, 120) || null;
    const notes = clean(body.notes, 500) || null;
    const externalReference = clean(body.externalReference, 180) || null;

    if (externalReference && !/^[a-zA-Z0-9_:.#\-\s]{1,180}$/.test(externalReference)) {
      return jsonError("External reference contains invalid characters.");
    }

    if (!Object.keys(CATEGORY_LABELS).includes(category)) {
      return jsonError("Choose a valid quick charge category.");
    }

    if (amount == null || amount <= 0) {
      return jsonError("Enter a valid payment amount.");
    }

    if (externalReference) {
      const { data: existingPayment, error: existingPaymentError } = await supabase
        .from("payments")
        .select("id")
        .eq("studio_id", context.studioId)
        .eq("external_reference", externalReference)
        .eq("payment_channel", "manual")
        .limit(1)
        .maybeSingle<{ id: string }>();

      if (existingPaymentError) {
        return jsonError(`Could not check existing external payment references: ${existingPaymentError.message}`);
      }

      if (existingPayment) {
        return jsonError(
          "That external reference is already recorded. Use a different reference or review the existing payment before recording another one.",
          409
        );
      }
    }

    const { data: studio, error: studioError } = await supabase
      .from("studios")
      .select("id")
      .eq("id", context.studioId)
      .single();

    if (studioError || !studio) {
      return jsonError("Studio workspace could not be loaded.", 404);
    }

    const nowIso = new Date().toISOString();
    const noteParts = [
      `Recorded external card payment: ${categoryLabel}`,
      guestName ? `Guest: ${guestName}` : null,
      externalReference ? `External ref: ${externalReference}` : null,
      notes,
    ].filter(Boolean);

    const { data: payment, error: paymentInsertError } = await supabase
      .from("payments")
      .insert({
        studio_id: studio.id,
        client_id: null,
        amount,
        payment_method: "card",
        status: "paid",
        notes: noteParts.join(" | ") || null,
        paid_at: nowIso,
        created_by: user.id,
        payment_type: "other",
        source: "manual",
        payment_channel: "manual",
        currency: "usd",
        quick_charge_category: category,
        guest_name: guestName,
        external_reference: externalReference,
      })
      .select("id")
      .single();

    if (paymentInsertError || !payment) {
      return jsonError(`Payment record could not be created: ${paymentInsertError?.message ?? "Unknown error"}`);
    }

    return NextResponse.json({
      ok: true,
      paymentId: payment.id,
      status: "paid",
      amount,
      category,
      categoryLabel,
    });
  } catch (error) {
    console.error("External quick charge record failed", error);
    return jsonError(error instanceof Error ? error.message : "External card payment could not be recorded.", 500);
  }
}
