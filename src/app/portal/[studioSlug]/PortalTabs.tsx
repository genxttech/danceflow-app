"use client";

import { Children, useMemo, useState, type ReactElement, type ReactNode } from "react";

type PortalTab = {
  id: string;
  label: string;
};

type PortalTabsProps = {
  tabs: PortalTab[];
  defaultTabId?: string;
  children: ReactNode;
};

export default function PortalTabs({
  tabs,
  defaultTabId,
  children,
}: PortalTabsProps) {
  const childArray = Children.toArray(children).filter(Boolean) as ReactElement<{
    id?: string;
  }>[];

  const visibleTabs = useMemo(
    () =>
      tabs.filter((tab) =>
        childArray.some((child) => child.props.id === tab.id),
      ),
    [tabs, childArray],
  );

  const firstTabId = visibleTabs[0]?.id ?? "";
  const [activeTab, setActiveTab] = useState(defaultTabId || firstTabId);

  const activeChild =
    childArray.find((child) => child.props.id === activeTab) ?? childArray[0];

  return (
    <div className="space-y-6">
      <div className="sticky top-0 z-20 -mx-1 border-y border-slate-200 bg-white/95 px-2 py-3 shadow-sm backdrop-blur sm:mx-0 sm:rounded-[28px] sm:border sm:px-4">
        <div
          className="flex gap-2 overflow-x-auto pb-1"
          role="tablist"
          aria-label="Portal sections"
        >
          {visibleTabs.map((tab) => {
            const isActive = activeTab === tab.id;

            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveTab(tab.id)}
                className={`shrink-0 rounded-full border px-4 py-2 text-sm font-semibold transition ${
                  isActive
                    ? "border-[var(--brand-primary)] bg-[var(--brand-primary)] text-white shadow-sm"
                    : "border-slate-200 bg-white text-slate-700 hover:border-violet-200 hover:bg-violet-50 hover:text-violet-950"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      <div role="tabpanel">{activeChild}</div>
    </div>
  );
}
