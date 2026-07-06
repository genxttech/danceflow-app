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
  type StudentGroupLessonRecap,
  type StudentLearnLesson,
  type StudentLearnOverview,
  type StudentPracticeFocus,
  type StudentSyllabusSummary
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

function groupRecapHref(recapId: string): Href {
  return `/learn/group-recaps/${recapId}` as Href;
}

function lessonRecapHref(lessonId: string): Href {
  return `/learn/lessons/${lessonId}` as Href;
}

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

function SyllabusCard({ syllabus }: { syllabus: StudentSyllabusSummary }) {
  const subtitle = [syllabus.studioName, syllabus.danceStyle, syllabus.level].filter(Boolean).join(" • ");

  return (
    <View style={styles.syllabusCard}>
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
    </View>
  );
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
      {recap.mediaLinks.length > 0 ? (
        <AppText variant="caption">
          {recap.mediaLinks.length} shared link{recap.mediaLinks.length === 1 ? "" : "s"}
        </AppText>
      ) : null}
      <Link href={groupRecapHref(recap.id)} asChild>
        <AppButton label="Read full recap" variant="secondary" />
      </Link>
    </View>
  );
}

function LatestRecapCard({
  item
}: {
  item:
    | { kind: "lesson"; lesson: StudentLearnLesson }
    | { kind: "group"; recap: StudentGroupLessonRecap };
}) {
  if (item.kind === "lesson") {
    const lesson = item.lesson;
    return (
      <View style={styles.itemCard}>
        <AppText variant="eyebrow">Latest Lesson Recap</AppText>
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

  return <GroupRecapCard recap={item.recap} />;
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
  const syllabi = overview.syllabi;
  const latestLesson = recentLessons[0] ?? null;
  const latestItems = [
    latestLesson ? { kind: "lesson" as const, lesson: latestLesson } : null,
    groupLessonRecaps[0] ? { kind: "group" as const, recap: groupLessonRecaps[0] } : null
  ].filter(
    (
      item
    ): item is
      | { kind: "lesson"; lesson: StudentLearnLesson }
      | { kind: "group"; recap: StudentGroupLessonRecap } => Boolean(item)
  );

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
          {latestItems.length ? (
            <View style={styles.section}>
              <AppText variant="subtitle">Latest recaps</AppText>
              <AppText variant="caption">
                Your most recent private and group lesson notes appear together here.
              </AppText>
              {latestItems.map((item) => (
                <LatestRecapCard
                  key={item.kind === "lesson" ? `lesson-${item.lesson.id}` : `group-${item.recap.id}`}
                  item={item}
                />
              ))}
            </View>
          ) : (
            <FeatureCard
              label="No lessons yet"
              title="Your learning history will appear here"
              detail="After completed lessons or classes are visible to your portal, this tab will show recent activity and practice prompts."
            />
          )}

          {syllabi.length ? (
            <View style={styles.section}>
              <AppText variant="subtitle">Syllabus</AppText>
              {syllabi.map((syllabus) => (
                <SyllabusCard key={syllabus.id} syllabus={syllabus} />
              ))}
            </View>
          ) : (
            <FeatureCard
              title="No visible syllabus yet"
              detail="Assigned syllabus progress will appear here when your studio makes it visible to your account."
            />
          )}

          <View style={styles.section}>
            <AppText variant="subtitle">Practice focus</AppText>
            {practiceFocus.map((focus) => (
              <FocusCard key={focus.id} focus={focus} />
            ))}
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
