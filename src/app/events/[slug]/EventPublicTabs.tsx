"use client";

import { Children, ReactElement, ReactNode, useMemo, useState } from "react";

type EventTab = {
  id: string;
  label: string;
};

type EventPublicTabsProps = {
  tabs: EventTab[];
  defaultTabId?: string;
  children: ReactNode;
};

export default function EventPublicTabs({
  tabs,
  defaultTabId,
  children,
}: EventPublicTabsProps) {
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
    <div className="space-y-5">
      <div className="sticky top-0 z-20 -mx-4 border-y border-slate-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur sm:mx-0 sm:rounded-2xl sm:border">
        <div
          className="flex gap-2 overflow-x-auto pb-1"
          role="tablist"
          aria-label="Event page sections"
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
                    ? "border-purple-700 bg-purple-700 text-white shadow-sm"
                    : "border-slate-200 bg-white text-slate-700 hover:border-purple-200 hover:bg-purple-50 hover:text-purple-900"
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

