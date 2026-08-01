import { useEffect, useState } from "react";
import { Link, type Href } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import {
  loadStudentCurriculumAssignments,
  type StudentCurriculumAssignment,
} from "@/lib/studentCurriculum";

function detailHref(assignmentId: string): Href {
  return `/learn/curriculum/${assignmentId}` as Href;
}

function statusLabel(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export default function CurriculumAssignmentsScreen() {
  const [assignments, setAssignments] = useState<StudentCurriculumAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    loadStudentCurriculumAssignments()
      .then((rows) => {
        if (active) setAssignments(rows);
      })
      .catch((error) => {
        if (active) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Curriculum assignments could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <Screen>
      <AppText variant="eyebrow">Learn</AppText>
      <AppText variant="title">Practice Assignments</AppText>
      <AppText variant="caption">
        Focused skills assigned by your studio, with charts, notes, and private instructional videos.
      </AppText>

      {loading ? (
        <FeatureCard
          title="Loading assignments"
          detail="Checking what your studio wants you to practice next."
        />
      ) : null}

      {errorMessage ? (
        <FeatureCard title="Assignments unavailable" detail={errorMessage} />
      ) : null}

      {!loading && !errorMessage && assignments.length === 0 ? (
        <FeatureCard
          title="No focused assignments yet"
          detail="Individual syllabus steps assigned by your instructor will appear here."
        />
      ) : null}

      <View style={styles.section}>
        {assignments.map((assignment) => (
          <Link key={assignment.id} href={detailHref(assignment.id)} asChild>
            <Pressable style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
              <View style={styles.headerRow}>
                <View style={{ flex: 1 }}>
                  <AppText variant="eyebrow">{assignment.studioName}</AppText>
                  <AppText variant="subtitle">{assignment.stepName}</AppText>
                  <AppText variant="caption">
                    {[assignment.styleName, assignment.danceName, assignment.levelName]
                      .filter(Boolean)
                      .join(" • ")}
                  </AppText>
                </View>
                <View style={styles.statusBadge}>
                  <AppText style={styles.statusText}>
                    {statusLabel(assignment.status)}
                  </AppText>
                </View>
              </View>

              {assignment.practiceNote ? (
                <AppText style={styles.practiceText}>
                  Practice: {assignment.practiceNote}
                </AppText>
              ) : null}

              {assignment.summary ? (
                <AppText variant="caption">{assignment.summary}</AppText>
              ) : null}
            </Pressable>
          </Link>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 10,
    padding: 16,
  },
  headerRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 10,
  },
  practiceText: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 21,
  },
  pressed: {
    opacity: 0.78,
  },
  section: {
    gap: 10,
  },
  statusBadge: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  statusText: {
    color: colors.primary,
    fontSize: 11,
    fontWeight: "800",
  },
});
