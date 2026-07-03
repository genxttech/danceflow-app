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
  appointmentTypeLabel,
  formatScheduleDateTime,
  formatScheduleTimeRange,
  loadStudentScheduleOverview,
  statusLabel,
  type StudentBookingRequest,
  type StudentScheduleItem,
  type StudentScheduleOverview
} from "@/lib/studentSchedule";

function isPrivateLesson(item: StudentScheduleItem) {
  const type = (item.appointmentType ?? "").toLowerCase();
  const title = item.title.toLowerCase();
  const subtitle = item.subtitle.toLowerCase();

  return type.includes("private") || title.includes("private") || subtitle.includes("private");
}

function displayScheduleTitle(item: StudentScheduleItem) {
  const typeLabel = appointmentTypeLabel(item.appointmentType);
  const title = item.title.trim();
  const normalizedTitle = title.toLowerCase();

  if (isPrivateLesson(item) && (normalizedTitle.includes("self-service") || normalizedTitle.includes("booking"))) {
    return typeLabel;
  }

  return title || typeLabel;
}

function displayScheduleSubtitle(item: StudentScheduleItem) {
  const title = displayScheduleTitle(item).toLowerCase();
  const subtitle = item.subtitle.trim();

  if (!subtitle || subtitle.toLowerCase() === title) return null;
  return subtitle;
}

function ScheduleItemCard({ item }: { item: StudentScheduleItem }) {
  const router = useRouter();
  const showLessonActions = isPrivateLesson(item);
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
      <AppText variant="caption">
        {formatScheduleTimeRange(item.startsAt, item.endsAt, item.timeZone)}
      </AppText>
      {subtitle ? <AppText variant="caption">{subtitle}</AppText> : null}

      {showLessonActions ? (
        <View style={styles.actionRow}>
          <AppButton label="View" onPress={() => openAppointment()} variant="secondary" />
          <AppButton label="Reschedule" onPress={() => openAppointment("reschedule")} variant="secondary" />
          <AppButton label="Cancel" onPress={() => openAppointment("cancel")} variant="secondary" />
        </View>
      ) : (
        <AppButton label="View details" onPress={() => openAppointment()} variant="secondary" />
      )}
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

function ScheduleValueCard({ signedIn }: { signedIn: boolean }) {
  return (
    <>
      <View style={styles.emptyHero}>
        <View style={styles.emptyIcon}>
          <Ionicons color="#fff" name="calendar-outline" size={24} />
        </View>
        <View style={{ flex: 1 }}>
          <AppText style={styles.emptyTitle}>Your dance schedule in one place</AppText>
          <AppText style={styles.emptyDetail}>
            Connected studios can show upcoming lessons, classes, bookings, and request status here.
          </AppText>
        </View>
      </View>

      {signedIn ? (
        <>
          <Link href="/(tabs)/discover" asChild>
            <AppButton label="Find studios to connect with" />
          </Link>
          <AppText variant="caption">
            Already taking lessons? Ask your studio to connect your DanceFlow account.
          </AppText>
        </>
      ) : (
        <Link href="/(auth)/sign-in" asChild>
          <AppButton label="Create or access your free account" />
        </Link>
      )}
    </>
  );
}

export default function ScheduleScreen() {
  const { session } = useAuth();
  const [loading, setLoading] = useState(true);
  const [linkedStudios, setLinkedStudios] = useState<LinkedStudioAccess[]>([]);
  const [overview, setOverview] = useState<StudentScheduleOverview | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function loadSchedule() {
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

      if (access.linkedStudios.length === 0) {
        setOverview(null);
        return;
      }

      setOverview(await loadStudentScheduleOverview(access.linkedStudios));
    } catch {
      setErrorMessage("Your schedule could not be loaded. Try again in a moment.");
      setOverview(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSchedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id]);

  const hasPortalAccess = linkedStudios.length > 0;
  const isSignedIn = Boolean(session);
  const upcoming = overview?.upcoming ?? [];
  const recent = overview?.recent ?? [];
  const bookingRequests = overview?.bookingRequests ?? [];

  return (
    <Screen>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <AppText variant="eyebrow">Schedule</AppText>
          <AppText variant="title">Lessons and classes</AppText>
          <AppText variant="caption">
            Upcoming and recent activity from your connected studios.
          </AppText>
        </View>
      </View>

      {isSignedIn ? (
        <Link href="/schedule/request" asChild>
          <Pressable style={styles.requestButton}>
            <View style={styles.requestButtonIcon}>
              <Ionicons color="#fff" name="add-outline" size={22} />
            </View>
            <View style={{ flex: 1 }}>
              <AppText style={styles.requestButtonTitle}>Request Lesson</AppText>
              <AppText style={styles.requestButtonDetail}>
                Send a private lesson request to your studio.
              </AppText>
            </View>
          </Pressable>
        </Link>
      ) : null}

      {loading ? (
        <FeatureCard title="Loading schedule..." detail="Checking your connected studios." />
      ) : null}

      {!loading && errorMessage ? (
        <FeatureCard title="Schedule unavailable" detail={errorMessage} />
      ) : null}

      {!loading && !hasPortalAccess ? <ScheduleValueCard signedIn={isSignedIn} /> : null}

      {!loading && hasPortalAccess ? (
        <>
          <View style={styles.summaryGrid}>
            <View style={styles.summaryCard}>
              <AppText variant="eyebrow">Upcoming</AppText>
              <AppText variant="title">{upcoming.length}</AppText>
              <AppText variant="caption">scheduled</AppText>
            </View>
            <View style={styles.summaryCard}>
              <AppText variant="eyebrow">Requests</AppText>
              <AppText variant="title">{bookingRequests.length}</AppText>
              <AppText variant="caption">active</AppText>
            </View>
          </View>

          {upcoming.length > 0 ? (
            <View style={styles.section}>
              <AppText variant="subtitle">Upcoming</AppText>
              {upcoming.slice(0, 8).map((item) => (
                <ScheduleItemCard key={item.id} item={item} />
              ))}
            </View>
          ) : (
            <FeatureCard
              title="No upcoming schedule items"
              detail="Lessons, classes, coachings, rentals, and commitments will appear here when scheduled."
            />
          )}

          {bookingRequests.length > 0 ? (
            <View style={styles.section}>
              <AppText variant="subtitle">Requests</AppText>
              {bookingRequests.slice(0, 5).map((request) => (
                <BookingRequestCard key={request.id} request={request} />
              ))}
            </View>
          ) : null}

          {recent.length > 0 ? (
            <View style={styles.section}>
              <AppText variant="subtitle">Recent</AppText>
              {recent.slice(0, 6).map((item) => (
                <ScheduleItemCard key={item.id} item={item} />
              ))}
            </View>
          ) : null}
        </>
      ) : null}

      {isSignedIn ? (
        <AppButton label="Refresh schedule" onPress={loadSchedule} variant="secondary" />
      ) : null}
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
  emptyDetail: {
    color: "rgba(255,255,255,0.78)",
    fontSize: 13,
    lineHeight: 19
  },
  emptyHero: {
    alignItems: "center",
    backgroundColor: colors.primaryDark,
    borderRadius: 20,
    flexDirection: "row",
    gap: 12,
    padding: 16
  },
  emptyIcon: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.16)",
    borderRadius: 999,
    height: 44,
    justifyContent: "center",
    width: 44
  },
  emptyTitle: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "900",
    marginBottom: 4
  },
  headerRow: {
    flexDirection: "row",
    gap: 12
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
  },
  summaryCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    elevation: 1,
    flex: 1,
    gap: 6,
    padding: 16
  },
  summaryGrid: {
    flexDirection: "row",
    gap: 12
  }
});
