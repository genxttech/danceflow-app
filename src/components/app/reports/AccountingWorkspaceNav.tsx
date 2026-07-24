import Link from "next/link";
import {
  Boxes,
  CircleDollarSign,
  FileDown,
  Landmark,
  PackageCheck,
  ReceiptText,
  UsersRound,
  WalletCards,
} from "lucide-react";

const sections = [
  { id: "overview", label: "Overview", icon: Landmark },
  { id: "revenue", label: "Revenue", icon: CircleDollarSign },
  { id: "expenses", label: "Expenses & profit", icon: ReceiptText },
  { id: "payouts", label: "Payouts", icon: WalletCards },
  { id: "packages", label: "Packages", icon: PackageCheck },
  { id: "memberships", label: "Memberships", icon: UsersRound },
  { id: "instructor-pay", label: "Instructor pay", icon: Boxes },
  { id: "exports", label: "Exports", icon: FileDown },
] as const;

export default function AccountingWorkspaceNav({ range }: { range: string }) {
  return (
    <nav
      aria-label="Accounting workspace sections"
      className="sticky top-3 z-20 overflow-x-auto rounded-2xl border border-violet-200/80 bg-white/95 p-2 shadow-[0_12px_35px_rgba(76,29,149,0.10)] backdrop-blur"
    >
      <div className="flex min-w-max gap-1">
        {sections.map((section) => {
          const Icon = section.icon;
          return (
            <Link
              key={section.id}
              href={`/app/reports?range=${encodeURIComponent(range)}#${section.id}`}
              className="group inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold text-slate-600 transition hover:bg-[linear-gradient(135deg,#f5f3ff_0%,#fff7ed_100%)] hover:text-violet-900"
            >
              <Icon className="h-4 w-4 text-slate-400 group-hover:text-violet-700" />
              {section.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
