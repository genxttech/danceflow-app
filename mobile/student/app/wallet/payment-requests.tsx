import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Linking, StyleSheet, useColorScheme, View } from "react-native";
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
  formatCurrency,
  formatWalletDate,
  loadStudentWallet,
  type StudentPaymentRequest,
  type StudentWallet
} from "@/lib/studentWallet";

function paymentTypeLabel(value: string | null | undefined) {
  if (value === "package") return "Package";
  if (value === "membership") return "Membership";
  if (value === "lesson") return "Lesson";
  if (value === "event_registration") return "Event";
  if (!value) return "Payment request";
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function PaymentRequestCard({ payment, onPay }: { payment: StudentPaymentRequest; onPay: (url: string) => void }) {
  const colors = colorsForScheme(useColorScheme());
  const styles = useMemo(() => createStyles(colors), [colors]);
  const amount = formatCurrency(payment.amount);

  return (
    <View style={styles.paymentRequestCard}>
      <AppText variant="eyebrow">Payment request</AppText>
      <AppText variant="subtitle">{amount ?? "Amount pending"}</AppText>
      <AppText variant="caption">{payment.studioName}</AppText>
      <AppText variant="caption">{paymentTypeLabel(payment.paymentType)}</AppText>
      {payment.notes ? <AppText variant="caption">{payment.notes}</AppText> : null}
      <AppText variant="caption">Requested {formatWalletDate(payment.createdAt)}</AppText>
      <AppButton label="Pay Now" onPress={() => onPay(payment.checkoutUrl)} />
    </View>
  );
}

export default function PaymentRequestsScreen() {
  const colors = colorsForScheme(useColorScheme());
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { session } = useAuth();
  const [loading, setLoading] = useState(true);
  const [linkedStudios, setLinkedStudios] = useState<LinkedStudioAccess[]>([]);
  const [wallet, setWallet] = useState<StudentWallet | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  const awaitingReturn = useRef(false);
  const userId = session?.user.id;
  const email = session?.user.email ?? null;

  const load = useCallback(
    async (quiet: boolean) => {
      if (!userId) {
        setLinkedStudios([]);
        setWallet(null);
        setLoading(false);
        return;
      }

      if (!quiet) setLoading(true);
      setErrorMessage(null);

      try {
        const access = await getStudentAccess(userId);
        const nextWallet = await loadStudentWallet(access.linkedStudios, email);

        if (!mounted.current) return;
        setLinkedStudios(access.linkedStudios);
        setWallet(nextWallet);
      } catch {
        if (!mounted.current) return;
        setErrorMessage("Payment requests could not be loaded. Try again in a moment.");
      } finally {
        if (mounted.current && !quiet) setLoading(false);
      }
    },
    [email, userId],
  );

  useEffect(() => {
    mounted.current = true;
    void load(false);
    return () => {
      mounted.current = false;
    };
  }, [load]);

  // Payment happens in the browser. When the dancer comes back, re-read the requests so a paid one is gone.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" || !awaitingReturn.current) return;
      awaitingReturn.current = false;
      setNotice("Checking your payment status...");
      void load(true).then(() => {
        if (mounted.current) setNotice("Payment requests are up to date.");
      });
    });
    return () => subscription.remove();
  }, [load]);

  async function pay(url: string) {
    setNotice(null);
    awaitingReturn.current = true;
    try {
      await Linking.openURL(url);
    } catch {
      awaitingReturn.current = false;
      setNotice("We could not open the payment page. Try again in a moment.");
    }
  }

  const hasPortalAccess = linkedStudios.length > 0;
  const paymentRequests = wallet?.paymentRequests ?? [];

  return (
    <Screen>
      <AppText variant="eyebrow">Wallet</AppText>
      <AppText variant="title">Payment Requests</AppText>
      <AppText variant="caption">Review and pay open requests from connected studios.</AppText>

      {notice ? <AppText accessibilityLiveRegion="polite" variant="caption">{notice}</AppText> : null}
      {loading ? <LoadingState label="Loading payment requests" /> : null}
      {errorMessage ? <ErrorState error={errorMessage} title="Payment requests unavailable" /> : null}

      {!loading && hasPortalAccess && paymentRequests.length > 0 ? (
        <View style={styles.section}>
          {paymentRequests.map((payment) => (
            <PaymentRequestCard key={payment.id} onPay={pay} payment={payment} />
          ))}
        </View>
      ) : !loading && hasPortalAccess ? (
        <FeatureCard title="No payment requests" detail="Any unpaid payment requests from your studio will appear here." />
      ) : !loading ? (
        <FeatureCard
          title="Connect with a studio"
          detail="Payment requests appear here after a studio connects your DanceFlow account."
        />
      ) : null}
    </Screen>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    paymentRequestCard: {
      backgroundColor: colors.accentSoft,
      borderColor: colors.border,
      borderRadius: 18,
      borderWidth: 1,
      gap: 8,
      padding: 14
    },
    section: {
      gap: 10
    }
  });
}
