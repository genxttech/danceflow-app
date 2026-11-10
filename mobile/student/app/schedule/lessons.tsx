import { Link, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, useColorScheme, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { LoadingState } from "@/components/LoadingState";
import { ErrorState } from "@/components/ErrorState";
import { Screen } from "@/components/Screen";
import { colorsForScheme, type ThemeColors } from "@/constants/theme";
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

function SectionHeader({
  eyebrow,
  title,
  count
}: {
  eyebrow: string;
  title: string;
  count: number;
}) {
  const colors = colorsForScheme(useColorScheme());
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.sectionHeader}>
      <View>
        <AppText style={styles.sectionEyebrow}>{eyebrow}</AppText>
        <AppText style={styles.sectionTitle}>{title}</AppText>
      </View>
      <View style={styles.countBadge}>
        <AppText style={styles.countBadgeText}>{count}</AppText>
      </View>
    </View>
  );
}

function LessonCard({
  item,
  muted = false
}: {
  item: StudentScheduleItem;
  muted?: boolean;
}) {
  const colors = colorsForScheme(useColorScheme());
  const styles = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();
  const subtitle = displayScheduleSubtitle(item);

  function openAppointment(action?: "reschedule" | "cancel") {
    router.push({
      pathname: "/appointments/[id]",
      params: action ? { id: item.id, action } : { id: item.id }
    });
  }

  return (
    <Pressable
      onPress={() => openAppointment()}
      style={({ pressed }) => [
        styles.lessonCard,
        muted && styles.lessonCardMuted,
        pressed && styles.pressed
      ]}
    >
      <View
        style={[
          styles.lessonAccent,
          item.status === "confirmed" && styles.lessonAccentConfirmed
        ]}
      />

      <View style={styles.lessonBody}>
        <View style={styles.lessonTopRow}>
          <View style={styles.lessonIcon}>
            <Ionicons color={colors.primary} name="person-outline" size={18} />
          </View>

          <View style={{ flex: 1 }}>
            <AppText style={styles.lessonStatus}>
              {statusLabel(item.status)}
            </AppText>
            <AppText style={styles.lessonStudio}>{item.studioName}</AppText>
          </View>

          <Ionicons color={colors.muted} name="chevron-forward" size={18} />
        </View>

        <AppText style={styles.lessonTitle}>
          {displayScheduleTitle(item)}
        </AppText>

        <View style={styles.metaRow}>
          <Ionicons color={colors.muted} name="time-outline" size={15} />
          <AppText style={styles.metaText}>
            {formatScheduleTimeRange(
              item.startsAt,
              item.endsAt,
              item.timeZone
            )}
          </AppText>
        </View>

        {subtitle ? (
          <View style={styles.metaRow}>
            <Ionicons color={colors.muted} name="location-outline" size={15} />
            <AppText style={styles.metaText}>{subtitle}</AppText>
          </View>
        ) : null}

        {!muted ? (
          <View style={styles.cardActions}>
            <Pressable
              onPress={(event) => {
                event.stopPropagation();
                openAppointment("reschedule");
              }}
              style={styles.textAction}
            >
              <AppText style={styles.textActionLabel}>Reschedule</AppText>
            </Pressable>

            <Pressable
              onPress={(event) => {
                event.stopPropagation();
                openAppointment("cancel");
              }}
              style={styles.textAction}
            >
              <AppText style={styles.textActionLabel}>Cancel</AppText>
            </Pressable>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

function BookingRequestCard({
  request
}: {
  request: StudentBookingRequest;
}) {
  const colors = colorsForScheme(useColorScheme());
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.requestCard}>
      <View style={styles.requestIcon}>
        <Ionicons color={colors.accent} name="hourglass-outline" size={18} />
      </View>

      <View style={{ flex: 1 }}>
        <View style={styles.requestTopRow}>
          <AppText style={styles.requestTitle}>Lesson request</AppText>
          <AppText style={styles.requestStatus}>
            {statusLabel(request.status)}
          </AppText>
        </View>

        <AppText style={styles.requestStudio}>{request.studioName}</AppText>
        <AppText style={styles.requestDetail}>
          {request.requestedStartsAt
            ? formatScheduleDateTime(
                request.requestedStartsAt,
                request.timeZone
              )
            : "Your studio will follow up with available times."}
        </AppText>
      </View>
    </View>
  );
}

export default function ScheduleLessonsScreen() {
  const colors = colorsForScheme(useColorScheme());
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { session } = useAuth();
  const [loading, setLoading] = useState(true);
  const [linkedStudios, setLinkedStudios] = useState<LinkedStudioAccess[]>([]);
  const [overview, setOverview] =
    useState<StudentScheduleOverview | null>(null);
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
      setOverview(
        access.linkedStudios.length
          ? await loadStudentScheduleOverview(access.linkedStudios)
          : null
      );
    } catch {
      setErrorMessage(
        "Lessons could not be loaded. Try again in a moment."
      );
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
  const upcomingLessons = (overview?.upcoming ?? []).filter(
    isLessonScheduleItem
  );
  const recentLessons = (overview?.recent ?? []).filter(
    isLessonScheduleItem
  );
  const bookingRequests = overview?.bookingRequests ?? [];

  return (
    <Screen>
      <View style={styles.hero}>
        <View style={styles.heroIcon}>
          <Ionicons color={colors.onPrimary} name="person-outline" size={24} />
        </View>

        <View style={{ flex: 1 }}>
          <AppText style={styles.heroEyebrow}>Private lessons</AppText>
          <AppText style={styles.heroTitle}>Your lesson schedule</AppText>
          <AppText style={styles.heroDetail}>
            Upcoming lessons, booking requests, and recent coaching in one
            place.
          </AppText>
        </View>
      </View>

      {session ? (
        <Link href="/schedule/request" asChild>
          <Pressable
            style={({ pressed }) => [
              styles.primaryAction,
              pressed && styles.pressed
            ]}
          >
            <View style={styles.primaryActionIcon}>
              <Ionicons color={colors.onPrimary} name="add-outline" size={22} />
            </View>
            <View style={{ flex: 1 }}>
              <AppText style={styles.primaryActionTitle}>
                Book a private lesson
              </AppText>
              <AppText style={styles.primaryActionDetail}>
                Choose an available studio, instructor, date, and time.
              </AppText>
            </View>
            <Ionicons color={colors.onPrimary} name="chevron-forward" size={18} />
          </Pressable>
        </Link>
      ) : null}

      {loading ? (
        <LoadingState label="Loading lessons" />
      ) : null}

      {!loading && errorMessage ? (
        <ErrorState error={errorMessage} title="Lessons unavailable" />
      ) : null}

      {!loading && !session ? (
        <Link href="/(auth)/sign-in" asChild>
          <AppButton label="Sign in to view lessons" />
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
          <View style={styles.section}>
            <SectionHeader
              eyebrow="Coming up"
              title="Upcoming lessons"
              count={upcomingLessons.length}
            />

            {upcomingLessons.length > 0 ? (
              <View style={styles.list}>
                {upcomingLessons.slice(0, 10).map((item) => (
                  <LessonCard key={item.id} item={item} />
                ))}
              </View>
            ) : (
              <FeatureCard
                title="No upcoming lessons"
                detail="Scheduled private lessons and coachings will appear here."
              />
            )}
          </View>

          {bookingRequests.length > 0 ? (
            <View style={styles.section}>
              <SectionHeader
                eyebrow="Pending"
                title="Booking requests"
                count={bookingRequests.length}
              />
              <View style={styles.list}>
                {bookingRequests.slice(0, 8).map((request) => (
                  <BookingRequestCard
                    key={request.id}
                    request={request}
                  />
                ))}
              </View>
            </View>
          ) : null}

          {recentLessons.length > 0 ? (
            <View style={styles.section}>
              <SectionHeader
                eyebrow="History"
                title="Recent lessons"
                count={recentLessons.length}
              />
              <View style={styles.list}>
                {recentLessons.slice(0, 8).map((item) => (
                  <LessonCard key={item.id} item={item} muted />
                ))}
              </View>
            </View>
          ) : null}
        </>
      ) : null}

      {session ? (
        <Pressable
          onPress={loadLessons}
          style={({ pressed }) => [
            styles.refreshLink,
            pressed && styles.pressed
          ]}
        >
          <Ionicons color={colors.muted} name="refresh-outline" size={16} />
          <AppText style={styles.refreshLinkText}>Refresh lessons</AppText>
        </Pressable>
      ) : null}
    </Screen>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    cardActions: {
      borderTopColor: colors.border,
      borderTopWidth: 1,
      flexDirection: "row",
      gap: 16,
      marginTop: 4,
      paddingTop: 12
    },
    countBadge: {
      alignItems: "center",
      backgroundColor: colors.surfaceAlt,
      borderRadius: 999,
      minWidth: 32,
      paddingHorizontal: 10,
      paddingVertical: 6
    },
    countBadgeText: {
      color: colors.primary,
      fontSize: 13,
      fontWeight: "900"
    },
    hero: {
      alignItems: "center",
      backgroundColor: colors.primaryDark,
      borderRadius: 28,
      flexDirection: "row",
      gap: 14,
      padding: 20
    },
    heroDetail: {
      color: "rgba(255,255,255,0.7)",
      fontSize: 13,
      lineHeight: 19,
      marginTop: 6
    },
    heroEyebrow: {
      color: "rgba(255,255,255,0.78)",
      fontSize: 11,
      fontWeight: "900",
      letterSpacing: 1,
      textTransform: "uppercase"
    },
    heroIcon: {
      alignItems: "center",
      backgroundColor: colors.primary,
      borderRadius: 18,
      height: 54,
      justifyContent: "center",
      width: 54
    },
    heroTitle: {
      color: "#FFFFFF",
      fontSize: 23,
      fontWeight: "900",
      marginTop: 3
    },
    lessonAccent: {
      alignSelf: "stretch",
      backgroundColor: colors.primary,
      borderBottomLeftRadius: 20,
      borderTopLeftRadius: 20,
      width: 5
    },
    lessonAccentConfirmed: {
      backgroundColor: "#06B6D4"
    },
    lessonBody: {
      flex: 1,
      gap: 8,
      padding: 16
    },
    lessonCard: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 20,
      borderWidth: 1,
      elevation: 1,
      flexDirection: "row",
      overflow: "hidden"
    },
    lessonCardMuted: {
      borderColor: colors.border,
      opacity: 0.78
    },
    lessonIcon: {
      alignItems: "center",
      backgroundColor: colors.surfaceAlt,
      borderRadius: 12,
      height: 36,
      justifyContent: "center",
      width: 36
    },
    lessonStatus: {
      color: colors.primary,
      fontSize: 11,
      fontWeight: "900",
      letterSpacing: 0.7,
      textTransform: "uppercase"
    },
    lessonStudio: {
      color: colors.muted,
      fontSize: 12,
      marginTop: 2
    },
    lessonTitle: {
      color: colors.text,
      fontSize: 18,
      fontWeight: "900"
    },
    lessonTopRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 10
    },
    list: {
      gap: 12
    },
    metaRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 7
    },
    metaText: {
      color: colors.muted,
      flex: 1,
      fontSize: 13,
      lineHeight: 19
    },
    pressed: {
      opacity: 0.75
    },
    primaryAction: {
      alignItems: "center",
      backgroundColor: colors.primary,
      borderRadius: 22,
      flexDirection: "row",
      gap: 12,
      padding: 16
    },
    primaryActionDetail: {
      color: colors.onPrimary,
      opacity: 0.8,
      fontSize: 12,
      lineHeight: 18,
      marginTop: 3
    },
    primaryActionIcon: {
      alignItems: "center",
      backgroundColor: "rgba(255,255,255,0.14)",
      borderRadius: 999,
      height: 42,
      justifyContent: "center",
      width: 42
    },
    primaryActionTitle: {
      color: colors.onPrimary,
      fontSize: 16,
      fontWeight: "900"
    },
    refreshLink: {
      alignItems: "center",
      alignSelf: "center",
      flexDirection: "row",
      gap: 7,
      paddingVertical: 8
    },
    refreshLinkText: {
      color: colors.muted,
      fontSize: 13,
      fontWeight: "800"
    },
    requestCard: {
      alignItems: "center",
      backgroundColor: colors.accentSoft,
      borderColor: colors.border,
      borderRadius: 18,
      borderWidth: 1,
      flexDirection: "row",
      gap: 12,
      padding: 15
    },
    requestDetail: {
      color: colors.muted,
      fontSize: 12,
      lineHeight: 18,
      marginTop: 5
    },
    requestIcon: {
      alignItems: "center",
      backgroundColor: colors.accentSoft,
      borderRadius: 12,
      height: 38,
      justifyContent: "center",
      width: 38
    },
    requestStatus: {
      color: colors.accent,
      fontSize: 10,
      fontWeight: "900",
      textTransform: "uppercase"
    },
    requestStudio: {
      color: colors.accent,
      fontSize: 12,
      marginTop: 2
    },
    requestTitle: {
      color: colors.text,
      fontSize: 15,
      fontWeight: "900"
    },
    requestTopRow: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between"
    },
    section: {
      gap: 12
    },
    sectionEyebrow: {
      color: colors.primary,
      fontSize: 11,
      fontWeight: "900",
      letterSpacing: 1,
      textTransform: "uppercase"
    },
    sectionHeader: {
      alignItems: "flex-end",
      flexDirection: "row",
      justifyContent: "space-between"
    },
    sectionTitle: {
      color: colors.text,
      fontSize: 21,
      fontWeight: "900",
      marginTop: 3
    },
    textAction: {
      paddingVertical: 2
    },
    textActionLabel: {
      color: colors.primary,
      fontSize: 13,
      fontWeight: "900"
    }
  });
}
