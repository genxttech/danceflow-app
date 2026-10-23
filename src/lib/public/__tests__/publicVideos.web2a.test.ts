import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPublicVideo, httpsUrlOrNull } from "@/lib/public/publicVideos";

/**
 * WEB-2A: public videos are served from owner-configured URLs only. No video file is committed,
 * and a missing or unsafe URL means the page shows its text fallback.
 */

const ROOT = process.cwd();

describe("public video URLs", () => {
  it("accepts only absolute https URLs", () => {
    expect(httpsUrlOrNull(undefined)).toBeNull();
    expect(httpsUrlOrNull("  ")).toBeNull();
    expect(httpsUrlOrNull("http://example.com/a.mp4")).toBeNull();
    expect(httpsUrlOrNull("javascript:alert(1)")).toBeNull();
    expect(httpsUrlOrNull("/media/a.mp4")).toBeNull();
    expect(httpsUrlOrNull(" https://cdn.example.com/a.mp4 ")).toBe("https://cdn.example.com/a.mp4");
  });

  it("returns no video when the URL is not configured", () => {
    if (!process.env.NEXT_PUBLIC_ARIA_VIDEO_30S_URL) {
      expect(getPublicVideo("aria30")).toBeNull();
    }
  });

  it("ships captions for each configured video, and no video files", () => {
    const captions = readFileSync(join(ROOT, "public", "media", "captions", "aria-30s.vtt"), "utf8");
    expect(captions.startsWith("WEBVTT")).toBe(true);
    expect(existsSync(join(ROOT, "public", "media", "videos"))).toBe(false);
  });

  it("the player is viewer-started with captions", () => {
    const player = readFileSync(join(ROOT, "src", "components", "public", "PublicVideoPlayer.tsx"), "utf8");
    expect(player).toContain("controls");
    expect(player).toContain('kind="captions"');
    expect(player).not.toMatch(/autoPlay/);
  });
});
