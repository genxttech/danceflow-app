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
  packageItemLabel,
  type StudentPackage,
  type StudentWallet
} from "@/lib/studentWallet";

function PackageCard({ item }: { item: StudentPackage }) {
  const price = formatCurrency(item.price);

  return (
    <View style={styles.itemCard}>
      <AppText variant="eyebrow">Package</AppText>
      <AppText variant="subtitle">{item.name}</AppText>
      <AppText variant="caption">{item.studioName}</AppText>
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

export default function PackagesScreen() {
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
        setErrorMessage("Packages could not be loaded. Try again in a moment.");
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
  const packages = wallet?.packages ?? [];

  return (
    <Screen>
      <AppText variant="eyebrow">Wallet</AppText>
      <AppText variant="title">Packages</AppText>
      <AppText variant="caption">Review lesson packages, credits, and remaining balances.</AppText>

      {loading ? <FeatureCard title="Loading packages" detail="Checking active lesson packages." /> : null}
      {errorMessage ? <FeatureCard title="Packages unavailable" detail={errorMessage} /> : null}

      {!loading && hasPortalAccess && packages.length > 0 ? (
        <View style={styles.section}>
          {packages.map((item) => (
            <PackageCard key={item.id} item={item} />
          ))}
        </View>
      ) : !loading && hasPortalAccess ? (
        <FeatureCard
          title="No active lesson packages"
          detail="Lesson credits and package balances will show when you have an active package."
        />
      ) : !loading ? (
        <FeatureCard
          title="Studio lesson packages"
          detail="Lesson credits and package balances appear here after a studio connects your account."
        />
      ) : null}
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
