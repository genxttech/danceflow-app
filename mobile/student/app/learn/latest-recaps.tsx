import { Link, type Href } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess, type LinkedStudioAccess } from "@/lib/studentAccess";
import {
  loadStudentLearnOverview,
  type StudentGroupLessonRecap,
  type StudentLearnLesson,
  type StudentLearnOverview
} from "@/lib/studentLearn";

const emptyOverview: StudentLearnOverview = {
  recentLessons: [],
  groupLessonRecaps: [],
  practiceFocus: [],
  syllabi: [],
  lumiPrompts: []
};

function groupRecapHref(recapId: string): Href {
  return `/learn/group-recaps/${recapId}` as Href;
}

function lessonRecapHref(lessonId: string): Href {
  return `/learn/lessons/${lessonId}` as Href;
}

function GroupRecapCard({ recap }: { recap: StudentGroupLessonRecap }) {
  const detail = [
    recap.studioName,
    recap.summary,
    recap.practiceAssignment ? `Practice: ${recap.practiceAssignment}` : null,
    recap.safetyNotes ? `Safety: ${recap.safetyNotes}` : null
  ]
    .filter(Boolean)
    .join(" • ");

  return (
    <View style={styles.itemCard}>
      <AppText variant="eyebrow">Group Recap</AppText>
      <AppText variant="subtitle">{recap.title}</AppText>
      {recap.publishedAt ? (
        <AppText variant="caption">
          Published{" "}
          {new Intl.DateTimeFormat(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric"
          }).format(new Date(recap.publishedAt))}
        </AppText>
      ) : null}
      {detail ? <AppText variant="caption">{detail}</AppText> : null}
      <Link href={groupRecapHref(recap.id)} asChild>
        <AppButton label="Read full recap" variant="secondary" />
      </Link>
    </View>
  );
}

function LessonRecapCard({ lesson, label = "Lesson Recap" }: { lesson: StudentLearnLesson; label?: string }) {
  return (
    <View style={styles.itemCard}>
      <AppText variant="eyebrow">{label}</AppText>
      <AppText variant="subtitle">{lesson.title}</AppText>
      <AppText variant="caption">{lesson.timeText}</AppText>
      <AppText variant="caption">
        {lesson.instructorName
          ? `Review what you worked on with ${lesson.instructorName}.`
          : "Review what you worked on and what to practice next."}
      </AppText>
      <Link href={lessonRecapHref(lesson.id)} asChild>
        <AppButton label="Read full recap" variant="secondary" />
      </Link>
    </View>
  );
}

export default function LatestRecapsScreen() {
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
        setErrorMessage("Recaps could not be loaded yet. Try again in a moment.");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();

    return () => {
      mounted = false;
    };
  }, [session?.user.id]);

  const latestLesson = overview.recentLessons[0] ?? null;
  const latestGroupRecap = overview.groupLessonRecaps[0] ?? null;
  const hasPortalAccess = linkedStudios.length > 0;

  return (
    <Screen>
      <AppText variant="eyebrow">Learn</AppText>
      <AppText variant="title">Latest Recaps</AppText>
      <AppText variant="caption">
        Review your most recent private lessons and published group class notes.
      </AppText>

      {loading ? <FeatureCard title="Loading recaps" detail="Checking your learning history." /> : null}
      {errorMessage ? <FeatureCard title="Recaps unavailable" detail={errorMessage} /> : null}

      {!loading && !hasPortalAccess ? (
        <FeatureCard
          title="Connect with a studio"
          detail="Lesson recaps appear after a studio connects your DanceFlow account and shares lesson history."
        />
      ) : null}

      {!loading && hasPortalAccess ? (
        <View style={styles.section}>
          {latestLesson ? <LessonRecapCard lesson={latestLesson} label="Latest Lesson Recap" /> : null}
          {latestGroupRecap ? <GroupRecapCard recap={latestGroupRecap} /> : null}
          {overview.recentLessons.slice(1, 6).map((lesson) => (
            <LessonRecapCard key={lesson.id} lesson={lesson} />
          ))}
          {!latestLesson && !latestGroupRecap ? (
            <FeatureCard
              title="No recaps yet"
              detail="After completed lessons or published group recaps are visible to your portal, they will appear here."
            />
          ) : null}
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
  section: {
    gap: 10
  }
});
