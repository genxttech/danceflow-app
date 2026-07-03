import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { danceflowApiFetch } from "@/lib/danceflowApi";
import { formatScheduleDateTime } from "@/lib/studentSchedule";

const selfServiceStudioSlug = process.env.EXPO_PUBLIC_DANCEFLOW_STUDIO_SLUG;

type SelfServiceSlot = {
  date: string;
  startsAt: string;
  endsAt: string;
  instructorId: string | null;
  roomId: string | null;
};

type SelfServiceInstructor = {
  id: string;
  name: string;
};

type SelfServiceSlotsResponse = {
  slots: SelfServiceSlot[];
  instructors?: SelfServiceInstructor[];
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

function formatSelfServiceDate(dateKey: string, timeZone: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric"
  }).format(date);
}

function actionLabel(value: string) {
  if (value === "book") return "Booking";
  if (value === "reschedule") return "Reschedule";
  if (value === "cancel") return "Cancellation";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function RequestStatusCard({
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
      <View style={styles.rowBetween}>
        <AppText variant="eyebrow">{request.status.replaceAll("_", " ")}</AppText>
        <AppText variant="caption">{request.mode.replaceAll("_", " ")}</AppText>
      </View>
      <AppText variant="subtitle">{actionLabel(request.action_type)} request</AppText>
      <AppText variant="caption">
        {startsAt ? formatScheduleDateTime(startsAt, timeZone) : "Studio will review your request."}
      </AppText>
      {request.staff_note ? <AppText variant="caption">Studio note: {request.staff_note}</AppText> : null}
      {request.failure_reason ? <AppText variant="caption">{request.failure_reason}</AppText> : null}
    </View>
  );
}

export default function ScheduleRequestScreen() {
  const [loading, setLoading] = useState(true);
  const [slots, setSlots] = useState<SelfServiceSlot[]>([]);
  const [instructors, setInstructors] = useState<SelfServiceInstructor[]>([]);
  const [selectedInstructorId, setSelectedInstructorId] = useState("");
  const [selectedDate, setSelectedDate] = useState("");
  const [decision, setDecision] = useState<SelfServiceSlotsResponse["bookingDecision"]>(undefined);
  const [requests, setRequests] = useState<SelfServiceRequestsResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [submittingSlotKey, setSubmittingSlotKey] = useState<string | null>(null);

  async function loadRequestOptions() {
    setLoading(true);
    setMessage(null);

    if (!selfServiceStudioSlug) {
      setSlots([]);
      setInstructors([]);
      setRequests(null);
      setLoading(false);
      return;
    }

    try {
      const [slotsResponse, requestsResponse] = await Promise.all([
        danceflowApiFetch<SelfServiceSlotsResponse>("/api/student/self-service/slots", {
          params: {
            studioSlug: selfServiceStudioSlug,
            lessonType: "private_lesson",
            instructorId: selectedInstructorId || null
          }
        }),
        danceflowApiFetch<SelfServiceRequestsResponse>("/api/student/self-service/requests", {
          params: {
            studioSlug: selfServiceStudioSlug
          }
        })
      ]);

      setSlots(slotsResponse.slots ?? []);
      setInstructors(slotsResponse.instructors ?? []);
      setDecision(slotsResponse.bookingDecision);
      setRequests(requestsResponse);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Lesson requests could not be loaded.");
      setSlots([]);
      setInstructors([]);
      setRequests(null);
    } finally {
      setLoading(false);
    }
  }

  async function submitSlot(slot: SelfServiceSlot) {
    if (!selfServiceStudioSlug) {
      setMessage("Lesson requests are not configured yet.");
      return;
    }

    const slotKey = `${slot.startsAt}|${slot.endsAt}`;
    setSubmittingSlotKey(slotKey);
    setMessage(null);

    try {
      const response = await danceflowApiFetch<{ bookingDecision?: { mode: string | null } }>(
        "/api/student/self-service/actions",
        {
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
        }
      );

      setMessage(
        response.bookingDecision?.mode === "instant"
          ? "Lesson booked."
          : "Request sent to the studio."
      );
      await loadRequestOptions();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not submit the request.");
    } finally {
      setSubmittingSlotKey(null);
    }
  }

  useEffect(() => {
    loadRequestOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInstructorId]);

  const timeZone = requests?.timezone ?? "America/New_York";
  const dates = Array.from(new Set(slots.map((slot) => slot.date)));
  const visibleSlots = selectedDate ? slots.filter((slot) => slot.date === selectedDate) : [];
  const activeRequests =
    requests?.requests.filter((request) =>
      ["pending", "approved", "executed", "declined", "failed"].includes(request.status)
    ) ?? [];

  return (
    <Screen>
      <AppText variant="eyebrow">Schedule</AppText>
      <AppText variant="title">Private Lesson Request</AppText>
      <AppText variant="caption">
        Choose an available private lesson time and send the request to your studio.
      </AppText>

      {loading ? <FeatureCard title="Loading request options" detail="Checking available lesson times." /> : null}
      {message ? <FeatureCard title="Request update" detail={message} /> : null}

      {!selfServiceStudioSlug ? (
        <FeatureCard
          title="Lesson requests are not configured"
          detail="Add EXPO_PUBLIC_DANCEFLOW_STUDIO_SLUG to enable in-app booking requests."
        />
      ) : decision?.allowed === false ? (
        <FeatureCard
          title="Lesson requests unavailable"
          detail={decision.reason ?? "This studio is not accepting self-service requests right now."}
        />
      ) : (
        <>
          <View style={styles.section}>
            <AppText variant="subtitle">Choose an instructor</AppText>
            <View style={styles.pillList}>
              {instructors.length ? (
                instructors.map((instructor) => (
                  <AppButton
                    key={instructor.id}
                    label={instructor.name}
                    onPress={() => {
                      setSelectedDate("");
                      setSelectedInstructorId(instructor.id);
                    }}
                    variant={selectedInstructorId === instructor.id ? "primary" : "secondary"}
                  />
                ))
              ) : (
                <FeatureCard
                  title="No instructors available"
                  detail="The studio has not opened instructor booking for self-service yet."
                />
              )}
            </View>
          </View>

          {selectedInstructorId ? (
            <View style={styles.section}>
              <AppText variant="subtitle">Choose a day</AppText>
              <View style={styles.pillList}>
                {dates.map((dateKey) => (
                  <AppButton
                    key={dateKey}
                    label={formatSelfServiceDate(dateKey, timeZone)}
                    onPress={() => setSelectedDate(dateKey)}
                    variant={selectedDate === dateKey ? "primary" : "secondary"}
                  />
                ))}
              </View>
            </View>
          ) : null}

          {selectedDate ? (
            <View style={styles.section}>
              <AppText variant="subtitle">Available times</AppText>
              {visibleSlots.length ? (
                visibleSlots.map((slot) => {
                  const slotKey = `${slot.startsAt}|${slot.endsAt}`;
                  return (
                    <View key={slotKey} style={styles.slotCard}>
                      <AppText variant="subtitle">{formatScheduleDateTime(slot.startsAt, timeZone)}</AppText>
                      <AppText variant="caption">
                        {submittingSlotKey === slotKey
                          ? "Submitting..."
                          : "Tap request to send this time to the studio."}
                      </AppText>
                      <AppButton
                        label={submittingSlotKey === slotKey ? "Submitting..." : "Request this time"}
                        onPress={() => submitSlot(slot)}
                        variant="secondary"
                      />
                    </View>
                  );
                })
              ) : (
                <FeatureCard
                  title="No times for this day"
                  detail="Choose a different day or instructor."
                />
              )}
            </View>
          ) : null}
        </>
      )}

      {activeRequests.length ? (
        <View style={styles.section}>
          <AppText variant="subtitle">Recent requests</AppText>
          {activeRequests.slice(0, 6).map((request) => (
            <RequestStatusCard key={request.id} request={request} timeZone={timeZone} />
          ))}
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  pillList: {
    gap: 8
  },
  requestCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 7,
    padding: 16
  },
  rowBetween: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between"
  },
  section: {
    gap: 10
  },
  slotCard: {
    backgroundColor: colors.surface,
    borderColor: colors.primary,
    borderRadius: 18,
    borderWidth: 1,
    gap: 8,
    padding: 16
  }
});
