/*
  Art for an event or moment when there is no photo. The design direction calls for
  photography of everyday adults social dancing; until licensed or commissioned photos exist,
  events use their own image when the API returns one and otherwise this brand-token gradient
  with the style's initials. Never stock imagery.
*/

/**
 * Amber ink at the top (behind the decorative initials), brand plum and plum dark at the bottom where
 * text sits: fixed brand colours, so hero text reads the same in both themes. Draw it top to bottom.
 */
export const EVENT_ART_GRADIENT = ["#8A5210", "#5B145E", "#431046"] as const;
/** The stops text is drawn over (the lower two). */
export const EVENT_ART_TEXT_STOPS = ["#5B145E", "#431046"] as const;
export const EVENT_ART_START = { x: 0, y: 0 };
export const EVENT_ART_END = { x: 0.35, y: 1 };

/** Text drawn on event art or on a photo's dark scrim. Checked against every gradient stop. */
export const EVENT_ART_TEXT = "#FBF3EE";
export const EVENT_ART_TEXT_MUTED = "#E4D6E0";
export const EVENT_ART_ACCENT = "#F0B15E";

/** Scrim laid over a photo so overlaid text keeps contrast whatever the photo. */
export const PHOTO_SCRIM = ["rgba(24,12,27,0)", "rgba(24,12,27,0.94)"] as const;

/** Up to two letters for the art: the style or category first ("Salsa & Bachata" -> "SB"), else the name. */
export function styleInitials(...labels: Array<string | null | undefined>) {
  for (const label of labels) {
    const words = (label ?? "")
      .split(/[\s&/,+-]+/)
      .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
      .filter((word) => word.length > 0 && !/^(and|the|of|a|an|with|at|night|social|dance)$/i.test(word));
    if (words.length > 0) return words.slice(0, 2).map((word) => word[0]!.toUpperCase()).join("");
  }
  return "DF";
}
