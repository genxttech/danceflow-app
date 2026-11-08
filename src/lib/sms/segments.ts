/**
 * SMS segment estimation for billing reservations. Conservative on purpose: the reservation must cover what the provider will count, so
 *  - a body is GSM-7 only if EVERY character is in the GSM 03.38 basic set or its extension table (extension characters take two septets);
 *  - anything else is UCS-2, counted in UTF-16 code units (an emoji is two);
 *  - concatenated messages use the reduced per-part capacity (153 septets / 67 code units).
 * The provider's own `num_segments` (evidence) is what is finally charged; this only sizes the reservation.
 */

const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENSION = "^{}\\[~]|€\f";
const BASIC = new Set(Array.from(GSM_BASIC));
const EXTENSION = new Set(Array.from(GSM_EXTENSION));

/** The most segments one billed message may have; longer bodies are refused before any reservation. */
export const MAX_BILLED_SEGMENTS = 10;

export type SegmentEstimate = { encoding: "gsm7" | "ucs2"; units: number; segments: number };

export function estimateBilledSegments(body: string): SegmentEstimate {
  let septets = 0;
  let gsm = true;
  let escaped = false;
  for (const ch of Array.from(body)) {
    if (BASIC.has(ch)) septets += 1;
    else if (EXTENSION.has(ch)) {
      septets += 2;
      escaped = true;
    }
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) {
    // an escape pair is never split across parts, so a part holding one may carry a septet less
    const segments = septets === 0 ? 0 : septets <= 160 ? 1 : Math.ceil(septets / (escaped ? 152 : 153));
    return { encoding: "gsm7", units: septets, segments };
  }
  const units = body.length; // UTF-16 code units
  const segments = units === 0 ? 0 : units <= 70 ? 1 : Math.ceil(units / 67);
  return { encoding: "ucs2", units, segments };
}
