import { useEffect, useState } from "react";
import { Dimensions, PixelRatio } from "react-native";

/*
  The system text size, tracked after the first layout and whenever the window metrics change.

  Android measures text with the font scale in force when a view is laid out. A release build installed with a large text
  size (and any change of the size while the app is open) can leave some views measured at 1.0 while their glyphs draw at
  the real scale, so labels and button text are clipped to a 1.0-sized box (seen on the emulator at 2.0, release build).
  Keying the navigator by this value rebuilds the screens, and so their layout, when the scale differs from the one they
  were first laid out with.
*/
export function useFontScale() {
  const [scale, setScale] = useState(() => PixelRatio.getFontScale());

  useEffect(() => {
    const read = () => setScale(PixelRatio.getFontScale());
    read(); // after the first layout: the value can differ from the one read while the module graph was loading
    const subscription = Dimensions.addEventListener("change", read);
    return () => subscription.remove();
  }, []);

  return scale;
}
