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
import { getStudentAccess } from "@/lib/studentAccess";
import {
  formatWalletDate,
  loadStudentWallet,
  type StudentWallet
} from "@/lib/studentWallet";
import { failureMessage } from "@/lib/errorKind";
import { eventItemsFromWallet, PAST_PAGE_SIZE, type EventScheduleItem } from "@/lib/eventRegistrationHistory";

function locationLine(item: EventScheduleItem) {
  return [item.venue, [item.city, item.state].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join(" • ");
}

function statusText(item: EventScheduleItem) {
  if (item.paymentStatus && item.paymentStatus !== "paid") {
    return item.paymentStatus.replaceAll("_", " ");
  }

  return item.status.replaceAll("_", " ");
}

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
        <AppText accessibilityRole="header" style={styles.sectionTitle}>{title}</AppText>
      </View>
      <View style={styles.countBadge}>
        <AppText style={styles.countBadgeText}>{count}</AppText>
      </View>
    </View>
  );
}

function EventCard({
  item,
  muted = false
}: {
  item: EventScheduleItem;
  muted?: boolean;
}) {
  const colors = colorsForScheme(useColorScheme());
  const styles = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();
  const location = locationLine(item);

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push(`/events/${item.eventId}`)}
      style={({ pressed }) => [
        styles.eventCard,
        muted && styles.eventCardMuted,
        pressed && styles.pressed
      ]}
    >
      <View style={styles.eventAccent} />

      <View style={styles.eventBody}>
        <View style={styles.eventTopRow}>
          <View style={styles.eventIcon}>
            <Ionicons color={colors.accent} name="ticket-outline" size={18} />
          </View>

          <View style={{ flex: 1 }}>
            <AppText style={styles.eventStatus}>
              {statusText(item)}
            </AppText>
            <AppText style={styles.eventStudio}>{item.hostName}</AppText>
          </View>

          <Ionicons color={colors.muted} name="chevron-forward" size={18} />
        </View>

        <AppText style={styles.eventTitle}>{item.eventName}</AppText>

        <View style={styles.metaRow}>
          <Ionicons color={colors.muted} name="calendar-outline" size={15} />
          <AppText style={styles.metaText}>
            {formatWalletDate(item.eventDate)}
            {item.eventTime ? ` • ${item.eventTime}` : ""}
          </AppText>
        </View>

        {location ? (
          <View style={styles.metaRow}>
            <Ionicons color={colors.muted} name="location-outline" size={15} />
            <AppText style={styles.metaText}>{location}</AppText>
          </View>
        ) : null}

        <View style={styles.ticketRow}>
          <View style={styles.ticketPill}>
            <Ionicons color={colors.accent} name="qr-code-outline" size={14} />
            <AppText style={styles.ticketPillText}>
              {item.ticketCount > 0
                ? `${item.ticketCount} ${
                    item.ticketCount === 1 ? "ticket" : "tickets"
                  }`
                : "Registration"}
            </AppText>
          </View>

          <Pressable
            accessibilityRole="button"
            onPress={(event) => {
              event.stopPropagation();
              router.push("/wallet/event-tickets");
            }}
          >
            <AppText style={styles.ticketLink}>Open tickets</AppText>
          </Pressable>
        </View>
      </View>
    </Pressable>
  );
}

export default function ScheduleEventsScreen() {
  const colors = colorsForScheme(useColorScheme());
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { session } = useAuth();
  const [loading, setLoading] = useState(true);
  const [wallet, setWallet] = useState<StudentWallet | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function loadEvents() {
    const userId = session?.user.id;

    if (!userId) {
      setWallet(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setErrorMessage(null);

    try {
      const access = await getStudentAccess(userId);
      setWallet(
        await loadStudentWallet(
          access.linkedStudios,
          session?.user.email ?? null
        )
      );
    } catch (err) {
      setErrorMessage(failureMessage(err, "Events could not be loaded. Try again in a moment."));
      setWallet(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadEvents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.email, session?.user.id]);

  const [pastShown, setPastShown] = useState(PAST_PAGE_SIZE);
  const { upcoming: upcomingEvents, past: pastEvents } = useMemo(() => eventItemsFromWallet(wallet), [wallet]);

  return (
    <Screen>
      <View style={styles.hero}>
        <View style={styles.heroIcon}>
          <Ionicons color="#FFFFFF" name="ticket-outline" size={24} />
        </View>

        <View style={{ flex: 1 }}>
          <AppText style={styles.heroEyebrow}>Event activity</AppText>
          <AppText style={styles.heroTitle}>Tickets & registrations</AppText>
          <AppText style={styles.heroDetail}>
            Purchased events, registrations, ticket status, and check-in
            details.
          </AppText>
        </View>
      </View>

      {loading ? (
        <LoadingState label="Loading events" />
      ) : null}

      {!loading && errorMessage ? (
        <ErrorState error={errorMessage} title="Events unavailable" onRetry={() => void loadEvents()} />
      ) : null}

      {!loading && !session ? (
        <Link href="/(auth)/sign-in" asChild>
          <AppButton label="Sign in to view events" />
        </Link>
      ) : null}

      {!loading && session ? (
        <>
          <View style={styles.section}>
            <SectionHeader
              eyebrow="Coming up"
              title="Upcoming events"
              count={upcomingEvents.length}
            />

            {upcomingEvents.length > 0 ? (
              <View style={styles.list}>
                {upcomingEvents.slice(0, 12).map((item) => (
                  <EventCard key={item.id} item={item} />
                ))}
              </View>
            ) : (
              <FeatureCard
                title="No upcoming events"
                detail="Events you register for or purchase with this account email will appear here, including organizer-hosted events."
              />
            )}
          </View>

          {pastEvents.length > 0 ? (
            <View style={styles.section}>
              <SectionHeader eyebrow="Earlier" title="Past events" count={pastEvents.length} />
              <View style={styles.list}>
                {pastEvents.slice(0, pastShown).map((item) => (
                  <EventCard key={item.id} item={item} muted />
                ))}
              </View>
              {pastEvents.length > pastShown ? (
                <AppButton
                  accessibilityLabel={`Show more past events, ${pastEvents.length - pastShown} remaining`}
                  label={`Show more (${pastEvents.length - pastShown} more)`}
                  onPress={() => setPastShown((count) => count + PAST_PAGE_SIZE)}
                  variant="secondary"
                />
              ) : null}
            </View>
          ) : null}
        </>
      ) : null}

      {session ? (
        <Pressable
          accessibilityRole="button"
          onPress={loadEvents}
          style={({ pressed }) => [
            styles.refreshLink,
            pressed && styles.pressed
          ]}
        >
          <Ionicons color={colors.muted} name="refresh-outline" size={16} />
          <AppText style={styles.refreshLinkText}>Refresh events</AppText>
        </Pressable>
      ) : null}
    </Screen>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    countBadge: {
      alignItems: "center",
      backgroundColor: colors.accentSoft,
      borderRadius: 999,
      minWidth: 32,
      paddingHorizontal: 10,
      paddingVertical: 6
    },
    countBadgeText: {
      color: colors.accent,
      fontSize: 13,
      fontWeight: "900"
    },
    eventAccent: {
      alignSelf: "stretch",
      backgroundColor: "#C2410C",
      borderBottomLeftRadius: 20,
      borderTopLeftRadius: 20,
      width: 5
    },
    eventBody: {
      flex: 1,
      gap: 8,
      padding: 16
    },
    eventCard: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 20,
      borderWidth: 1,
      elevation: 1,
      flexDirection: "row",
      overflow: "hidden"
    },
    eventCardMuted: {
      borderColor: colors.border
    },
    eventIcon: {
      alignItems: "center",
      backgroundColor: colors.accentSoft,
      borderRadius: 12,
      height: 36,
      justifyContent: "center",
      width: 36
    },
    eventStatus: {
      color: colors.accent,
      fontSize: 11,
      fontWeight: "900",
      letterSpacing: 0.7,
      textTransform: "uppercase"
    },
    eventStudio: {
      color: colors.muted,
      fontSize: 12,
      marginTop: 2
    },
    eventTitle: {
      color: colors.text,
      fontSize: 18,
      fontWeight: "900"
    },
    eventTopRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 10
    },
    hero: {
      alignItems: "center",
      backgroundColor: "#2B1A10",
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
      color: "#FED7AA",
      fontSize: 11,
      fontWeight: "900",
      letterSpacing: 1,
      textTransform: "uppercase"
    },
    heroIcon: {
      alignItems: "center",
      backgroundColor: "#C2410C",
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
    section: {
      gap: 12
    },
    sectionEyebrow: {
      color: colors.accent,
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
    ticketLink: {
      color: colors.accent,
      fontSize: 12,
      fontWeight: "900"
    },
    ticketPill: {
      alignItems: "center",
      backgroundColor: colors.accentSoft,
      borderRadius: 999,
      flexDirection: "row",
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 6
    },
    ticketPillText: {
      color: colors.accent,
      fontSize: 11,
      fontWeight: "900"
    },
    ticketRow: {
      alignItems: "center",
      borderTopColor: colors.border,
      borderTopWidth: 1,
      flexDirection: "row",
      justifyContent: "space-between",
      marginTop: 4,
      paddingTop: 12
    }
  });
}
