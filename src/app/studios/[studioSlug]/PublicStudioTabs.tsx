"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { decodeHashId, resolveDeepLinkTab } from "./deepLink";

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

  // A URL hash never reaches the server, so a link like /studios/{slug}#lead would render
  // the default tab with the target section hidden. Open the tab that owns the hash target,
  // on first load and on later hash changes, then bring the target into view.
  useEffect(() => {
    const validTabs = tabs.map((tab) => tab.key);

    function applyHash() {
      const hash = window.location.hash;
      const nextTab = resolveDeepLinkTab(
        hash,
        activeTab,
        (id) => {
          const target = document.getElementById(id);
          if (!target) return null;
          const panel = target.closest("[data-studio-tab]");
          return { panelTab: panel?.getAttribute("data-studio-tab") ?? null };
        },
        validTabs,
      );

      if (nextTab) {
        router.replace(`/studios/${studioSlug}?tab=${nextTab}`);
        return;
      }

      const id = decodeHashId(hash);
      const target = id ? document.getElementById(id) : null;
      if (target && target.closest("[data-studio-tab]")?.getAttribute("data-studio-tab") === activeTab) {
        target.scrollIntoView({ block: "start" });
      }
    }

    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, [activeTab, studioSlug, tabs, router]);

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
