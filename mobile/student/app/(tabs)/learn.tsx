import { Link } from "expo-router";
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
  type StudentLearnLesson,
  type StudentLearnOverview,
  type StudentPracticeFocus
} from "@/lib/studentLearn";

const lumiAvatar = require("../../assets/lumi-avatar.png");

const emptyOverview: StudentLearnOverview = {
  recentLessons: [],
  practiceFocus: [],
  lumiPrompts: [
    "What should I practice this week?",
    "How do I set a dance goal?",
    "How can I feel more confident at my next lesson?"
  ]
};

function LessonCard({ lesson }: { lesson: StudentLearnLesson }) {
  const detail = [
    lesson.studioName,
    lesson.instructorName ? `Instructor: ${lesson.instructorName}` : null,
    lesson.roomName
  ]
    .filter(Boolean)
    .join(" • ");

  return (
    <View style={styles.itemCard}>
      <AppText variant="eyebrow">{lesson.typeLabel}</AppText>
      <AppText variant="subtitle">{lesson.title}</AppText>
      <AppText variant="caption">{lesson.timeText}</AppText>
      {detail ? <AppText variant="caption">{detail}</AppText> : null}
    </View>
  );
}

function FocusCard({ focus }: { focus: StudentPracticeFocus }) {
  return (
    <View style={styles.itemCard}>
      <AppText variant="subtitle">{focus.title}</AppText>
      <AppText variant="caption">{focus.detail}</AppText>
    </View>
  );
}

function LearnValueCard({ signedIn }: { signedIn: boolean }) {
  return (
    <>
      <View style={styles.lumiCard}>
        <Image
          accessibilityIgnoresInvertColors
          resizeMode="cover"
          source={lumiAvatar}
          style={styles.lumiAvatar}
        />
        <View style={styles.lumiCopy}>
          <AppText variant="eyebrow">Meet LUMI</AppText>
          <AppText variant="title">Your practice coach</AppText>
          <AppText variant="caption">
            When your studio connects your DanceFlow account, LUMI can help turn lesson notes, goals, and progress into focused practice steps between lessons.
          </AppText>
        </View>
      </View>

      <FeatureCard
        label="Why connect with a studio?"
        title="Your learning history becomes useful between lessons"
        detail="Connected studios can share lesson recaps, practice assignments, syllabus progress, recent lessons, and next-step recommendations in this tab."
      />

      <View style={styles.valueList}>
        <FeatureCard
          title="Lesson recaps"
          detail="Review what your instructor covered so you know exactly what to practice next."
        />
        <FeatureCard
          title="Practice focus"
          detail="Turn recent lessons into small, clear goals you can work on before your next appointment."
        />
        <FeatureCard
          title="Progress with LUMI"
          detail="LUMI can help explain feedback, summarize priorities, and suggest questions to bring back to your instructor."
        />
      </View>

      {signedIn ? (
        <>
          <Link href="/(tabs)/discover" asChild>
            <AppButton label="Find studios to connect with" />
          </Link>
          <AppText variant="caption">
            Already taking lessons? Ask your studio to connect your DanceFlow account so lesson recaps and progress can appear here.
          </AppText>
        </>
      ) : (
        <>
          <Link href="/(auth)/sign-in" asChild>
            <AppButton label="Create or access your free account" />
          </Link>
          <AppText variant="caption">
            Returning dancer? Use the same email you use for DanceFlow, your studio, events, or tickets.
          </AppText>
        </>
      )}
    </>
  );
}

export default function LearnScreen() {
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

        setLinkedStudios([]);
        setOverview(emptyOverview);
        setErrorMessage("Learning history could not be loaded yet. Try again in a moment.");
      } finally {
        if (!mounted) return;
        setLoading(false);
      }
    }

    load();

    return () => {
      mounted = false;
    };
  }, [session?.user.id]);

  const hasPortalAccess = linkedStudios.length > 0;
  const isSignedIn = Boolean(session);
  const recentLessons = overview.recentLessons;
  const practiceFocus = overview.practiceFocus;
  const latestLesson = recentLessons[0] ?? null;

  return (
    <Screen>
      <AppText variant="eyebrow">Learn</AppText>
      <AppText variant="title">Recaps and practice</AppText>
      <AppText variant="caption">
        Connect with a studio to bring lesson recaps, practice focus, progress tracking, and LUMI coaching support into DanceFlow.
      </AppText>

      {loading ? (
        <FeatureCard
          label="Loading"
          title="Finding your learning history"
          detail="DanceFlow is checking linked studios, recent lessons, and practice context."
        />
      ) : null}

      {errorMessage ? (
        <FeatureCard label="Needs review" title="Learning history unavailable" detail={errorMessage} />
      ) : null}

      {!loading && !hasPortalAccess ? <LearnValueCard signedIn={isSignedIn} /> : null}

      {!loading && hasPortalAccess ? (
        <>
          {latestLesson ? (
            <View style={styles.highlightCard}>
              <AppText variant="eyebrow">Latest lesson</AppText>
              <AppText variant="title">{latestLesson.title}</AppText>
              <AppText variant="caption">{latestLesson.timeText}</AppText>
              <AppText variant="caption">
                {latestLesson.instructorName
                  ? `Ask LUMI what to practice from your lesson with ${latestLesson.instructorName}.`
                  : "Ask LUMI what to practice from this lesson."}
              </AppText>
            </View>
          ) : (
            <FeatureCard
              label="No lessons yet"
              title="Your learning history will appear here"
              detail="After completed lessons or classes are visible to your portal, this tab will show recent activity and practice prompts."
            />
          )}

          <View style={styles.section}>
            <AppText variant="subtitle">Practice focus</AppText>
            {practiceFocus.map((focus) => (
              <FocusCard key={focus.id} focus={focus} />
            ))}
          </View>

          <View style={styles.section}>
            <AppText variant="subtitle">Recent lessons</AppText>
            {recentLessons.length ? (
              recentLessons.slice(0, 6).map((lesson) => <LessonCard key={lesson.id} lesson={lesson} />)
            ) : (
              <AppText variant="caption">
                Completed lessons and classes will show here when your studio makes them visible.
              </AppText>
            )}
          </View>

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
                  <View key={prompt} style={styles.promptChip}>
                    <AppText variant="caption">{prompt}</AppText>
                  </View>
                ))}
              </View>
              <Link href="/lumi" asChild>
                <AppButton label="Ask LUMI what to practice" variant="secondary" />
              </Link>
            </View>
          </View>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  highlightCard: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 18,
    gap: 8,
    padding: 18
  },
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
  promptChip: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  promptList: {
    gap: 8
  },
  section: {
    gap: 10
  },
  valueList: {
    gap: 10
  }
});
