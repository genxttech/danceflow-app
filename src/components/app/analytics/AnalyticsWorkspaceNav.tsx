import Link from "next/link";
import { BarChart3, CircleDollarSign, Goal, ShoppingBag, TrendingUp, Users } from "lucide-react";

type AnalyticsSection = "overview" | "journey" | "dance_goals" | "instructors" | "lead_sources" | "commerce";

const ITEMS = [
  { id: "overview" as const, label: "Overview", href: "/app/analytics", icon: BarChart3 },
  { id: "journey" as const, label: "Client journey", href: "/app/analytics#client-journey", icon: TrendingUp },
  { id: "dance_goals" as const, label: "Dance goals", href: "/app/analytics/dance-goals", icon: Goal },
  { id: "instructors" as const, label: "Instructors", href: "/app/analytics#instructors", icon: Users },
  { id: "lead_sources" as const, label: "Lead sources", href: "/app/analytics#lead-sources", icon: CircleDollarSign },
  { id: "commerce" as const, label: "Commerce", href: "/app/analytics#commerce", icon: ShoppingBag },
];

export default function AnalyticsWorkspaceNav({ activeSection = "overview", range }: { activeSection?: AnalyticsSection; range?: string }) {
  return (
    <nav aria-label="Analytics sections" className="sticky top-3 z-20 overflow-x-auto rounded-2xl border border-violet-200/80 bg-white/95 p-2 shadow-[0_12px_35px_rgba(76,29,149,0.10)] backdrop-blur [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="flex min-w-max gap-1 pr-2">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          const active = item.id === activeSection;
          const href = item.id === "dance_goals" && range ? `${item.href}?range=${encodeURIComponent(range)}` : item.href;
          return (
            <Link key={item.id} href={href} aria-current={active ? "page" : undefined} className={["inline-flex min-h-11 items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition", active ? "bg-[linear-gradient(135deg,#ede9fe_0%,#ffedd5_100%)] text-violet-950 ring-1 ring-violet-200" : "text-slate-600 hover:bg-slate-50 hover:text-violet-900"].join(" ")}>
              <Icon className="h-4 w-4" />{item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
