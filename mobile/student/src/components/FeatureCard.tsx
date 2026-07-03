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
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <LinearGradient colors={colors.brandGradient} style={styles.accentBar} />
      {label ? <AppText variant="eyebrow">{label}</AppText> : null}
      <AppText variant="subtitle">{title}</AppText>
      <AppText variant="caption">{detail}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 18,
    borderWidth: 1,
    gap: 8,
    overflow: "hidden",
    padding: 18,
    paddingTop: 22
  },
  accentBar: {
    height: 4,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0
  }
});
