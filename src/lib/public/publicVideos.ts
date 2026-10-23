/**
 * Public marketing videos. The video files are never committed: the owner uploads each approved
 * file to a host and sets its URL in the environment. Until a URL is set, `getPublicVideo` returns
 * null and the page shows its text fallback, so merging this code publishes no video.
 *
 * The URL must be a direct, progressive MP4 (for example a Mux static rendition or a storage
 * object URL); an HLS playlist does not play in a plain <video> element outside Safari.
 */

export type PublicVideo = {
  src: string;
  poster: string | null;
  /** Same-origin WebVTT captions committed under public/media/captions. */
  captions: string;
};

/** Only absolute https URLs are accepted, so a mistyped value never renders a broken or unsafe source. */
export function httpsUrlOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

// NEXT_PUBLIC_ values are inlined at build time, so each one is read with a literal property access.
const PUBLIC_VIDEOS = {
  aria30: {
    src: process.env.NEXT_PUBLIC_ARIA_VIDEO_30S_URL,
    poster: process.env.NEXT_PUBLIC_ARIA_VIDEO_30S_POSTER_URL,
    captions: "/media/captions/aria-30s.vtt",
  },
} as const;

export type PublicVideoKey = keyof typeof PUBLIC_VIDEOS;

export function getPublicVideo(key: PublicVideoKey): PublicVideo | null {
  const config = PUBLIC_VIDEOS[key];
  const src = httpsUrlOrNull(config.src);
  if (!src) return null;
  return { src, poster: httpsUrlOrNull(config.poster), captions: config.captions };
}
