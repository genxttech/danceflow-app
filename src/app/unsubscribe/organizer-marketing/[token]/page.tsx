import Link from "next/link";
import { CheckCircle2, MailX } from "lucide-react";
import { createAdminClient } from "@/lib/supabase/admin";

type Params = Promise<{
  token: string;
}>;

function normalizeEmail(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export default async function OrganizerMarketingUnsubscribePage({
  params,
}: {
  params: Params;
}) {
  const { token } = await params;
  const supabase = createAdminClient();

  const { data: recipient, error } = await supabase
    .from("organizer_marketing_campaign_recipients")
    .select(
      "id, organizer_id, email, campaign_id, organizer_marketing_campaigns(name, subject)",
    )
    .eq("unsubscribe_token", token)
    .maybeSingle();

  if (error || !recipient) {
    return (
      <main className="min-h-screen bg-[#f8f5f2] px-4 py-12 text-[#241432]">
        <section className="mx-auto max-w-xl rounded-[32px] border border-slate-200 bg-white p-8 text-center shadow-sm">
          <MailX className="mx-auto h-10 w-10 text-slate-400" />
          <h1 className="mt-4 text-2xl font-semibold">
            Unsubscribe link not found
          </h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            This unsubscribe link may be invalid or expired. Contact the event
            organizer if you need help.
          </p>
          <Link
            href="/"
            className="mt-6 inline-flex rounded-2xl bg-[#4D1F47] px-5 py-3 text-sm font-semibold text-white"
          >
            Return to DanceFlow
          </Link>
        </section>
      </main>
    );
  }

  const email = normalizeEmail(recipient.email);

  if (email) {
    await supabase.from("organizer_marketing_unsubscribes").upsert(
      {
        organizer_id: recipient.organizer_id,
        email,
        reason: "recipient_unsubscribe_link",
        unsubscribed_at: new Date().toISOString(),
      },
      { onConflict: "organizer_id,email" },
    );

    await supabase
      .from("organizer_marketing_campaign_recipients")
      .update({
        status: "unsubscribed",
        error_message: "Recipient unsubscribed from organizer marketing",
      })
      .eq("id", recipient.id);
  }

  return (
    <main className="min-h-screen bg-[#f8f5f2] px-4 py-12 text-[#241432]">
      <section className="mx-auto max-w-xl rounded-[32px] border border-slate-200 bg-white p-8 text-center shadow-sm">
        <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600" />
        <h1 className="mt-4 text-2xl font-semibold">
          You have been unsubscribed
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          {email || "This email address"} will no longer receive marketing
          emails from this organizer through DanceFlow.
        </p>
        <p className="mt-3 text-xs leading-5 text-slate-500">
          You may still receive transactional emails for purchases,
          registrations, tickets, schedule changes, or account activity.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex rounded-2xl bg-[#4D1F47] px-5 py-3 text-sm font-semibold text-white"
        >
          Return to DanceFlow
        </Link>
      </section>
    </main>
  );
}
