import { useEffect, useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
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

function PaymentRequestCard({ payment }: { payment: StudentPaymentRequest }) {
  const amount = formatCurrency(payment.amount);

  return (
    <View style={styles.paymentRequestCard}>
      <AppText variant="eyebrow">Payment request</AppText>
      <AppText variant="subtitle">{amount ?? "Amount pending"}</AppText>
      <AppText variant="caption">{payment.studioName}</AppText>
      <AppText variant="caption">{paymentTypeLabel(payment.paymentType)}</AppText>
      {payment.notes ? <AppText variant="caption">{payment.notes}</AppText> : null}
      <AppText variant="caption">Requested {formatWalletDate(payment.createdAt)}</AppText>
      <AppButton label="Pay Now" onPress={() => Linking.openURL(payment.checkoutUrl)} />
    </View>
  );
}

export default function PaymentRequestsScreen() {
  const { session } = useAuth();
  const [loading, setLoading] = useState(true);
  const [linkedStudios, setLinkedStudios] = useState<LinkedStudioAccess[]>([]);
  const [wallet, setWallet] = useState<StudentWallet | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const userId = session?.user.id;

    async function load() {
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
        const nextWallet = await loadStudentWallet(access.linkedStudios, session?.user.email ?? null);

        if (!mounted) return;
        setLinkedStudios(access.linkedStudios);
        setWallet(nextWallet);
      } catch {
        if (!mounted) return;
        setErrorMessage("Payment requests could not be loaded. Try again in a moment.");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();

    return () => {
      mounted = false;
    };
  }, [session?.user.email, session?.user.id]);

  const hasPortalAccess = linkedStudios.length > 0;
  const paymentRequests = wallet?.paymentRequests ?? [];

  return (
    <Screen>
      <AppText variant="eyebrow">Wallet</AppText>
      <AppText variant="title">Payment Requests</AppText>
      <AppText variant="caption">Review and pay open requests from connected studios.</AppText>

      {loading ? <FeatureCard title="Loading payment requests" detail="Checking open requests." /> : null}
      {errorMessage ? <FeatureCard title="Payment requests unavailable" detail={errorMessage} /> : null}

      {!loading && hasPortalAccess && paymentRequests.length > 0 ? (
        <View style={styles.section}>
          {paymentRequests.map((payment) => (
            <PaymentRequestCard key={payment.id} payment={payment} />
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

const styles = StyleSheet.create({
  paymentRequestCard: {
    backgroundColor: "#fff4e7",
    borderColor: "#fed7aa",
    borderRadius: 18,
    borderWidth: 1,
    gap: 8,
    padding: 14
  },
  section: {
    gap: 10
  }
});
