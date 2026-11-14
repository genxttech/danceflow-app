import type React from "react";
import { Dimensions, PixelRatio, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * Development-only layout diagnostics for device QA (the Android 15 edge-to-edge tab bar investigation).
 * Off unless Metro starts with EXPO_PUBLIC_LAYOUT_DEBUG=1; when off it renders its children untouched, so it can
 * never change a release layout. When on, it wraps the children in a flex:1 View and logs, to logcat
 * (adb logcat -s ReactNativeJS), the container's measured size next to the window, screen, insets and font scale.
 */
export const LAYOUT_DEBUG = __DEV__ && process.env.EXPO_PUBLIC_LAYOUT_DEBUG === "1";

function Probe({ name, children }: { name: string; children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={styles.fill}
      onLayout={(event) => {
        const { width, height, y } = event.nativeEvent.layout;
        const win = Dimensions.get("window");
        const screen = Dimensions.get("screen");
        console.log(
          `[layout] ${name} container=${Math.round(width)}x${Math.round(height)}@y${Math.round(y)} window=${Math.round(win.width)}x${Math.round(win.height)} screen=${Math.round(screen.width)}x${Math.round(screen.height)} insets=t${insets.top}/b${insets.bottom} fontScale=${PixelRatio.getFontScale()}`,
        );
      }}
    >
      {children}
    </View>
  );
}

export function LayoutProbe({ name, children }: { name: string; children: React.ReactNode }) {
  if (!LAYOUT_DEBUG) return <>{children}</>;
  return <Probe name={name}>{children}</Probe>;
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
