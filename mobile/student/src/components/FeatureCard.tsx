import { StyleSheet, useColorScheme, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { AppText } from "@/components/AppText";
import { colorsForScheme } from "@/constants/theme";

type FeatureCardProps = {
  title: string;
  detail: string;
  label?: string;
};

export function FeatureCard({ title, detail, label }: FeatureCardProps) {
  const colors = colorsForScheme(useColorScheme());

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          shadowColor: colors.black,
        },
      ]}
    >
      <LinearGradient colors={colors.brandGradient} style={styles.accentBar} />
      {label ? <AppText variant="eyebrow">{label}</AppText> : null}
      <AppText variant="subtitle">{title}</AppText>
      <AppText variant="caption">{detail}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 22,
    borderWidth: 1,
    elevation: 2,
    gap: 8,
    overflow: "hidden",
    padding: 18,
    paddingTop: 22,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.07,
    shadowRadius: 16,
  },
  accentBar: {
    borderRadius: 999,
    height: 5,
    left: 18,
    position: "absolute",
    top: 0,
    width: 68,
  },
});
