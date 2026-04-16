import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { canAdjustBalances } from "@/lib/auth/permissions";
import BalanceAdjustmentForm from "./BalanceAdjustmentForm";

type ClientPackageOption = {
  id: string;
  name_snapshot: string;
  clients:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
  client_package_items: {
    id: string;
    usage_type: string;
    quantity_total: number | null;
    quantity_used: number;
    quantity_remaining: number | null;
    is_unlimited: boolean;
  }[];
};

export default async function PackageAdjustmentsPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: roleRow } = await supabase
    .from("user_studio_roles")
    .select("studio_id, role")
    .eq("user_id", user.id)
    .eq("active", true)
    .limit(1)
    .single();

  if (!roleRow) {
    redirect("/login");
  }

  if (!canAdjustBalances(roleRow.role)) {
    redirect("/app");
  }

  const { data, error } = await supabase
    .from("client_packages")
    .select(`
      id,
      name_snapshot,
      clients (
        first_name,
        last_name
      ),
      client_package_items (
        id,
        usage_type,
        quantity_total,
        quantity_used,
        quantity_remaining,
        is_unlimited
      )
    `)
    .eq("studio_id", roleRow.studio_id)
    .eq("active", true)
    .order("purchase_date", { ascending: false });

  if (error) {
    throw new Error(`Failed to load client packages: ${error.message}`);
  }

  return <BalanceAdjustmentForm clientPackages={(data ?? []) as ClientPackageOption[]} />;
}