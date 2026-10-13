import { UnsubscribeConfirmation } from "../../UnsubscribeConfirmation";

// Marketing M-0: GET never unsubscribes; the confirmation posts to /api/email/unsubscribe/[token]. Used by studio
// campaign links and by commercial ARIA / automation message links.
export const dynamic = "force-dynamic";

export default async function MarketingUnsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ done?: string; error?: string; unsubscribed?: string }>;
}) {
  const { token } = await params;
  const query = await searchParams;
  return <UnsubscribeConfirmation token={token} kind="studio" done={query.done ?? query.unsubscribed} error={query.error} />;
}
