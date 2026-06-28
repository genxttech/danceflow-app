import { Link, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { danceflowApiFetch } from "@/lib/danceflowApi";
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
const selfServiceStudioSlug = process.env.EXPO_PUBLIC_DANCEFLOW_STUDIO_SLUG;

type SelfServiceSlot = {
  startsAt: string;
  endsAt: string;
  instructorId: string | null;
  roomId: string | null;
};

type SelfServiceSlotsResponse = {
  slots: SelfServiceSlot[];
  bookingDecision?: {
    allowed: boolean;
    mode: "request_only" | "approval_required" | "instant" | null;
    reason: string | null;
  };
};

type SelfServiceActionRequest = {
  id: string;
  action_type: string;
  mode: string;
  status: string;
  requested_starts_at: string | null;
  previous_starts_at: string | null;
  staff_note: string | null;
  failure_reason: string | null;
};

type SelfServiceRequestsResponse = {
  timezone: string;
  requests: SelfServiceActionRequest[];
};

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
    <View style={styles.requestCard}>
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

function actionLabel(value: string) {
  if (value === "book") return "Booking";
  if (value === "reschedule") return "Reschedule";
  if (value === "cancel") return "Cancellation";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function SelfServiceRequestCard({
  request,
  timeZone
}: {
  request: SelfServiceActionRequest;
  timeZone: string;
}) {
  const startsAt =
    request.action_type === "cancel"
      ? request.previous_starts_at
      : request.requested_starts_at;

  return (
    <View style={styles.requestCard}>
      <View style={styles.itemHeader}>
        <AppText variant="eyebrow">{statusLabel(request.status)}</AppText>
        <AppText variant="caption">{request.mode.replaceAll("_", " ")}</AppText>
      </View>
      <AppText variant="subtitle">{actionLabel(request.action_type)} request</AppText>
      <AppText variant="caption">
        {startsAt
          ? formatScheduleDateTime(startsAt, timeZone)
          : "Studio will review your request."}
      </AppText>
      {request.staff_note ? (
        <AppText variant="caption">Studio note: {request.staff_note}</AppText>
      ) : null}
      {request.failure_reason ? (
        <AppText variant="caption">{request.failure_reason}</AppText>
      ) : null}
    </View>
  );
}

function SelfServiceSlotCard({
  slot,
  timeZone,
  submitting,
  onPress
}: {
  slot: SelfServiceSlot;
  timeZone: string;
  submitting: boolean;
  onPress: () => void;
}) {
  return (
    <View style={styles.slotCard}>
      <AppText variant="subtitle">{formatScheduleDateTime(slot.startsAt, timeZone)}</AppText>
      <AppText variant="caption">
        {submitting ? "Submitting..." : "Tap request to send this time to the studio."}
      </AppText>
      <AppButton
        label={submitting ? "Submitting..." : "Request this time"}
        onPress={onPress}
        variant="secondary"
      />
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
  const [selfServiceSlots, setSelfServiceSlots] = useState<SelfServiceSlot[]>([]);
  const [selfServiceDecision, setSelfServiceDecision] =
    useState<SelfServiceSlotsResponse["bookingDecision"]>(undefined);
  const [selfServiceRequests, setSelfServiceRequests] =
    useState<SelfServiceRequestsResponse | null>(null);
  const [selfServiceMessage, setSelfServiceMessage] = useState<string | null>(null);
  const [submittingSlotKey, setSubmittingSlotKey] = useState<string | null>(null);
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
        setSelfServiceSlots([]);
        setSelfServiceRequests(null);
        return;
      }

      const nextOverview = await loadStudentScheduleOverview(access.linkedStudios);
      setOverview(nextOverview);

      if (selfServiceStudioSlug) {
        try {
          const [slotsResponse, requestsResponse] = await Promise.all([
            danceflowApiFetch<SelfServiceSlotsResponse>(
              "/api/student/self-service/slots",
              {
                params: {
                  studioSlug: selfServiceStudioSlug,
                  lessonType: "private_lesson"
                }
              }
            ),
            danceflowApiFetch<SelfServiceRequestsResponse>(
              "/api/student/self-service/requests",
              {
                params: {
                  studioSlug: selfServiceStudioSlug
                }
              }
            )
          ]);
          setSelfServiceSlots(slotsResponse.slots ?? []);
          setSelfServiceDecision(slotsResponse.bookingDecision);
          setSelfServiceRequests(requestsResponse);
        } catch {
          setSelfServiceSlots([]);
          setSelfServiceDecision(undefined);
          setSelfServiceRequests(null);
        }
      } else {
        setSelfServiceSlots([]);
        setSelfServiceDecision(undefined);
        setSelfServiceRequests(null);
      }
    } catch {
      setErrorMessage("Your schedule could not be loaded. Try again in a moment.");
      setOverview(null);
      setSelfServiceSlots([]);
      setSelfServiceRequests(null);
    } finally {
      setLoading(false);
    }
  }

  async function submitSelfServiceSlot(slot: SelfServiceSlot) {
    if (!selfServiceStudioSlug) {
      setSelfServiceMessage("Self-service booking is not configured yet.");
      return;
    }

    const slotKey = `${slot.startsAt}|${slot.endsAt}`;
    setSubmittingSlotKey(slotKey);
    setSelfServiceMessage(null);

    try {
      const response = await danceflowApiFetch<{
        bookingDecision?: { mode: string | null };
      }>("/api/student/self-service/actions", {
        method: "POST",
        body: JSON.stringify({
          studioSlug: selfServiceStudioSlug,
          actionType: "book",
          lessonType: "private_lesson",
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          instructorId: slot.instructorId,
          roomId: slot.roomId
        })
      });

      setSelfServiceMessage(
        response.bookingDecision?.mode === "instant"
          ? "Lesson booked."
          : "Request sent to the studio."
      );
      await loadSchedule();
    } catch (error) {
      setSelfServiceMessage(
        error instanceof Error ? error.message : "Could not submit the request."
      );
    } finally {
      setSubmittingSlotKey(null);
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
  const selfServiceTimeZone =
    upcoming[0]?.timeZone ??
    bookingRequests[0]?.timeZone ??
    recent[0]?.timeZone ??
    selfServiceRequests?.timezone ??
    "America/New_York";
  const activeSelfServiceRequests =
    selfServiceRequests?.requests.filter((request) =>
      ["pending", "approved", "executed", "declined", "failed"].includes(request.status)
    ) ?? [];

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
              <AppText variant="title">
                {bookingRequests.length + activeSelfServiceRequests.length}
              </AppText>
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

          <View style={styles.section}>
            <AppText variant="subtitle">Request a private lesson</AppText>
            {selfServiceMessage ? (
              <FeatureCard title="Self-service update" detail={selfServiceMessage} />
            ) : null}
            {!selfServiceStudioSlug ? (
              <FeatureCard
                title="Self-service not configured"
                detail="Add EXPO_PUBLIC_DANCEFLOW_STUDIO_SLUG to enable in-app booking requests."
              />
            ) : selfServiceDecision?.allowed === false ? (
              <FeatureCard
                title="Self-service unavailable"
                detail={selfServiceDecision.reason ?? "This studio is not accepting self-service booking requests right now."}
              />
            ) : selfServiceSlots.length > 0 ? (
              selfServiceSlots.slice(0, 6).map((slot) => {
                const slotKey = `${slot.startsAt}|${slot.endsAt}`;
                return (
                  <SelfServiceSlotCard
                    key={slotKey}
                    slot={slot}
                    timeZone={selfServiceTimeZone}
                    submitting={submittingSlotKey === slotKey}
                    onPress={() => submitSelfServiceSlot(slot)}
                  />
                );
              })
            ) : (
              <FeatureCard
                title="No self-service times"
                detail="The studio has not opened any private lesson slots yet."
              />
            )}
          </View>

          {bookingRequests.length > 0 || activeSelfServiceRequests.length > 0 ? (
            <View style={styles.section}>
              <AppText variant="subtitle">Booking requests</AppText>
              {activeSelfServiceRequests.slice(0, 6).map((request) => (
                <SelfServiceRequestCard
                  key={request.id}
                  request={request}
                  timeZone={selfServiceTimeZone}
                />
              ))}
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
  valueList: {
    gap: 12
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
  slotCard: {
    backgroundColor: colors.surface,
    borderColor: colors.primary,
    borderRadius: 18,
    borderWidth: 1,
    elevation: 1,
    gap: 8,
    padding: 16
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
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    elevation: 1,
    flex: 1,
    gap: 6,
    padding: 16
  }
});
