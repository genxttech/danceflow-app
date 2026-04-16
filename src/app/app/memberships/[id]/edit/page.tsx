import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import EditMembershipPlanForm from "./EditMembershipPlanForm";

type Params = Promise<{
  id: string;
}>;

type MembershipPlan = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  billing_interval: string;
  price: number;
  signup_fee: number | null;
  auto_renew_default: boolean;
  visibility: string;
  sort_order: number;
};

type MembershipBenefit = {
  id: string;
  benefit_type: string;
  quantity: number | null;
  discount_percent: number | null;
  discount_amount: number | null;
  usage_period: string;
  applies_to: string | null;
};

export default async function EditMembershipPlanPage({
  params,
}: {
  params: Params;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  const studioId = context.studioId;

  const [
    { data: plan, error: planError },
    { data: benefits, error: benefitsError },
  ] = await Promise.all([
    supabase
      .from("membership_plans")
      .select(`
        id,
        name,
        description,
        active,
        billing_interval,
        price,
        signup_fee,
        auto_renew_default,
        visibility,
        sort_order
      `)
      .eq("id", id)
      .eq("studio_id", studioId)
      .single(),

    supabase
      .from("membership_plan_benefits")
      .select(`
        id,
        benefit_type,
        quantity,
        discount_percent,
        discount_amount,
        usage_period,
        applies_to
      `)
      .eq("membership_plan_id", id)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
  ]);

  if (planError || !plan) {
    notFound();
  }

  if (benefitsError) {
    throw new Error(`Failed to load benefits: ${benefitsError.message}`);
  }

  return (
    <EditMembershipPlanForm
      plan={plan as MembershipPlan}
      benefits={(benefits ?? []) as MembershipBenefit[]}
    />
  );
}