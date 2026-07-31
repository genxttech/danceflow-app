import type React from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import {
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
};

export function Screen({
  children,
  scroll = true,
  style,
  refreshing = false,
  onRefresh,
}: ScreenProps) {
  const colors = colorsForScheme(useColorScheme());
  const { width } = useWindowDimensions();
  const contentWidthStyle = width >= 900 ? styles.contentWide : null;

  const content = (
    <View style={[styles.content, contentWidthStyle, style]}>{children}</View>
  );

  return (
    <LinearGradient colors={colors.appBackgroundGradient} style={styles.gradient}>
      <SafeAreaView style={styles.safe}>
        {scroll ? (
          <ScrollView
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
        ) : (
          content
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
