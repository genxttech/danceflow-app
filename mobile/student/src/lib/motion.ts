import { useEffect } from "react";
import {
  Easing,
  FadeIn,
  FadeInDown,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming
} from "react-native-reanimated";

/*
  The core motion set (docs/mobile/Mobile_Design_Direction.md: transform and opacity on the UI
  thread; with Reduce Motion on, movement becomes a fade or nothing). Screens use these
  presets instead of their own timings.
*/

export const durations = { quick: 120, standard: 220, emphasized: 320, pulse: 900 } as const;
export const standardEasing = Easing.bezier(0.2, 0, 0, 1);

/** Content arriving: rises 8pt while fading in; a plain short fade with Reduce Motion. */
export function enterUp(reducedMotion: boolean, delay = 0) {
  return reducedMotion
    ? FadeIn.duration(durations.quick).delay(delay)
    : FadeInDown.duration(durations.standard).delay(delay).easing(standardEasing).withInitialValues({ transform: [{ translateY: 8 }] });
}

export function useEnterUp(delay = 0) {
  return enterUp(useReducedMotion(), delay);
}

/** Press feedback: a slight scale while held, or none with Reduce Motion (the opacity change stays). */
export function pressedTransform(reducedMotion: boolean) {
  return reducedMotion ? [] : [{ scale: 0.985 }];
}

/** Skeleton pulse between 0.45 and 1 opacity; held still at 0.7 with Reduce Motion. */
export function usePulse() {
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(reducedMotion ? 0.7 : 0.45);

  useEffect(() => {
    if (reducedMotion) {
      opacity.set(0.7);
      return;
    }
    opacity.set(withRepeat(withTiming(1, { duration: durations.pulse, easing: Easing.inOut(Easing.quad) }), -1, true));
    return () => cancelAnimation(opacity);
  }, [opacity, reducedMotion]);

  return useAnimatedStyle(() => ({ opacity: opacity.value }));
}
