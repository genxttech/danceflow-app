import { useEffect, useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess, type LinkedStudioAccess } from "@/lib/studentAccess";
import {
  formatWalletDate,
  loadStudentWallet,
  type StudentTicket,
  type StudentWallet
} from "@/lib/studentWallet";

function locationLine(ticket: StudentTicket) {
  return [ticket.venue, [ticket.city, ticket.state].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join(" • ");
}

function TicketCard({ ticket }: { ticket: StudentTicket }) {
  const checkedIn = Boolean(ticket.checkedInAt);
  const location = locationLine(ticket);

  return (
    <View style={styles.ticketCard}>
      <View style={styles.ticketMain}>
        <AppText variant="eyebrow">{checkedIn ? "Checked in" : "Ticket"}</AppText>
        <AppText variant="subtitle">{ticket.eventName}</AppText>
        <AppText variant="caption">Hosted by {ticket.hostName}</AppText>
        <AppText variant="caption">{ticket.ticketName}</AppText>
        <AppText variant="caption">
          {formatWalletDate(ticket.eventDate)}{ticket.eventTime ? ` • ${ticket.eventTime}` : ""}
        </AppText>
        {location ? <AppText variant="caption">{location}</AppText> : null}
        {ticket.ticketCode ? (
          <View style={styles.codeBox}>
            <AppText variant="eyebrow">Code</AppText>
            <AppText variant="subtitle">{ticket.ticketCode}</AppText>
          </View>
        ) : (
          <AppText variant="caption">Ticket code will appear when issued.</AppText>
        )}
      </View>
      {ticket.qrImageUrl ? (
        <Image
          accessibilityIgnoresInvertColors
          resizeMode="contain"
          source={{ uri: ticket.qrImageUrl }}
          style={styles.qrImage}
        />
      ) : null}
    </View>
  );
}

export default function EventTicketsScreen() {
  const { session } = useAuth();
  const [loading, setLoading] = useState(true);
  const [wallet, setWallet] = useState<StudentWallet | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const userId = session?.user.id;

    async function load() {
      if (!userId) {
        setWallet(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      setErrorMessage(null);

      try {
        const access: { linkedStudios: LinkedStudioAccess[] } = await getStudentAccess(userId);
        const nextWallet = await loadStudentWallet(access.linkedStudios, session?.user.email ?? null);

        if (!mounted) return;
        setWallet(nextWallet);
      } catch {
        if (!mounted) return;
        setErrorMessage("Event tickets could not be loaded. Try again in a moment.");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();

    return () => {
      mounted = false;
    };
  }, [session?.user.email, session?.user.id]);

  const tickets = wallet?.tickets ?? [];
  const registrations = wallet?.registrations ?? [];

  return (
    <Screen>
      <AppText variant="eyebrow">Wallet</AppText>
      <AppText variant="title">Event Tickets</AppText>
      <AppText variant="caption">Keep ticket codes and QR check-in details handy.</AppText>

      {loading ? <FeatureCard title="Loading tickets" detail="Checking your event tickets." /> : null}
      {errorMessage ? <FeatureCard title="Tickets unavailable" detail={errorMessage} /> : null}

      {!loading && tickets.length > 0 ? (
        <View style={styles.section}>
          {tickets.slice(0, 10).map((ticket) => (
            <TicketCard key={ticket.id} ticket={ticket} />
          ))}
        </View>
      ) : !loading && registrations.length > 0 ? (
        <FeatureCard
          title="Registrations found"
          detail="Your registrations are available. Ticket codes will appear here when attendee tickets are issued."
        />
      ) : !loading ? (
        <FeatureCard
          title="No event tickets yet"
          detail="Register for DanceFlow events with this account email, and tickets or check-in QR codes can appear here."
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  codeBox: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    gap: 3,
    marginTop: 4,
    padding: 10
  },
  qrImage: {
    backgroundColor: "white",
    borderRadius: 12,
    height: 104,
    width: 104
  },
  section: {
    gap: 10
  },
  ticketCard: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderRadius: 18,
    flexDirection: "row",
    gap: 14,
    padding: 14
  },
  ticketMain: {
    flex: 1,
    gap: 7
  }
});
