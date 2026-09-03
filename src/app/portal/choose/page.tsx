import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  decidePortalDestination,
  listLinkedPortalDestinations,
  PORTAL_SELECTED_STUDIO_COOKIE,
} from "@/lib/auth/portal-linking";
import { choosePortalDestinationAction } from "./actions";

export default async function ChoosePortalPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?intent=public&next=/portal/choose");
  }

  const destinations = await listLinkedPortalDestinations(user.id);
  const cookieStore = await cookies();
  const rememberedStudioId =
    cookieStore.get(PORTAL_SELECTED_STUDIO_COOKIE)?.value ?? null;
  const decision = decidePortalDestination(destinations, rememberedStudioId);

  // Defensive re-check: this page is only ever linked to when the redirect
  // logic already found genuine multi-studio ambiguity, but a stale
  // bookmark, a relationship change between requests, or a since-validated
  // remembered cookie can all mean that's no longer true by the time this
  // page actually renders -- so recompute from fresh data rather than
  // trusting why the caller thought this page was needed.
  if (decision.type === "none") {
    redirect("/account");
  }

  if (decision.type === "single") {
    redirect(decision.path);
  }

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#f8fafc_0%,#ffffff_28%,#f8fafc_100%)]">
      <main className="mx-auto max-w-2xl px-4 py-12 sm:px-6 lg:px-8">
        <h1 className="text-2xl font-semibold text-[var(--brand-text)]">
          Choose a studio
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          You&apos;re linked to more than one studio. Pick the one you&apos;d
          like to open.
        </p>

        <div className="mt-6 space-y-3">
          {decision.options.map((option) => (
            <form key={option.studioId} action={choosePortalDestinationAction}>
              <input type="hidden" name="studioId" value={option.studioId} />
              <button
                type="submit"
                className="flex w-full items-center justify-between rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-4 text-left shadow-sm transition hover:bg-[var(--brand-primary-soft)]"
              >
                <div>
                  <p className="font-medium text-[var(--brand-text)]">
                    {option.studioPublicName?.trim() ||
                      option.studioName ||
                      option.studioSlug}
                  </p>
                  {option.isIndependentInstructor ? (
                    <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-violet-600">
                      Instructor Portal
                    </p>
                  ) : null}
                </div>
              </button>
            </form>
          ))}
        </div>
      </main>
    </div>
  );
}
