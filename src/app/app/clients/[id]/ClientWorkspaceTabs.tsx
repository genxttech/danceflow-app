"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";

type ClientTab = {
  id: string;
  label: string;
  description: string;
};

export default function ClientWorkspaceTabs({
  clientId,
  activeTab,
  tabs,
}: {
  clientId: string;
  activeTab: string;
  tabs: ClientTab[];
}) {
  const router = useRouter();
  const activeTabInfo = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];

  return (
    <div className="sticky top-0 z-20 rounded-2xl border border-violet-200/80 bg-white/95 p-2 shadow-[0_12px_35px_rgba(76,29,149,0.10)] backdrop-blur">
      <div className="sm:hidden">
        <label htmlFor="client-workspace-tab" className="sr-only">
          Client workspace section
        </label>
        <select
          id="client-workspace-tab"
          value={activeTab}
          onChange={(event) => {
            router.push(`/app/clients/${clientId}?tab=${event.target.value}`);
          }}
          className="w-full rounded-xl border border-[var(--brand-border)] bg-white px-3 py-2 text-sm font-semibold text-[var(--brand-text)]"
        >
          {tabs.map((tab) => (
            <option key={tab.id} value={tab.id}>
              {tab.label}
            </option>
          ))}
        </select>
      </div>

      <div className="hidden gap-2 overflow-x-auto pb-1 sm:flex">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTab;

          return (
            <Link
              key={tab.id}
              href={`/app/clients/${clientId}?tab=${tab.id}`}
              className={[
                "whitespace-nowrap rounded-xl px-3 py-2 text-sm font-medium transition",
                isActive
                  ? "bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] text-white shadow-sm"
                  : "border border-[var(--brand-border)] bg-white text-[var(--brand-text)] hover:bg-[var(--brand-primary-soft)]",
              ].join(" ")}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      <p className="mt-2 px-1 text-xs leading-5 text-[var(--brand-muted)]">
        {activeTabInfo.description}
      </p>
    </div>
  );
}
