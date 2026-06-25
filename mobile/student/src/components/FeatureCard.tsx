import { StyleSheet, View } from "react-native";
import { AppText } from "@/components/AppText";
import { colors } from "@/constants/theme";

type FeatureCardProps = {
  title: string;
  detail: string;
  label?: string;
};

export function FeatureCard({ title, detail, label }: FeatureCardProps) {
  return (
    <View style={styles.card}>
      {label ? <AppText variant="eyebrow">{label}</AppText> : null}
      <AppText variant="subtitle">{title}</AppText>
      <AppText variant="caption">{detail}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    gap: 8,
    padding: 18
  }
});
