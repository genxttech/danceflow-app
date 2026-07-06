import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess } from "@/lib/studentAccess";
import {
  loadStudentLearnOverview,
  type StudentLearnLesson
} from "@/lib/studentLearn";

function normalizeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function lumiPromptHref(prompt: string): Href {
  return {
    pathname: "/lumi",
    params: { prompt }
  } as Href;
}

export default function LessonRecapDetailScreen() {
  const { lessonId: lessonIdParam } = useLocalSearchParams<{ lessonId: string }>();
  const lessonId = normalizeParam(lessonIdParam);
  const router = useRouter();
  const { session } = useAuth();
  const [lesson, setLesson] = useState<StudentLearnLesson | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const userId = session?.user.id;

    async function load() {
      if (!userId || !lessonId) {
        setErrorMessage("Sign in to view this lesson recap.");
        setLoading(false);
        return;
      }

      setLoading(true);
      setErrorMessage(null);

      try {
        const access = await getStudentAccess(userId);
        const overview = await loadStudentLearnOverview(access.linkedStudios);
        const match = overview.recentLessons.find((item) => item.id === lessonId) ?? null;

        if (!mounted) return;
        setLesson(match);
        if (!match) {
          setErrorMessage("This lesson recap could not be found.");
        }
      } catch {
        if (!mounted) return;
        setErrorMessage("This lesson recap could not be loaded.");
      } finally {
        if (!mounted) return;
        setLoading(false);
      }
    }

    load();

    return () => {
      mounted = false;
    };
  }, [lessonId, session?.user.id]);

  if (loading) {
    return (
      <Screen>
        <FeatureCard title="Loading recap" detail="Finding your lesson notes." />
      </Screen>
    );
  }

  if (!lesson) {
    return (
      <Screen>
        <FeatureCard title="Recap unavailable" detail={errorMessage ?? "This recap could not be found."} />
        <AppButton label="Back to Learn" onPress={() => router.replace("/(tabs)/learn")} />
      </Screen>
    );
  }

  const lumiPrompt = [
    `Help me practice from my lesson recap: ${lesson.title}.`,
    lesson.instructorName ? `Instructor: ${lesson.instructorName}.` : null,
    `Lesson type: ${lesson.typeLabel}.`,
    `Lesson time: ${lesson.timeText}.`
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Screen>
      <AppText variant="eyebrow">Lesson Recap</AppText>
      <AppText variant="title">{lesson.title}</AppText>
      <AppText variant="caption">{lesson.studioName}</AppText>

      <View style={styles.detailCard}>
        <AppText variant="subtitle">Lesson details</AppText>
        <AppText variant="caption">{lesson.timeText}</AppText>
        <AppText variant="caption">{lesson.typeLabel}</AppText>
        {lesson.instructorName ? <AppText variant="caption">Instructor: {lesson.instructorName}</AppText> : null}
        {lesson.roomName ? <AppText variant="caption">Room: {lesson.roomName}</AppText> : null}
      </View>

      <View style={styles.detailCard}>
        <AppText variant="subtitle">Practice next</AppText>
        <AppText variant="caption">
          Review what you covered in this lesson and ask LUMI for a focused practice plan before your next session.
        </AppText>
      </View>

      <View style={styles.actions}>
        <AppButton label="Ask LUMI what to practice" onPress={() => router.push(lumiPromptHref(lumiPrompt))} />
        <AppButton label="Back to Learn" onPress={() => router.replace("/(tabs)/learn")} variant="secondary" />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: 10
  },
  detailCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    gap: 8,
    padding: 16
  }
});
