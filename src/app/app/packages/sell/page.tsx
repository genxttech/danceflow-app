import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import SellPackageForm from "./SellPackageForm";
import { canSellPackages } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type ClientOption = {
  id: string;
  first_name: string;
  last_name: string;
  status: string;
};

type PackageTemplateOption = {
  id: string;
  name: string;
  price: number;
  active: boolean;
  package_template_items: {
    usage_type: string;
    quantity: number | null;
    is_unlimited: boolean;
  }[];
};

export default async function SellPackagePage() {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  const studioId = context.studioId;
  const role = context.studioRole ?? "";

  if (!canSellPackages(role)) {
    redirect("/app");
  }

  const [{ data: clients }, { data: packageTemplates }] = await Promise.all([
    supabase
      .from("clients")
      .select("id, first_name, last_name, status")
      .eq("studio_id", studioId)
      .neq("status", "archived")
      .order("first_name"),

    supabase
      .from("package_templates")
      .select(`
        id,
        name,
        price,
        active,
        package_template_items (
          usage_type,
          quantity,
          is_unlimited
        )
      `)
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("name"),
  ]);

  return (
    <SellPackageForm
      clients={(clients ?? []) as ClientOption[]}
      packageTemplates={(packageTemplates ?? []) as PackageTemplateOption[]}
    />
  );
}