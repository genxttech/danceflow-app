"use client";

import { useMemo, useState } from "react";
import { Film, Package2, ShoppingBag, Sparkles, WalletCards, Zap } from "lucide-react";
import SellPackageForm from "@/app/app/packages/sell/SellPackageForm";
import SellMembershipForm from "@/app/app/memberships/sell/SellMembershipForm";
import QuickChargeClient from "@/app/app/payments/quick-charge/QuickChargeClient";
import PhysicalProductSaleForm from "./PhysicalProductSaleForm";
import DigitalProductSaleForm from "./DigitalProductSaleForm";

type SaleType = "package" | "membership" | "quick_charge" | "physical_product" | "digital_product";



type ReaderOption = {
  id: string;
  label: string | null;
  status: string | null;
  device_type: string | null;
};



type DigitalProductOption = {
  catalogItemId: string;
  name: string;
  itemType: string;
  price: number;
  summary: string | null;
  skillLevel: string | null;
  danceStyle: string | null;
};

type PhysicalProductOption = {
  catalogItemId: string;
  catalogName: string;
  variantId: string;
  variantName: string;
  sku: string | null;
  size: string | null;
  color: string | null;
  unitPrice: number;
  quantityOnHand: number;
  taxable: boolean;
};

type ClientOption = {
  id: string;
  first_name: string;
  last_name: string;
  email?: string | null;
  phone?: string | null;
  status: string | null;
  account_balance?: number | string | null;
};

type PackageTemplateOption = {
  id: string;
  name: string;
  price: number;
  active: boolean;
  expiration_days?: number | null;
  package_template_items: {
    usage_type: string;
    quantity: number | null;
    is_unlimited: boolean;
  }[];
};

type MembershipPlanOption = {
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

type MembershipBenefitOption = {
  id: string;
  membership_plan_id: string;
  benefit_type: string;
  quantity: number | null;
  discount_percent: number | null;
  discount_amount: number | null;
  usage_period: string | null;
  applies_to: string | null;
};

type ExistingMembership = {
  id: string;
  client_id: string;
  status: string;
  name_snapshot: string | null;
};

export default function UnifiedSalesForm({
  initialType,
  canSellPackages,
  canSellMemberships,
  canQuickCharge,
  canSellPhysicalProducts,
  readers,
  physicalProducts,
  digitalProducts,
  clients,
  packageTemplates,
  clientAccountBalances,
  membershipPlans,
  membershipBenefitsByPlanId,
  existingMembershipsByClientId,
}: {
  initialType: SaleType;
  canSellPackages: boolean;
  canSellMemberships: boolean;
  canQuickCharge: boolean;
  canSellPhysicalProducts: boolean;
  readers: ReaderOption[];
  physicalProducts: PhysicalProductOption[];
  digitalProducts: DigitalProductOption[];
  clients: ClientOption[];
  packageTemplates: PackageTemplateOption[];
  clientAccountBalances: Record<string, number>;
  membershipPlans: MembershipPlanOption[];
  membershipBenefitsByPlanId: Record<string, MembershipBenefitOption[]>;
  existingMembershipsByClientId: Record<string, ExistingMembership>;
}) {
  const allowedInitialType = useMemo<SaleType>(() => {
    if (initialType === "membership" && canSellMemberships) return "membership";
    if (initialType === "package" && canSellPackages) return "package";
    if (initialType === "quick_charge" && canQuickCharge) return "quick_charge";
    if (
      initialType === "physical_product" &&
      canSellPhysicalProducts
    ) {
      return "physical_product";
    }
    if (initialType === "digital_product" && canSellPhysicalProducts) {
      return "digital_product";
    }
    if (canSellPackages) return "package";
    if (canSellMemberships) return "membership";
    if (canSellPhysicalProducts) return "physical_product";
    return "quick_charge";
  }, [
    canQuickCharge,
    canSellMemberships,
    canSellPackages,
    canSellPhysicalProducts,
    initialType,
  ]);

  const [saleType, setSaleType] = useState<SaleType>(allowedInitialType);

  return (
    <div className="space-y-6">
      <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
              Step 1
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">What are you selling?</h2>
            <p className="mt-1 text-sm text-slate-600">
              Start every front-desk sale from one place, then DanceFlow will show the right workflow.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5 xl:min-w-[980px]">
            <button
              type="button"
              disabled={!canSellPackages}
              onClick={() => canSellPackages && setSaleType("package")}
              className={`rounded-2xl border p-4 text-left transition ${
                saleType === "package"
                  ? "border-[var(--brand-primary)] bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
              } ${!canSellPackages ? "cursor-not-allowed opacity-50" : ""}`}
            >
              <div className="flex items-center gap-3">
                <Package2 className="h-5 w-5" />
                <div>
                  <p className="font-semibold">Package</p>
                  <p className="text-xs opacity-75">Lesson credits or passes</p>
                </div>
              </div>
            </button>

            <button
              type="button"
              disabled={!canSellMemberships}
              onClick={() => canSellMemberships && setSaleType("membership")}
              className={`rounded-2xl border p-4 text-left transition ${
                saleType === "membership"
                  ? "border-[var(--brand-primary)] bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
              } ${!canSellMemberships ? "cursor-not-allowed opacity-50" : ""}`}
            >
              <div className="flex items-center gap-3">
                <WalletCards className="h-5 w-5" />
                <div>
                  <p className="font-semibold">Membership</p>
                  <p className="text-xs opacity-75">Recurring plans and benefits</p>
                </div>
              </div>
            </button>

            <button
              type="button"
              disabled={!canSellPhysicalProducts}
              onClick={() =>
                canSellPhysicalProducts && setSaleType("physical_product")
              }
              className={`rounded-2xl border p-4 text-left transition ${
                saleType === "physical_product"
                  ? "border-[var(--brand-primary)] bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
              } ${
                !canSellPhysicalProducts
                  ? "cursor-not-allowed opacity-50"
                  : ""
              }`}
            >
              <div className="flex items-center gap-3">
                <ShoppingBag className="h-5 w-5" />
                <div>
                  <p className="font-semibold">Physical Product</p>
                  <p className="text-xs opacity-75">Retail and merchandise</p>
                </div>
              </div>
            </button>

            <button
              type="button"
              disabled={!canSellPhysicalProducts}
              onClick={() =>
                canSellPhysicalProducts && setSaleType("digital_product")
              }
              className={`rounded-2xl border p-4 text-left transition ${
                saleType === "digital_product"
                  ? "border-[var(--brand-primary)] bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
              } ${
                !canSellPhysicalProducts
                  ? "cursor-not-allowed opacity-50"
                  : ""
              }`}
            >
              <div className="flex items-center gap-3">
                <Film className="h-5 w-5" />
                <div>
                  <p className="font-semibold">Digital Content</p>
                  <p className="text-xs opacity-75">Videos, series, downloads</p>
                </div>
              </div>
            </button>

            <button
              type="button"
              disabled={!canQuickCharge}
              onClick={() => canQuickCharge && setSaleType("quick_charge")}
              className={`rounded-2xl border p-4 text-left transition ${
                saleType === "quick_charge"
                  ? "border-[var(--brand-primary)] bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
              } ${!canQuickCharge ? "cursor-not-allowed opacity-50" : ""}`}
            >
              <div className="flex items-center gap-3">
                <Zap className="h-5 w-5" />
                <div>
                  <p className="font-semibold">Quick Charge</p>
                  <p className="text-xs opacity-75">Walk-ins and fast charges</p>
                </div>
              </div>
            </button>
          </div>
        </div>
      </section>

      {saleType === "package" ? (
        <SellPackageForm
          clients={clients.map((client) => ({
            id: client.id,
            first_name: client.first_name,
            last_name: client.last_name,
            email: client.email ?? null,
            status: client.status ?? "active",
            account_balance: client.account_balance ?? 0,
          }))}
          packageTemplates={packageTemplates}
          clientAccountBalances={clientAccountBalances}
        />
      ) : null}

      {saleType === "membership" ? (
        <SellMembershipForm
          clients={clients.map((client) => ({
            id: client.id,
            first_name: client.first_name,
            last_name: client.last_name,
            email: client.email ?? null,
            phone: client.phone ?? null,
            status: client.status ?? null,
          }))}
          plans={membershipPlans}
          benefitsByPlanId={membershipBenefitsByPlanId}
          existingMembershipsByClientId={existingMembershipsByClientId}
          returnTo="/app/sell?type=membership"
        />
      ) : null}

      {saleType === "digital_product" ? (
        <DigitalProductSaleForm
          clients={clients.map((client) => ({
            id: client.id,
            first_name: client.first_name,
            last_name: client.last_name,
            email: client.email ?? null,
          }))}
          products={digitalProducts}
        />
      ) : null}

      {saleType === "physical_product" ? (
        <PhysicalProductSaleForm
          clients={clients.map((client) => ({
            id: client.id,
            first_name: client.first_name,
            last_name: client.last_name,
            email: client.email ?? null,
          }))}
          products={physicalProducts}
          hasOnlineReader={readers.some((reader) => reader.status === "online")}
        />
      ) : null}

      {saleType === "quick_charge" ? (
        <QuickChargeClient readers={readers} />
      ) : null}

      <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">
        <div className="flex items-start gap-3">
          <Sparkles className="mt-0.5 h-4 w-4 text-[var(--brand-primary)]" />
          <p>
            Packages, memberships, and Quick Charge keep their existing fulfillment and payment logic underneath. Sell is the single front-desk entry point; catalog products will join this workflow in later slices.
          </p>
        </div>
      </div>
    </div>
  );
}
