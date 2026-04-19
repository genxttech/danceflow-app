import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUserPlatformRole } from "@/lib/auth/platform";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";

export default async function HomePage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const platformRole = await getCurrentUserPlatformRole();

    if (platformRole === "platform_admin") {
      redirect("/platform");
    }

    const { data: studioRole } = await supabase
      .from("user_studio_roles")
      .select("studio_id")
      .eq("user_id", user.id)
      .eq("active", true)
      .limit(1)
      .maybeSingle();

    if (studioRole) {
      redirect("/app");
    }

    redirect("/account");
  }

  return (
  <>
    <PublicSiteHeader currentPath="home" isAuthenticated={false} />
    <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_18%,#f8fafc_100%)]">
      {/* existing homepage content */}
    </main>
    <PublicSiteFooter />
  </>
);
}