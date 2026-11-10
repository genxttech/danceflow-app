import type React from "react";
import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { AppText } from "@/components/AppText";
import { EVENT_ART_END, EVENT_ART_GRADIENT, EVENT_ART_START, PHOTO_SCRIM, styleInitials } from "@/lib/eventArt";

type EventArtProps = {
  imageUrl?: string | null;
  /** Labels the initials are taken from, most specific first (style, category, name). */
  labels: Array<string | null | undefined>;
  height: number;
  radius?: number;
  /** Text and controls drawn over the art, at the bottom, on a dark scrim. */
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** An event's own photo, or the brand fallback: a token gradient with the style's initials. Decorative. */
export function EventArt({ imageUrl, labels, height, radius = 20, children, style, testID }: EventArtProps) {
  return (
    <View style={[styles.frame, { borderRadius: radius, height }, style]} testID={testID}>
      {imageUrl ? (
        <Image
          accessibilityIgnoresInvertColors
          accessible={false}
          resizeMode="cover"
          source={{ uri: imageUrl }}
          style={StyleSheet.absoluteFill}
          testID="event-art-photo"
        />
      ) : (
        <LinearGradient
          colors={EVENT_ART_GRADIENT}
          end={EVENT_ART_END} start={EVENT_ART_START}
          style={StyleSheet.absoluteFill}
          testID="event-art-fallback"
        >
          <AppText
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.initials, { fontSize: Math.min(120, Math.round(height * 0.42)) }]}
          >
            {styleInitials(...labels)}
          </AppText>
        </LinearGradient>
      )}
      {children ? (
        <LinearGradient colors={PHOTO_SCRIM} style={styles.scrim}>
          {children}
        </LinearGradient>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: "hidden", position: "relative" },
  initials: {
    color: "rgba(251,243,238,0.22)",
    fontWeight: "800",
    letterSpacing: -2,
    position: "absolute",
    right: 16,
    top: 6
  },
  scrim: { bottom: 0, gap: 4, left: 0, paddingBottom: 16, paddingHorizontal: 16, paddingTop: 48, position: "absolute", right: 0 }
});
