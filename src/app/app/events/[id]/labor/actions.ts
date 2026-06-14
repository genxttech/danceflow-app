"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

const allowedPayTypes = new Set(["flat", "hourly", "per_session", "manual"]);
const allowedStatuses = new Set(["planned", "earned", "paid", "cancelled"]);

function cleanText(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function cleanOptionalText(value: FormDataEntryValue | null) {
  const cleaned = cleanText(value);
  return cleaned.length > 0 ? cleaned : null;
}

function cleanNumber(value: FormDataEntryValue | null, fallback = 0) {
  const parsed = Number(cleanText(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function canManageEventLabor(role: string | null | undefined, isPlatformAdmin: boolean) {
  if (isPlatformAdmin) return true;

  return role === "studio_owner" || role === "studio_admin" || role === "studio_manager";
}


async function assertEventSettlementIsEditable(supabase: Awaited<ReturnType<typeof createClient>>, eventId: string) {
  const { data, error } = await (supabase as any)
    .from("event_settlements")
    .select("status")
    .eq("event_id", eventId)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not verify event settlement lock: ${error.message}`);
  }

  if ((data?.status ?? "open") === "settled") {
    throw new Error("This event has been settled. Reopen the settlement before changing event labor costs.");
  }
}

function calculateTotal(params: {
  payType: string;
  rateAmount: number;
  hours: number;
  quantity: number;
  manualTotal: number;
}) {
  const { payType, rateAmount, hours, quantity, manualTotal } = params;

  if (manualTotal > 0) return manualTotal;
  if (payType === "hourly") return rateAmount * hours;
  if (payType === "per_session") return rateAmount * quantity;
  if (payType === "flat") return rateAmount;
  return manualTotal;
}

export async function createEventLaborCostAction(formData: FormData) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("You must be signed in to add event labor costs.");
  }

  const context = await getCurrentStudioContext();

  if (!context?.studioId) {
    throw new Error("No active workspace was found.");
  }

  if (!canManageEventLabor(context.studioRole, context.isPlatformAdmin)) {
    throw new Error("You do not have permission to add event labor costs.");
  }

  const eventId = cleanText(formData.get("event_id"));
  const staffName = cleanText(formData.get("staff_name"));
  const role = cleanText(formData.get("role"));
  const rawPayType = cleanText(formData.get("pay_type")) || "flat";
  const rawStatus = cleanText(formData.get("status")) || "planned";
  const laborDate = cleanText(formData.get("labor_date"));
  const notes = cleanOptionalText(formData.get("notes"));

  const payType = allowedPayTypes.has(rawPayType) ? rawPayType : "flat";
  const status = allowedStatuses.has(rawStatus) ? rawStatus : "planned";
  const rateAmount = Math.max(0, cleanNumber(formData.get("rate_amount")));
  const hours = Math.max(0, cleanNumber(formData.get("hours")));
  const quantity = Math.max(0, cleanNumber(formData.get("quantity"), 1));
  const manualTotal = Math.max(0, cleanNumber(formData.get("total_amount")));
  const totalAmount = calculateTotal({
    payType,
    rateAmount,
    hours,
    quantity,
    manualTotal,
  });

  if (!eventId) {
    throw new Error("Event ID is required.");
  }

  if (!staffName) {
    throw new Error("Staff name is required.");
  }

  if (!role) {
    throw new Error("Role is required.");
  }

  if (!laborDate) {
    throw new Error("Labor date is required.");
  }

  if (!Number.isFinite(totalAmount) || totalAmount < 0) {
    throw new Error("Total amount must be a valid number.");
  }

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("id, studio_id, organizer_id")
    .eq("id", eventId)
    .eq("studio_id", context.studioId)
    .maybeSingle();

  if (eventError) {
    throw new Error(`Could not verify event: ${eventError.message}`);
  }

  if (!event) {
    throw new Error("Event was not found in this workspace.");
  }

  await assertEventSettlementIsEditable(supabase, event.id);

  const { error } = await (supabase as any).from("event_labor_costs").insert({
    studio_id: event.studio_id,
    organizer_id: event.organizer_id,
    event_id: event.id,
    staff_name: staffName,
    role,
    pay_type: payType,
    rate_amount: rateAmount,
    hours,
    quantity,
    total_amount: totalAmount,
    currency: "USD",
    labor_date: laborDate,
    status,
    notes,
    created_by: user.id,
  });

  if (error) {
    throw new Error(`Could not add event labor cost: ${error.message}`);
  }

  revalidatePath(`/app/events/${eventId}`);
  revalidatePath("/app/reports");
}

export async function deleteEventLaborCostAction(formData: FormData) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("You must be signed in to delete event labor costs.");
  }

  const context = await getCurrentStudioContext();

  if (!context?.studioId) {
    throw new Error("No active workspace was found.");
  }

  if (!canManageEventLabor(context.studioRole, context.isPlatformAdmin)) {
    throw new Error("You do not have permission to delete event labor costs.");
  }

  const eventId = cleanText(formData.get("event_id"));
  const laborCostId = cleanText(formData.get("labor_cost_id"));

  if (!eventId || !laborCostId) {
    throw new Error("Event ID and labor cost ID are required.");
  }

  await assertEventSettlementIsEditable(supabase, eventId);

  const { error } = await (supabase as any)
    .from("event_labor_costs")
    .delete()
    .eq("id", laborCostId)
    .eq("event_id", eventId)
    .eq("studio_id", context.studioId);

  if (error) {
    throw new Error(`Could not delete event labor cost: ${error.message}`);
  }

  revalidatePath(`/app/events/${eventId}`);
  revalidatePath("/app/reports");
}
