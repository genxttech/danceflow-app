"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/*
  GC-3.5-3: Stripe's redirect can arrive before the webhook finalizes the
  purchase. This only re-renders the server page (router.refresh) a bounded
  number of times; it never writes anything. The page decides what to show
  from the database alone.
*/
export default function PurchaseFinalizingPoller({ attempts, intervalMs }: { attempts: number; intervalMs: number }) {
  const router = useRouter();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (count >= attempts) return;
    const timer = setTimeout(() => {
      setCount((value) => value + 1);
      router.refresh();
    }, intervalMs);
    return () => clearTimeout(timer);
  }, [count, attempts, intervalMs, router]);

  if (count >= attempts) {
    return (
      <p role="status" className="mt-4 rounded-2xl bg-slate-100 px-4 py-3 text-sm text-slate-700">
        We&apos;re still confirming your payment. We&apos;ll email you as soon as you&apos;re registered — you can safely
        close this page.
      </p>
    );
  }

  return (
    <p role="status" aria-live="polite" className="mt-4 text-sm text-slate-500">
      Checking your registration…
    </p>
  );
}
