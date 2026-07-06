import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
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
  type StudentMembership,
  type StudentWallet
} from "@/lib/studentWallet";

function statusLabel(value: string | null | undefined) {
  return (value ?? "active").replace(/_/g, " ");
}

function MembershipCard({ membership }: { membership: StudentMembership }) {
  const price = formatCurrency(membership.price);
  const periodEnd = membership.currentPeriodEnd || membership.endsOn;

  return (
    <View style={styles.itemCard}>
      <AppText variant="eyebrow">{statusLabel(membership.status)}</AppText>
      <AppText variant="subtitle">{membership.name}</AppText>
      <AppText variant="caption">{membership.studioName}</AppText>
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

export default function MembershipsScreen() {
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
        setErrorMessage("Memberships could not be loaded. Try again in a moment.");
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
  const memberships = wallet?.memberships ?? [];

  return (
    <Screen>
      <AppText variant="eyebrow">Wallet</AppText>
      <AppText variant="title">Memberships</AppText>
      <AppText variant="caption">Review active memberships, renewal dates, and status.</AppText>

      {loading ? <FeatureCard title="Loading memberships" detail="Checking active memberships." /> : null}
      {errorMessage ? <FeatureCard title="Memberships unavailable" detail={errorMessage} /> : null}

      {!loading && hasPortalAccess && memberships.length > 0 ? (
        <View style={styles.section}>
          {memberships.map((membership) => (
            <MembershipCard key={membership.id} membership={membership} />
          ))}
        </View>
      ) : !loading && hasPortalAccess ? (
        <FeatureCard
          title="No active membership"
          detail="Active, trialing, or past-due memberships from your studio will appear here."
        />
      ) : !loading ? (
        <FeatureCard
          title="Studio memberships"
          detail="Memberships appear here after a studio connects your DanceFlow account."
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  itemCard: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 18,
    gap: 7,
    padding: 14
  },
  section: {
    gap: 10
  }
});
