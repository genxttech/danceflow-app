"use client";

import { useEffect, useRef } from "react";
import { EMBED_HEIGHT_MESSAGE } from "@/lib/public/embedOptions";

/**
 * Wrapper for every Website Embed page. It tells the host page how tall the content is (height only, nothing else crosses the
 * frame) so the iframe can grow instead of scrolling, and it is a no-op when the page is opened outside an iframe.
 */
export default function EmbedFrame({
  accent,
  accentText,
  theme,
  children,
}: {
  accent: string;
  accentText: string;
  theme: "light" | "dark";
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window === "undefined" || window.parent === window) return;
    const el = ref.current;
    if (!el) return;
    let last = 0;
    const post = () => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      if (height > 0 && height !== last) {
        last = height;
        // Target origin "*" is intentional and safe: the payload is only a number. The host listener validates the sender.
        window.parent.postMessage({ type: EMBED_HEIGHT_MESSAGE, height }, "*");
      }
    };
    post();
    const observer = new ResizeObserver(post);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const dark = theme === "dark";
  return (
    <div
      ref={ref}
      data-theme={theme}
      style={{ ["--embed-accent" as string]: accent, ["--embed-accent-text" as string]: accentText }}
      className={`mx-auto w-full max-w-4xl p-3 sm:p-4 ${dark ? "bg-slate-900 text-slate-100" : "bg-white text-slate-900"}`}
    >
      {/* The frame fills the host's iframe box, so the page background must match the chosen theme (no stray tint). */}
      <style>{`html,body{background:${dark ? "#0f172a" : "#ffffff"} !important;margin:0}`}</style>
      {children}
    </div>
  );
}
