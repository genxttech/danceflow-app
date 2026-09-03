"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  listLinkedPortalDestinations,
  resolveDestinationForStudio,
  PORTAL_SELECTED_STUDIO_COOKIE,
} from "@/lib/auth/portal-linking";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function choosePortalDestinationAction(formData: FormData) {
  const studioId = getString(formData, "studioId");

  if (!studioId) {
    redirect("/portal/choose");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?intent=public&next=/portal/choose");
  }

  // H3: the posted studioId is client-controlled and must never be trusted
  // directly -- re-fetch this user's currently-linked destinations fresh
  // (scoped by the server-derived user.id, never the request) and only
  // accept the posted studioId if it's still present among them. The
  // representative client for that studio is always derived here via the
  // same deterministic tie-break used for automatic routing; a client-
  // supplied clientId is never read or trusted for this decision.
  const destinations = await listLinkedPortalDestinations(user.id);
  const destination = resolveDestinationForStudio(destinations, studioId);

  if (!destination) {
    redirect("/portal/choose");
  }

  const cookieStore = await cookies();
  cookieStore.set(PORTAL_SELECTED_STUDIO_COOKIE, destination.studioId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    // H3 review remediation: this is a routing preference remembered across
    // logins, not a session artifact -- every use is still revalidated
    // against freshly-fetched linked destinations (see
    // resolveDestinationForStudio/decidePortalDestination), so a long
    // lifetime here only ever saves a click, never grants access on its
    // own.
    maxAge: 60 * 60 * 24 * 180,
  });

  redirect(destination.path);
}
