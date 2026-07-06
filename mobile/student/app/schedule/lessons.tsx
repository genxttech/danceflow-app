import { Link, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess, type LinkedStudioAccess } from "@/lib/studentAccess";
import {
  formatScheduleDateTime,
  formatScheduleTimeRange,
  loadStudentScheduleOverview,
  statusLabel,
  type StudentBookingRequest,
  type StudentScheduleItem,
  type StudentScheduleOverview
} from "@/lib/studentSchedule";
import {
  displayScheduleSubtitle,
  displayScheduleTitle,
  isLessonScheduleItem
} from "@/lib/studentScheduleSections";

function LessonCard({ item }: { item: StudentScheduleItem }) {
  const router = useRouter();
  const subtitle = displayScheduleSubtitle(item);

  function openAppointment(action?: "reschedule" | "cancel") {
    router.push({
      pathname: "/appointments/[id]",
      params: action ? { id: item.id, action } : { id: item.id }
    });
  }

  return (
    <View style={styles.itemCard}>
      <View style={styles.itemHeader}>
        <AppText variant="eyebrow">{statusLabel(item.status)}</AppText>
        <AppText variant="caption">{item.studioName}</AppText>
      </View>
      <AppText variant="subtitle">{displayScheduleTitle(item)}</AppText>
      <AppText variant="caption">{formatScheduleTimeRange(item.startsAt, item.endsAt, item.timeZone)}</AppText>
      {subtitle ? <AppText variant="caption">{subtitle}</AppText> : null}

      <View style={styles.actionRow}>
        <AppButton label="View" onPress={() => openAppointment()} variant="secondary" />
        <AppButton label="Reschedule" onPress={() => openAppointment("reschedule")} variant="secondary" />
        <AppButton label="Cancel" onPress={() => openAppointment("cancel")} variant="secondary" />
      </View>
    </View>
  );
}

function BookingRequestCard({ request }: { request: StudentBookingRequest }) {
  return (
    <View style={styles.requestCard}>
      <View style={styles.itemHeader}>
        <AppText variant="eyebrow">{statusLabel(request.status)}</AppText>
        <AppText variant="caption">{request.studioName}</AppText>
      </View>
      <AppText variant="subtitle">Lesson request</AppText>
      <AppText variant="caption">
        {request.requestedStartsAt
          ? formatScheduleDateTime(request.requestedStartsAt, request.timeZone)
          : "Studio will follow up with available times."}
      </AppText>
    </View>
  );
}

export default function ScheduleLessonsScreen() {
  const { session } = useAuth();
  const [loading, setLoading] = useState(true);
  const [linkedStudios, setLinkedStudios] = useState<LinkedStudioAccess[]>([]);
  const [overview, setOverview] = useState<StudentScheduleOverview | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function loadLessons() {
    const userId = session?.user.id;

    if (!userId) {
      setLinkedStudios([]);
      setOverview(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setErrorMessage(null);

    try {
      const access = await getStudentAccess(userId);
      setLinkedStudios(access.linkedStudios);
      setOverview(access.linkedStudios.length ? await loadStudentScheduleOverview(access.linkedStudios) : null);
    } catch {
      setErrorMessage("Lessons could not be loaded. Try again in a moment.");
      setOverview(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadLessons();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id]);

  const hasPortalAccess = linkedStudios.length > 0;
  const upcomingLessons = (overview?.upcoming ?? []).filter(isLessonScheduleItem);
  const recentLessons = (overview?.recent ?? []).filter(isLessonScheduleItem);
  const bookingRequests = overview?.bookingRequests ?? [];

  return (
    <Screen>
      <AppText variant="eyebrow">Schedule</AppText>
      <AppText variant="title">Lessons</AppText>
      <AppText variant="caption">Private lessons, intro lessons, coaching, and booking requests.</AppText>

      {session ? (
        <Link href="/schedule/request" asChild>
          <Pressable style={styles.requestButton}>
            <View style={styles.requestButtonIcon}>
              <Ionicons color="#fff" name="add-outline" size={22} />
            </View>
            <View style={{ flex: 1 }}>
              <AppText style={styles.requestButtonTitle}>Request Lesson</AppText>
              <AppText style={styles.requestButtonDetail}>Send a private lesson request to your studio.</AppText>
            </View>
          </Pressable>
        </Link>
      ) : null}

      {loading ? <FeatureCard title="Loading lessons..." detail="Checking your connected studios." /> : null}
      {!loading && errorMessage ? <FeatureCard title="Lessons unavailable" detail={errorMessage} /> : null}
      {!loading && !session ? (
        <Link href="/(auth)/sign-in" asChild>
          <AppButton label="Create or access your free account" />
        </Link>
      ) : null}
      {!loading && session && !hasPortalAccess ? (
        <FeatureCard
          title="No connected studio yet"
          detail="Ask your studio to connect your DanceFlow account so lessons and requests can appear here."
        />
      ) : null}

      {!loading && hasPortalAccess ? (
        <>
          {upcomingLessons.length > 0 ? (
            <View style={styles.section}>
              <AppText variant="subtitle">Upcoming Lessons</AppText>
              {upcomingLessons.slice(0, 10).map((item) => (
                <LessonCard key={item.id} item={item} />
              ))}
            </View>
          ) : (
            <FeatureCard title="No upcoming lessons" detail="Scheduled private lessons and coachings will appear here." />
          )}

          {bookingRequests.length > 0 ? (
            <View style={styles.section}>
              <AppText variant="subtitle">Requests</AppText>
              {bookingRequests.slice(0, 8).map((request) => (
                <BookingRequestCard key={request.id} request={request} />
              ))}
            </View>
          ) : null}

          {recentLessons.length > 0 ? (
            <View style={styles.section}>
              <AppText variant="subtitle">Recent Lessons</AppText>
              {recentLessons.slice(0, 8).map((item) => (
                <LessonCard key={item.id} item={item} />
              ))}
            </View>
          ) : null}
        </>
      ) : null}

      {session ? <AppButton label="Refresh lessons" onPress={loadLessons} variant="secondary" /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 6
  },
  itemCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    elevation: 2,
    gap: 7,
    padding: 16,
    shadowColor: colors.primaryDark,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.06,
    shadowRadius: 18
  },
  itemHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between"
  },
  requestButton: {
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: 20,
    flexDirection: "row",
    gap: 12,
    padding: 16
  },
  requestButtonDetail: {
    color: "rgba(255,255,255,0.82)",
    fontSize: 13,
    lineHeight: 19
  },
  requestButtonIcon: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.16)",
    borderRadius: 999,
    height: 44,
    justifyContent: "center",
    width: 44
  },
  requestButtonTitle: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "900",
    marginBottom: 4
  },
  requestCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    elevation: 1,
    gap: 7,
    padding: 16
  },
  section: {
    gap: 10
  }
});
