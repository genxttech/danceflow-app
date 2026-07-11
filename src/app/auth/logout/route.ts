import { createClient } from "@/lib/supabase/server";
import { getTrustedSiteOrigin } from "@/lib/security/redirects";
import { NextResponse } from "next/server";

export async function POST() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login", getTrustedSiteOrigin()));
}
