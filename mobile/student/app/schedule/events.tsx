import { Link, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess } from "@/lib/studentAccess";
import {
  formatWalletDate,
  loadStudentWallet,
  type StudentEventRegistration,
  type StudentTicket,
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

function eventDateTime(item: Pick<EventScheduleItem, "eventDate" | "eventTime">) {
  if (!item.eventDate) return null;
  return new Date(`${item.eventDate}T${item.eventTime || "12:00:00"}`);
}

function isUpcomingEvent(item: EventScheduleItem) {
  const date = eventDateTime(item);
  if (!date || Number.isNaN(date.getTime())) return true;
  return date.getTime() >= new Date().setHours(0, 0, 0, 0);
}

function locationLine(item: EventScheduleItem) {
  return [item.venue, [item.city, item.state].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join(" • ");
}

function statusText(item: EventScheduleItem) {
  if (item.paymentStatus && item.paymentStatus !== "paid") return item.paymentStatus.replaceAll("_", " ");
  return item.status.replaceAll("_", " ");
}

function eventItemsFromWallet(wallet: StudentWallet | null): EventScheduleItem[] {
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

  const registrationIds = new Set(registrationItems.map((item) => item.id));
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
    const aTime = eventDateTime(a)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bTime = eventDateTime(b)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return aTime - bTime;
  });
}

function EventCard({ item }: { item: EventScheduleItem }) {
  const router = useRouter();
  const location = locationLine(item);

  return (
    <View style={styles.eventCard}>
      <View style={styles.itemHeader}>
        <AppText variant="eyebrow">{statusText(item)}</AppText>
        <AppText variant="caption">{item.studioName}</AppText>
      </View>
      <AppText variant="subtitle">{item.eventName}</AppText>
      <AppText variant="caption">
        {formatWalletDate(item.eventDate)}{item.eventTime ? ` • ${item.eventTime}` : ""}
      </AppText>
      {location ? <AppText variant="caption">{location}</AppText> : null}
      <AppText variant="caption">
        {item.ticketCount > 0
          ? `${item.ticketCount} ticket${item.ticketCount === 1 ? "" : "s"} ready or pending`
          : "Registration found. Ticket codes will appear when issued."}
      </AppText>
      <View style={styles.actionRow}>
        <AppButton label="Tickets" onPress={() => router.push("/wallet/event-tickets")} variant="secondary" />
        <AppButton
          label="Event details"
          onPress={() => router.push(`/events/${item.eventId}`)}
          variant="secondary"
        />
      </View>
    </View>
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
      setWallet(await loadStudentWallet(access.linkedStudios, session?.user.email ?? null));
    } catch {
      setErrorMessage("Events could not be loaded. Try again in a moment.");
      setWallet(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadEvents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.email, session?.user.id]);

  const eventItems = useMemo(() => eventItemsFromWallet(wallet), [wallet]);
  const upcomingEvents = eventItems.filter(isUpcomingEvent);
  const pastEvents = eventItems.filter((item) => !isUpcomingEvent(item));

  return (
    <Screen>
      <AppText variant="eyebrow">Schedule</AppText>
      <AppText variant="title">Events</AppText>
      <AppText variant="caption">Purchased and registered DanceFlow events from your account.</AppText>

      {loading ? <FeatureCard title="Loading events..." detail="Checking your event registrations and tickets." /> : null}
      {!loading && errorMessage ? <FeatureCard title="Events unavailable" detail={errorMessage} /> : null}
      {!loading && !session ? (
        <Link href="/(auth)/sign-in" asChild>
          <AppButton label="Create or access your free account" />
        </Link>
      ) : null}

      {!loading && session && upcomingEvents.length > 0 ? (
        <View style={styles.section}>
          <AppText variant="subtitle">Upcoming Events</AppText>
          {upcomingEvents.slice(0, 12).map((item) => (
            <EventCard key={item.id} item={item} />
          ))}
        </View>
      ) : null}

      {!loading && session && upcomingEvents.length === 0 ? (
        <FeatureCard
          title="No upcoming events"
          detail="Events you register for or purchase with this account email will appear here."
        />
      ) : null}

      {!loading && pastEvents.length > 0 ? (
        <View style={styles.section}>
          <AppText variant="subtitle">Past Events</AppText>
          {pastEvents.slice(0, 8).map((item) => (
            <EventCard key={item.id} item={item} />
          ))}
        </View>
      ) : null}

      {session ? <AppButton label="Refresh events" onPress={loadEvents} variant="secondary" /> : null}
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
  eventCard: {
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
  section: {
    gap: 10
  }
});
