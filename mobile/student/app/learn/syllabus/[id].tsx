import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess, type LinkedStudioAccess } from "@/lib/studentAccess";
import {
  loadStudentSyllabusDetail,
  type StudentSyllabusDetail,
  type StudentSyllabusStep
} from "@/lib/studentLearn";

function statusLabel(status: string) {
  if (status === "not_started") return "Not Started";
  return status.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusStyle(status: string) {
  if (status === "mastered") return styles.statusMastered;
  if (status === "comfortable") return styles.statusComfortable;
  if (status === "practicing") return styles.statusPracticing;
  if (status === "introduced") return styles.statusIntroduced;
  return styles.statusNotStarted;
}

function StepCard({ index, step }: { index: number; step: StudentSyllabusStep }) {
  return (
    <View style={styles.stepCard}>
      <View style={styles.stepHeader}>
        <View style={styles.stepNumber}>
          <AppText style={styles.stepNumberText}>{index + 1}</AppText>
        </View>
        <View style={{ flex: 1 }}>
          <AppText variant="subtitle">{step.title}</AppText>
          {step.category ? <AppText variant="caption">{step.category}</AppText> : null}
        </View>
        <View style={[styles.statusPill, statusStyle(step.status)]}>
          <AppText style={styles.statusText}>{statusLabel(step.status)}</AppText>
        </View>
      </View>

      {step.description ? <AppText variant="caption">{step.description}</AppText> : null}
      {step.notes ? (
        <View style={styles.notesBox}>
          <AppText variant="eyebrow">Instructor Notes</AppText>
          <AppText variant="caption">{step.notes}</AppText>
        </View>
      ) : null}
    </View>
  );
}

function paramValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default function SyllabusDetailScreen() {
  const { session } = useAuth();
  const params = useLocalSearchParams<{ id?: string }>();
  const assignmentId = paramValue(params.id);
  const [loading, setLoading] = useState(true);
  const [linkedStudios, setLinkedStudios] = useState<LinkedStudioAccess[]>([]);
  const [syllabus, setSyllabus] = useState<StudentSyllabusDetail | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const userId = session?.user.id;

    async function load() {
      if (!userId || !assignmentId) {
        setLinkedStudios([]);
        setSyllabus(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      setErrorMessage(null);

      try {
        const access = await getStudentAccess(userId);
        const detail = await loadStudentSyllabusDetail(access.linkedStudios, assignmentId);

        if (!mounted) return;
        setLinkedStudios(access.linkedStudios);
        setSyllabus(detail);
      } catch {
        if (!mounted) return;
        setErrorMessage("Syllabus details could not be loaded yet. Try again in a moment.");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();

    return () => {
      mounted = false;
    };
  }, [assignmentId, session?.user.id]);

  const hasPortalAccess = linkedStudios.length > 0;
  const subtitle = syllabus
    ? [syllabus.studioName, syllabus.danceStyle, syllabus.level].filter(Boolean).join(" • ")
    : "";

  return (
    <Screen>
      <AppText variant="eyebrow">Learn</AppText>
      <AppText variant="title">{syllabus?.name ?? "Syllabus"}</AppText>
      {subtitle ? <AppText variant="caption">{subtitle}</AppText> : null}

      {loading ? <FeatureCard title="Loading syllabus" detail="Checking your syllabus steps." /> : null}
      {errorMessage ? <FeatureCard title="Syllabus unavailable" detail={errorMessage} /> : null}

      {!loading && !hasPortalAccess ? (
        <FeatureCard
          title="Connect with a studio"
          detail="Syllabus details appear after a studio connects your DanceFlow account."
        />
      ) : null}

      {!loading && hasPortalAccess && !syllabus ? (
        <FeatureCard
          title="Syllabus not found"
          detail="This syllabus may have been removed or may no longer be connected to your account."
        />
      ) : null}

      {syllabus ? (
        <>
          <View style={styles.summaryCard}>
            <AppText variant="eyebrow">Progress</AppText>
            <AppText variant="subtitle">{syllabus.percentMastered}% mastered</AppText>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${syllabus.percentMastered}%` }]} />
            </View>
            <AppText variant="caption">
              {syllabus.masteredItems} mastered • {syllabus.activeItems} active • {syllabus.startedItems} of {syllabus.totalItems} started
            </AppText>
            {syllabus.description ? <AppText variant="caption">{syllabus.description}</AppText> : null}
          </View>

          {syllabus.steps.length ? (
            <View style={styles.section}>
              <AppText variant="subtitle">Dance Steps</AppText>
              {syllabus.steps.map((step, index) => (
                <StepCard key={step.id} index={index} step={step} />
              ))}
            </View>
          ) : (
            <FeatureCard
              title="No steps yet"
              detail="This syllabus template does not have dance steps or figures yet."
            />
          )}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  notesBox: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 14,
    gap: 4,
    padding: 12
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
  statusComfortable: {
    backgroundColor: "#dcfce7"
  },
  statusIntroduced: {
    backgroundColor: "#ffedd5"
  },
  statusMastered: {
    backgroundColor: "#d1fae5"
  },
  statusNotStarted: {
    backgroundColor: colors.surfaceAlt
  },
  statusPill: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  statusPracticing: {
    backgroundColor: "#dbeafe"
  },
  statusText: {
    color: colors.text,
    fontSize: 11,
    fontWeight: "900"
  },
  stepCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 10,
    padding: 16
  },
  stepHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10
  },
  stepNumber: {
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: 999,
    height: 34,
    justifyContent: "center",
    width: 34
  },
  stepNumberText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "900"
  },
  summaryCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 7,
    padding: 16
  }
});
