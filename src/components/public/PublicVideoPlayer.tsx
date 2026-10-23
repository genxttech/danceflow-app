import type { PublicVideo } from "@/lib/public/publicVideos";

/**
 * A plain, accessible video player for public pages: viewer-started (never autoplay), inline on
 * phones, with English captions. `preload="none"` keeps the homepage light; pages where the video
 * is the main content can use "metadata".
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
  return (
    <div className="overflow-hidden rounded-3xl bg-slate-950 shadow-[0_30px_90px_rgba(15,23,42,0.12)] ring-1 ring-slate-200">
      <video
        className="aspect-video h-auto w-full"
        controls
        playsInline
        preload={preload}
        poster={video.poster ?? undefined}
        aria-label={title}
        title={title}
      >
        <source src={video.src} type="video/mp4" />
        <track kind="captions" src={video.captions} srcLang="en" label="English" default />
      </video>
    </div>
  );
}
