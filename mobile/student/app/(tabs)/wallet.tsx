import { useEffect, useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess, type LinkedStudioAccess } from "@/lib/studentAccess";
import {
  formatCurrency,
  formatWalletDate,
  loadStudentWallet,
  packageItemLabel,
  type StudentMembership,
  type StudentPackage,
  type StudentTicket,
  type StudentWallet
} from "@/lib/studentWallet";

function statusLabel(value: string | null | undefined) {
  return (value ?? "active").replace(/_/g, " ");
}

function locationLine(ticket: StudentTicket) {
  return [ticket.venue, [ticket.city, ticket.state].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join(" · ");
}

function studentDisplayName(linkedStudios: LinkedStudioAccess[]) {
  const primary = linkedStudios[0];
  const name = [primary?.clientFirstName, primary?.clientLastName].filter(Boolean).join(" ").trim();
  return name || "DanceFlow student";
}

function studentPassQrUrl(linkedStudios: LinkedStudioAccess[]) {
  const primary = linkedStudios[0];
  const webBase = (process.env.EXPO_PUBLIC_DANCEFLOW_WEB_URL ?? "https://idanceflow.com").replace(/\/$/, "");

  if (!primary?.clientId || !primary.studioSlug) return null;

  // V1 mobile display pass. A later scanner phase can resolve this opaque pass payload
  // into the studio/client check-in workflow.
  const payload = `danceflow-pass:${primary.studioSlug}:${primary.clientId}`;
  return `${webBase}/api/tickets/qr?code=${encodeURIComponent(payload)}`;
}

function StudentPassCard({ linkedStudios }: { linkedStudios: LinkedStudioAccess[] }) {
  const primary = linkedStudios[0];
  const qrUrl = studentPassQrUrl(linkedStudios);
  const name = studentDisplayName(linkedStudios);
  const studioName = primary?.studioPublicName || primary?.studioName || "Linked studio";

  return (
    <View style={styles.passCard}>
      <View style={styles.passInfo}>
        <AppText variant="eyebrow">My DanceFlow Pass</AppText>
        <AppText variant="title">{name}</AppText>
        <AppText variant="caption">{studioName}</AppText>
        <AppText variant="caption">Use this pass for studio lookup and future student check-ins.</AppText>
        <AppButton label="Edit profile" onPress={() => router.push("/profile")} variant="secondary" />
      </View>
      {qrUrl ? (
        <Image
          accessibilityIgnoresInvertColors
          resizeMode="contain"
          source={{ uri: qrUrl }}
          style={styles.passQrImage}
        />
      ) : null}
    </View>
  );
}

function MembershipCard({ membership }: { membership: StudentMembership }) {
  const price = formatCurrency(membership.price);
  const periodEnd = membership.currentPeriodEnd || membership.endsOn;

  return (
    <View style={styles.itemCard}>
      <View style={styles.itemHeader}>
        <AppText variant="eyebrow">{statusLabel(membership.status)}</AppText>
        <AppText variant="caption">{membership.studioName}</AppText>
      </View>
      <AppText variant="subtitle">{membership.name}</AppText>
      <AppText variant="caption">
        {price ? `${price}${membership.billingInterval ? ` / ${membership.billingInterval}` : ""}` : "Membership details"}
      </AppText>
      <AppText variant="caption">
        {membership.cancelAtPeriodEnd
          ? `Ends ${formatWalletDate(periodEnd)}`
          : membership.autoRenew
            ? `Renews ${formatWalletDate(periodEnd)}`
            : `Period ends ${formatWalletDate(periodEnd)}`}
      </AppText>
    </View>
  );
}

function PackageCard({ item }: { item: StudentPackage }) {
  const price = formatCurrency(item.price);

  return (
    <View style={styles.itemCard}>
      <View style={styles.itemHeader}>
        <AppText variant="eyebrow">Package</AppText>
        <AppText variant="caption">{item.studioName}</AppText>
      </View>
      <AppText variant="subtitle">{item.name}</AppText>
      {price ? <AppText variant="caption">Purchased for {price}</AppText> : null}
      <AppText variant="caption">Expires {formatWalletDate(item.expiresOn)}</AppText>
      {item.items.length > 0 ? (
        <View style={styles.chipWrap}>
          {item.items.slice(0, 4).map((packageItem, index) => (
            <View key={`${item.id}-${packageItem.usageType}-${index}`} style={styles.chip}>
              <AppText variant="caption">{packageItemLabel(packageItem)}</AppText>
            </View>
          ))}
        </View>
      ) : (
        <AppText variant="caption">Package balance details will appear here when available.</AppText>
      )}
    </View>
  );
}

function TicketCard({ ticket }: { ticket: StudentTicket }) {
  const checkedIn = Boolean(ticket.checkedInAt);
  const location = locationLine(ticket);

  return (
    <View style={styles.ticketCard}>
      <View style={styles.ticketMain}>
        <View style={styles.itemHeader}>
          <AppText variant="eyebrow">{checkedIn ? "Checked in" : "Ticket"}</AppText>
          <AppText variant="caption">{ticket.studioName}</AppText>
        </View>
        <AppText variant="subtitle">{ticket.eventName}</AppText>
        <AppText variant="caption">{ticket.ticketName}</AppText>
        <AppText variant="caption">
          {formatWalletDate(ticket.eventDate)}{ticket.eventTime ? ` · ${ticket.eventTime}` : ""}
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

export default function WalletScreen() {
  const { session } = useAuth();
  const [loading, setLoading] = useState(true);
  const [linkedStudios, setLinkedStudios] = useState<LinkedStudioAccess[]>([]);
  const [wallet, setWallet] = useState<StudentWallet | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function loadWallet() {
    const userId = session?.user.id;

    if (!userId) {
      setLinkedStudios([]);
      setWallet(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setErrorMessage(null);

    try {
      const access = await getStudentAccess(userId);
      setLinkedStudios(access.linkedStudios);

      if (!access.hasPortalAccess) {
        setWallet(null);
        return;
      }

      const nextWallet = await loadStudentWallet(access.linkedStudios);
      setWallet(nextWallet);
    } catch {
      setErrorMessage("Your wallet could not be loaded. Try again in a moment.");
      setWallet(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadWallet();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id]);

  const hasPortalAccess = linkedStudios.length > 0;
  const memberships = wallet?.memberships ?? [];
  const packages = wallet?.packages ?? [];
  const tickets = wallet?.tickets ?? [];
  const registrations = wallet?.registrations ?? [];

  return (
    <Screen>
      <AppText variant="eyebrow">Wallet</AppText>
      <AppText variant="title">Memberships, packages, and tickets</AppText>
      <AppText variant="caption">
        Pull up studio balances, active memberships, event tickets, and QR check-in codes.
      </AppText>

      {loading ? (
        <FeatureCard
          title="Loading wallet..."
          detail="Checking your connected studios for memberships, package balances, and event tickets."
        />
      ) : null}

      {!loading && errorMessage ? (
        <FeatureCard title="Wallet unavailable" detail={errorMessage} />
      ) : null}

      {!loading && !hasPortalAccess ? (
        <FeatureCard
          title="Studio wallet unlocks after portal connection"
          detail="Memberships, lesson packages, and studio-linked tickets appear after a studio links your DanceFlow portal."
        />
      ) : null}

      {!loading && hasPortalAccess ? (
        <>
          <StudentPassCard linkedStudios={linkedStudios} />

          <View style={styles.summaryGrid}>
            <View style={styles.summaryCard}>
              <AppText variant="eyebrow">Tickets</AppText>
              <AppText variant="title">{tickets.length}</AppText>
              <AppText variant="caption">ready for check-in</AppText>
            </View>
            <View style={styles.summaryCard}>
              <AppText variant="eyebrow">Balances</AppText>
              <AppText variant="title">{packages.length}</AppText>
              <AppText variant="caption">active packages</AppText>
            </View>
          </View>

          {tickets.length > 0 ? (
            <View style={styles.section}>
              <AppText variant="subtitle">Event tickets</AppText>
              {tickets.slice(0, 10).map((ticket) => (
                <TicketCard key={ticket.id} ticket={ticket} />
              ))}
            </View>
          ) : registrations.length > 0 ? (
            <FeatureCard
              title="Registrations found"
              detail="Your registrations are available. Ticket codes will appear here when attendee tickets are issued."
            />
          ) : (
            <FeatureCard
              title="No event tickets yet"
              detail="Upcoming event tickets and check-in QR codes will appear here after registration."
            />
          )}

          {memberships.length > 0 ? (
            <View style={styles.section}>
              <AppText variant="subtitle">Memberships</AppText>
              {memberships.map((membership) => (
                <MembershipCard key={membership.id} membership={membership} />
              ))}
            </View>
          ) : (
            <FeatureCard
              title="No active membership"
              detail="Active, trialing, or past-due memberships from your studio will appear here."
            />
          )}

          {packages.length > 0 ? (
            <View style={styles.section}>
              <AppText variant="subtitle">Packages</AppText>
              {packages.map((item) => (
                <PackageCard key={item.id} item={item} />
              ))}
            </View>
          ) : (
            <FeatureCard
              title="No active lesson packages"
              detail="Lesson credits and package balances will show when you have an active package."
            />
          )}
        </>
      ) : null}

      <AppButton label="Refresh wallet" onPress={loadWallet} variant="secondary" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  chip: {
    backgroundColor: colors.surface,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  chipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 4
  },
  codeBox: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    gap: 3,
    marginTop: 4,
    padding: 10
  },
  itemCard: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 18,
    gap: 7,
    padding: 14
  },
  itemHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between"
  },
  passCard: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderRadius: 22,
    flexDirection: "row",
    gap: 14,
    padding: 16
  },
  passInfo: {
    flex: 1,
    gap: 7
  },
  passQrImage: {
    backgroundColor: "white",
    borderRadius: 14,
    height: 116,
    width: 116
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
