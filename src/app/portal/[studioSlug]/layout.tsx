import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

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
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, slug")
    .eq("slug", studioSlug)
    .maybeSingle<StudioRow>();

  if (studioError || !studio) {
    redirect("/login");
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
    const { data: emailMatchedClient, error: emailMatchedClientError } = await supabase
      .from("clients")
      .select("id, first_name, last_name, email, is_independent_instructor")
      .eq("studio_id", studio.id)
      .eq("email", user.email)
      .eq("is_independent_instructor", true)
      .maybeSingle();

    if (emailMatchedClientError) {
      throw emailMatchedClientError;
    }

    if (emailMatchedClient) {
      const { error: linkError } = await supabase
        .from("clients")
        .update({ portal_user_id: user.id })
        .eq("id", emailMatchedClient.id)
        .eq("studio_id", studio.id);

      if (linkError) {
        throw linkError;
      }

      portalClient = emailMatchedClient as ClientRow;
    }
  }

  if (!portalClient) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#f8fafc_0%,#ffffff_28%,#f8fafc_100%)]">
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}