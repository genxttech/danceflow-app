import { useCallback, useEffect, useState } from "react";
import { Link, useLocalSearchParams, useRouter, type Href } from "expo-router";
import { StyleSheet, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import {
  loadStudentCurriculumAssignment,
  type StudentCurriculumDetail,
} from "@/lib/studentCurriculum";

function normalizeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function videoHref(assignmentId: string, videoAssetId: string): Href {
  return {
    pathname: "/learn/curriculum/videos/[videoAssetId]",
    params: { assignmentId, videoAssetId },
  } as Href;
}

function DetailSection({
  body,
  title,
}: {
  body: string | null;
  title: string;
}) {
  if (!body) return null;

  return (
    <View style={styles.card}>
      <AppText variant="subtitle">{title}</AppText>
      <AppText style={styles.body}>{body}</AppText>
    </View>
  );
}

export default function CurriculumAssignmentDetailScreen() {
  const { assignmentId: rawAssignmentId } = useLocalSearchParams<{
    assignmentId: string;
  }>();
  const assignmentId = normalizeParam(rawAssignmentId);
  const router = useRouter();
  const [assignment, setAssignment] =
    useState<StudentCurriculumDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!assignmentId) {
      setErrorMessage("Curriculum assignment could not be found.");
      setLoading(false);
      return;
    }

    try {
      setAssignment(await loadStudentCurriculumAssignment(assignmentId));
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Curriculum assignment could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, [assignmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <Screen>
        <FeatureCard
          title="Loading assignment"
          detail="Preparing your curriculum details."
        />
      </Screen>
    );
  }

  if (!assignment) {
    return (
      <Screen>
        <FeatureCard
          title="Assignment unavailable"
          detail={errorMessage ?? "This assignment could not be found."}
        />
        <AppButton
          label="Back to assignments"
          onPress={() => router.replace("/learn/curriculum" as never)}
        />
      </Screen>
    );
  }

  const path = [
    assignment.step.styleName,
    assignment.step.danceName,
    assignment.step.levelName,
  ]
    .filter(Boolean)
    .join(" • ");

  return (
    <Screen>
      <AppText variant="eyebrow">{assignment.studioName}</AppText>
      <AppText variant="title">{assignment.step.name}</AppText>
      {assignment.step.alternateName ? (
        <AppText variant="caption">
          Also called {assignment.step.alternateName}
        </AppText>
      ) : null}
      {path ? <AppText variant="caption">{path}</AppText> : null}

      {assignment.practiceNote ? (
        <View style={styles.practiceCard}>
          <AppText variant="subtitle">Your practice focus</AppText>
          <AppText style={styles.practiceText}>
            {assignment.practiceNote}
          </AppText>
        </View>
      ) : null}

      <DetailSection title="Overview" body={assignment.step.summary} />
      <DetailSection title="Timing" body={assignment.step.timing} />
      <DetailSection title="Counts" body={assignment.step.counts} />
      <DetailSection
        title="Starting position"
        body={assignment.step.startingPosition}
      />
      <DetailSection
        title="Ending position"
        body={assignment.step.endingPosition}
      />
      <DetailSection
        title="Technique notes"
        body={assignment.step.techniqueNotes}
      />
      <DetailSection
        title="Student notes"
        body={assignment.step.studentNotes}
      />
      <DetailSection
        title="Prerequisites"
        body={assignment.step.prerequisiteNotes}
      />

      {assignment.chart ? (
        <View style={styles.card}>
          <AppText variant="subtitle">{assignment.chart.title}</AppText>
          {assignment.chart.notes ? (
            <AppText style={styles.body}>{assignment.chart.notes}</AppText>
          ) : null}

          {assignment.chart.rows.map((row, index) => (
            <View key={row.id} style={styles.chartRow}>
              <AppText variant="eyebrow">
                {row.countLabel || `Movement ${index + 1}`}
              </AppText>
              {row.direction ? (
                <AppText variant="caption">Direction: {row.direction}</AppText>
              ) : null}
              {row.leaderAction || row.leaderFoot ? (
                <AppText style={styles.body}>
                  Leader: {[row.leaderFoot, row.leaderAction]
                    .filter(Boolean)
                    .join(" — ")}
                </AppText>
              ) : null}
              {row.followerAction || row.followerFoot ? (
                <AppText style={styles.body}>
                  Follower: {[row.followerFoot, row.followerAction]
                    .filter(Boolean)
                    .join(" — ")}
                </AppText>
              ) : null}
              {row.notes ? (
                <AppText variant="caption">{row.notes}</AppText>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {assignment.videos.length > 0 ? (
        <View style={styles.card}>
          <AppText variant="subtitle">Instructional videos</AppText>
          {assignment.videos.map((video) => (
            <Link
              key={video.id}
              href={videoHref(assignment.id, video.id)}
              asChild
            >
              <AppButton
                label={`${video.title} • ${video.presentationType.replaceAll(
                  "_",
                  " ",
                )}`}
                variant="secondary"
              />
            </Link>
          ))}
        </View>
      ) : null}

      <AppButton
        label="Back to assignments"
        onPress={() => router.replace("/learn/curriculum" as never)}
        variant="secondary"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 23,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 10,
    padding: 16,
  },
  chartRow: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 14,
    gap: 5,
    padding: 12,
  },
  practiceCard: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.primary,
    borderRadius: 18,
    borderWidth: 1,
    gap: 8,
    padding: 16,
  },
  practiceText: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 23,
  },
});
