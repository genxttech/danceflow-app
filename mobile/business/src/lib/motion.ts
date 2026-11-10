import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/*
  Motion rules from the design direction: motion confirms an action and gets out of the way, and when the person
  has Reduce Motion on, movement is replaced with a fade. The app's only animation today is the stack screen
  transition (spinners and pull-to-refresh are system controls), so this is where the rule is applied.
*/

/** Native-stack animation for the current Reduce Motion setting. */
export function stackAnimation(reduceMotion: boolean): "fade" | "default" {
  return reduceMotion ? "fade" : "default";
}

/** Tracks the system Reduce Motion setting, including changes while the app is open. Starts false until the system answers. */
export function useReduceMotion() {
  const [reduce, setReduce] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (mounted) setReduce(value);
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => setReduce(value));
    return () => {
      mounted = false;
      subscription?.remove();
    };
  }, []);

  return reduce;
}
