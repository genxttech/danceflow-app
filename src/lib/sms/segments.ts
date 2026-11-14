/**
 * SMS segment estimation for billing reservations. Same rule and order as the SQL _tw4us_segments (migration 20270217090000); the reference is Twilio's segment
 * calculator (TwilioDevEd/message-segment-calculator): a part is 140 octets, a concatenated part carries a 6-octet header, and a character never splits across parts.
 *  - GSM-7 only if EVERY character is in the GSM 03.38 basic set or its extension table (extension characters take two septets and are never split): 160 septets
 *    in one part, otherwise 153 per part, packed greedily.
 *  - Anything else is UCS-2, counted in UTF-16 code units (an emoji is two): 70 units in one part, otherwise 67 per part, packed greedily by character cluster:
 *    a cluster that does not fit what is left of a part starts the next one.
 * Clusters: a cluster breaks only before a character that always starts a new grapheme (Latin, Greek, Cyrillic, Hebrew, Arabic, Devanagari and Thai letters, CJK,
 * kana, Hangul syllables, punctuation, symbols, emoji bases), and never after a ZWJ, a prepended mark, a Devanagari virama or a leading Hangul jamo; regional
 * indicators pair into flags. Every other character joins the cluster before it. For English, emoji and GSM-7 text this is exactly Twilio's grapheme split (CR and
 * LF stay separate characters, as in Twilio's calculator). Elsewhere a cluster may be coarser than a grapheme (up to a word in other scripts), which can only add
 * parts, never remove them. A cluster longer than 67 units (unspaced complex-script text)
 * is sized at 34 units per part, which holds while no single grapheme exceeds 34 units.
 * The count is exact (not capped); callers refuse more than MAX_BILLED_SEGMENTS. The provider's own `num_segments` (evidence) is what is finally charged; this only
 * sizes the reservation.
 */

const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENSION = "^{}\\[~]|€\f";
const BASIC = new Set(Array.from(GSM_BASIC));
const EXTENSION = new Set(Array.from(GSM_EXTENSION));

/** The most segments one billed message may have; longer bodies are refused before any reservation. */
export const MAX_BILLED_SEGMENTS = 10;

export type SegmentEstimate = { encoding: "gsm7" | "ucs2"; units: number; segments: number };

/** Code points that always start a new grapheme (none is Extend, SpacingMark, ZWJ, Prepend, a Hangul V/T jamo or a regional indicator). Mirrored in SQL. */
const STARTERS: readonly [number, number][] = [
  [0x0000, 0x02ff], [0x0370, 0x0482], [0x048a, 0x052f],
  [0x05be, 0x05be], [0x05c0, 0x05c0], [0x05c3, 0x05c3], [0x05c6, 0x05c6], [0x05d0, 0x05f4], // Hebrew letters and punctuation (not points)
  [0x0606, 0x060f], [0x061b, 0x064a], [0x0660, 0x066f], [0x0671, 0x06d5], [0x06de, 0x06de], [0x06e5, 0x06e6], [0x06e9, 0x06e9], [0x06ee, 0x06ff], // Arabic (not harakat)
  [0x0904, 0x0939], [0x093d, 0x093d], [0x0950, 0x0950], [0x0958, 0x0961], [0x0964, 0x097f], // Devanagari (not vowel signs, virama, nukta)
  [0x0e01, 0x0e30], [0x0e32, 0x0e32], [0x0e3f, 0x0e46], [0x0e4f, 0x0e5b], // Thai (not vowel or tone marks)
  [0x1e00, 0x1eff], [0x2000, 0x200b], [0x200e, 0x20cf], [0x2100, 0x2bff],
  [0x3000, 0x3029], [0x3030, 0x3096], [0x30a0, 0x30ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xff01, 0xff9d],
  [0x1f000, 0x1f1e5], [0x1f200, 0x1f3fa], [0x1f400, 0x1faff],
];

/** Code points the next character always joins: ZWJ, Prepend marks, the Devanagari virama (conjuncts), leading Hangul jamo. Mirrored in SQL. */
const JOINS_NEXT: readonly [number, number][] = [
  [0x0600, 0x0605], [0x06dd, 0x06dd], [0x070f, 0x070f], [0x0890, 0x0891], [0x08e2, 0x08e2], [0x094d, 0x094d], [0x0d4e, 0x0d4e], [0x1100, 0x115f], [0x200d, 0x200d], [0xa960, 0xa97c],
  [0x110bd, 0x110bd], [0x110cd, 0x110cd], [0x111c2, 0x111c3], [0x1193f, 0x1193f], [0x11941, 0x11941], [0x11a3a, 0x11a3a], [0x11a84, 0x11a89], [0x11d46, 0x11d46],
  [0x11f02, 0x11f02],
];

const inRanges = (cp: number, ranges: readonly [number, number][]) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
const isRegionalIndicator = (cp: number) => cp >= 0x1f1e6 && cp <= 0x1f1ff;

/** UCS-2 parts for a body longer than one part (see the header). */
function ucs2Parts(body: string): number {
  let parts = 1;
  let used = 0;
  let cluster = 0;
  let joinNext = false;
  let riOpen = false;
  const place = () => {
    if (cluster > 67) {
      if (used > 0) parts += 1;
      parts += Math.ceil(cluster / 34) - 1;
      used = 67;
    } else if (used + cluster > 67) {
      parts += 1;
      used = cluster;
    } else used += cluster;
  };
  for (const ch of body) {
    const cp = ch.codePointAt(0) as number;
    const ri = isRegionalIndicator(cp);
    const join: boolean = cluster > 0 && (joinNext || (ri ? riOpen : !inRanges(cp, STARTERS)));
    riOpen = ri && !(riOpen && join);
    joinNext = inRanges(cp, JOINS_NEXT);
    if (!join && cluster > 0) {
      place();
      cluster = 0;
    }
    cluster += cp > 0xffff ? 2 : 1;
  }
  place();
  return parts;
}

/** GSM-7 parts for a body longer than one part: 153 septets each, an extension character (two septets) never split. */
function gsmParts(widths: number[]): number {
  let parts = 1;
  let used = 0;
  for (const w of widths) {
    if (used + w > 153) {
      parts += 1;
      used = w;
    } else used += w;
  }
  return parts;
}

export function estimateBilledSegments(body: string): SegmentEstimate {
  const widths: number[] = [];
  let gsm = true;
  for (const ch of body) {
    if (BASIC.has(ch)) widths.push(1);
    else if (EXTENSION.has(ch)) widths.push(2);
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) {
    const septets = widths.reduce((a, w) => a + w, 0);
    return { encoding: "gsm7", units: septets, segments: septets === 0 ? 0 : septets <= 160 ? 1 : gsmParts(widths) };
  }
  const units = body.length; // UTF-16 code units
  return { encoding: "ucs2", units, segments: units === 0 ? 0 : units <= 70 ? 1 : ucs2Parts(body) };
}
