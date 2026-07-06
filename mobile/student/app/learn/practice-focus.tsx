import { Link, type Href } from "expo-router";
import { useEffect, useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess, type LinkedStudioAccess } from "@/lib/studentAccess";
import {
  loadStudentLearnOverview,
  type StudentLearnOverview,
  type StudentPracticeFocus
} from "@/lib/studentLearn";

const lumiAvatar = require("../../assets/lumi-avatar.png");

const emptyOverview: StudentLearnOverview = {
  recentLessons: [],
  groupLessonRecaps: [],
  practiceFocus: [],
  syllabi: [],
  lumiPrompts: [
    "What should I practice this week?",
    "How do I set a dance goal?",
    "How can I feel more confident at my next lesson?"
  ]
};

function lumiPromptHref(prompt: string): Href {
  return {
    pathname: "/lumi",
    params: { prompt }
  } as Href;
}

function FocusCard({ focus }: { focus: StudentPracticeFocus }) {
  return (
    <View style={styles.itemCard}>
      <AppText variant="subtitle">{focus.title}</AppText>
      <AppText variant="caption">{focus.detail}</AppText>
    </View>
  );
}

export default function PracticeFocusScreen() {
  const { session } = useAuth();
  const [loading, setLoading] = useState(true);
  const [linkedStudios, setLinkedStudios] = useState<LinkedStudioAccess[]>([]);
  const [overview, setOverview] = useState<StudentLearnOverview>(emptyOverview);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const userId = session?.user.id;

    async function load() {
      if (!userId) {
        setLinkedStudios([]);
        setOverview(emptyOverview);
        setLoading(false);
        return;
      }

      setLoading(true);
      setErrorMessage(null);

      try {
        const access = await getStudentAccess(userId);
        const learnOverview = await loadStudentLearnOverview(access.linkedStudios);

        if (!mounted) return;
        setLinkedStudios(access.linkedStudios);
        setOverview(learnOverview);
      } catch {
        if (!mounted) return;
        setErrorMessage("Practice focus could not be loaded yet. Try again in a moment.");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();

    return () => {
      mounted = false;
    };
  }, [session?.user.id]);

  const hasPortalAccess = linkedStudios.length > 0;

  return (
    <Screen>
      <AppText variant="eyebrow">Learn</AppText>
      <AppText variant="title">Practice Focus</AppText>
      <AppText variant="caption">
        Turn recent lessons and recaps into a short list of things to work on next.
      </AppText>

      {loading ? <FeatureCard title="Loading practice focus" detail="Checking your recent lessons." /> : null}
      {errorMessage ? <FeatureCard title="Practice focus unavailable" detail={errorMessage} /> : null}

      {!loading && !hasPortalAccess ? (
        <FeatureCard
          title="Connect with a studio"
          detail="Practice focus becomes more useful after your studio connects lessons, recaps, and progress."
        />
      ) : null}

      {!loading && hasPortalAccess ? (
        <View style={styles.section}>
          {overview.practiceFocus.map((focus) => (
            <FocusCard key={focus.id} focus={focus} />
          ))}

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
                LUMI can turn recent lessons and upcoming goals into a focused practice plan.
              </AppText>
              <View style={styles.promptList}>
                {overview.lumiPrompts.slice(0, 2).map((prompt) => (
                  <Link key={prompt} href={lumiPromptHref(prompt)} asChild>
                    <AppButton label={prompt} variant="secondary" />
                  </Link>
                ))}
              </View>
              <Link href={lumiPromptHref(overview.lumiPrompts[0] ?? "What should I practice this week?")} asChild>
                <AppButton label="Ask LUMI what to practice" variant="secondary" />
              </Link>
            </View>
          </View>
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  itemCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    gap: 6,
    padding: 14
  },
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
  },
  promptList: {
    gap: 8
  },
  section: {
    gap: 10
  }
});
