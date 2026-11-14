/*
  Tab bar size, computed rather than left to layout. On native a tab bar with no explicit height
  collapses to its padding (the tab items are flex: 1 with no intrinsic height; the Business app
  measured 28 dp on Android 15), and a fixed height clips labels at large text sizes because the
  labels scale with the system font. Web sizes the bar from content, which hides both bugs.
*/

export const TAB_ICON_SIZE = 24;
export const TAB_LABEL_FONT_SIZE = 11;
const PADDING_TOP = 8;
const ICON_LABEL_GAP = 4;
const LABEL_LINE_FACTOR = 1.35;
const BOTTOM_EXTRA = 8;
const MIN_CONTENT = 48; // touch target
/** The bar's top border comes out of the content area (measured on the emulator: 47 dp without it). */
export const TAB_BAR_BORDER_TOP = 1;

export function tabBarMetrics(fontScale: number, insetBottom: number) {
  const scale = Math.max(1, Number.isFinite(fontScale) ? fontScale : 1);
  const label = Math.ceil(TAB_LABEL_FONT_SIZE * LABEL_LINE_FACTOR * scale);
  const content = Math.max(MIN_CONTENT, TAB_ICON_SIZE + ICON_LABEL_GAP + label);
  const paddingBottom = Math.max(0, insetBottom) + BOTTOM_EXTRA;
  return { height: TAB_BAR_BORDER_TOP + PADDING_TOP + content + paddingBottom, paddingTop: PADDING_TOP, paddingBottom };
}
