import { useEffect, useState } from "react";
import { Link, type Href } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess, type LinkedStudioAccess } from "@/lib/studentAccess";
import { loadStudentLearnOverview, type StudentLearnOverview } from "@/lib/studentLearn";

type StudentSyllabusSummary = {
  id: string;
  studioName: string;
  name: string;
  description: string | null;
  danceStyle: string | null;
  level: string | null;
  totalItems: number;
  startedItems: number;
  activeItems: number;
  masteredItems: number;
  percentMastered: number;
};

const emptyOverview: StudentLearnOverview & { syllabi: StudentSyllabusSummary[] } = {
  recentLessons: [],
  groupLessonRecaps: [],
  practiceFocus: [],
  syllabi: [],
  digitalContent: [],
  lumiPrompts: []
};

function SyllabusCard({ syllabus }: { syllabus: StudentSyllabusSummary }) {
  const subtitle = [syllabus.studioName, syllabus.danceStyle, syllabus.level].filter(Boolean).join(" • ");
  const href = `/learn/syllabus/${syllabus.id}` as Href;

  return (
    <Link href={href} asChild>
      <Pressable style={({ pressed }) => [styles.syllabusCard, pressed && styles.cardPressed]}>
        <View style={{ flex: 1 }}>
          <AppText variant="eyebrow">Syllabus</AppText>
          <AppText variant="subtitle">{syllabus.name}</AppText>
          {subtitle ? <AppText variant="caption">{subtitle}</AppText> : null}
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${syllabus.percentMastered}%` }]} />
          </View>
          <AppText variant="caption">
            {syllabus.masteredItems} mastered • {syllabus.activeItems} active • {syllabus.startedItems} of {syllabus.totalItems} started
          </AppText>
          {syllabus.description ? <AppText variant="caption">{syllabus.description}</AppText> : null}
        </View>
        <View style={styles.progressBadge}>
          <AppText style={styles.progressBadgeValue}>{syllabus.percentMastered}%</AppText>
          <AppText style={styles.progressBadgeLabel}>mastered</AppText>
        </View>
      </Pressable>
    </Link>
  );
}

export default function SyllabusScreen() {
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
        setErrorMessage("Syllabus progress could not be loaded yet. Try again in a moment.");
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
  const syllabi =
    (overview as StudentLearnOverview & { syllabi?: StudentSyllabusSummary[] }).syllabi ?? [];

  return (
    <Screen>
      <AppText variant="eyebrow">Learn</AppText>
      <AppText variant="title">Syllabus</AppText>
      <AppText variant="caption">
        Track assigned programs, focused practice steps, progress checkpoints, and what your studio wants you to work on next.
      </AppText>

      <Link href={"/learn/curriculum" as Href} asChild>
        <Pressable style={({ pressed }) => [styles.focusCard, pressed && styles.cardPressed]}>
          <View style={{ flex: 1 }}>
            <AppText variant="eyebrow">Focused Practice</AppText>
            <AppText variant="subtitle">Individual step assignments</AppText>
            <AppText variant="caption">
              Open the exact figures and techniques your instructor assigned, including charts and private videos.
            </AppText>
          </View>
          <View style={styles.openBadge}>
            <AppText style={styles.openBadgeText}>Open</AppText>
          </View>
        </Pressable>
      </Link>

      {loading ? <FeatureCard title="Loading syllabus" detail="Checking your assigned progress." /> : null}
      {errorMessage ? <FeatureCard title="Syllabus unavailable" detail={errorMessage} /> : null}

      {!loading && !hasPortalAccess ? (
        <FeatureCard
          title="Connect with a studio"
          detail="Syllabus progress appears after a studio connects your DanceFlow account and makes progress visible."
        />
      ) : null}

      {!loading && hasPortalAccess ? (
        syllabi.length ? (
          <View style={styles.section}>
            {syllabi.map((syllabus) => (
              <SyllabusCard key={syllabus.id} syllabus={syllabus} />
            ))}
          </View>
        ) : (
          <FeatureCard
            title="No visible syllabus yet"
            detail="Assigned syllabus progress will appear here when your studio makes it visible to your account."
          />
        )
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  focusCard: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.primary,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    padding: 16
  },
  openBadge: {
    backgroundColor: colors.primary,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7
  },
  openBadgeText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "800"
  },
  cardPressed: {
    opacity: 0.78
  },
  progressBadge: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderRadius: 16,
    minWidth: 82,
    padding: 10
  },
  progressBadgeLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: "800"
  },
  progressBadgeValue: {
    color: colors.primary,
    fontSize: 22,
    fontWeight: "900"
  },
  progressFill: {
    backgroundColor: colors.primary,
    borderRadius: 999,
    height: "100%"
  },
  progressTrack: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 999,
    height: 8,
    marginVertical: 6,
    overflow: "hidden"
  },
  section: {
    gap: 10
  },
  syllabusCard: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    padding: 16
  }
});
