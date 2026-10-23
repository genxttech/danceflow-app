"use client";

import { useState } from "react";
import type { PublicVideo } from "@/lib/public/publicVideos";

/**
 * A plain, accessible video player for public pages: viewer-started (never autoplay), inline on
 * phones, with English captions and a poster frame. `preload="none"` keeps the homepage light;
 * pages where the video is the main content can use "metadata".
 *
 * If the configured file cannot be loaded (a removed or mistyped URL), the player is replaced by
 * a short message on the poster instead of an empty black box.
 */
export default function PublicVideoPlayer({
  video,
  title,
  preload = "none",
}: {
  video: PublicVideo;
  title: string;
  preload?: "none" | "metadata";
}) {
  const [unavailable, setUnavailable] = useState(false);

  return (
    <div className="overflow-hidden rounded-3xl bg-slate-950 shadow-[0_30px_90px_rgba(15,23,42,0.12)] ring-1 ring-slate-200">
      {unavailable ? (
        <div
          role="note"
          className="relative flex aspect-video w-full items-center justify-center bg-cover bg-center"
          style={{ backgroundImage: `url(${video.poster})` }}
        >
          <p className="m-4 rounded-2xl bg-white/95 px-5 py-3 text-center text-sm font-medium text-slate-700 shadow-sm">
            This video can&apos;t be played right now. Please try again later.
          </p>
        </div>
      ) : (
        <video
          className="aspect-video h-auto w-full"
          controls
          playsInline
          preload={preload}
          poster={video.poster}
          aria-label={title}
          title={title}
          onError={() => setUnavailable(true)}
        >
          {/* Network and format failures fire on the <source>, not the <video>. */}
          <source src={video.src} type="video/mp4" onError={() => setUnavailable(true)} />
          <track kind="captions" src={video.captions} srcLang="en" label="English" default />
        </video>
      )}
    </div>
  );
}
