"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUserStudioContext } from "@/lib/auth/serverRoleGuard";
import { getOwnerNumberOffers } from "@/lib/sms/provisioning/ownerRead";

/**
 * TW-4F J3: the studio owner's texting-number approval and its withdrawal. Owner only, through the owner's OWN session: the studio comes from the server-side
 * context, never from the form, and tw4_num_select_as_owner / tw4_num_withdraw_as_owner bind the actor to auth.uid() and re-check every rule under their locks
 * (published price, live offer on the active account, one open approval per location, number not taken). This layer adds no authority: it re-reads the owner's
 * offers first so a stale screen (changed price, replaced offer, reached pilot ceiling) is refused with a plain message instead of being sent. No Twilio call.
 */

export type NumberActionState = { ok?: boolean; error?: string; notice?: string };

const PATH = "/app/settings/sms";

const field = (formData: FormData, key: string) => {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
};

// database refusals in owner language (codes from tw4_num_select / tw4_num_withdraw, 20261208); anything else is generic and changes nothing
const REFUSED: Record<string, string> = {
  "42501": "Only the studio owner can approve a texting number.",
  TW008: "The price changed or is not published. Review the price and approve again.",
  TW040: "These number options expired. DanceFlow will offer new ones.",
  TW030: "The number step is not open for this setup.",
  TW032: "The number step opens once your campaign is approved.",
  TW022: "This location already has a texting number.",
  TW005: "Number options are not available right now. DanceFlow will follow up.",
  "23505": "That number is no longer available, or another approval is still open. Refresh the page and try again.",
  "22023": "That choice is no longer valid. Refresh the page and try again.",
};

async function ownerContext() {
  const ctx = await getCurrentUserStudioContext();
  if (ctx.studioRole !== "studio_owner") return null;
  return ctx;
}

export async function approveNumberAction(_previous: NumberActionState, formData: FormData): Promise<NumberActionState> {
  try {
    const ctx = await ownerContext();
    if (!ctx) return { ok: false, error: REFUSED["42501"] };
    const e164 = field(formData, "e164");
    const offerId = field(formData, "offer_id");
    const ackCents = Number(field(formData, "ack_price_cents"));
    if (field(formData, "confirm") !== "yes") return { ok: false, error: "Confirm that you approve the recurring monthly charge." };

    const offers = await getOwnerNumberOffers(ctx.supabase, ctx.studioId);
    if (!offers || !offers.stepOpen || !offers.offer) return { ok: false, error: "Number options are not available right now. Refresh the page." };
    if (offers.approval?.status === "open") return { ok: false, error: "You already approved a number. Withdraw that approval first to choose another." };
    if (offers.monthlyCents == null) return { ok: false, error: REFUSED.TW008 };
    if (offers.pilotCeilingReached || offers.blocker !== "none") return { ok: false, error: "This number cannot be approved right now. DanceFlow will follow up with you." };
    // the screen the owner approved must be the current one: same offer, same published price, a number that is still offered
    if (offerId !== offers.offer.offerId) return { ok: false, error: "The number options changed. Review them and approve again." };
    if (!Number.isInteger(ackCents) || ackCents !== offers.monthlyCents) return { ok: false, error: REFUSED.TW008 };
    if (!offers.offer.numbers.some((n) => n.e164 === e164)) return { ok: false, error: REFUSED["22023"] };

    const { error } = await ctx.supabase.rpc("tw4_num_select_as_owner", { p_studio_id: ctx.studioId, p_offer_id: offers.offer.offerId, p_e164: e164, p_ack_price_cents: offers.monthlyCents });
    if (error) return { ok: false, error: REFUSED[String(error.code ?? "")] ?? "Something went wrong. Nothing was approved." };
    revalidatePath(PATH);
    return { ok: true, notice: "Number approved. DanceFlow will secure it; nothing is complete until the provider confirms it." };
  } catch {
    return { ok: false, error: "Something went wrong. Nothing was approved." };
  }
}

export async function withdrawNumberAction(_previous: NumberActionState, formData: FormData): Promise<NumberActionState> {
  try {
    const ctx = await ownerContext();
    if (!ctx) return { ok: false, error: REFUSED["42501"] };
    const offers = await getOwnerNumberOffers(ctx.supabase, ctx.studioId);
    const selectionId = field(formData, "selection_id");
    // only the owner's own current approval of this studio is withdrawn here
    if (!offers?.approval || offers.approval.selectionId !== selectionId) return { ok: false, error: "That approval is no longer open. Refresh the page." };
    const { error } = await ctx.supabase.rpc("tw4_num_withdraw_as_owner", { p_studio_id: ctx.studioId, p_selection_id: offers.approval.selectionId, p_note: "withdrawn by the studio owner" });
    if (error) return { ok: false, error: error.code === "22023" ? "This number is already being secured and can no longer be withdrawn here. Contact DanceFlow." : REFUSED[String(error.code ?? "")] ?? "Something went wrong. Nothing was changed." };
    revalidatePath(PATH);
    return { ok: true, notice: "Your number approval was withdrawn. Nothing was charged." };
  } catch {
    return { ok: false, error: "Something went wrong. Nothing was changed." };
  }
}
