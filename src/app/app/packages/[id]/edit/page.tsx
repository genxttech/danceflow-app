import { createClient } from "@/lib/supabase/server";
import { notFound, redirect } from "next/navigation";
import PackageTemplateEditForm from "./PackageTemplateEditForm";
import { canManagePackages } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type PackageTemplateEditRow = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  expiration_days: number | null;
  active: boolean;
  package_template_items: {
    id: string;
    usage_type: string;
    quantity: number | null;
    is_unlimited: boolean;
  }[];
};

export default async function EditPackageTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  const studioId = context.studioId;
  const role = context.studioRole ?? "";

  if (!canManagePackages(role)) {
    redirect("/app");
  }

  const { data, error } = await supabase
    .from("package_templates")
    .select(`
      id,
      name,
      description,
      price,
      expiration_days,
      active,
      package_template_items (
        id,
        usage_type,
        quantity,
        is_unlimited
      )
    `)
    .eq("id", id)
    .eq("studio_id", studioId)
    .single();

  if (error || !data) {
    notFound();
  }

  return <PackageTemplateEditForm pkg={data as PackageTemplateEditRow} />;
}