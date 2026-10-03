# BR-5 Collateral Strategy (DRAFT — awaiting production approval)

Status: strategy only. No final assets exist yet. Source of messaging truth is BR-4 (`src/lib/public/homeCopy.ts`, `src/lib/public/audienceCopy.ts`). Brand rules live in `DANCEFLOW_BRAND_GUIDE.md`; destinations and attribution mechanics live in `PUBLIC_DESTINATIONS.md`. This file does not duplicate either.

## 1. Architecture: eight pieces from four templates

| # | Asset | Audience | Format | Template |
|---|---|---|---|---|
| 1 | Event banner | Booth visitors (business first) | Retractable, 33" × 81" | Banner |
| 2 | Studio sheet | Studio owners | US Letter, 2-sided | Business sheet |
| 3 | Instructor sheet | Independent instructors | US Letter, 2-sided | Business sheet |
| 4 | Organizer sheet | Event organizers | US Letter, 2-sided | Business sheet |
| 5 | Dancer card | Dancers / public | 4" × 6" postcard, 2-sided | Dancer card |
| 6 | Social square | All (awareness / event presence) | 1080 × 1080 PNG | Social |
| 7 | Social story | All (awareness / event presence) | 1080 × 1920 PNG | Social |
| 8 | Collateral & QR guide | Internal | Markdown | — |

One banner, one business-sheet template (three copy variants), one dancer card, one social template (two sizes, two messages each: **event presence** and **product awareness**; four exports).

**Shared vs separate.** Studios and instructors use the same plans and tools, so their sheets share structure and most proof. They stay separate variants because BR-4 already gave them separate landing pages and different openings ("run the studio" vs "run your teaching business"), and a separate variant lets the QR report which audience a printed piece reached. They cost one copy block each, not a new design. Organizers diverge on substance (event flow, not studio operations) and also use the same template. Fallback if the owner wants fewer pieces: merge 2 and 3 into one "Studios and instructors" sheet pointing at `/for-studios`.

**Excluded on purpose:** tri-fold brochures (three variants of six panels each is the pile this phase should avoid); a second banner; a Facebook landscape / cover graphic (the existing 1200×630 OG image and the Facebook foundation doc already cover link and cover needs); ad creatives and calendars; pricing sheets (print cannot track price or founder changes); video or motion (BR-6).

## 2. Format decisions

- **Banner 33" × 81".** The common retractable standard; vendor print areas run roughly 33–33.5" × 79–81", so the master is built at 33" × 81" trim plus 0.5" bleed and re-fit to the chosen vendor's template before order. A wider (36"–48") stand costs and weighs materially more and is not needed for a single-message banner. The bottom ≈ 8–10" is hidden in the base and the top ≈ 1" in the clamp, so critical content sits inside a vertical safe band.
- **Business sheet: Letter, two-sided, flat.** Front is the hook and the single action; back holds three proof blocks and a quiet contact line. Handout-ready, printable on any desktop or copy shop, no fold cost.
- **Dancer card: 4" × 6" postcard.** Cheapest, fits dance bags and standard 4×6 counter holders. A 4×9 rack card was considered and rejected: it adds cost for room the four short rows do not need.
- **Social: square + story.** The square works for Facebook and Instagram feeds; the story is 9:16 for stories and reels covers. No QR on social (links go in captions).

## 3. Message hierarchy (copy is reused verbatim from BR-4 where it exists)

| Asset | Pain / outcome | Proof | Primary CTA → destination |
|---|---|---|---|
| Banner | "The dance platform that helps do the work—not just track it." (approved H1) | One line: "For studios, instructors, organizers and dancers." No feature list. | "Scan to see how it works" → `/for-studios` (see §9 decision 1) |
| Studio sheet | "Run the studio without chasing the details." | Run the day-to-day (scheduling, clients and packages, payments and paperwork); ARIA points out what needs attention, you choose how much it does; be found in Discover | "See plans and start your trial" → `/for-studios` |
| Instructor sheet | "Run your teaching business, not a pile of spreadsheets." | Get found; Teach; Keep students coming back; same studio plans and tools | "Try it on your own schedule" → `/for-instructors` |
| Organizer sheet | "From event page to check-in, in one place." | Publish, Sell (Stripe checkout, QR confirmation), Check in, Settle up; transparent event pricing shown before signup | "See organizer pricing and start your trial" → `/for-organizers` |
| Dancer card | "A public home for the dance community." | Find studios, find events, browse dance partner listings, find dance jobs, learn in Marketplace | "Explore Discover" → `/discover` |
| Social | Awareness: the approved H1. Event presence: "Find DanceFlow at {event}". | One approved proof line each | Caption link only |

Trial wording: print says "free trial" with no day count, no price and no founder-pricing claim, because print cannot follow the plan definitions the website derives from.

## 4. CTA and QR convention

One primary action per physical piece (one QR, one destination). The URL is also printed in quiet type as a fallback.

QR URLs always target one of the four BR-4 audience pages, never the sign-up form, so the value stage is seen first.

Convention (consistent with `PUBLIC_DESTINATIONS.md`; values use only allowed characters):

| Parameter | Meaning | Values |
|---|---|---|
| `utm_source` | Asset family | `banner`, `sheet`, `card`, `facebook`, `instagram` |
| `utm_medium` | Channel | `qr` (print), `social` |
| `utm_campaign` | Campaign wave | `br5-launch` (new wave = new name) |
| `utm_content` | Audience and version | `studios-v1`, `instructors-v1`, `organizers-v1`, `dancers-v1`, `booth-v1` |
| `utm_term` | Optional label | Only for one-off runs, e.g. a single event's handouts |
| `ref` | Optional short code | Only when a specific partner or studio distributes the piece; never a person's name, email or phone |

Example: `https://www.idanceflow.com/for-studios?utm_source=banner&utm_medium=qr&utm_campaign=br5-launch&utm_content=studios-v1`

Known limit: attribution is first-touch only, and a reusable banner or reprinted sheet carries the same static QR at every event, so event-level reporting is not possible from print alone. Per-event reporting would need a per-event print run or a sign-up survey question; neither is built, and BR-5 adds no infrastructure.

QR rules: error correction M, 4-module quiet zone, black on a light panel, no logo in the center, vector output, URL kept short to keep the module count low.

## 5. Visual system

- Surfaces: `--brand-surface #fff9f3` and white as grounds, `--brand-primary #5b145e` for text accents and one solid panel, `--brand-accent-dark #b86f18` as the small counterweight (eyebrows, rules; use the contrast-checked values from BR-4). Text `--brand-text #2b1b2a`, muted `--brand-muted #6f5b6b`.
- Logo: tracked SVG masters in `docs/brand/masters/`; primary gradient on light, white forms on brand purple; clear space per guide §5.3; never over imagery without a solid panel.
- Type: system sans stack, per guide §7 (no font adopted). The PDFs embed the font actually used at build time; the build records which one. Heading semibold with tight tracking, generous whitespace, one idea per panel.
- Imagery: at most one dance photograph per piece, and only on the dancer card and social. The existing hero rasters are 1536 × 1024, adequate for a half-card (about 256 dpi) but not for the banner, so the banner is vector and typographic.
- Avoid: feature inventories, card grids, multiple gradients, nightclub styling, QR clusters.

## 6. Print production assumptions

| | Banner | Business sheet | Dancer card |
|---|---|---|---|
| Trim | 33" × 81", portrait | 8.5" × 11", portrait | 4" × 6", portrait |
| Bleed | 0.5" | 0.125" | 0.125" |
| Safe area | 1" sides; content between 10" from bottom and 3" from top | 0.375" | 0.25" |
| Min text | Headline ≥ 90 pt, supporting ≥ 48 pt | Body ≥ 10 pt, fine print ≥ 8 pt | Body ≥ 9.5 pt, fine print ≥ 7.5 pt |
| QR size | ≥ 4.5", centered 36"–54" up from the graphic bottom | ≥ 1.1" | ≥ 1.0" |
| Viewing distance | 4–10 ft; phone scan at 3–4 ft | Hand-held | Hand-held |
| Image resolution | Vector; any raster ≥ 100 dpi at full size | ≥ 300 dpi | ≥ 300 dpi |

Color: working assets are RGB. The PDFs are RGB with embedded fonts. Conversion to CMYK / PDF/X (the printer's profile) is done by the print vendor or their preflight; no CMYK converter is installed in this environment, so BR-5 will not claim CMYK files. The purple and gold gradient may shift slightly in CMYK; the guide's flat brand colors convert safely. Recommended export: PDF, 100 % scale, bleed included, crop marks off (vendors add their own), vendor profile applied at their end.

## 7. Proposed file structure

```
docs/brand/collateral/
  COLLATERAL_STRATEGY.md        (this draft; becomes the guide at closeout)
  COLLATERAL_GUIDE.md           (final guide: formats, specs, QR convention, naming, reuse, claims)
  copy.json                     (all collateral copy; single source for the builder and the claims test)
  src/                          (HTML/CSS templates: banner, sheet, card, social)
  exports/                      (PDFs and PNGs; names below)
scripts/brand/build-collateral.mjs   (renders templates with Playwright; QR from the repo's qrcode package; --verify)
src/lib/public/__tests__/collateral.br5.test.ts   (claims guard + QR URL validation against attribution.ts)
```

Nothing goes under `public/` (print masters should not be served). Exports are tracked, versioned binaries; the total is expected to stay in the low megabytes.

File naming: `df-{asset}-{audience}-{size}-v{n}.{ext}`, for example `df-banner-booth-33x81-v1.pdf`, `df-sheet-studios-letter-v1.pdf`, `df-card-dancers-4x6-v1.pdf`, `df-social-event-square-v1.png`.

Reuse rules: change copy only in `copy.json`; any new claim must pass the claims test; a new version number for any change after printing; do not recolor or recompose the logo.

## 8. Claims and safety

All BR-4 restrictions carry over: no Featured Events promotion or boosting, Partner Match only as partner listings (no matching, "free forever" or speed claims), no SOC 2, no Competition OS claims, no autonomous ARIA, no pricing values, no founder or trial-day numbers. ARIA is described only by what it does today: it points out what needs attention, and the owner chooses how much it does. Static collateral only: no forms, analytics or data collection; QR URLs contain no personal data.

## 9. Owner decisions needed before production

1. **Banner QR destination and primary audience.** Recommended: `/for-studios` (highest-value buyer at a dance event; instructors and organizers reach their pages from the takeaway sheets and the website nav). Alternative: `/` (homepage routes all four audiences, but weaker as a single action).
2. **Studios and instructors: separate sheets (recommended) or merged.**
3. **Typeface.** Recommended: keep the system stack (no new font adopted). Adopting a brand typeface for print would be a separate approved decision.
4. **Dancer-card photo.** Use the existing `danceflow-home-hero.png` crop (recommended) or a new owner-supplied photograph.
5. **Banner vendor** and its exact template (width/height may shift by up to 0.5"); final fit happens after the vendor is chosen.
6. **Event name placeholder** for the "event presence" social variant is a text field; the owner supplies each event's name and date at use time.
