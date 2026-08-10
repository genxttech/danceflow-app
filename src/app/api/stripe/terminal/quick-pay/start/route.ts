import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStripe } from "@/lib/payments/stripe";
import { startQuickCharge } from "@/lib/payments/terminal-quick-charge";

const CATEGORY_LABELS: Record<string, string> = {
  group_class: "Group Class",
  social_party: "Social Party",
  practice_party: "Practice Party",
  floor_fee: "Floor Fee",
  private_lesson_ad_hoc: "Private Lesson",
  merchandise: "Merchandise",
  other: "Other",
};

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function canCollectTerminal(role: string | null | undefined, isPlatformAdmin: boolean) {
  if (isPlatformAdmin) return true;
  return ["studio_owner", "studio_admin", "front_desk"].includes(role ?? "");
}

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

function parseAmount(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
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
    const stripe = getStripe();

    const {
      data: { user },
      error: authError,
    } = await userSupabase.auth.getUser();

    if (authError || !user) {
      return jsonError("Please sign in before collecting a payment.", 401);
    }

    const context = await getCurrentStudioContext();
    if (!context?.studioId) {
      return jsonError("No studio workspace is selected.", 400);
    }

    if (!canCollectTerminal(context.studioRole, context.isPlatformAdmin)) {
      return jsonError("You do not have permission to collect in-person payments.", 403);
    }

    const body = await getRequestJson(request);
    const category = clean(body.category) || "other";
    const amount = parseAmount(body.amount);
    const guestName = clean(body.guestName).slice(0, 120) || null;
    const notes = clean(body.notes).slice(0, 500) || null;
    const requestedReaderId = clean(body.readerId);
    const clientRequestId = clean(body.clientRequestId).slice(0, 64);

    if (!Object.keys(CATEGORY_LABELS).includes(category)) {
      return jsonError("Choose a valid quick charge category.");
    }

    if (amount == null || amount <= 0) {
      return jsonError("Enter a valid payment amount.");
    }

    const { data: studio, error: studioError } = await supabase
      .from("studios")
      .select("id, name, stripe_connected_account_id")
      .eq("id", context.studioId)
      .single();

    if (studioError || !studio) {
      return jsonError("Studio workspace could not be loaded.", 404);
    }

    const connectedAccountId = clean(studio.stripe_connected_account_id);
    if (!connectedAccountId) {
      return jsonError("Stripe is not connected for this studio.");
    }

    let readerQuery = supabase
      .from("stripe_terminal_readers")
      .select("id, terminal_location_id, stripe_reader_id, stripe_location_id, label, status, active")
      .eq("studio_id", studio.id)
      .eq("active", true);

    if (requestedReaderId) {
      readerQuery = readerQuery.eq("id", requestedReaderId);
    }

    const { data: readers, error: readerError } = await readerQuery
      .order("updated_at", { ascending: false })
      .limit(5);

    if (readerError) {
      return jsonError(`Reader lookup failed: ${readerError.message}`);
    }

    const reader = (readers ?? []).find((row) => row.status === "online") ?? (readers ?? [])[0] ?? null;

    if (!reader?.stripe_reader_id) {
      return jsonError("No active Stripe reader is available. Register or refresh a reader in Settings > Billing.");
    }

    const result = await startQuickCharge({
      supabase,
      stripe,
      studio: { id: studio.id, stripe_connected_account_id: connectedAccountId },
      reader: {
        id: reader.id,
        label: reader.label,
        terminal_location_id: reader.terminal_location_id,
        stripe_reader_id: reader.stripe_reader_id,
        stripe_location_id: reader.stripe_location_id,
      },
      userId: user.id,
      clientRequestId,
      idempotencyNamespace: "quick-pay",
      input: {
        kind: "ad_hoc",
        category,
        amount: Number(amount ?? 0),
        guestName,
        notes,
      },
    });

    if (!result.ok) {
      return jsonError(result.error, result.status);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("Quick charge start failed", error);
    return jsonError(error instanceof Error ? error.message : "Quick charge could not be started.", 500);
  }
}
