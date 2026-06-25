import { Link } from "expo-router";
import { Image, StyleSheet, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";

const lumiAvatar = require("../../assets/lumi-avatar.png");

export default function LearnScreen() {
  return (
    <Screen>
      <AppText variant="eyebrow">Learn</AppText>
      <AppText variant="title">Recaps and syllabus</AppText>
      <AppText variant="caption">
        Student-visible learning history belongs here, separate from staff-only notes.
      </AppText>

      <FeatureCard
        title="Lesson recaps"
        detail="Display instructor-approved summaries, practice assignments, and follow-up items."
      />
      <FeatureCard
        title="Syllabus progress"
        detail="Show curriculum levels, completed skills, in-progress material, and next recommendations."
      />

      <View style={styles.lumiCard}>
        <Image
          accessibilityIgnoresInvertColors
          resizeMode="cover"
          source={lumiAvatar}
          style={styles.lumiAvatar}
        />
        <View style={styles.lumiCopy}>
          <AppText variant="eyebrow">LUMI</AppText>
          <AppText variant="title">Practice coach</AppText>
          <AppText variant="caption">
            LUMI can help turn lesson recaps and syllabus progress into focused
            practice goals.
          </AppText>
          <Link href="/lumi" asChild>
            <AppButton label="Ask LUMI what to practice" variant="secondary" />
          </Link>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  lumiAvatar: {
    borderRadius: 34,
    height: 68,
    width: 68
  },
  lumiCard: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderRadius: 18,
    flexDirection: "row",
    gap: 14,
    padding: 16
  },
  lumiCopy: {
    flex: 1,
    gap: 8
  }
});
