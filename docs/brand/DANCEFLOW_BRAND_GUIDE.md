# DanceFlow Brand Guide (BR-1 — source of truth)

Status: BR-1 of the Branding Relaunch. This guide records decisions and rules; it does not change any product surface.
BR-2 (product shell), BR-3 (emails and documents), BR-4 (public website) and BR-7 (QA) migrate the product to it.

---

## 1. Master brand and legal identity

- **Master brand:** `DanceFlow` (one word, capital D and F). Never `Dance Flow`, `Danceflow`, or `Dance-Flow`. Lowercase `danceflow` is allowed only in URLs, identifiers, package/bundle ids and file names. `DANCEFLOW` is allowed only as a deliberate uppercase typographic treatment of the wordmark label.
- **Legal entity:** GenX TotalTech LLC.
- **Canonical relationship:** "DanceFlow is a software platform owned and operated by GenX TotalTech LLC." (owner-approved for A2P-1C; used on the public footer, Terms, Privacy, SMS Consent and in SMS consent disclosures). The email legal line (`EMAIL_LEGAL_LINE`) still reads "DanceFlow is a product of GenX TotalTech LLC." pending a later email cleanup; the two are consistent in meaning.
- DanceFlow stays visually dominant on every customer-facing product surface. The legal entity appears where it is required or expected, in quiet type, never as a competing brand.

### Where the legal entity must appear

| Context | Rule |
|---|---|
| Legal pages (Terms, Privacy, DPA, Acceptable Use, Refund Policy, SMS Consent, Electronic Signature Consent, Security) | Name the contracting entity. |
| Copyright / site footer | "© {year} DanceFlow" plus the relationship line: "DanceFlow is a software platform owned and operated by GenX TotalTech LLC." |
| Contracts and order forms | Full legal name as the contracting party. |
| Payment / merchant disclosures | Wherever a merchant or seller-of-record disclosure is legally required. |
| Google Play (and any store) developer identity | The developer account carries the legal entity where the store requires it; the store listing itself is branded DanceFlow. |
| Marketing-email footers | Where a sender identity and postal address are required (e.g. CAN-SPAM), include the required address and sender identity. |
| Structured data (JSON-LD Organization) | Add the legal name alongside `name: "DanceFlow"`. |

### Where it should not compete

Product headers, navigation, sidebar, buttons, hero and marketing copy, email headers, PDF headers, app icons and social avatars use DanceFlow only.

**Current state (audit, 2026-09-20):** "GenX TotalTech LLC" appears nowhere in the product. This is a gap to close in BR-2 (footer, legal pages), BR-3 (emails/PDFs) and BR-4 (structured data).

---

## 2. Approved copy (record verbatim — do not rewrite)

**Mission (full):**
> DanceFlow exists to give every dance studio an automated team member—handling daily operations, client follow-up, sales opportunities, marketing support, and administrative work—so studio owners can spend more time teaching and less time running the business.

**Mission (short):**
> DanceFlow helps run the studio, so you can focus on teaching.

**Positioning:**
> Software that helps do the work—not just track it.

Notes:
- Only a variant of the short mission exists in the product today (`PublicSiteFooter.tsx`: "…so owners can focus on teaching."). Align it to the approved wording in BR-2/BR-4.
- The full mission and the positioning line appear nowhere in the repository yet.
- These three lines are the master-brand anchors. Persona-specific supporting lines (BR-4) sit beneath them; they never replace them.

---

## 3. Brand architecture

**Master brand:** DanceFlow.

**Persona language (descriptive, not sub-brands):**
- DanceFlow for Studios (includes independent instructors)
- DanceFlow for Organizers
- DanceFlow for Dancers / the student experience

**Feature and capability names (not brands):** Discover, Marketplace, Documents, Payroll Prep, Group Classes, Competitions.

**Assistant identities:** ARIA, LUMI.

**Do not create:** a separate Organizer logo, a separate Competition logo, a standalone Competition visual brand, or any app-specific product brand. Organizer and Competition are DanceFlow personas/capabilities.

**Out of scope for this guide:** the number, names or boundaries of mobile apps. Those are reserved for the Mobile App Architecture & Boundary Audit.

---

## 4. ARIA and LUMI

**Capitalization:** `ARIA` and `LUMI` always upper case.

**ARIA**
- Canonical name: ARIA.
- Role: DanceFlow's studio operational AI assistant — the "automated team member" of the mission.
- Expansion: the product currently displays "AI Revenue Insights Assistant" (`src/app/app/aria/page.tsx`, `src/app/get-started/page.tsx`, `src/app/get-started/studio/page.tsx`, `src/components/app/AriaAvatar.tsx`, knowledgebase). No approved canonical expansion exists elsewhere, and project direction describes ARIA more broadly than "revenue insights". **The expansion is treated as legacy display copy pending a later copy review.** Use "ARIA" on its own in new copy; do not invent a new expansion.
- Pronoun: current public copy uses "she". Pending copy review.
- Sub-names in use: ARIA Opportunity Hub, ARIA Goals, Operations, Chat with ARIA (the last is described as future on the pricing page).

**LUMI**
- Canonical name: LUMI.
- Role: DanceFlow's student/dancer-facing assistant, described in product as the **Dance Journey Assistant** ("LUMI, Dance Journey Assistant" — `src/app/portal/[studioSlug]/journey/page.tsx`, `src/app/app/settings/SettingsForm.tsx`).
- LUMI is a feature/assistant identity inside the student experience, not a product or app name.

Assistant art (existing, not redesigned): `public/aria/aria-avatar.png`, `public/lumi-avatar.png` (both ≈ 2 MB; optimize in BR-2).

---

## 5. Logo

### Canonical source

- **Approved artwork (owner-approved, supersedes the earlier BR-1 decision):** the modern DanceFlow identity: an abstract pair of dancers (purple and orange figures with round gradient heads) and the custom geometric "DanceFlow" wordmark with the swash D, in the purple-to-gold gradient. It is the "Final Branding" artwork (Candidate A), approved by the owner in the BR-1 correction. The design is final and is not to be redesigned.
- **Retired:** the earlier dancing-couple mark with the ornate script wordmark (`public/brand/danceflow-logo.png`, SHA-256 `0c4d74f56b5334563e561af70d786bb2247ff517d1d596c7058a336abde2184a`) is **no longer canonical**. It was removed from the web runtime asset tree in the BR-1 correction (Git history preserves it). `mobile/student/assets/danceflow-logo.png` is a byte-identical copy of the retired file and stays until the mobile branding slice.
- **Tracked masters (source of truth):** `docs/brand/masters/`, each pinned by SHA-256 in `docs/brand/masters/SHA256SUMS.txt`:

| Master | Role |
|---|---|
| `danceflow-logo-primary-gradient.svg` (600×150) | Primary horizontal logo, full colour |
| `danceflow-logo-primary-white.svg` | Primary horizontal, single-colour white knockout (also the source of the mono-purple form) |
| `danceflow-symbol-gradient.svg` (197×272) | Symbol only, full colour (also the source of the favicon family) |
| `danceflow-symbol-white.svg` | Symbol only, white knockout |
| `danceflow-app-icon-1024.png` (1024×1024) | Approved app icon: symbol on a dark navy tile (owner-approved composition; source of the PWA/apple-touch icons) |
| `danceflow-social-avatar-1080.png` (1080×1080) | Approved social avatar: symbol on a navy disc with transparent corners |

- **Vector masters:** the four SVG masters are pure paths (no embedded images, no live text). The wordmark is custom vector artwork and is never re-typeset. The earlier "vector master deferred" note is resolved.
- **What the approval covers:** the logo artwork only. It does **not** adopt the package's UI palette (`#6B1FA3` family) or its fonts (Sora / Inter) as application tokens, and it does not adopt the compact or descriptor lockups ("STUDIO OPERATING SYSTEM"). Those need separate approval. The application palette in §7 is unchanged.

### 5.1 Asset family (generated from the tracked masters)

Generated by `node scripts/brand/build-logo-family.mjs` and checked by `--verify`, which verifies the tracked master hashes, regenerates into a temporary directory and compares decoded pixels (and dimensions) with the committed outputs. The generator reads only files tracked in this repository.

| Role | File | Notes |
|---|---|---|
| Primary horizontal logo (full colour) | `public/brand/logo/danceflow-logo-primary.png` (2400×600); `-640` (640×160), `-320` (320×80) scaled | 4:1 lockup, from the primary gradient SVG. |
| Symbol-only mark | `public/brand/logo/danceflow-symbol.png` (788×1088); `-256`, `-128` (128×177) scaled | ≈0.72:1, from the symbol gradient SVG. |
| Monochrome (brand purple `#5b145e`) | `danceflow-logo-primary-mono-purple.png`, `danceflow-symbol-mono-purple.png` | White master recoloured to the existing UI brand value `#5b145e`. |
| White / reversed | `danceflow-logo-primary-white.png` (1200×300), `danceflow-symbol-white.png` | For brand-purple and other dark-colour backgrounds. |
| Dark-background use | Full-colour primary/symbol or the white forms | See §5.3. |
| Favicon set | `public/brand/icons/danceflow-favicon-16.png`, `-32`, `-48`, `danceflow-favicon.ico` (16/32/48) | Symbol only, transparent, from the symbol SVG. |
| Apple touch icon | `public/brand/icons/danceflow-apple-touch-icon-180.png` | Downscaled from the approved app-icon master (opaque navy tile). |
| PWA icons | `danceflow-pwa-192.png`, `danceflow-pwa-512.png`, `danceflow-pwa-maskable-512.png` | Downscaled from the approved app-icon master; the symbol stays inside the 80 % maskable safe zone. |
| Icon / app-icon sources | `danceflow-icon-source-1024.png` (transparent), `danceflow-app-icon-source-1024.png` (byte copy of the approved app-icon master), `danceflow-app-icon-source-1024-reversed.png` (white symbol on `#5b145e`) | No rounded corners baked in; platforms apply their own mask. |
| Facebook / social avatar | `public/brand/icons/danceflow-social-avatar-1024.png` | 1024×1024 export of the approved 1080 avatar master (navy disc, circle-safe). |
| Open Graph / Twitter card | `public/brand/danceflow-og-1200x630.png` | Primary gradient logo centred on `--brand-surface`; no text or claims. |

The navy tile/disc colour exists only inside the approved icon and avatar rasters; it is not an application UI token.

### 5.2 Compact and descriptor lockups

A compact horizontal lockup and the "STUDIO OPERATING SYSTEM" descriptor lockup exist in the source package but are **not adopted or produced**. They require separate owner approval. Until then use the symbol for compact/narrow slots and the primary logo for full-width slots.

### 5.3 Usage rules

**Which form where**
- **Primary horizontal:** headers, footers, documents, emails, marketing where width allows.
- **Symbol only:** favicon, app icon, social avatar, sidebar/collapsed navigation, any square or narrow slot.
- **Full colour:** on white, `--brand-surface`, `--brand-primary-soft`, and other light backgrounds.
- **White / reversed:** on `--brand-primary` (`#5b145e`), `--brand-primary-dark` (`#431046`) and other saturated or dark-colour fills. The full-colour purple figure disappears on brand purple — always reverse there (this is the studio sidebar case).
- **Monochrome purple:** one-colour print, stamps, watermarks on light backgrounds.

**Minimum sizes (raster; reassess against the SVG masters)**
- Primary horizontal: 120 px wide minimum (150 px+ preferred in UI).
- Symbol: 24 px minimum, 32 px+ preferred. A 16 px favicon is acceptable.
- Below the minimums, drop the wordmark (use the symbol).

**Clear space:** `x` = the diameter of one dancer's head in the symbol. Keep 1x clear on all sides of the primary logo and 0.75x around the symbol. Clear space is a usage rule and is not baked into the files.

**Approved backgrounds:** white; `--brand-surface` (`#fff9f3`); `--brand-primary-soft` (`#f6edf7`); dark navy/neutral (full colour); brand purple (white/reversed only). Photos and busy imagery need a solid or scrimmed panel behind the logo.

**Small-screen rule:** never place the full wide logo in a square or tiny slot. Use the symbol, or the primary logo at ≥ 120 px wide.

### 5.4 Never

- Never stretch, squash, rotate or skew.
- Never recolour arbitrarily (only the approved full-colour, brand-purple and white forms).
- Never place the full wide logo into a tiny square slot (the current `object-contain` 40–80 px tiles are the anti-pattern this guide replaces).
- Never add unrelated effects (glows, drop shadows, outlines, gradients over the mark).
- Never re-typeset the wordmark.
- Never use Organizer, Competition or any other persona as a separate visual brand.
- Never mix the DanceFlow mark with another logo mark (see §5.5).

### 5.5 Reconciliation record and legacy marks

- **Earlier decision superseded (logo artwork only).** BR-1 originally fixed the dancing-couple + script logo as canonical and rejected the "Revision 3" package for production use, including its palette and fonts. The owner has since directly reviewed and approved the modern logo artwork shown in the approved review images (primary light/dark previews, primary gradient, symbol gradient, social avatar, app icon, and the Nashville promo graphic), which is the "Final Branding" (Candidate A) artwork, as the DanceFlow logo/brand family. The earlier rejection no longer applies to the visual identity. The old dancing-couple/script art is retired.
- **Still not adopted:** the package's UI palette (`#6B1FA3`, `#C2187A`, `#FF5A5F`, `#FF8A3D`, `#FFC107`, `#0E1028` as application tokens), Sora / Inter, the package tokens, the compact lockup and the descriptor lockup. Each needs its own approval. Organizer and Competition remain descriptors/capabilities of the single DanceFlow master brand, never sub-brands.
- **`DF` monogram — legacy, non-canonical.** `mobile/student/assets/danceflow-app-icon.png`, `danceflow-adaptive-foreground.png` and `danceflow-monochrome-icon.png` show a "DF" monogram. It is not a secondary DanceFlow mark and must not be propagated to any new asset.
- **Known non-compliant until the mobile branding slice:** `mobile/student/` still ships the retired couple/script logo (splash, notification icon, sign-in and home) and the DF monogram icons. The mobile app is not modified by the web correction; it is rebuilt from the approved masters (new primary/symbol, and app icon art from the approved app-icon master) in the mobile branding slice, followed by a native rebuild.
- **Future DanceFlow Business app:** nothing exists yet. It is DanceFlow-branded ("Business" is a descriptor/capability, not a separate brand); its icon kit derives from the approved app-icon master (symbol on navy tile, adaptive foreground = symbol within the safe zone, monochrome = white symbol) when it is built.

---

## 6. Visual tokens

### 6.1 Canonical palette (existing `src/app/globals.css`, `:root`)

| Variable | Value | Role |
|---|---|---|
| `--brand-primary` | `#5b145e` | Primary brand colour: primary actions, active states, headings accents, brand surfaces. |
| `--brand-primary-dark` | `#431046` | Depth: hover/pressed states, the dark end of brand gradients. |
| `--brand-primary-soft` | `#f6edf7` | Tints, selected rows, soft panels. |
| `--brand-accent` | `#d88a2d` | Warm accent: highlights, secondary emphasis, ARIA/insight moments. Use sparingly. |
| `--brand-accent-dark` | `#b86f18` | Accent on light backgrounds where contrast is needed. |
| `--brand-accent-soft` | `#f7e2c4` | Accent tint backgrounds. |
| `--brand-surface` | `#fff9f3` | Page and card background (warm off-white). |
| `--brand-border` | `#ead9cb` | Borders and dividers. |
| `--brand-text` | `#2b1b2a` | Body and heading text. |
| `--brand-muted` | `#6f5b6b` | Secondary text. |

Existing utility classes: `.brand-page-bg`, `.brand-sidebar` (`linear-gradient(180deg, #5b145e 0%, #431046 100%)`), `.brand-button-primary`, `.brand-nav-active`, `.brand-nav-idle`.

Usage: `var(--brand-primary)` is used ≈ 885 times, `--brand-border` ≈ 504, `--brand-text` ≈ 354 — the token family is already the de facto system.

### 6.2 Roles
- **Primary** carries identity and action. **Accent** is a small, deliberate counterweight, not a second primary.
- **Surface / text / muted / border** define the reading experience; body text uses `--brand-text`, secondary `--brand-muted`.
- Semantic colours (success, warning, error) are not brand colours and are outside this guide.

### 6.3 Gradients
Navy / violet / orange may be used deliberately in richer branded moments (hero, login, marketing, app-store and social artwork, the studio sidebar). Gradients must not become decoration everywhere: routine UI surfaces stay flat (`--brand-surface`, white, soft tints). One gradient family per surface; never a gradient behind body text or over the logo.

### 6.4 Migration policy (BR-1 does not replace colours)
- New and touched code uses the `--brand-*` variables (or a Tailwind alias to them), not raw hex.
- Existing hard-coded colours are migrated progressively in BR-2 (shell), BR-3 (email/PDF palettes) and BR-7 (sweep). BR-1 makes no repo-wide replacement.
- Measured drift at audit time (raw hex in `src`): `#5b197a` ≈ 115 uses (near-miss of `--brand-primary`), `#7c2d92` ≈ 95, `#a64ac9` ≈ 43, `#4b2e83` ≈ 65 (undefined), `#806f89` ≈ 53 and `#6f5a7a` ≈ 23 (near-misses of `--brand-muted`), plus the email purples (`#2e1065`, `#4c1d95`, `#6d28d9`) and PDF RGB purples. Each is mapped to a token or explicitly retired during the slice that touches it.
- Existing non-token colours already in use, recorded for the record: mobile splash navy `#071427`; dark navy `#0b1226` used only for logo-on-dark checks in this guide. Neither is a token. **No new dark-surface brand token is established in BR-1/BR-2** (deferred).

---

## 7. Typography

**Current state (audited):** no font family is loaded. There is no `next/font` import and no `font-family` in `globals.css`; pages render Tailwind's default system sans stack. Email uses Arial; generated PDFs use Helvetica; the embed script and the account-data export use Inter. The wordmark is artwork (script), not a font.

**Policy for BR-1:** document the state; introduce no font. Conceptual hierarchy: a clear display/heading style (semibold, tight tracking) for headings and a neutral sans for body and UI, on the system stack until a font decision is made. The wordmark is never typeset.

**No new production font is selected during BR-1 or BR-2.** Sora, Inter or any other family is not adopted. If a font decision is ever taken it will be a separate, explicit owner decision followed by a single `next/font` load; until then the system stack stands.

---

## 8. Vocabulary standard (initial)

| Concept | Standard |
|---|---|
| Brand | `DanceFlow`, never `Dance Flow` |
| Studio-facing customer records | `clients` |
| Student/dancer-facing language | `student` or `dancer`, according to context (student for lessons/portal/LUMI; dancer for discovery and community) |
| Assistants | `ARIA`, `LUMI` |
| `Workspace` | May describe a context ("your workspace"); not a product brand ("DanceFlow Workspace" is retired) |
| Organizer | A DanceFlow persona/capability context, not a separate brand ("Organizer Suite/Platform/Workspace" to converge on one descriptor in BR-4) |
| Competition | A capability/domain, not a separate brand |
| Auth CTAs | `Log In` (not "Sign in"), `Create Free Account` |

Not mass-renamed in BR-1. Visible remediation happens in BR-2 (shell labels) and BR-4 (public copy). Audit counts (relative signals): "Studio Portal" 13, "Organizer Workspace" 15, "DanceFlow Platform" 14, "DanceFlow Discovery" 11, "Sign in" 28 vs "Log In" 7.

---

## 9. Universal app-store brand preparation (no app decisions)

Reusable, app-agnostic rules only. The number, names and boundaries of apps are decided by the later Mobile App Architecture & Boundary Audit; no app-specific listings, names, or screenshots are created here.
- **Icon:** the symbol-only mark on a solid ground (`--brand-surface`) or reversed (white symbol on `--brand-primary`); no rounded corners baked in; keep the symbol inside the safe zone. Sources: `public/brand/icons/danceflow-app-icon-source-1024*.png`.
- **Background / gradient:** solid ground for icons; gradients only in store artwork per §6.3.
- **Logo placement:** symbol for icons and small slots; primary logo for feature graphics and headers.
- **Screenshot framing:** device frame on a `--brand-surface` or brand-gradient background, one headline per screenshot using the approved messaging, product UI shown as it exists today.
- **Typography direction:** the system stack until §7's font decision; headlines short and high-contrast.
- **Store-description framework:** lead with the approved short mission or a persona line beneath it, list only features that exist, identify the developer as GenX TotalTech LLC where the store requires it.
- **Not decided here:** app count, any Business/Organizer/Competition app naming.

---

## 10. Social channels

- **Facebook is the only social channel in the immediate relaunch.** Requirements are in `FACEBOOK_RELAUNCH_FOUNDATION.md`. The actual account inventory (URL, handle, avatar, cover, bio) is an external owner follow-up and does not block BR-1 or BR-2.
- **Instagram, LinkedIn, YouTube and TikTok are later expansion candidates.** No assets, plans or accounts are created for them here.

---

## 11. Deferred and external items

1. **Vector master** of the canonical logo — deferred; does not block BR-2.
2. **Facebook inventory** (page URL, handle, current avatar, cover, bio) — external owner follow-up.
3. **ARIA acronym expansion and pronoun cleanup** — deferred to a later copy review; ARIA stays the canonical visible assistant name.
4. **Mobile app icons** (legacy `DF` monogram) — not modified until mobile branding is planned.
5. **Dark-surface token** and **production font family** — deliberately not decided (see §6.4, §7).
6. **Legal line placement** in the product (footer, legal pages, emails, structured data) — implemented in BR-2/BR-3/BR-4. Public surfaces use the A2P-1C wording "DanceFlow is a software platform owned and operated by GenX TotalTech LLC."; email footers still use "DanceFlow is a product of GenX TotalTech LLC." until a later email cleanup.

---

## 12. Asset provenance

- Masters: `docs/brand/masters/` (SHA-256 in `SHA256SUMS.txt`).
- Derived family: `public/brand/logo/`, `public/brand/icons/` — regenerate with `node scripts/brand/build-logo-family.mjs` and check with `--verify` (requires `sharp`, installed with Next.js; reads only tracked inputs).
- Superseded/legacy (untouched in BR-1): `src/app/icon.png`, `src/app/apple-icon.png`, `src/app/favicon.ico` (wide logo padded into squares), `public/brand/danceflow-home-hero.png`, `public/brand/danceflow-path-hero.png`, `public/file.svg`, `globe.svg`, `next.svg`, `vercel.svg`, `window.svg`.
