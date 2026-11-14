/**
 * SMS segment estimation for billing reservations. Conservative on purpose: the reservation must cover what the provider will count, so
 *  - a body is GSM-7 only if EVERY character is in the GSM 03.38 basic set or its extension table (extension characters take two septets);
 *  - anything else is UCS-2, counted in UTF-16 code units (an emoji is two);
 *  - concatenated messages use the reduced per-part capacity (153 septets / 67 code units; a UCS-2 character cluster such as an emoji is never split across parts).
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

/** True when `cp` attaches to the cluster before it: ZWJ, variation selectors, keycap, skin tones, tag characters, combining marks. */
function joinsPrevious(cp: number): boolean {
  return cp === 0x200d || cp === 0xfe0e || cp === 0xfe0f || cp === 0x20e3 || (cp >= 0x1f3fb && cp <= 0x1f3ff) || (cp >= 0xe0020 && cp <= 0xe007f) || (cp >= 0x300 && cp <= 0x36f);
}

/**
 * UCS-2 parts for a body longer than one part: 67 UTF-16 units each, packed greedily, never splitting a character cluster (an emoji with its modifiers, a ZWJ sequence,
 * a flag, a keycap, a base with combining marks): a cluster that does not fit what is left of a part starts the next one. Same rule and order as the SQL _tw4us_segments
 * (migration 20270217090000), including "more than 10 parts is 11" (the caller refuses 1..10 only).
 */
function ucs2Parts(body: string): number {
  let parts = 1;
  let used = 0;
  let cluster = 0;
  let afterZwj = false;
  let riOpen = false;
  let first = true;
  const place = () => {
    if (used + cluster > 67) {
      parts += 1;
      used = cluster;
    } else used += cluster;
  };
  for (const ch of body) {
    const cp = ch.codePointAt(0) as number;
    const isRi = cp >= 0x1f1e6 && cp <= 0x1f1ff;
    const join: boolean = !first && (afterZwj || joinsPrevious(cp) || (isRi && riOpen));
    riOpen = isRi && !(riOpen && join);
    afterZwj = cp === 0x200d;
    first = false;
    const w = cp > 0xffff ? 2 : 1;
    if (join) cluster += w;
    else {
      if (cluster > 0) {
        place();
        if (parts > 10) return 11;
      }
      cluster = w;
    }
  }
  if (used + cluster > 67) parts += 1;
  return Math.min(parts, 11);
}

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
  const segments = units === 0 ? 0 : units <= 70 ? 1 : ucs2Parts(body);
  return { encoding: "ucs2", units, segments };
}
