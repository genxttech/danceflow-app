import { UnsubscribeConfirmation } from "../../UnsubscribeConfirmation";

// Marketing M-0: GET never unsubscribes (the previous page wrote on every page load, and its write never matched the
// suppression index, so organizer unsubscribes were not kept). The confirmation posts to /api/email/unsubscribe/[token].
export const dynamic = "force-dynamic";

export default async function OrganizerMarketingUnsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ done?: string; error?: string }>;
}) {
  const { token } = await params;
  const query = await searchParams;
  return <UnsubscribeConfirmation token={token} kind="organizer" done={query.done} error={query.error} />;
}
