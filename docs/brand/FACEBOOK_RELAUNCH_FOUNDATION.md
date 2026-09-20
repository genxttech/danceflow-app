# Facebook Relaunch Foundation (BR-1)

Facebook is the only social channel in the immediate relaunch. Instagram, LinkedIn, YouTube and TikTok are later-expansion candidates and are not covered here.
This document holds reusable requirements only. No Facebook account was accessed or modified, and no external account exists in the repository.

## External inventory (owner to supply — nothing invented)

| Item | Value |
|---|---|
| Page URL | _owner to supply_ |
| Handle / username | _owner to supply_ |
| Current avatar | _owner to supply (screenshot or file)_ |
| Current cover | _owner to supply_ |
| Current bio / About text | _owner to supply_ |
| Page category, contact details | _owner to supply_ |
| Admin roles / who publishes | _owner to supply_ |

## Avatar

- Source: `public/brand/icons/danceflow-social-avatar-1024.png` — the symbol-only couple mark centred on `--brand-surface` (`#fff9f3`), circle-safe (symbol fills ≈ 64 % of the square).
- Do not use the wide primary logo or the wordmark in the avatar (illegible at avatar size, and Facebook crops to a circle).
- Alternate for dark contexts: `danceflow-app-icon-source-1024-reversed.png` (white symbol on brand purple).

## Cover / banner

- Composition: brand-consistent panel (`--brand-surface` or a restrained brand gradient per the guide §6.3) with the **primary horizontal logo** on one side and space for one approved line of copy on the other.
- Copy: the approved short mission ("DanceFlow helps run the studio, so you can focus on teaching.") or the positioning line ("Software that helps do the work—not just track it."). No rewritten variants.
- Layout guidance (platform convention — re-verify against Facebook's current specs at production time): design at 2x (about 1640×624) and keep essential content in the central safe area, because desktop and mobile crop differently.
- Use the full-colour primary logo on light grounds, the white version on `--brand-primary`.

## Bio / About message framework

Use approved copy only.
1. **Line 1 (short mission, verbatim):** DanceFlow helps run the studio, so you can focus on teaching.
2. **Line 2 (persona-neutral description, to be written in BR-5 from approved language):** who it serves — studios and independent instructors first, then organizers and dancers.
3. **Link:** `https://www.idanceflow.com` (canonical host; no tracking parameters in the profile link).
4. **Legal/contact:** support address `support@idanceflow.com` as already used by the product; legal entity shown where Facebook's About fields require it ("DanceFlow is a product of GenX TotalTech LLC").

## Pinned relaunch post framework (BR-5 content)

- One image: the primary logo or a branded graphic on `--brand-surface`.
- Headline: the approved short mission.
- Body: what is new in plain language, only features that exist in production today; no unreleased capabilities.
- One call to action to `https://www.idanceflow.com`.
- Pinned until launch-week content replaces it.

## Preconditions

- The logo family in `public/brand/` (this slice).
- Approved copy in the brand guide §2.
- Owner inventory above.
- Website destination ready (BR-4) before driving traffic.
