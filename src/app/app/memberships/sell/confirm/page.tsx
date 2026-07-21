import { redirect } from "next/navigation";

type SearchParams = Promise<{
  clientId?: string;
  membershipPlanId?: string;
}>;

export default async function ConfirmMembershipSalePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();

  query.set("type", "membership");
  if (params.clientId) query.set("client", params.clientId);
  if (params.membershipPlanId) query.set("plan", params.membershipPlanId);
  query.set("error", "membership_confirm_removed_use_single_page_sale");

  redirect(`/app/sell?${query.toString()}`);
}
