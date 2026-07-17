import { Link, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { Image, Pressable, StyleSheet, useColorScheme, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colorsForScheme } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess, type LinkedStudioAccess } from "@/lib/studentAccess";
import {
  loadStudentLearnOverview,
  type StudentLearnOverview,
} from "@/lib/studentLearn";

const lumiAvatar = require("../../assets/lumi-avatar.png");

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
  lumiPrompts: [
    "What should I practice this week?",
    "How do I set a dance goal?",
    "How can I feel more confident at my next lesson?"
  ]
};

function LearnCategoryCard({
  countLabel,
  detail,
  icon,
  onPress,
  title,
  styles,
}: {
  countLabel: string;
  detail: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  title: string;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.categoryCard,
        pressed && styles.cardPressed
      ]}
    >
      <View style={styles.categoryIcon}>
        <Ionicons color="#fff" name={icon} size={24} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={styles.cardHeader}>
          <AppText style={styles.categoryTitle}>{title}</AppText>
          <AppText style={styles.countPill}>{countLabel}</AppText>
        </View>
        <AppText style={styles.categoryDetail}>{detail}</AppText>
      </View>
    </Pressable>
  );
}

function LearnValueCard({
  signedIn,
  styles,
}: {
  signedIn: boolean;
  styles: ReturnType<typeof createStyles>;
}) {
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
          title="Group lesson recaps"
          detail="Review class topics, shared practice notes, and safety tips from group classes when your studio publishes them."
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
  const colors = colorsForScheme(useColorScheme());
  const styles = createStyles(colors);
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
  const groupLessonRecaps = overview.groupLessonRecaps;
  const practiceFocus = overview.practiceFocus;
  const syllabi =
    (overview as StudentLearnOverview & { syllabi?: StudentSyllabusSummary[] }).syllabi ?? [];
  const recapCount = recentLessons.length + groupLessonRecaps.length;

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

      {!loading && !hasPortalAccess ? <LearnValueCard signedIn={isSignedIn} styles={styles} /> : null}

      {!loading && hasPortalAccess ? (
        <>
          <View style={styles.categoryList}>
            <LearnCategoryCard
              countLabel={`${recapCount}`}
              detail="Recent private lessons, completed schedule items, and published group-class notes."
              icon="reader-outline"
              onPress={() => router.push("/learn/latest-recaps")}
              title="Latest Recaps"
              styles={styles}
            />
            <LearnCategoryCard
              countLabel={`${syllabi.length}`}
              detail="Assigned syllabus progress and skill checklists from your studio."
              icon="list-outline"
              onPress={() => router.push("/learn/syllabus")}
              title="Syllabus"
              styles={styles}
            />
            <LearnCategoryCard
              countLabel={`${practiceFocus.length}`}
              detail="A short focus list based on recent lessons, recaps, and LUMI prompts."
              icon="sparkles-outline"
              onPress={() => router.push("/learn/practice-focus")}
              title="Practice Focus"
              styles={styles}
            />
          </View>
        </>
      ) : null}
    </Screen>
  );
}

function createStyles(colors: ReturnType<typeof colorsForScheme>) {
  return StyleSheet.create({
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
  cardHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between"
  },
  cardPressed: {
    opacity: 0.78
  },
  categoryCard: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 22,
    borderWidth: 1,
    flexDirection: "row",
    gap: 14,
    padding: 16
  },
  categoryDetail: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4
  },
  categoryIcon: {
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: 18,
    height: 50,
    justifyContent: "center",
    width: 50
  },
  categoryList: {
    gap: 12
  },
  categoryTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "900"
  },
  countPill: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 999,
    color: colors.primary,
    fontSize: 12,
    fontWeight: "900",
    overflow: "hidden",
    paddingHorizontal: 10,
    paddingVertical: 5
  },
  lumiAvatar: {
    borderRadius: 34,
    height: 68,
    width: 68
  },
  lumiCard: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
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
  },
  valueList: {
    gap: 10
  }
  });
}
