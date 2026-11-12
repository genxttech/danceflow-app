import { useEffect, useMemo, useState } from "react";
import { Image, StyleSheet, useColorScheme, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { EventArt } from "@/components/EventArt";
import { admitLine, PASS, ticketAccessibilityLabel, ticketHolder, ticketWhen } from "@/lib/ticketPass";
import { ticketPaymentLabel } from "@/lib/ticketFacts";
import { EVENT_ART_ACCENT, EVENT_ART_TEXT } from "@/lib/eventArt";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { LoadingState } from "@/components/LoadingState";
import { ErrorState } from "@/components/ErrorState";
import { Screen } from "@/components/Screen";
import { colorsForScheme, type ThemeColors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess, type LinkedStudioAccess } from "@/lib/studentAccess";
import {
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
  const colors = colorsForScheme(useColorScheme());
  const styles = useMemo(() => createStyles(colors), [colors]);
  const checkedIn = Boolean(ticket.checkedInAt);
  const location = locationLine(ticket);
  const when = ticketWhen(ticket);
  const admits = admitLine(ticket);
  const payment = ticketPaymentLabel(ticket.paymentState);

  return (
    <View accessible accessibilityLabel={ticketAccessibilityLabel(ticket)} style={styles.pass} testID="ticket-pass">
      <EventArt height={132} labels={[ticket.eventName]} radius={0}>
        <AppText style={styles.passWhen}>{when}</AppText>
        <AppText numberOfLines={2} style={styles.passName}>{ticket.eventName}</AppText>
      </EventArt>
      <View style={styles.passBody}>
        {ticket.qrImageUrl ? (
          <Image accessibilityIgnoresInvertColors resizeMode="contain" source={{ uri: ticket.qrImageUrl }} style={styles.qrImage} testID="ticket-qr" />
        ) : null}
        {ticket.ticketCode ? (
          <View style={styles.codeBlock}>
            <AppText style={styles.passMuted}>{ticket.qrImageUrl ? "Or read this code at the door" : "Show this code at the door"}</AppText>
            {/* One line, always: a code split across lines is misread at the door (it wrapped at 200% on
                Android). It is already large (24 bold), so it doesn't grow with the system text size;
                adjustsFontSizeToFit was tried and clips glyph tops on Android. */}
            <AppText maxFontSizeMultiplier={1} numberOfLines={1} selectable style={styles.code} testID="ticket-code">
              {ticket.ticketCode}
            </AppText>
          </View>
        ) : (
          <AppText style={styles.passMuted}>Your ticket code appears here when the host issues it.</AppText>
        )}
      </View>
      <View style={styles.passFooter}>
        <View style={styles.passFooterCopy}>
          <AppText style={styles.passStrong}>{ticketHolder(ticket)}</AppText>
          {admits || payment ? (
            <AppText style={styles.passMuted} testID="ticket-admission">
              {[admits, payment].filter(Boolean).join(" · ")}
            </AppText>
          ) : null}
          <AppText style={styles.passMuted}>{[ticket.hostName, location].filter(Boolean).join(" · ")}</AppText>
        </View>
        <View style={styles.status}>
          <Ionicons color={checkedIn ? PASS.ok : PASS.muted} name={checkedIn ? "checkmark-circle" : "time-outline"} size={18} />
          <AppText style={[styles.passStrong, checkedIn && { color: PASS.ok }]}>{checkedIn ? "Checked in" : "Not yet"}</AppText>
        </View>
      </View>
    </View>
  );
}

export default function EventTicketsScreen() {
  const colors = colorsForScheme(useColorScheme());
  const styles = useMemo(() => createStyles(colors), [colors]);
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
      <AppText accessibilityRole="header" variant="display">Your tickets</AppText>
      <AppText variant="caption">Open this at the door and show the code or QR.</AppText>

      {loading ? <LoadingState label="Loading tickets" /> : null}
      {errorMessage ? <ErrorState error={errorMessage} title="Tickets unavailable" /> : null}

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

function createStyles(_colors: ThemeColors) {
  return StyleSheet.create({
    section: { gap: 16 },
    pass: { backgroundColor: PASS.body, borderRadius: 24, overflow: "hidden" },
    passWhen: { color: EVENT_ART_ACCENT, fontSize: 14, fontWeight: "700" },
    passName: { color: EVENT_ART_TEXT, fontSize: 26, fontWeight: "800", letterSpacing: -0.5, lineHeight: 30 },
    passBody: { alignItems: "center", gap: 14, paddingHorizontal: 24, paddingVertical: 22 },
    qrImage: { backgroundColor: PASS.body, height: 216, width: 216 },
    codeBlock: { alignItems: "center", alignSelf: "stretch", gap: 2 },
    code: { alignSelf: "stretch", color: PASS.text, fontSize: 24, textAlign: "center", fontVariant: ["tabular-nums"], fontWeight: "800", letterSpacing: 1 },
    passFooter: { alignItems: "center", borderColor: PASS.rule, borderStyle: "dashed", borderTopWidth: 1, flexDirection: "row", gap: 12, paddingHorizontal: 24, paddingVertical: 16 },
    passFooterCopy: { flex: 1, gap: 2 },
    passStrong: { color: PASS.text, fontSize: 15, fontWeight: "700" },
    passMuted: { color: PASS.muted, fontSize: 13, lineHeight: 18 },
    status: { alignItems: "center", flexDirection: "row", gap: 6 }
  });
}
