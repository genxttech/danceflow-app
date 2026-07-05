import { useCallback, useEffect, useState } from "react";
import { Image, Linking, StyleSheet, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import {
  getStudentEventOrderStatus,
  type StudentEventOrderTicket,
  type StudentEventOrderStatus
} from "@/lib/eventCheckout";
import { getStudentAccess, type LinkedStudioAccess } from "@/lib/studentAccess";
import {
  formatCurrency,
  formatWalletDate,
  loadStudentWallet,
  packageItemLabel,
  type StudentMembership,
  type StudentPackage,
  type StudentPaymentRequest,
  type StudentTicket,
  type StudentWallet
} from "@/lib/studentWallet";

const CHECKOUT_SYNC_REFRESH_LIMIT = 180;

function statusLabel(value: string | null | undefined) {
  return (value ?? "active").replace(/_/g, " ");
}

function paymentTypeLabel(value: string | null | undefined) {
  if (value === "package") return "Package";
  if (value === "membership") return "Membership";
  if (value === "lesson") return "Lesson";
  if (value === "event_registration") return "Event";
  if (!value) return "Payment request";
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
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

function normalizeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function orderTicketToWalletTicket(ticket: StudentEventOrderTicket): StudentTicket {
  return {
    checkedInAt: ticket.checkedInAt,
    city: ticket.city,
    eventDate: ticket.eventDate,
    eventId: ticket.eventId,
    eventName: ticket.eventName,
    eventSlug: ticket.eventSlug,
    eventTime: ticket.eventTime,
    id: ticket.id,
    qrImageUrl: ticket.qrImageUrl,
    registrationId: ticket.registrationId,
    state: ticket.state,
    studioId: "",
    studioName: "Event",
    ticketCode: ticket.ticketCode,
    ticketName: ticket.ticketName,
    venue: ticket.venue,
    waiverSignedAt: ticket.waiverSignedAt
  };
}

function StudentPassCard({ linkedStudios }: { linkedStudios: LinkedStudioAccess[] }) {
  const primary = linkedStudios[0];
  const name = studentDisplayName(linkedStudios);
  const studioName = primary?.studioPublicName || primary?.studioName || "Connected studio";

  return (
    <View style={styles.passCard}>
      <View style={styles.passInfo}>
        <AppText variant="eyebrow">My DanceFlow Pass</AppText>
        <AppText variant="title">{name}</AppText>
        <AppText variant="caption">{studioName}</AppText>
        <AppText variant="caption">Use this pass for studio lookup and future student check-ins.</AppText>
        <AppButton label="Edit profile" onPress={() => router.push("/profile")} variant="secondary" />
      </View>
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

function PaymentRequestCard({ payment }: { payment: StudentPaymentRequest }) {
  const amount = formatCurrency(payment.amount);

  return (
    <View style={styles.paymentRequestCard}>
      <View style={styles.itemHeader}>
        <AppText variant="eyebrow">Payment request</AppText>
        <AppText variant="caption">{payment.studioName}</AppText>
      </View>
      <AppText variant="subtitle">{amount ?? "Amount pending"}</AppText>
      <AppText variant="caption">{paymentTypeLabel(payment.paymentType)}</AppText>
      {payment.notes ? <AppText variant="caption">{payment.notes}</AppText> : null}
      <AppText variant="caption">Requested {formatWalletDate(payment.createdAt)}</AppText>
      <AppButton label="Pay Now" onPress={() => Linking.openURL(payment.checkoutUrl)} />
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
  const params = useLocalSearchParams<{ checkout?: string; orderId?: string }>();
  const checkoutSource = normalizeParam(params.checkout);
  const checkoutOrderId = normalizeParam(params.orderId);
  const [loading, setLoading] = useState(true);
  const [linkedStudios, setLinkedStudios] = useState<LinkedStudioAccess[]>([]);
  const [wallet, setWallet] = useState<StudentWallet | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [checkoutRefreshes, setCheckoutRefreshes] = useState(0);
  const [checkoutOrderStatus, setCheckoutOrderStatus] = useState<StudentEventOrderStatus | null>(null);
  const [checkoutStatusError, setCheckoutStatusError] = useState<string | null>(null);

  async function loadWallet(options?: { background?: boolean }) {
    const userId = session?.user.id;
    const background = options?.background === true;

    if (!userId) {
      setLinkedStudios([]);
      setWallet(null);
      setLoading(false);
      return;
    }

    if (!background) {
      setLoading(true);
    }
    setErrorMessage(null);

    try {
      const access = await getStudentAccess(userId);
      setLinkedStudios(access.linkedStudios);

      const nextWallet = await loadStudentWallet(access.linkedStudios, session?.user.email ?? null);
      setWallet(nextWallet);
    } catch {
      if (checkoutSource === "event") {
        setErrorMessage(null);
      } else {
        setErrorMessage("Your wallet could not be loaded. Try again in a moment.");
        setWallet(null);
      }
    } finally {
      if (!background) {
        setLoading(false);
      }
    }
  }

  async function loadCheckoutOrderStatus() {
    if (!checkoutOrderId) return;

    try {
      const nextStatus = await getStudentEventOrderStatus(checkoutOrderId);
      setCheckoutOrderStatus(nextStatus);
      setCheckoutStatusError(null);
    } catch (error) {
      setCheckoutStatusError(error instanceof Error ? error.message : "Ticket status could not be checked.");
    }
  }

  useEffect(() => {
    loadWallet();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id]);

  useFocusEffect(
    useCallback(() => {
      loadWallet();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session?.user.id])
  );

  useEffect(() => {
    if (checkoutSource !== "event" || checkoutRefreshes >= CHECKOUT_SYNC_REFRESH_LIMIT) return;

    const timer = setTimeout(() => {
      setCheckoutRefreshes((current) => current + 1);
      loadCheckoutOrderStatus();
      loadWallet({ background: true });
    }, checkoutRefreshes === 0 ? 1200 : 2500);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkoutRefreshes, checkoutOrderId, checkoutSource, session?.user.id]);

  const hasPortalAccess = linkedStudios.length > 0;
  const isSignedIn = Boolean(session);
  const memberships = wallet?.memberships ?? [];
  const packages = wallet?.packages ?? [];
  const paymentRequests = wallet?.paymentRequests ?? [];
  const walletTickets = wallet?.tickets ?? [];
  const checkoutFallbackTickets = (checkoutOrderStatus?.tickets ?? [])
    .filter((ticket) => !walletTickets.some((walletTicket) => walletTicket.id === ticket.id))
    .map(orderTicketToWalletTicket);
  const tickets = [...walletTickets, ...checkoutFallbackTickets];
  const registrations = wallet?.registrations ?? [];
  const checkoutOrderTicketsAvailable = Boolean(
    checkoutOrderStatus?.registrationIds.some((registrationId) =>
      tickets.some((ticket) => ticket.registrationId === registrationId)
    )
  );
  const legacyCheckoutHasTickets = checkoutSource === "event" && !checkoutOrderId && tickets.length > 0;
  const showCheckoutSync =
    checkoutSource === "event" &&
    !checkoutOrderTicketsAvailable &&
    !legacyCheckoutHasTickets &&
    checkoutRefreshes < CHECKOUT_SYNC_REFRESH_LIMIT;
  const checkoutSyncTitle =
    checkoutOrderStatus?.paymentStatus === "paid"
      ? checkoutOrderStatus.ticketsReady
        ? "Tickets are ready"
        : "Issuing your ticket codes"
      : checkoutStatusError
        ? "Checking ticket status"
        : "Checking for your new tickets";
  const checkoutSyncDetail =
    checkoutOrderStatus?.paymentStatus === "paid"
      ? checkoutOrderStatus.ticketsReady
        ? "Ticket codes are ready. Wallet is refreshing so they appear here."
        : `Payment is confirmed. ${checkoutOrderStatus.ticketCodesIssued}/${checkoutOrderStatus.ticketCount} ticket codes have been issued.`
      : checkoutStatusError
        ? checkoutStatusError
        : checkoutOrderId
          ? "Waiting for payment confirmation and ticket issuing status."
          : "Stripe confirmed the purchase. Ticket codes can take a moment to finish issuing, so Wallet will refresh automatically.";

  return (
    <Screen>
      <AppText variant="eyebrow">Wallet</AppText>
      <AppText variant="title">Your dance essentials in one place</AppText>
      <AppText variant="caption">
        Wallet keeps your event tickets, QR codes, studio pass, memberships, and lesson package balances handy as your DanceFlow account grows.
      </AppText>

      {!isSignedIn || !hasPortalAccess ? (
        <View style={styles.valueList}>
          <FeatureCard
            label="Event tickets"
            title="Keep tickets and QR codes ready"
            detail="When you register for DanceFlow events with your account email, your tickets and check-in codes can appear here."
          />
          <FeatureCard
            label="Studio connection"
            title="Unlock studio passes and balances"
            detail="After a studio connects your account, Wallet can show your DanceFlow pass, lesson packages, memberships, and credits."
          />
          <FeatureCard
            label="Fast access"
            title="Less searching at the door or front desk"
            detail="Use Wallet to keep important dance items easy to find before lessons, classes, events, and check-ins."
          />
        </View>
      ) : null}

      {!loading && !isSignedIn ? (
        <View style={styles.ctaCard}>
          <AppText variant="subtitle">Create or access your free account</AppText>
          <AppText variant="caption">
            Continue with email to save favorites, keep tickets handy, complete your profile, and connect with studios later.
          </AppText>
          <AppButton label="Continue with email" onPress={() => router.push("/(auth)/sign-in")} />
        </View>
      ) : null}

      {!loading && isSignedIn && !hasPortalAccess ? (
        <View style={styles.ctaCard}>
          <AppText variant="subtitle">Ready when your studio connects</AppText>
          <AppText variant="caption">
            Your Wallet is active for your DanceFlow account. Studio passes, packages, and memberships will appear here after a studio connects your account.
          </AppText>
          <View style={styles.actionRow}>
            <AppButton label="Find studios and events" onPress={() => router.push("/(tabs)/discover")} />
            <AppButton label="Complete profile" onPress={() => router.push("/profile")} variant="secondary" />
          </View>
        </View>
      ) : null}

      {loading ? (
        <FeatureCard
          title="Loading wallet..."
          detail="Checking your tickets, passes, and studio items."
        />
      ) : null}

      {!loading && showCheckoutSync ? (
        <View style={styles.syncCard}>
          <AppText variant="subtitle">{checkoutSyncTitle}</AppText>
          <AppText variant="caption">{checkoutSyncDetail}</AppText>
        </View>
      ) : null}

      {!loading && checkoutSource === "event" && !checkoutOrderTicketsAvailable && !legacyCheckoutHasTickets && checkoutRefreshes >= CHECKOUT_SYNC_REFRESH_LIMIT ? (
        <FeatureCard
          title="Ticket sync is taking longer than expected"
          detail="Payment completed, but Wallet has not found the ticket yet. Refresh once more or check the webhook logs for the event order."
        />
      ) : null}

      {!loading && errorMessage ? (
        <FeatureCard title="Wallet unavailable" detail={errorMessage} />
      ) : null}

      {!loading && isSignedIn ? (
        <>
          {hasPortalAccess ? <StudentPassCard linkedStudios={linkedStudios} /> : null}

          <View style={styles.summaryGrid}>
            <View style={styles.summaryCard}>
              <AppText variant="eyebrow">Tickets</AppText>
              <AppText variant="title">{tickets.length}</AppText>
              <AppText variant="caption">ready for check-in</AppText>
            </View>
            <View style={styles.summaryCard}>
              <AppText variant="eyebrow">Payments</AppText>
              <AppText variant="title">{paymentRequests.length}</AppText>
              <AppText variant="caption">requests</AppText>
            </View>
          </View>

          {hasPortalAccess && paymentRequests.length > 0 ? (
            <View style={styles.section}>
              <AppText variant="subtitle">Payment Requests</AppText>
              {paymentRequests.map((payment) => (
                <PaymentRequestCard key={payment.id} payment={payment} />
              ))}
            </View>
          ) : hasPortalAccess ? (
            <FeatureCard
              title="No payment requests"
              detail="Any unpaid payment requests from your studio will appear here."
            />
          ) : null}

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
              detail="Register for DanceFlow events with this account email, and tickets or check-in QR codes can appear here."
            />
          )}

          {hasPortalAccess && memberships.length > 0 ? (
            <View style={styles.section}>
              <AppText variant="subtitle">Memberships</AppText>
              {memberships.map((membership) => (
                <MembershipCard key={membership.id} membership={membership} />
              ))}
            </View>
          ) : hasPortalAccess ? (
            <FeatureCard
              title="No active membership"
              detail="Active, trialing, or past-due memberships from your studio will appear here."
            />
          ) : (
            <FeatureCard
              title="Studio memberships"
              detail="Memberships appear here after a studio connects your DanceFlow account."
            />
          )}

          {hasPortalAccess && packages.length > 0 ? (
            <View style={styles.section}>
              <AppText variant="subtitle">Packages</AppText>
              {packages.map((item) => (
                <PackageCard key={item.id} item={item} />
              ))}
            </View>
          ) : hasPortalAccess ? (
            <FeatureCard
              title="No active lesson packages"
              detail="Lesson credits and package balances will show when you have an active package."
            />
          ) : (
            <FeatureCard
              title="Studio lesson packages"
              detail="Lesson credits and package balances appear here after a studio connects your account."
            />
          )}
        </>
      ) : null}

{isSignedIn ? <AppButton label="Refresh wallet" onPress={() => loadWallet()} variant="secondary" /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  actionRow: {
    gap: 10
  },
  ctaCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 12,
    padding: 18
  },
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
  paymentRequestCard: {
    backgroundColor: "#fff4e7",
    borderColor: "#fed7aa",
    borderRadius: 18,
    borderWidth: 1,
    gap: 8,
    padding: 14
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
  syncCard: {
    backgroundColor: "#ecfeff",
    borderColor: "#67e8f9",
    borderRadius: 18,
    borderWidth: 1,
    gap: 8,
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
  },
  valueList: {
    gap: 12
  }
});
