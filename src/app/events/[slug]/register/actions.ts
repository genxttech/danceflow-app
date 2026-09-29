"use server";

import { redirect } from "next/navigation";
import { normalizeRequiredSlug, rawFormString } from "@/lib/validation/forms";

/**
 * PAY-DC-2D (N1): the legacy single-registration flow is retired.
 *
 * It inserted event_registrations / event_registration_attendees rows and
 * wrote Stripe checkout ids through the anonymous user-scoped client, which
 * depended on the public INSERT policies that let any caller create a
 * "confirmed" ticket with a chosen ticket code. Those policies are dropped and
 * public registration is created only by the server-side cart checkout
 * (service role). These entry points now write nothing and direct callers to
 * the supported registration flow.
 */

type ActionState = {
  error: string;
  success: string;
};

// "use server" modules may only export async functions, so the code stays local.
// An existing register-page banner code ("Checkout could not start ... review
// your selections and try again") sends the buyer into the supported flow.
const REGISTRATION_FLOW_RETIRED_CODE = "cart_checkout_failed";

const REGISTRATION_FLOW_RETIRED_MESSAGE =
  "Please choose your tickets on the event registration page to register.";

export async function createEventRegistrationAction(
  prevState: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  // The signature is kept for existing callers; nothing is read or written.
  void prevState;
  void formData;
  return { error: REGISTRATION_FLOW_RETIRED_MESSAGE, success: "" };
}

export async function retryEventRegistrationCheckoutAction(formData: FormData) {
  const eventSlugResult = normalizeRequiredSlug(rawFormString(formData, "eventSlug"), "Event");
  const eventSlug = eventSlugResult.ok ? eventSlugResult.value : "";

  if (!eventSlug) {
    redirect("/events");
  }

  redirect(
    `/events/${encodeURIComponent(eventSlug)}/register?error=${REGISTRATION_FLOW_RETIRED_CODE}`,
  );
}
