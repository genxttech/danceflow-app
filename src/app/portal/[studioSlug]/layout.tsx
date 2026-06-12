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

  let portalClient: ClientRow | null = null;

  const { data: linkedClient, error: linkedClientError } = await supabase
    .from("clients")
    .select("id, first_name, last_name, email, is_independent_instructor")
    .eq("studio_id", studio.id)
    .eq("portal_user_id", user.id)
    .maybeSingle();

  if (linkedClientError) {
    throw linkedClientError;
  }

  if (linkedClient) {
    portalClient = linkedClient as ClientRow;
  } else if (user.email) {
    await ensurePortalProfileAndClientLinks({
      userId: user.id,
      email: user.email,
      fullName: getAuthUserFullName(user),
      studioId: studio.id,
    });

    const { data: repairedClient, error: repairedClientError } = await supabase
      .from("clients")
      .select("id, first_name, last_name, email, is_independent_instructor")
      .eq("studio_id", studio.id)
      .eq("portal_user_id", user.id)
      .maybeSingle();

    if (repairedClientError) {
      throw repairedClientError;
    }

    if (repairedClient) {
      portalClient = repairedClient as ClientRow;
    }
  }

  if (!portalClient) {
    redirect(buildPortalLoginPath(studioSlug, "portal-access-not-found"));
  }

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#f8fafc_0%,#ffffff_28%,#f8fafc_100%)]">
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}