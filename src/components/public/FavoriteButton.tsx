"use client";

import Link from "next/link";
import { useOptimistic, useTransition } from "react";
import { toggleFavoriteAction } from "@/app/actions/public-favorites";

type FavoriteTargetType = "studio" | "event";

export default function FavoriteButton({
  targetType,
  targetId,
  initiallyFavorited,
  isAuthenticated,
  returnPath,
}: {
  targetType: FavoriteTargetType;
  targetId: string;
  initiallyFavorited: boolean;
  isAuthenticated: boolean;
  returnPath: string;
}) {
  const [pending, startTransition] = useTransition();
  const [optimisticFavorited, setOptimisticFavorited] = useOptimistic(
    initiallyFavorited,
    (_current, next: boolean) => next
  );

  if (!isAuthenticated) {
    return (
      <Link
        href={`/login?next=${encodeURIComponent(returnPath)}`}
        className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white/95 text-slate-700 shadow-sm hover:bg-slate-50"
        aria-label={`Sign in to favorite this ${targetType}`}
        title={`Sign in to favorite this ${targetType}`}
      >
        <span className="text-lg leading-none">♡</span>
      </Link>
    );
  }

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        const nextValue = !optimisticFavorited;
        startTransition(async () => {
          setOptimisticFavorited(nextValue);
          await toggleFavoriteAction({
            targetType,
            targetId,
            returnPath,
          });
        });
      }}
      className={`inline-flex h-10 w-10 items-center justify-center rounded-full border shadow-sm ${
        optimisticFavorited
          ? "border-rose-200 bg-rose-50 text-rose-600"
          : "border-slate-200 bg-white/95 text-slate-700 hover:bg-slate-50"
      }`}
      aria-label={
        optimisticFavorited
          ? `Remove favorite ${targetType}`
          : `Favorite this ${targetType}`
      }
      title={
        optimisticFavorited
          ? `Remove favorite ${targetType}`
          : `Favorite this ${targetType}`
      }
    >
      <span className="text-lg leading-none">
        {optimisticFavorited ? "♥" : "♡"}
      </span>
    </button>
  );
}