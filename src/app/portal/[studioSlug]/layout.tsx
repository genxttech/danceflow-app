import type { ReactNode } from "react";
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
    .select("id, slug")
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

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#f8fafc_0%,#ffffff_28%,#f8fafc_100%)]">
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}