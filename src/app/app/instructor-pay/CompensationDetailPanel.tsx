"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ResponsiveDetailPanel } from "@/components/app/workspace";

/**
 * URL-driven right-side detail panel for one instructor's compensation.
 * The page renders it only when `?compensation=<instructorId>` is present;
 * closing it (button, backdrop, Escape) navigates to `closeHref`, which keeps
 * every other page parameter so the person stays where they were.
 */
export default function CompensationDetailPanel({
  title,
  description,
  closeHref,
  children,
}: {
  title: string;
  description?: string;
  closeHref: string;
  children: ReactNode;
}) {
  const router = useRouter();

  return (
    <ResponsiveDetailPanel
      open
      title={title}
      description={description}
      onClose={() => router.push(closeHref, { scroll: false })}
    >
      {children}
    </ResponsiveDetailPanel>
  );
}
