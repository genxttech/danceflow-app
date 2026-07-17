import { Link, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { useAuth } from "@/lib/auth";
import { getStudentAccess } from "@/lib/studentAccess";
import {
  formatWalletDate,
  loadStudentWallet,
  type StudentWallet
} from "@/lib/studentWallet";

type EventScheduleItem = {
  id: string;
  eventId: string;
  eventName: string;
  eventSlug: string | null;
  studioName: string;
  status: string;
  paymentStatus: string | null;
  ticketCount: number;
  eventDate: string | null;
  eventTime: string | null;
  venue: string | null;
  city: string | null;
  state: string | null;
};

function eventDateKey(item: Pick<EventScheduleItem, "eventDate">) {
  return item.eventDate?.slice(0, 10) ?? null;
}

function todayDateKey() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isUpcomingEvent(item: EventScheduleItem) {
  const dateKey = eventDateKey(item);
  if (!dateKey) return true;
  return dateKey >= todayDateKey();
}

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

function eventItemsFromWallet(
  wallet: StudentWallet | null
): EventScheduleItem[] {
  if (!wallet) return [];

  const ticketCountByRegistrationId = new Map<string, number>();

  wallet.tickets.forEach((ticket) => {
    ticketCountByRegistrationId.set(
      ticket.registrationId,
      (ticketCountByRegistrationId.get(ticket.registrationId) ?? 0) + 1
    );
  });

  const registrationItems = wallet.registrations.map((registration) => ({
    id: registration.id,
    eventId: registration.eventId,
    eventName: registration.eventName,
    eventSlug: registration.eventSlug,
    studioName: registration.studioName,
    status: registration.status,
    paymentStatus: registration.paymentStatus,
    ticketCount: ticketCountByRegistrationId.get(registration.id) ?? 0,
    eventDate: registration.eventDate,
    eventTime: registration.eventTime,
    venue: registration.venue,
    city: registration.city,
    state: registration.state
  }));

  const registrationIds = new Set(
    registrationItems.map((item) => item.id)
  );

  const ticketOnlyItems = wallet.tickets
    .filter((ticket) => !registrationIds.has(ticket.registrationId))
    .map((ticket) => ({
      id: ticket.registrationId,
      eventId: ticket.eventId,
      eventName: ticket.eventName,
      eventSlug: ticket.eventSlug,
      studioName: ticket.studioName,
      status: ticket.checkedInAt ? "checked_in" : "confirmed",
      paymentStatus: null,
      ticketCount: 1,
      eventDate: ticket.eventDate,
      eventTime: ticket.eventTime,
      venue: ticket.venue,
      city: ticket.city,
      state: ticket.state
    }));

  return [...registrationItems, ...ticketOnlyItems].sort((a, b) => {
    const aDate = eventDateKey(a) ?? "9999-12-31";
    const bDate = eventDateKey(b) ?? "9999-12-31";
    return aDate.localeCompare(bDate);
  });
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

function EventCard({
  item,
  muted = false
}: {
  item: EventScheduleItem;
  muted?: boolean;
}) {
  const router = useRouter();
  const location = locationLine(item);

  return (
    <Pressable
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
            <Ionicons color="#C2410C" name="ticket-outline" size={18} />
          </View>

          <View style={{ flex: 1 }}>
            <AppText style={styles.eventStatus}>
              {statusText(item)}
            </AppText>
            <AppText style={styles.eventStudio}>{item.studioName}</AppText>
          </View>

          <Ionicons color="#94A3B8" name="chevron-forward" size={18} />
        </View>

        <AppText style={styles.eventTitle}>{item.eventName}</AppText>

        <View style={styles.metaRow}>
          <Ionicons color="#64748B" name="calendar-outline" size={15} />
          <AppText style={styles.metaText}>
            {formatWalletDate(item.eventDate)}
            {item.eventTime ? ` • ${item.eventTime}` : ""}
          </AppText>
        </View>

        {location ? (
          <View style={styles.metaRow}>
            <Ionicons color="#64748B" name="location-outline" size={15} />
            <AppText style={styles.metaText}>{location}</AppText>
          </View>
        ) : null}

        <View style={styles.ticketRow}>
          <View style={styles.ticketPill}>
            <Ionicons color="#C2410C" name="qr-code-outline" size={14} />
            <AppText style={styles.ticketPillText}>
              {item.ticketCount > 0
                ? `${item.ticketCount} ${
                    item.ticketCount === 1 ? "ticket" : "tickets"
                  }`
                : "Registration"}
            </AppText>
          </View>

          <Pressable
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
    } catch {
      setErrorMessage(
        "Events could not be loaded. Try again in a moment."
      );
      setWallet(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadEvents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.email, session?.user.id]);

  const eventItems = useMemo(
    () => eventItemsFromWallet(wallet),
    [wallet]
  );
  const upcomingEvents = eventItems.filter(isUpcomingEvent);

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
        <FeatureCard
          title="Loading events"
          detail="Checking registrations and tickets."
        />
      ) : null}

      {!loading && errorMessage ? (
        <FeatureCard title="Events unavailable" detail={errorMessage} />
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
                detail="Events you register for or purchase with this account email will appear here."
              />
            )}
          </View>

        </>
      ) : null}

      {session ? (
        <Pressable
          onPress={loadEvents}
          style={({ pressed }) => [
            styles.refreshLink,
            pressed && styles.pressed
          ]}
        >
          <Ionicons color="#64748B" name="refresh-outline" size={16} />
          <AppText style={styles.refreshLinkText}>Refresh events</AppText>
        </Pressable>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  countBadge: {
    alignItems: "center",
    backgroundColor: "#FFF7ED",
    borderRadius: 999,
    minWidth: 32,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  countBadgeText: {
    color: "#C2410C",
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
    backgroundColor: "#FFFFFF",
    borderColor: "#FED7AA",
    borderRadius: 20,
    borderWidth: 1,
    elevation: 1,
    flexDirection: "row",
    overflow: "hidden"
  },
  eventCardMuted: {
    borderColor: "#E2E8F0",
    opacity: 0.78
  },
  eventIcon: {
    alignItems: "center",
    backgroundColor: "#FFF7ED",
    borderRadius: 12,
    height: 36,
    justifyContent: "center",
    width: 36
  },
  eventStatus: {
    color: "#C2410C",
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0.7,
    textTransform: "uppercase"
  },
  eventStudio: {
    color: "#64748B",
    fontSize: 12,
    marginTop: 2
  },
  eventTitle: {
    color: "#0F172A",
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
    color: "#64748B",
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
    color: "#64748B",
    fontSize: 13,
    fontWeight: "800"
  },
  section: {
    gap: 12
  },
  sectionEyebrow: {
    color: "#C2410C",
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
    color: "#0F172A",
    fontSize: 21,
    fontWeight: "900",
    marginTop: 3
  },
  ticketLink: {
    color: "#C2410C",
    fontSize: 12,
    fontWeight: "900"
  },
  ticketPill: {
    alignItems: "center",
    backgroundColor: "#FFF7ED",
    borderRadius: 999,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  ticketPillText: {
    color: "#C2410C",
    fontSize: 11,
    fontWeight: "900"
  },
  ticketRow: {
    alignItems: "center",
    borderTopColor: "#F1F5F9",
    borderTopWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
    paddingTop: 12
  }
});
