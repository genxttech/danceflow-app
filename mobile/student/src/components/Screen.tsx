import { useEffect, useRef, useState } from "react";
import type React from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  useColorScheme,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { colorsForScheme } from "@/constants/theme";

type ScreenProps = {
  children: React.ReactNode;
  scroll?: boolean;
  style?: ViewStyle;
  refreshing?: boolean;
  onRefresh?: () => void;
  /**
   * Android only, for a form that ends the screen: the scroll area shrinks to sit above the open
   * keyboard and scrolls to its end. iOS relies on automaticallyAdjustKeyboardInsets.
   */
  keepEndAboveKeyboard?: boolean;
};

export function Screen({
  children,
  scroll = true,
  style,
  refreshing = false,
  onRefresh,
  keepEndAboveKeyboard = false,
}: ScreenProps) {
  const colors = colorsForScheme(useColorScheme());
  const { width } = useWindowDimensions();
  const contentWidthStyle = width >= 900 ? styles.contentWide : null;
  const scrollRef = useRef<ScrollView>(null);
  // Android draws edge to edge, so the window does not resize for the keyboard.
  const avoidKeyboard = keepEndAboveKeyboard && Platform.OS === "android";
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    if (!avoidKeyboard) return;
    const shown = Keyboard.addListener("keyboardDidShow", () => setKeyboardOpen(true));
    const hidden = Keyboard.addListener("keyboardDidHide", () => setKeyboardOpen(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, [avoidKeyboard]);

  const content = (
    <View style={[styles.content, contentWidthStyle, style]}>{children}</View>
  );

  // Asked after the scroll area or its content is resized, one frame later: on a device, asking
  // only as the area resized stopped short of the end at large text.
  const scrollToEndAboveKeyboard = () => {
    requestAnimationFrame(() => {
      if (Keyboard.isVisible()) scrollRef.current?.scrollToEnd();
    });
  };

  const scrollView = (
    <ScrollView
      ref={scrollRef}
      onLayout={avoidKeyboard ? scrollToEndAboveKeyboard : undefined}
      onContentSizeChange={avoidKeyboard ? scrollToEndAboveKeyboard : undefined}
      contentContainerStyle={styles.scrollContent}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      automaticallyAdjustsScrollIndicatorInsets
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        ) : undefined
      }
      showsVerticalScrollIndicator={false}
    >
      {content}
    </ScrollView>
  );

  return (
    <LinearGradient colors={colors.appBackgroundGradient} style={styles.gradient}>
      <SafeAreaView style={styles.safe}>
        {!scroll ? (
          content
        ) : avoidKeyboard ? (
          // Padding only while open: after the keyboard hides, Android's hide event still leaves
          // KeyboardAvoidingView with a strip of padding the height of a system bar.
          <KeyboardAvoidingView
            behavior={keyboardOpen ? "padding" : undefined}
            style={styles.keyboardArea}
          >
            {scrollView}
          </KeyboardAvoidingView>
        ) : (
          scrollView
        )}
      </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  gradient: {
    flex: 1,
  },
  safe: {
    backgroundColor: "transparent",
    flex: 1,
  },
  keyboardArea: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  content: {
    alignSelf: "center",
    flexGrow: 1,
    gap: 16,
    maxWidth: "100%",
    paddingBottom: 32,
    paddingHorizontal: 18,
    paddingTop: 16,
    width: "100%",
  },
  contentWide: {
    maxWidth: 760,
  },
});
