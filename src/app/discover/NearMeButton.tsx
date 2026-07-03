"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

export function NearMeButton({ label = "Use my location" }: { label?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [busy, setBusy] = useState(false);

  function useLocation() {
    if (!navigator.geolocation) return;

    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set("lat", String(position.coords.latitude));
        params.set("lng", String(position.coords.longitude));
        if (!params.get("radius")) params.set("radius", "50");
        router.push(`?${params.toString()}`);
        setBusy(false);
      },
      () => setBusy(false),
      { enableHighAccuracy: false, maximumAge: 300000, timeout: 10000 },
    );
  }

  return (
    <button
      type="button"
      onClick={useLocation}
      className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
    >
      {busy ? "Finding location..." : label}
    </button>
  );
}
