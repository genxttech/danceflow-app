import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
    for (const file of ["aria-30s.vtt", "aria-77s.vtt"]) {
      const captions = readFileSync(join(ROOT, "public", "media", "captions", file), "utf8");
      expect(captions.startsWith("WEBVTT"), file).toBe(true);
    }
    expect(existsSync(join(ROOT, "public", "media", "videos"))).toBe(false);
  });

  it("/for-studios features the full overview at #meet-aria, right after the hero", () => {
    const page = readFileSync(join(ROOT, "src", "app", "for-studios", "page.tsx"), "utf8");
    expect(page).toContain('id="meet-aria"');
    expect(page).toContain('getPublicVideo("aria77")');
    expect(page.indexOf('id="meet-aria"')).toBeGreaterThan(page.indexOf("<AudienceHero"));
    expect(page.indexOf('id="meet-aria"')).toBeLessThan(page.indexOf("STUDIOS_PAGE.dayHeading"));
  });

  it("the player is viewer-started with captions", () => {
    const player = readFileSync(join(ROOT, "src", "components", "public", "PublicVideoPlayer.tsx"), "utf8");
    expect(player).toContain("controls");
    expect(player).toContain('kind="captions"');
    expect(player).not.toMatch(/autoPlay/);
  });

  it("replaces an unloadable video with a message on the poster instead of an empty player", () => {
    const player = readFileSync(join(ROOT, "src", "components", "public", "PublicVideoPlayer.tsx"), "utf8");
    expect(player).toMatch(/<source[^>]*onError=\{\(\) => setUnavailable\(true\)\}/);
    expect(player).toContain("This video can&apos;t be played right now.");
    expect(player).toContain("poster={video.poster}");
  });
});

/** WEB-2B: release assets for the two approved cuts (30 s horizontal v2, 77 s R4). */
describe("ARIA video release assets", () => {
  const vtt = (file: string) =>
    readFileSync(join(ROOT, "public", "media", "captions", file), "utf8").replace(/\r\n/g, "\n");
  const cueTimes = (text: string) =>
    [...text.matchAll(/(\d\d):(\d\d):(\d\d)\.(\d{3}) --> (\d\d):(\d\d):(\d\d)\.(\d{3})/g)].map((m) => [
      +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000,
      +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000,
    ]);

  it("each video has a small committed poster frame, used unless a poster URL is configured", () => {
    for (const file of ["aria-30s.webp", "aria-77s.webp"]) {
      const poster = readFileSync(join(ROOT, "public", "media", "posters", file));
      expect(poster.subarray(8, 12).toString("ascii"), file).toBe("WEBP");
      expect(poster.length, file).toBeLessThan(60_000);
    }
    const source = readFileSync(join(ROOT, "src", "lib", "public", "publicVideos.ts"), "utf8");
    expect(source).toContain('defaultPoster: "/media/posters/aria-30s.webp"');
    expect(source).toContain('defaultPoster: "/media/posters/aria-77s.webp"');
  });

  it("captions use the audio-verified wording, not the earlier draft transcript", () => {
    const full = vtt("aria-77s.vtt");
    for (const line of [
      "a new inquiry that's gone quiet,",
      "while you're focused on your business,",
      "Others, I simply bring to your attention.",
      "from the moment a dancer finds a studio,",
      "Studios. Instructors. Organizers. Dancers.",
    ]) {
      expect(full).toContain(line);
    }
    expect(full).not.toMatch(/unanswered inquiry|a client who's gone quiet/);
    expect(vtt("aria-30s.vtt")).toContain("the AI team member inside DanceFlow.");
  });

  it("cues are ordered, non-overlapping and inside each video's duration", () => {
    for (const [file, duration] of [
      ["aria-30s.vtt", 30],
      ["aria-77s.vtt", 77],
    ] as const) {
      const times = cueTimes(vtt(file));
      expect(times.length, file).toBeGreaterThan(5);
      times.forEach(([start, end], i) => {
        expect(end, `${file} cue ${i + 1}`).toBeGreaterThan(start);
        expect(end, `${file} cue ${i + 1}`).toBeLessThanOrEqual(duration);
        if (i > 0) expect(start, `${file} cue ${i + 1}`).toBeGreaterThanOrEqual(times[i - 1][1]);
      });
    }
  });

  it("no video file is committed anywhere under public/", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
      });
    expect(walk(join(ROOT, "public")).filter((path) => /\.(mp4|mov|webm|m4v)$/i.test(path))).toEqual([]);
  });
});
