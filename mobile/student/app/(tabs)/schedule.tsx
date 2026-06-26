import { Link, useRouter } from "expo-router";
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
  formatScheduleDateTime,
  formatScheduleTimeRange,
  loadStudentScheduleOverview,
  statusLabel,
  type StudentBookingRequest,
  type StudentScheduleItem,
  type StudentScheduleOverview
} from "@/lib/studentSchedule";

const lumiAvatar = require("../../assets/lumi-avatar.png");

function isPrivateLesson(item: StudentScheduleItem) {
  const type = (item.appointmentType ?? "").toLowerCase();
  const title = item.title.toLowerCase();
  const subtitle = item.subtitle.toLowerCase();

  return type.includes("private") || title.includes("private") || subtitle.includes("private");
}

function ScheduleItemCard({ item }: { item: StudentScheduleItem }) {
  const router = useRouter();
  const showLessonActions = isPrivateLesson(item);

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
      <AppText variant="subtitle">{item.title}</AppText>
      <AppText variant="caption">
        {formatScheduleTimeRange(item.startsAt, item.endsAt, item.timeZone)}
      </AppText>
      <AppText variant="caption">{item.subtitle}</AppText>

      {showLessonActions ? (
        <View style={styles.actionRow}>
          <AppButton label="View" onPress={() => openAppointment()} variant="secondary" />
          <AppButton
            label="Reschedule"
            onPress={() => openAppointment("reschedule")}
            variant="secondary"
          />
          <AppButton
            label="Cancel"
            onPress={() => openAppointment("cancel")}
            variant="secondary"
          />
        </View>
      ) : (
        <AppButton label="View details" onPress={() => openAppointment()} variant="secondary" />
      )}
    </View>
  );
}

function BookingRequestCard({ request }: { request: StudentBookingRequest }) {
  return (
    <View style={styles.itemCard}>
      <View style={styles.itemHeader}>
        <AppText variant="eyebrow">{statusLabel(request.status)}</AppText>
        <AppText variant="caption">{request.studioName}</AppText>
      </View>
      <AppText variant="subtitle">Booking request</AppText>
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
      <View style={styles.lumiCard}>
        <Image source={lumiAvatar} style={styles.lumiAvatar} resizeMode="contain" />
        <View style={styles.lumiCopy}>
          <AppText variant="eyebrow">Meet LUMI</AppText>
          <AppText variant="subtitle">Your dance schedule coach</AppText>
          <AppText variant="caption">
            When your studio connects your DanceFlow account, LUMI can help you understand what is coming up, prepare for lessons, and turn your schedule into a simple practice plan.
          </AppText>
        </View>
      </View>

      <FeatureCard
        label="Why connect with a studio?"
        title="Your dance schedule becomes easier to manage"
        detail="Connected studios can show your private lessons, group classes, coachings, floor rentals, event commitments, and booking requests in one place."
      />

      <View style={styles.valueList}>
        <FeatureCard
          title="Know what is next"
          detail="See upcoming lessons, classes, and studio bookings without digging through messages."
        />
        <FeatureCard
          title="Request changes"
          detail="When supported by your studio, private lessons can include request options for rescheduling or cancellation."
        />
        <FeatureCard
          title="Prepare with LUMI"
          detail="LUMI can use your connected schedule to help you plan what to review before your next lesson."
        />
      </View>

      {signedIn ? (
        <>
          <Link href="/(tabs)/discover" asChild>
            <AppButton label="Find studios to connect with" />
          </Link>
          <AppText variant="caption">
            Already taking lessons? Ask your studio to connect your DanceFlow account so your schedule can appear here.
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

      const nextOverview = await loadStudentScheduleOverview(access.linkedStudios);
      setOverview(nextOverview);
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
      <AppText variant="eyebrow">Schedule</AppText>
      <AppText variant="title">Classes, lessons, and bookings</AppText>
      <AppText variant="caption">
        Connect with a studio to bring your dance schedule, lesson requests, and LUMI planning support into DanceFlow.
      </AppText>

      {loading ? (
        <FeatureCard
          title="Loading schedule..."
          detail="Checking your connected studios for upcoming lessons, classes, rentals, and booking requests."
        />
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
              <AppText variant="caption">confirmed schedule items</AppText>
            </View>
            <View style={styles.summaryCard}>
              <AppText variant="eyebrow">Requests</AppText>
              <AppText variant="title">{bookingRequests.length}</AppText>
              <AppText variant="caption">pending or approved</AppText>
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
              detail="When your studio schedules a lesson, class, coaching, rental, or event commitment, it will appear here."
            />
          )}

          {bookingRequests.length > 0 ? (
            <View style={styles.section}>
              <AppText variant="subtitle">Booking requests</AppText>
              {bookingRequests.slice(0, 5).map((request) => (
                <BookingRequestCard key={request.id} request={request} />
              ))}
            </View>
          ) : (
            <FeatureCard
              title="No active booking requests"
              detail="Booking requests will show here while your studio reviews them."
            />
          )}

          {recent.length > 0 ? (
            <View style={styles.section}>
              <AppText variant="subtitle">Recent</AppText>
              {recent.slice(0, 4).map((item) => (
                <ScheduleItemCard key={item.id} item={item} />
              ))}
            </View>
          ) : null}

          <View style={styles.lumiCard}>
            <Image source={lumiAvatar} style={styles.lumiAvatar} resizeMode="contain" />
            <View style={styles.lumiCopy}>
              <AppText variant="subtitle">Need help planning?</AppText>
              <AppText variant="caption">
                LUMI can help you understand your schedule, prepare for lessons, and plan your next practice step.
              </AppText>
            </View>
          </View>

          <Link href="/lumi" asChild>
            <AppButton label="Ask LUMI about my schedule" variant="secondary" />
          </Link>
        </>
      ) : null}

      {isSignedIn ? (
        <AppButton label="Refresh schedule" onPress={loadSchedule} variant="secondary" />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  itemCard: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 18,
    gap: 7,
    padding: 14
  },
  valueList: {
  gap: 12,
},
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 6
  },
  itemHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10
  },
  lumiCard: {
    alignItems: "center",
    backgroundColor: "rgba(236, 72, 153, 0.08)",
    borderColor: "rgba(236, 72, 153, 0.22)",
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 14,
    marginTop: 4,
    padding: 14
  },
  lumiAvatar: {
    height: 72,
    width: 72
  },
  lumiCopy: {
    flex: 1,
    gap: 4
  },
  section: {
    gap: 10
  },
  summaryGrid: {
    flexDirection: "row",
    gap: 12
  },
  summaryCard: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 18,
    flex: 1,
    gap: 6,
    padding: 16
  }
});
