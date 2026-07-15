import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canManageSettings } from "@/lib/auth/permissions";
import AccountantForm from "./AccountantForm";

export default async function AccountantSettingsPage({ searchParams }: { searchParams: Promise<{ success?: string }> }) {
  const context = await getCurrentStudioContext();
  if (!canManageSettings(context.studioRole ?? "")) redirect("/app");

  const supabase = await createClient();
  const { data: profile, error } = await supabase
    .from("studio_accountant_profiles")
    .select("accountant_name,firm_name,email,phone,preferred_cadence,preferred_export_types,internal_notes,authorized_to_receive_exports,authorization_granted_at,active")
    .eq("studio_id", context.studioId)
    .maybeSingle();

  if (error) {
    console.error("Failed to load accountant profile", { studioId: context.studioId, error });
    throw new Error("Accountant details could not be loaded.");
  }
  const query = await searchParams;

  return <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
    <div className="overflow-hidden rounded-xl border bg-white shadow-sm">
      <div className="bg-[#2D0B45] p-6 text-white"><p className="text-sm font-semibold uppercase tracking-[0.22em] text-white/75">Accounting settings</p><h1 className="mt-2 text-3xl font-semibold">Accountant and export preferences</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-white/85">Keep a verified destination and clear instructions for payroll and accounting handoff. Nothing is sent automatically from this page.</p></div>
      <div className="flex flex-wrap items-center justify-between gap-3 p-5"><p className="text-sm text-slate-600">Studio owner and admin access only.</p><Link href="/app/settings" className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Back to settings</Link></div>
    </div>
    {query.success === "saved" ? <p className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">Accountant details saved.</p> : null}
    <AccountantForm profile={profile} />
  </div>;
}
