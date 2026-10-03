# Public campaign destinations

Stable public landing pages for future collateral, QR codes and launch campaigns (BR-5 and later). QR images are **not** generated yet; this note only fixes the destinations and how attribution works, so the printed URLs do not need to change.

| Audience | Destination |
|---|---|
| Studio owners | `/for-studios` |
| Independent instructors | `/for-instructors` |
| Organizers | `/for-organizers` |
| Dancers / public | `/discover` |

Base URL: `https://www.idanceflow.com`

## Tagging a link

Append any of these query parameters. Nothing else is read.

| Parameter | Use | Example |
|---|---|---|
| `utm_source` | Where the link lives | `flyer`, `banner`, `facebook` |
| `utm_medium` | The channel | `qr`, `print`, `social` |
| `utm_campaign` | The campaign | `br5-launch` |
| `utm_content` | Which piece or placement | `banner-33x81`, `postcard-a` |
| `utm_term` | Optional extra label | `booth-demo` |
| `ref` | Optional short referral code | `instructor-jane` |

Example: `https://www.idanceflow.com/for-studios?utm_source=banner&utm_medium=qr&utm_campaign=br5-launch`

Rules for values: letters, digits, spaces and `. _ ~ -` only; at most 64 characters (longer values are truncated); empty values, email-like values (`@`) and URL-like values (`://`, `//`, `www.`) are discarded. Do not put personal information in a campaign link.

## What is stored

- **First-touch only.** The first valid tagged visit sets one first-party cookie, `df_attr`, for 30 days (`Path=/`, `SameSite=Lax`, `Secure` on https). While a valid cookie exists, later tagged links and normal navigation do not change it. Latest-touch tracking is intentionally not built.
- **At signup**, the server re-validates the cookie and copies only the allowlisted values into the new account's auth user metadata as `attribution_utm_source`, `attribution_utm_medium`, `attribution_utm_campaign`, `attribution_utm_content`, `attribution_utm_term`, `attribution_ref` and `attribution_captured_on`. No database column or migration is involved.
- The full landing URL and the HTTP referrer are never stored, and nothing is sent to a third party.

Implementation: `src/lib/public/attribution.ts` (rules), `src/components/public/AttributionCapture.tsx` (one capture point in the shared public header), `src/lib/public/attributionServer.ts` and the signup action (metadata).
