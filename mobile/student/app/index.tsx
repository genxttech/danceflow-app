import { useMemo } from "react";
import { ActivityIndicator, StyleSheet, useColorScheme, View } from "react-native";
import { Redirect } from "expo-router";
import { colorsForScheme, type ThemeColors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";

export default function IndexScreen() {
  const colors = colorsForScheme(useColorScheme());
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { loading, session } = useAuth();

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  return session ? <Redirect href="/(tabs)/home" /> : <Redirect href="/(auth)/sign-in" />;
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    loading: {
      alignItems: "center",
      backgroundColor: colors.background,
      flex: 1,
      justifyContent: "center"
    }
  });
}
