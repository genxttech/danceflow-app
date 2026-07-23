import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, Package2, ShoppingBag, Users, WalletCards } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  canManagePackages,
  canSellCommerce,
  canTakePayments,
} from "@/lib/auth/permissions";
import UnifiedSalesForm from "./UnifiedSalesForm";

type SearchParams = Promise<{
  type?: string;
  error?: string;
  success?: string;
}>;

type ClientRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  status: string | null;
};

type PackageTemplateRow = {
  id: string;
  name: string;
  price: number;
  active: boolean;
  expiration_days: number | null;
  package_template_items:
    | {
        usage_type: string;
        quantity: number | null;
        is_unlimited: boolean;
      }[]
    | null;
};

type LedgerRow = {
  client_id: string;
  direction: string | null;
  amount: number | string | null;
};

type MembershipPlanRow = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  billing_interval: string;
  price: number;
  signup_fee: number | null;
  auto_renew_default: boolean | null;
  visibility: string | null;
};

type MembershipBenefitRow = {
  id: string;
  membership_plan_id: string;
  benefit_type: string;
  quantity: number | null;
  discount_percent: number | null;
  discount_amount: number | null;
  usage_period: string | null;
  applies_to: string | null;
};

type ExistingMembershipRow = {
  id: string;
  client_id: string;
  status: string;
  name_snapshot: string | null;
};


type ReaderRow = {
  id: string;
  label: string | null;
  status: string | null;
  device_type: string | null;
  active: boolean | null;
};


type DigitalProductRow = {
  id: string;
  name: string;
  item_type: string;
  price: number | string;
  commerce_digital_content:
    | {
        summary: string | null;
        skill_level: string | null;
        dance_style: string | null;
        status: string;
      }
    | {
        summary: string | null;
        skill_level: string | null;
        dance_style: string | null;
        status: string;
      }[]
    | null;
};

type PhysicalVariantRow = {
  id: string;
  catalog_item_id: string;
  name: string;
  sku: string | null;
  size: string | null;
  color: string | null;
  price_override: number | string | null;
  quantity_on_hand: number | null;
  commerce_catalog_items:
    | {
        id: string;
        name: string;
        price: number | string;
        taxable: boolean;
        active: boolean;
        published: boolean;
      }
    | {
        id: string;
        name: string;
        price: number | string;
        taxable: boolean;
        active: boolean;
        published: boolean;
      }[]
    | null;
};

function canSellMemberships(role: string | null | undefined, isPlatformAdmin: boolean) {
  if (isPlatformAdmin) return true;
  return role === "studio_owner" || role === "studio_admin" || role === "front_desk";
}

function roundCurrency(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function calculateClientBalances(rows: LedgerRow[]) {
  return rows.reduce<Record<string, number>>((map, row) => {
    const amount = Number(row.amount ?? 0);
    if (!row.client_id || !Number.isFinite(amount)) return map;

    map[row.client_id] = roundCurrency(
      (map[row.client_id] ?? 0) + (row.direction === "credit" ? amount : -amount)
    );

    return map;
  }, {});
}

function messageFromCode(code: string | undefined) {
  if (!code) return null;
  const normalized = decodeURIComponent(code);
  const known: Record<string, string> = {
    missing_client: "Choose a client before completing the sale.",
    invalid_client: "The selected client ID is invalid. Please select the client again.",
    missing_package: "Choose a package before completing the sale.",
    missing_sale_selection: "Choose a client and product before completing the sale.",
    missing_plan: "Choose a membership plan before completing the sale.",
    invalid_plan: "The selected membership plan ID is invalid. Please select the plan again.",
    missing_start: "Choose a membership start date.",
    client_not_found: "The selected client could not be found.",
    plan_not_found: "The selected membership plan could not be found.",
    plan_inactive: "This membership plan is inactive.",
    active_membership_exists: "This client already has an active or pending membership.",
    recurring_consent_required: "Recurring billing consent is required for card reader enrollment.",
    terminal_membership_amount_required: "Card reader enrollment requires a positive first payment amount.",
    membership_confirm_removed_use_single_page_sale: "Use the unified sales page to complete membership sales.",
    membership_payment_method_saved: "Payment method saved.",
    membership_subscription_created: "Membership subscription created.",
    membership_assigned: "Membership assigned.",
  };
  return known[normalized] ?? normalized.replaceAll("_", " ");
}

export default async function NewSalePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const initialType =
    params.type === "membership"
      ? "membership"
      : params.type === "quick_charge"
        ? "quick_charge"
        : params.type === "physical_product"
          ? "physical_product"
          : params.type === "digital_product"
            ? "digital_product"
            : "package";
  const error = messageFromCode(params.error);
  const success = messageFromCode(params.success);

  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const role = context.studioRole ?? "";
  const canSellPackages = canManagePackages(role) || context.isPlatformAdmin;
  const membershipAllowed = canSellMemberships(
    context.studioRole,
    context.isPlatformAdmin,
  );
  const quickChargeAllowed =
    canTakePayments(context.studioRole) || context.isPlatformAdmin;
  const commerceAllowed =
    canSellCommerce(context.studioRole) || context.isPlatformAdmin;

  if (!commerceAllowed || (!canSellPackages && !membershipAllowed && !quickChargeAllowed)) {
    redirect("/app");
  }

  const studioId = context.studioId;

  const [
    packageTemplatesResult,
    clientsResult,
    ledgerResult,
    plansResult,
    existingResult,
    readersResult,
    physicalVariantsResult,
    digitalProductsResult,
  ] = await Promise.all([
    supabase
      .from("package_templates")
      .select(`
        id,
        name,
        price,
        active,
        expiration_days,
        package_template_items (
          usage_type,
          quantity,
          is_unlimited
        )
      `)
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("name", { ascending: true }),
    supabase
      .from("clients")
      .select("id, first_name, last_name, email, phone, status")
      .eq("studio_id", studioId)
      .in("status", ["active", "lead", "inactive"])
      .order("first_name", { ascending: true })
      .limit(300),
    supabase
      .from("client_account_ledger")
      .select("client_id, direction, amount")
      .eq("studio_id", studioId),
    supabase
      .from("membership_plans")
      .select("id, name, description, active, billing_interval, price, signup_fee, auto_renew_default, visibility")
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true }),
    supabase
      .from("client_memberships")
      .select("id, client_id, status, name_snapshot")
      .eq("studio_id", studioId)
      .in("status", ["active", "pending", "past_due", "unpaid"]),
    supabase
      .from("stripe_terminal_readers")
      .select("id, label, status, device_type, active")
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("updated_at", { ascending: false }),
    supabase
      .from("commerce_product_variant_inventory")
      .select(
        "id, catalog_item_id, name, sku, size, color, price_override, quantity_on_hand, commerce_catalog_items(id, name, price, taxable, active, published)",
      )
      .eq("studio_id", studioId)
      .eq("active", true)
      .gt("quantity_on_hand", 0)
      .order("name", { ascending: true }),
    supabase
      .from("commerce_catalog_items")
      .select(
        "id, name, item_type, price, commerce_digital_content(summary, skill_level, dance_style, status)",
      )
      .eq("studio_id", studioId)
      .eq("active", true)
      .eq("published", true)
      .in("item_type", [
        "digital_video",
        "video_series",
        "digital_download",
      ])
      .order("name", { ascending: true }),
  ]);

  if (packageTemplatesResult.error) {
    throw new Error(`Failed to load package templates: ${packageTemplatesResult.error.message}`);
  }

  if (clientsResult.error) {
    throw new Error(`Failed to load clients: ${clientsResult.error.message}`);
  }

  if (ledgerResult.error) {
    throw new Error(`Failed to load client account credits: ${ledgerResult.error.message}`);
  }

  if (plansResult.error) {
    throw new Error(`Failed to load membership plans: ${plansResult.error.message}`);
  }

  if (existingResult.error) {
    throw new Error(`Failed to load existing memberships: ${existingResult.error.message}`);
  }

  if (readersResult.error) {
    throw new Error(`Failed to load Stripe readers: ${readersResult.error.message}`);
  }

  if (physicalVariantsResult.error) {
    throw new Error(
      `Failed to load physical products: ${physicalVariantsResult.error.message}`,
    );
  }

  if (digitalProductsResult.error) {
    throw new Error(
      `Failed to load digital products: ${digitalProductsResult.error.message}`,
    );
  }

  const packageTemplates = (packageTemplatesResult.data ?? []) as PackageTemplateRow[];
  const clients = (clientsResult.data ?? []) as ClientRow[];
  const clientAccountBalances = calculateClientBalances((ledgerResult.data ?? []) as LedgerRow[]);
  const membershipPlans = (plansResult.data ?? []) as MembershipPlanRow[];
  const readers = (readersResult.data ?? []) as ReaderRow[];
  const physicalVariantRows = (physicalVariantsResult.data ??
    []) as PhysicalVariantRow[];
  const digitalProductRows = (digitalProductsResult.data ??
    []) as DigitalProductRow[];
  const digitalProducts = digitalProductRows.flatMap((product) => {
    const content = Array.isArray(product.commerce_digital_content)
      ? product.commerce_digital_content[0]
      : product.commerce_digital_content;

    if (!content || content.status !== "published") return [];

    return [
      {
        catalogItemId: product.id,
        name: product.name,
        itemType: product.item_type,
        price: Number(product.price ?? 0),
        summary: content.summary,
        skillLevel: content.skill_level,
        danceStyle: content.dance_style,
      },
    ];
  });

  const physicalProducts = physicalVariantRows.flatMap((variant) => {
    const catalogItem = Array.isArray(variant.commerce_catalog_items)
      ? variant.commerce_catalog_items[0]
      : variant.commerce_catalog_items;

    if (!catalogItem?.active) return [];

    return [
      {
        catalogItemId: catalogItem.id,
        catalogName: catalogItem.name,
        variantId: variant.id,
        variantName: variant.name,
        sku: variant.sku,
        size: variant.size,
        color: variant.color,
        unitPrice: Number(variant.price_override ?? catalogItem.price ?? 0),
        quantityOnHand: Number(variant.quantity_on_hand ?? 0),
        taxable: Boolean(catalogItem.taxable),
      },
    ];
  });
  const planIds = membershipPlans.map((plan) => plan.id);

  const benefitsResult = planIds.length
    ? await supabase
        .from("membership_plan_benefits")
        .select("id, membership_plan_id, benefit_type, quantity, discount_percent, discount_amount, usage_period, applies_to")
        .in("membership_plan_id", planIds)
        .order("sort_order", { ascending: true })
    : { data: [], error: null };

  if (benefitsResult.error) {
    throw new Error(`Failed to load membership benefits: ${benefitsResult.error.message}`);
  }

  const membershipBenefitsByPlanId = ((benefitsResult.data ?? []) as MembershipBenefitRow[]).reduce<
    Record<string, MembershipBenefitRow[]>
  >((map, benefit) => {
    map[benefit.membership_plan_id] = [...(map[benefit.membership_plan_id] ?? []), benefit];
    return map;
  }, {});

  const existingMembershipsByClientId = ((existingResult.data ?? []) as ExistingMembershipRow[]).reduce<
    Record<string, ExistingMembershipRow>
  >((map, membership) => {
    if (!map[membership.client_id]) map[membership.client_id] = membership;
    return map;
  }, {});

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Commerce
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Sell
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Sell packages, memberships, physical products, digital content,
                and fast front-desk charges from one guided workspace.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/app/orders"
                className="inline-flex items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                <ArrowLeft className="h-4 w-4" />
                Orders
              </Link>
              <Link
                href="/app/packages/client-balances"
                className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
              >
                Client Balances
              </Link>
            </div>
          </div>
        </div>
      </section>

      {error ? (
        <div className="rounded-3xl border border-rose-200 bg-rose-50 p-5 text-sm font-medium text-rose-800">
          {error}
        </div>
      ) : null}

      {success ? (
        <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-5 text-sm font-medium text-emerald-800">
          {success}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-slate-500">Selectable Clients</p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">{clients.length}</p>
            </div>
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <Users className="h-5 w-5" />
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-slate-500">Active Packages</p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">{packageTemplates.length}</p>
            </div>
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <Package2 className="h-5 w-5" />
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-slate-500">Active Memberships</p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">{membershipPlans.length}</p>
            </div>
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <WalletCards className="h-5 w-5" />
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-slate-500">Online Readers</p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">
                {readers.filter((reader) => reader.status === "online").length}
              </p>
            </div>
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <ShoppingBag className="h-5 w-5" />
            </div>
          </div>
        </div>
      </div>

      <UnifiedSalesForm
        initialType={initialType}
        canSellPackages={canSellPackages}
        canSellMemberships={membershipAllowed}
        canQuickCharge={quickChargeAllowed}
        canSellPhysicalProducts={commerceAllowed}
        readers={readers}
        physicalProducts={physicalProducts}
        digitalProducts={digitalProducts}
        clients={clients.map((client) => ({
          ...client,
          status: client.status ?? "active",
          account_balance: clientAccountBalances[client.id] ?? 0,
        }))}
        packageTemplates={packageTemplates.map((template) => ({
          ...template,
          package_template_items: template.package_template_items ?? [],
        }))}
        clientAccountBalances={clientAccountBalances}
        membershipPlans={membershipPlans}
        membershipBenefitsByPlanId={membershipBenefitsByPlanId}
        existingMembershipsByClientId={existingMembershipsByClientId}
      />
    </div>
  );
}