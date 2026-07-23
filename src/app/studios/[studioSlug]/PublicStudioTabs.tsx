"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

type PublicStudioTab = {
  key: string;
  label: string;
};

export default function PublicStudioTabs({
  studioSlug,
  activeTab,
  tabs,
}: {
  studioSlug: string;
  activeTab: string;
  tabs: PublicStudioTab[];
}) {
  const router = useRouter();

  return (
    <nav
      aria-label="Studio page tabs"
      className="sticky top-0 z-20 border-b border-orange-100 bg-white/95 px-4 py-2.5 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-white/85 sm:px-6 lg:px-8"
    >
      <div className="mx-auto max-w-7xl">
        <div className="sm:hidden">
          <label htmlFor="public-studio-tab" className="sr-only">
            Studio section
          </label>
          <select
            id="public-studio-tab"
            value={activeTab}
            onChange={(event) => {
              router.push(`/studios/${studioSlug}?tab=${event.target.value}`);
            }}
            className="w-full rounded-xl border border-orange-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800 shadow-sm"
          >
            {tabs.map((tab) => (
              <option key={tab.key} value={tab.key}>
                {tab.label}
              </option>
            ))}
          </select>
        </div>

        <div className="hidden gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:flex">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.key;

            return (
              <Link
                key={tab.key}
                href={`/studios/${studioSlug}?tab=${tab.key}`}
                aria-current={isActive ? "page" : undefined}
                className={
                  isActive
                    ? "shrink-0 rounded-xl bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] px-3 py-2 text-sm font-semibold text-white shadow-sm"
                    : "shrink-0 rounded-xl border border-orange-100 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-violet-200 hover:bg-violet-50"
                }
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
