import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStudioSmsStatus } from "@/lib/sms/onboarding/client";
import { attestLocationAction } from "./actions";

/**
 * TW-4F: "This location belongs to my existing business" (owner only, pilot studios only). Sends a request for review; DanceFlow verifies the
 * association before the location shares the business's texting registration, budget and prepaid credit.
 */
export default async function SmsLocationAttestationPage({ searchParams }: { searchParams?: Promise<Record<string, string | undefined>> }) {
  const query = (await searchParams) ?? {};
  const context = await getCurrentStudioContext();
  const supabase = await createClient();
  let role: string | null = null;
  try {
    const status = await getStudioSmsStatus(supabase, context.studioId);
    if (!status.available) redirect("/app/settings");
    role = status.role;
  } catch {
    redirect("/app/settings");
  }
  if (role !== "studio_owner") redirect("/app/settings/sms");

  return (
    <main className="mx-auto w-full max-w-2xl space-y-5 p-4">
      <Link href="/app/settings/sms" className="text-sm font-semibold text-violet-800 hover:underline">Back to Texting</Link>
      <section className="rounded-[1.5rem] border border-slate-200 bg-white p-5 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-950">Add this location to your existing business</h1>
        <p className="mt-2 text-sm text-slate-600">
          Use this when this studio is another location of a business that already has DanceFlow texting set up. The locations then share one texting
          registration, one setup budget and one prepaid balance. DanceFlow verifies the association before anything is linked.
        </p>
        {query.sent ? <p role="status" className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Request sent. DanceFlow will review it; nothing changes until it is approved.</p> : null}
        {query.error ? <p role="alert" className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800">{query.error}</p> : null}
        <form action={attestLocationAction} className="mt-4 space-y-3">
          <label className="block text-sm font-medium text-slate-800">Legal business name (exactly as registered)
            <input name="legalName" required minLength={2} maxLength={200} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="block text-sm font-medium text-slate-800">Last four digits of the business&apos;s EIN
            <input name="einLast4" required inputMode="numeric" pattern="[0-9]{4}" maxLength={4} className="mt-1 w-32 rounded-xl border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" name="attest" className="mt-1" />
            I am the owner of this studio and I confirm it is a location of this legal business, which I also own or am authorized to act for.
          </label>
          <button type="submit" className="rounded-xl bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800">Send for review</button>
        </form>
      </section>
    </main>
  );
}
