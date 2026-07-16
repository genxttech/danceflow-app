import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashAccountantDeliveryToken } from "@/lib/accountant-deliveries/tokens";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    noarchive: true,
    nosnippet: true,
  },
  referrer: "no-referrer",
};

const labels: Record<string, string> = {
  profit_loss: "Profit & loss",
  accounting_ledger: "Accounting ledger",
  payments_refunds: "Payments and refunds",
  expenses: "Expenses",
  event_profitability: "Event profitability",
};

function isValidDeliveryToken(token: string) {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

function maskEmail(value: string | null | undefined) {
  if (!value) return "the authorized accountant";

  const [localPart, domain] = value.split("@");
  if (!localPart || !domain) return "the authorized accountant";

  const visibleLocal =
    localPart.length <= 2
      ? `${localPart.slice(0, 1)}*`
      : `${localPart.slice(0, 2)}${"*".repeat(Math.min(localPart.length - 2, 6))}`;

  return `${visibleLocal}@${domain}`;
}

export default async function AccountantDeliveryPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  if (!isValidDeliveryToken(token)) {
    notFound();
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("studio_accountant_deliveries")
    .select(
      "id,recipient_email,report_types,report_range,status,expires_at,studios(name)",
    )
    .eq("token_hash", hashAccountantDeliveryToken(token))
    .maybeSingle();

  const expired =
    !data?.expires_at || new Date(data.expires_at).getTime() <= Date.now();
  const accessibleStatus = data?.status === "queued" || data?.status === "sent";

  if (error || !data || expired || !accessibleStatus) {
    notFound();
  }

  const studio = Array.isArray(data.studios)
    ? data.studios[0]
    : data.studios;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wider text-violet-700">
          Secure accounting package
        </p>
        <h1 className="mt-2 text-3xl font-semibold">
          {studio?.name ?? "DanceFlow studio"} reports
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Prepared for {maskEmail(data.recipient_email)}. This private link expires{" "}
          {new Date(data.expires_at).toLocaleString()}.
        </p>

        <div className="mt-6 space-y-3">
          {(data.report_types ?? []).map((type: string) => (
            <a
              key={type}
              href={`/accountant-delivery/${token}/download/${type}`}
              rel="noreferrer"
              className="block rounded-xl border px-4 py-3 font-semibold text-violet-700 hover:bg-violet-50"
            >
              Download {labels[type] ?? "report"}
            </a>
          ))}
        </div>

        <p className="mt-6 text-xs text-slate-500">
          Do not forward this link. Contact the studio if access should be revoked
          or extended.
        </p>
      </div>
    </main>
  );
}
