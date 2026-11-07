"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformStepUp, type AssuranceTier } from "@/lib/auth/platform-assurance";
import { PRICE_FLASH_COOKIE, PRICE_KINDS, PriceChangeStore } from "@/lib/sms/priceChange";
import { encodePanelFlash } from "@/lib/sms/twilioIsv/panelFlash";
import { usdToCents } from "@/lib/sms/pilotApprovalEvidence";

/**
 * D4-1: SMS price changes need TWO different platform administrators. Every action runs `requirePlatformStepUp()` FIRST (which runs `requirePlatformAdmin()` and then
 * demands the verified AAL2 session, plus a fresh authenticator code for a proposal or an approval), validates its inputs, and only then calls the database WITH THE
 * ADMINISTRATOR'S OWN SESSION (the user-scoped client: no service-role key, no actor argument, the identity is auth.uid()). The database checks that session again (aal2, a recent TOTP), the protected approver registry, refuses a requester approving their own proposal, and re-checks both
 * administrators, the expiry and the active price under locks. Database error text is never shown: SQLSTATEs map to fixed sentences. Nothing here calls Twilio or Stripe,
 * and a proposal changes no price; only the second administrator's approval publishes one.
 */

const RETURN_PATH = "/platform/sms";
const ANCHOR = "#price-changes";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Flash = { ok: boolean; message: string };
const fail = (message: string): Flash => ({ ok: false, message });
const done = (message: string): Flash => ({ ok: true, message });

const ERRORS: Record<string, string> = {
  "42501": "Not allowed. Only an active platform administrator can do this, and a price change can never be approved by the administrator who proposed it. Nothing changed.",
  "22023": "The database refused the input (check the kind, the amounts, the lengths, and that the proposal differs from the active price). Nothing changed.",
  TW041: "This is not allowed in the proposal's current state (another proposal for this price is still open, or this one is already decided). Nothing changed.",
  TW042: "Prices can only be changed by a proposal and a second administrator's approval. Nothing changed.",
  "23514": "The database refused the amounts. Nothing changed.",
  "42883": "This operation is not available in this environment yet. Nothing changed.",
  PGRST202: "This operation is not available in this environment yet. Nothing changed.",
};

function describeError(e: unknown): string {
  const code = e && typeof e === "object" ? String((e as { code?: unknown }).code ?? "") : "";
  return ERRORS[code] ?? "The action failed. Nothing changed; reload and check the current state before trying again.";
}

function field(form: FormData, name: string): string {
  return String(form.get(name) ?? "").trim();
}
function text(form: FormData, name: string, min: number, max: number): string | null {
  const v = field(form, name);
  return v.length >= min && v.length <= max ? v : null;
}
function id(form: FormData, name: string): string | null {
  const v = field(form, name);
  return UUID.test(v) ? v : null;
}

/** Back to the panel with the result. The text goes in a short-lived httpOnly cookie, never the URL (a crafted link cannot show a fake result). */
async function finish(result: Flash): Promise<never> {
  revalidatePath(RETURN_PATH);
  (await cookies()).set(PRICE_FLASH_COOKIE, encodePanelFlash(result), {
    httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: RETURN_PATH, maxAge: 60,
  });
  // redirect throws: it stays outside any try/catch
  redirect(`${RETURN_PATH}?${result.ok ? "price" : "price_error"}=1${ANCHOR}`);
}

async function guarded(tier: AssuranceTier, work: (admin: { id: string }) => Promise<Flash>): Promise<never> {
  const admin = await requirePlatformStepUp(tier);
  let result: Flash;
  try {
    result = await work(admin);
  } catch (e) {
    result = fail(describeError(e));
  }
  return finish(result);
}

const store = async () => new PriceChangeStore(await createClient());

export async function pricePropose(formData: FormData) {
  await guarded("recent", async (admin) => {
    const kind = field(formData, "kind");
    const customer = usdToCents(field(formData, "customerUsd"));
    const provider = usdToCents(field(formData, "providerUsd"));
    const description = text(formData, "description", 3, 200);
    const reason = text(formData, "reason", 10, 500);
    if (!PRICE_KINDS.includes(kind) || customer === null || customer <= 0 || provider === null || !description || !reason) {
      return fail("Choose a price kind, give the customer price (above zero) and DanceFlow's provider cost in dollars, a description (3 to 200 characters) and a written reason (10 to 500). Nothing changed.");
    }
    const out = await (await store()).propose({ kind, customerCents: customer, providerCents: provider, description, reason });
    return done(out.replayed
      ? "This identical proposal is already waiting for a second administrator. Nothing changed."
      : "Proposal recorded. A different platform administrator must approve it within 24 hours; no price has changed.");
  });
}

export async function priceApprove(formData: FormData) {
  await guarded("recent", async (admin) => {
    const requestId = id(formData, "requestId");
    const note = text(formData, "note", 10, 500);
    if (!requestId || !note) return fail("Give an approval note of 10 to 500 characters. Nothing changed.");
    const out = await (await store()).approve(requestId, note);
    if (out.status === "applied") return done(out.replayed ? "This proposal was already approved by you and is in effect." : "Approved. The new price is now the published price. Existing money movements are not changed.");
    if (out.status === "expired") return fail("The proposal had expired. No price changed.");
    if (out.status === "invalidated") return fail("The active price (or the proposer's standing) changed since the proposal, so it was invalidated. No price changed; make a new proposal.");
    return fail("The proposal was not approved. Reload and check its state.");
  });
}

export async function priceReject(formData: FormData) {
  await guarded("aal2", async (admin) => {
    const requestId = id(formData, "requestId");
    const note = text(formData, "note", 10, 500);
    if (!requestId || !note) return fail("Give a note of 10 to 500 characters. Nothing changed.");
    const out = await (await store()).reject(requestId, note);
    return done(out.withdrawn ? "Your proposal was withdrawn. No price changed." : "The proposal was rejected. No price changed.");
  });
}
