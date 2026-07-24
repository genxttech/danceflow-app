import Link from "next/link";
import type { ReactNode } from "react";
import {
  BarChart3,
  Calculator,
  ReceiptText,
  TrendingUp,
} from "lucide-react";

type ReportingWorkspace = "analytics" | "reports";

const WORKSPACE_LINKS = [
  {
    id: "analytics" as const,
    label: "Analytics",
    description: "Conversion, lifecycle, goals, and growth",
    href: "/app/analytics",
    icon: TrendingUp,
  },
  {
    id: "reports" as const,
    label: "Accounting & Reports",
    description: "Revenue, expenses, payouts, and exports",
    href: "/app/reports",
    icon: Calculator,
  },
];

export default function ReportingWorkspaceHeader({
  activeWorkspace,
  eyebrow,
  title,
  description,
  controls,
  children,
}: {
  activeWorkspace: ReportingWorkspace;
  eyebrow: string;
  title: string;
  description: ReactNode;
  controls?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-[32px] border border-violet-200/70 bg-white shadow-[0_20px_55px_rgba(76,29,149,0.12)]">
      <div className="bg-[linear-gradient(135deg,#0f172a_0%,#312e81_52%,#7c2d92_100%)] px-5 py-6 text-white sm:px-7 sm:py-8">
        <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-violet-200">
              {eyebrow}
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              {title}
            </h1>
            <div className="mt-3 max-w-2xl text-sm leading-7 text-white/78 sm:text-base">
              {description}
            </div>
          </div>
          {controls ? <div className="flex flex-wrap gap-2">{controls}</div> : null}
        </div>

        {children ? <div className="mt-7">{children}</div> : null}
      </div>

      <nav className="grid border-t border-violet-100 bg-[linear-gradient(135deg,#faf5ff_0%,#fff7ed_100%)] sm:grid-cols-2">
        {WORKSPACE_LINKS.map((workspace) => {
          const Icon = workspace.icon;
          const active = activeWorkspace === workspace.id;

          return (
            <Link
              key={workspace.id}
              href={workspace.href}
              className={[
                "group flex items-center gap-3 px-5 py-4 transition sm:px-6",
                active
                  ? "bg-white text-violet-950"
                  : "text-slate-600 hover:bg-white/70 hover:text-violet-900",
              ].join(" ")}
              aria-current={active ? "page" : undefined}
            >
              <span
                className={[
                  "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl",
                  active
                    ? "bg-[linear-gradient(135deg,#ede9fe_0%,#ffedd5_100%)] text-violet-800 ring-1 ring-violet-200"
                    : "bg-white text-slate-500 ring-1 ring-slate-200 group-hover:text-violet-800",
                ].join(" ")}
              >
                <Icon className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{workspace.label}</span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  {workspace.description}
                </span>
              </span>
            </Link>
          );
        })}
      </nav>
    </section>
  );
}
