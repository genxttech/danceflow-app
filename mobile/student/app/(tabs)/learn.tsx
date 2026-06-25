import { Link } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";

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

      <Link href="/lumi" asChild>
        <AppButton label="Ask LUMI what to practice" variant="secondary" />
      </Link>
    </Screen>
  );
}
