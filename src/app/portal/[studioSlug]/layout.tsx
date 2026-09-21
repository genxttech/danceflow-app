import type { ReactNode } from "react";
import Image from "next/image";
import SkipToMainLink from "@/components/shell/SkipToMainLink";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ensurePortalProfileAndClientLinks, getAuthUserFullName } from "@/lib/auth/portal-linking";

type PortalStudioLayoutProps = {
  children: ReactNode;
  params: Promise<{
    studioSlug: string;
  }>;
};

type StudioRow = {
  id: string;
  slug: string;
  name: string;
  public_name: string | null;
  public_logo_url: string | null;
};

function buildPortalLoginPath(studioSlug: string, error?: string) {
  const search = new URLSearchParams({
    intent: "public",
    next: `/portal/${studioSlug}`,
  });

  if (error) {
    search.set("error", error);
  }

  return `/login?${search.toString()}`;
}

type ClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  is_independent_instructor: boolean | null;
};

export default async function PortalStudioLayout({
  children,
  params,
}: PortalStudioLayoutProps) {
  const { studioSlug } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(buildPortalLoginPath(studioSlug));
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, slug, name, public_name, public_logo_url")
    .eq("slug", studioSlug)
    .maybeSingle<StudioRow>();

  if (studioError || !studio) {
    redirect(buildPortalLoginPath(studioSlug, "portal-studio-not-found"));
  }

  const { data: linkedRelationships, error: relationshipError } = await supabase
    .from("client_account_links")
    .select("client_id")
    .eq("studio_id", studio.id)
    .eq("user_id", user.id)
    .eq("status", "linked")
    .limit(1);

  if (relationshipError) {
    throw relationshipError;
  }

  const portalClient = linkedRelationships?.[0] ?? null;

  if (!portalClient) {
    redirect(buildPortalLoginPath(studioSlug, "portal-access-not-found"));
  }

  const studioLabel = studio.public_name?.trim() || studio.name;
  const studioInitial = studioLabel.trim().charAt(0).toUpperCase() || "S";

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#f8fafc_0%,#ffffff_28%,#f8fafc_100%)]">
      <SkipToMainLink />
      <header className="border-b border-[var(--brand-border)] bg-[var(--brand-surface)]">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            {studio.public_logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={studio.public_logo_url}
                alt=""
                className="h-9 w-9 shrink-0 rounded-xl border border-[var(--brand-border)] bg-white object-contain p-0.5"
              />
            ) : (
              <span
                aria-hidden="true"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--brand-primary-soft)] text-base font-semibold text-[var(--brand-primary)]"
              >
                {studioInitial}
              </span>
            )}
            <p className="truncate text-base font-semibold text-[var(--brand-text)]">
              {studioLabel}
            </p>
          </div>

          <Image
            src="/brand/logo/danceflow-symbol-128.png"
            alt="DanceFlow"
            width={128}
            height={177}
            className="h-6 w-auto shrink-0"
          />
        </div>
      </header>

      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto max-w-6xl px-4 py-8 outline-none sm:px-6 lg:px-8"
      >
        {children}
      </main>
    </div>
  );
}