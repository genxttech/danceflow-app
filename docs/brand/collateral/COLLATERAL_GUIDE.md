# DanceFlow Collateral Guide (BR-5)

How to use, reprint and rebuild the BR-5 event and print collateral. Brand rules (logo, colors, vocabulary, typography) are in [`DANCEFLOW_BRAND_GUIDE.md`](../DANCEFLOW_BRAND_GUIDE.md); landing-page and attribution mechanics are in [`PUBLIC_DESTINATIONS.md`](../PUBLIC_DESTINATIONS.md); the reasoning behind the formats is in [`COLLATERAL_STRATEGY.md`](COLLATERAL_STRATEGY.md). This guide does not repeat them.

## 1. Asset inventory

| Asset | Audience | Size | Primary action (one QR) | Files |
|---|---|---|---|---|
| Event banner | Mixed audience at events | 33" × 81" trim, 0.5" bleed | "Scan to explore DanceFlow" → `/` | `exports/review/df-banner-booth-33x81-v1-vendor-neutral-master.pdf`, `-proof.png`, `-guides.png` |
| Studio sheet | Studio owners | US Letter 8.5" × 11", 2-sided, flat | "See plans and start your trial" → `/for-studios` | `exports/print/df-sheet-studios-letter-v1.pdf` |
| Instructor sheet | Independent instructors | US Letter, 2-sided | "Try it on your own schedule" → `/for-instructors` | `exports/print/df-sheet-instructors-letter-v1.pdf` |
| Organizer sheet | Event organizers | US Letter, 2-sided | "See organizer pricing and start your trial" → `/for-organizers` | `exports/print/df-sheet-organizers-letter-v1.pdf` |
| Dancer card | Dancers / public | 4" × 6" postcard, 2-sided | "Explore Discover" → `/discover` | `exports/print/df-card-dancers-4x6-v1.pdf` |
| Social: product awareness | All | 1080 × 1080 and 1080 × 1920 PNG | Caption link only (no QR) | `exports/social/df-social-awareness-{square,story}-v1.png` |
| Social: event presence | All | 1080 × 1080 and 1080 × 1920 PNG | Caption link only (no QR) | `exports/social/df-social-event-{square,story}-v1.png` |

Review previews of every print face (trim size, 150 dpi) are in `exports/review/` as `-front.png` / `-back.png`. `exports/BUILD_REPORT.json` records the fonts, PDF fonts, page sizes, QR measurements, image resolution and layout QA from the last build.

The studio and instructor sheets share one template and stay separate on purpose: distinct opening, proof, landing page and QR attribution. Print pieces never link straight to a signup form; the audience page is the value stage and carries the get-started path.

## 2. Copy and claims

All copy lives in [`copy.json`](copy.json) (text only). Wording reused from BR-4 is checked against `src/lib/public/audienceCopy.ts` and `homeCopy.ts` by `src/lib/public/__tests__/collateral.br5.test.ts`, so it cannot drift silently. The same test enforces the launch restrictions: no Featured Events or boosting claims, no algorithmic Partner Match or matching guarantees, no "free forever", no SOC 2, no Competition OS wording (judging, scoring, live heats, awards, results), no ARIA autonomy, and no hardcoded trial length, price or founder-pricing text. Print says "free trial" with no number because print cannot follow the plan definitions the website derives its trial wording from.

To change wording: edit `copy.json`, rebuild, run the test, review the proofs, and bump the file version (`v1` → `v2`) before anything is reprinted.

## 3. QR and attribution convention

Every print QR encodes `https://www.idanceflow.com{path}?utm_source=…&utm_medium=qr&utm_campaign=br5-launch&utm_content=…`, built from `copy.json` by `scripts/brand/collateral-lib.mjs` (error correction M, 4-module quiet zone, black on white, no logo, vector). The values are validated against the same character rules the website applies, and the test confirms the site's own parser keeps every parameter.

| Piece | `utm_source` | `utm_content` | Destination |
|---|---|---|---|
| Banner | `banner` | `booth-v1` | `/` |
| Studio sheet | `sheet` | `studios-v1` | `/for-studios` |
| Instructor sheet | `sheet` | `instructors-v1` | `/for-instructors` |
| Organizer sheet | `sheet` | `organizers-v1` | `/for-organizers` |
| Dancer card | `card` | `dancers-v1` | `/discover` |

Social caption links (not encoded in the images): `utm_medium=social`, `utm_campaign=br5-launch`, and one of

- Facebook feed, product awareness: `utm_source=facebook&utm_content=awareness-square`
- Instagram story, product awareness: `utm_source=instagram&utm_content=awareness-story`
- Facebook feed, event presence: `utm_source=facebook&utm_content=event-square`
- Instagram story, event presence: `utm_source=instagram&utm_content=event-story`

all appended to `https://www.idanceflow.com/` (use the platform you actually post to as `utm_source`; the allowed values are letters, digits and `. _ ~ -`). The exact tagged links are generated from `copy.json` (`social.links`).

Optional: `utm_term` for a one-off print run, `ref` for a named distributor. Never put a person's name, email or phone number in either.

**Event limitation.** Attribution is first-touch only, and a reusable banner or a reprinted sheet carries the same QR at every event. Print alone cannot tell you which event a signup came from. Per-event reporting needs either a separate print run with its own `utm_term` or a "how did you hear about us" step at signup; neither exists yet, and BR-5 adds no tracking infrastructure.

## 4. Print and export specifications

| | Banner | Business sheet | Dancer card |
|---|---|---|---|
| Trim | 33" × 81" | 8.5" × 11" | 4" × 6" |
| Page in the PDF | 34" × 82" (0.5" bleed) | 8.75" × 11.25" (0.125" bleed) | 4.25" × 6.25" (0.125" bleed) |
| Safe area | 1" sides, 3" top, 10" bottom | 0.375" | 0.25" |
| Smallest text | 78 pt | 9.5 pt (eyebrow); body 10.5 pt and up | 9.5 pt |
| QR symbol size | about 11.7" | about 1.74" | about 1.1" |
| Images | Vector only | Vector only | Photo at about 310 dpi (source 1536 × 1024, no upscaling) |

- PDFs carry TrimBox and BleedBox, embed their fonts, and are RGB. There is no CMYK or PDF/X conversion in this toolchain (no Ghostscript or color-managed converter is installed), so the PDFs are **not** CMYK or PDF/X files. Send the RGB PDFs with bleed; the printer's preflight converts to their press profile. Expect small shifts in the purple-to-gold logo gradient and the gold accent after conversion. Ask the printer for a hard proof if the color matters.
- Typeface: the application's system sans stack (no font adopted). The proofs here were rendered with **Segoe UI** (Regular, Semibold and Bold) and the PDFs embed those subsets. A build on another operating system would render a different fallback font, so rebuild on the same machine class or review the output before reprinting.
- Photograph: the dancer card uses a crop of `public/brand/danceflow-path-hero.png`. It is not used on the banner or the sheets and must not be enlarged beyond its card size.

### Banner: vendor fit required before ordering

The banner is a **VENDOR-NEUTRAL MASTER — FINAL PRINTER FIT PENDING**. It is deliberately stored in `exports/review/`, not `exports/print/`, and is not a printer-ready file. **FINAL VENDOR FIT / BLEED / BOTTOM-FEED ADJUSTMENT REQUIRED BEFORE PRINT ORDER.** Before ordering:

1. Choose the stand and vendor, and download their template.
2. Confirm the printable area (vendors vary roughly 33–33.5" × 79–81"), the bleed they want, and how much of the bottom their base hides (assumed 10") and top their clamp hides (assumed 3").
3. Refit the master to that template (the layout is HTML/CSS: `templates/banner.html`) and re-run the builder.
4. Get the vendor's proof or preflight approval, then record the vendor-specific file under a new name.

The review proof `-guides.png` shades the assumed hidden zones and side margins and shows the 36"–54" height band for the QR (measured up from the bottom of the trim; the QR center is about 36.3" up).

## 5. File naming

`df-{asset}-{audience}-{size}-v{n}.{ext}`, for example `df-sheet-studios-letter-v1.pdf`, `df-card-dancers-4x6-v1.pdf`, `df-social-event-story-v1.png`. Reviews add `-front`/`-back`/`-proof`/`-guides`. A new version number is required for any change after printing; keep the old file.

## 6. Event-presence social posts

The event-presence templates export with a visible `{event}` placeholder, so the reusable masters never name a real event. To make a post for a real event, render it (outside the repository exports):

```bash
node scripts/brand/build-collateral.mjs --event "Event Name" --detail "Booth 12, Saturday" --out C:/path/to/output
```

The result is `df-social-event-square-v1-custom.png` and `df-social-event-story-v1-custom.png` (`--detail` is optional). Post with the matching event caption link above. No QR is on social images. For stories, platform controls cover roughly the top 250 px and bottom 340 px; the layout keeps all content clear of those zones.

## 7. Rebuilding and verifying

```bash
node scripts/brand/build-collateral.mjs            # rebuild every export and BUILD_REPORT.json
node scripts/brand/build-collateral.mjs --verify   # rebuild to a temp dir and compare with the committed exports
npx vitest run src/lib/public/__tests__/collateral.br5.test.ts
```

Requirements: the repository's existing `playwright` (Chromium installed), `qrcode`, `pdf-lib` and `sharp`; no new dependency. The builder reads only tracked files (`copy.json`, `templates/`, the logo masters in `docs/brand/masters/`, and the hero image) and fetches nothing. Output is byte-identical between runs on the same machine, which is what `--verify` checks. The builder fails its layout QA (and exits non-zero) if any text, logo or QR leaves its safe area, two text elements overlap, or a page overflows.

## 8. Reuse rules

- Change wording only in `copy.json`; change layout only in `templates/`.
- Use the tracked logo masters as they are (the white form on brand purple, the full-color form on light grounds); never recolor, restyle or re-typeset them.
- No new claims without a matching change to the roadmap restrictions and the claims test.
- Keep one primary action per piece; supporting URLs stay quiet text.
- Collateral is static: no forms, tracking pixels or analytics. Only the QR links carry campaign tags.
