import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, useColorScheme, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colorsForScheme } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess, type LinkedStudioAccess } from "@/lib/studentAccess";
import {
  formatWalletDate,
  loadStudentWallet,
  type StudentReward,
  type StudentRewardProgress,
  type StudentWallet,
} from "@/lib/studentWallet";

function rewardValueLabel(type: string, value: number | null) {
  if (type === "points") return `${Number(value ?? 0).toLocaleString()} points`;
  if (type === "account_credit" || type === "fixed_discount") {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
    }).format(Number(value ?? 0));
  }
  if (type === "percent_discount") return `${Number(value ?? 0)}% discount`;
  if (type === "free_class") return "Free class";
  if (type === "package_credit") return "Bonus lesson / package credit";
  return "Studio perk";
}

function triggerLabel(value: string) {
  if (value === "referral_converted") return "Referral";
  if (value === "attendance_milestone") return "Attendance";
  if (value === "membership_renewal") return "Membership renewal";
  if (value === "intro_completed") return "Intro completed";
  if (value === "spend_milestone") return "Spending";
  if (value === "participation_milestone") return "Participation";
  return "Feedback";
}

function thresholdLabel(progress: StudentRewardProgress) {
  if (progress.thresholdUnit === "currency") {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
    }).format(progress.thresholdValue);
  }
  return progress.thresholdValue.toLocaleString();
}

function progressLabel(progress: StudentRewardProgress) {
  if (progress.thresholdUnit === "currency") {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
    }).format(progress.progressValue);
  }
  return progress.progressValue.toLocaleString();
}

function ProgressCard({
  item,
  styles,
}: {
  item: StudentRewardProgress;
  styles: ReturnType<typeof createStyles>;
}) {
  const colors = colorsForScheme(useColorScheme());
  const ratio =
    item.thresholdValue > 0
      ? Math.max(0, Math.min(1, item.progressValue / item.thresholdValue))
      : 0;
  const percent = Math.round(ratio * 100);

  return (
    <View style={styles.card}>
      <View style={styles.rowBetween}>
        <View style={{ flex: 1 }}>
          <AppText variant="eyebrow">{item.studioName}</AppText>
          <AppText variant="subtitle">{item.ruleName}</AppText>
        </View>
        <View style={styles.progressBadge}>
          <AppText style={styles.progressBadgeText}>{percent}%</AppText>
        </View>
      </View>

      <AppText variant="caption">
        {triggerLabel(item.triggerType)} · {progressLabel(item)} of {thresholdLabel(item)}
      </AppText>

      <View
        accessibilityRole="progressbar"
        accessibilityValue={{
          min: 0,
          max: item.thresholdValue,
          now: Math.min(item.progressValue, item.thresholdValue),
        }}
        style={styles.progressTrack}
      >
        <View
          style={[
            styles.progressFill,
            {
              backgroundColor: colors.primary,
              width: `${percent}%`,
            },
          ]}
        />
      </View>

      <View style={styles.rewardPreview}>
        <Ionicons color={colors.accent} name="gift-outline" size={19} />
        <View style={{ flex: 1 }}>
          <AppText style={styles.rewardPreviewTitle}>{item.rewardName}</AppText>
          <AppText variant="caption">
            {rewardValueLabel(item.rewardType, item.rewardValue)}
            {item.repeatable ? " · Repeatable" : ""}
          </AppText>
        </View>
      </View>
    </View>
  );
}

function EarnedRewardCard({
  reward,
  styles,
}: {
  reward: StudentReward;
  styles: ReturnType<typeof createStyles>;
}) {
  const colors = colorsForScheme(useColorScheme());
  const ready = reward.status === "earned";

  return (
    <View style={[styles.card, ready && styles.readyCard]}>
      <View style={styles.rowBetween}>
        <View style={{ flex: 1 }}>
          <AppText variant="eyebrow">{reward.studioName}</AppText>
          <AppText variant="subtitle">{reward.name}</AppText>
        </View>
        <View style={[styles.statusBadge, ready && styles.statusBadgeReady]}>
          <AppText style={[styles.statusBadgeText, ready && styles.statusBadgeTextReady]}>
            {ready ? "Ready" : reward.status.replace(/_/g, " ")}
          </AppText>
        </View>
      </View>

      <View style={styles.rewardValueRow}>
        <Ionicons
          color={ready ? colors.accent : colors.muted}
          name={ready ? "sparkles-outline" : "gift-outline"}
          size={21}
        />
        <AppText style={styles.rewardValue}>
          {rewardValueLabel(reward.rewardType, reward.rewardValue)}
        </AppText>
      </View>

      <AppText variant="caption">
        Earned {formatWalletDate(reward.earnedAt)}
        {reward.expiresAt ? ` · Expires ${formatWalletDate(reward.expiresAt)}` : ""}
        {reward.redeemedAt ? ` · Used ${formatWalletDate(reward.redeemedAt)}` : ""}
      </AppText>

      {ready ? (
        <View style={styles.notice}>
          <AppText variant="caption">
            Show this reward to your studio. Redemption is recorded by the studio so your reward history stays accurate.
          </AppText>
        </View>
      ) : null}
    </View>
  );
}

export default function RewardsScreen() {
  const { session } = useAuth();
  const colors = colorsForScheme(useColorScheme());
  const styles = createStyles(colors);
  const [loading, setLoading] = useState(true);
  const [linkedStudios, setLinkedStudios] = useState<LinkedStudioAccess[]>([]);
  const [wallet, setWallet] = useState<StudentWallet | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadRewards = useCallback(async (force = false) => {
    if (!session?.user.id) {
      setLinkedStudios([]);
      setWallet(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setErrorMessage(null);

    try {
      const access = await getStudentAccess(session.user.id);
      setLinkedStudios(access.linkedStudios);
      const nextWallet = await loadStudentWallet(
        access.linkedStudios,
        session.user.email ?? null,
        { force },
      );
      setWallet(nextWallet);
    } catch {
      setWallet(null);
      setErrorMessage("Rewards could not be loaded. Try again in a moment.");
    } finally {
      setLoading(false);
    }
  }, [session?.user.email, session?.user.id]);

  useEffect(() => {
    void loadRewards();
  }, [loadRewards]);

  useFocusEffect(
    useCallback(() => {
      void loadRewards();
    }, [loadRewards]),
  );

  const rewards = wallet?.rewards ?? [];
  const progress = wallet?.rewardProgress ?? [];
  const available = useMemo(
    () => rewards.filter((reward) => reward.status === "earned"),
    [rewards],
  );
  const history = useMemo(
    () => rewards.filter((reward) => reward.status !== "earned"),
    [rewards],
  );
  const activeProgress = useMemo(
    () => progress.filter((item) => item.progressValue < item.thresholdValue),
    [progress],
  );
  const hasLinkedStudio = linkedStudios.length > 0;

  return (
    <Screen refreshing={loading} onRefresh={() => void loadRewards(true)}>
      <View style={styles.hero}>
        <View style={styles.heroIcon}>
          <Ionicons color={colors.primary} name="gift-outline" size={24} />
        </View>
        <AppText style={styles.heroEyebrow}>Rewards</AppText>
        <AppText style={styles.heroTitle}>Your studio rewards</AppText>
        <AppText style={styles.heroDetail}>
          Track progress, see what you have earned, and keep a clear history across your connected studios.
        </AppText>

        <ScrollView
          horizontal
          contentContainerStyle={styles.summaryScroller}
          showsHorizontalScrollIndicator={false}
        >
          <View style={styles.summaryChip}>
            <AppText style={styles.summaryLabel}>Ready</AppText>
            <AppText style={styles.summaryValue}>{available.length}</AppText>
          </View>
          <View style={styles.summaryChip}>
            <AppText style={styles.summaryLabel}>In progress</AppText>
            <AppText style={styles.summaryValue}>{activeProgress.length}</AppText>
          </View>
          <View style={styles.summaryChip}>
            <AppText style={styles.summaryLabel}>History</AppText>
            <AppText style={styles.summaryValue}>{history.length}</AppText>
          </View>
        </ScrollView>
      </View>

      {errorMessage ? (
        <FeatureCard title="Rewards unavailable" detail={errorMessage} />
      ) : null}

      {!loading && !hasLinkedStudio ? (
        <FeatureCard
          label="Connect a studio"
          title="Rewards appear after a studio connects your DanceFlow account"
          detail="Each studio controls its own reward rules. Once connected, DanceFlow can show your progress and earned rewards here."
        />
      ) : null}

      {!loading && hasLinkedStudio && available.length > 0 ? (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={{ flex: 1 }}>
              <AppText variant="eyebrow">Ready to use</AppText>
              <AppText variant="subtitle">Earned rewards</AppText>
            </View>
            <AppText style={styles.countPill}>{available.length}</AppText>
          </View>
          {available.map((reward) => (
            <EarnedRewardCard key={reward.id} reward={reward} styles={styles} />
          ))}
        </View>
      ) : null}

      {!loading && hasLinkedStudio && activeProgress.length > 0 ? (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={{ flex: 1 }}>
              <AppText variant="eyebrow">Keep going</AppText>
              <AppText variant="subtitle">Reward progress</AppText>
            </View>
            <AppText style={styles.countPill}>{activeProgress.length}</AppText>
          </View>
          {activeProgress.map((item) => (
            <ProgressCard key={item.id} item={item} styles={styles} />
          ))}
        </View>
      ) : null}

      {!loading &&
      hasLinkedStudio &&
      available.length === 0 &&
      activeProgress.length === 0 &&
      history.length === 0 ? (
        <FeatureCard
          label="Rewards"
          title="No rewards to show yet"
          detail="Your connected studio has not recorded reward progress or an earned reward for your account yet."
        />
      ) : null}

      {!loading && history.length > 0 ? (
        <View style={styles.section}>
          <AppText variant="eyebrow">History</AppText>
          <AppText variant="subtitle">Past rewards</AppText>
          {history.map((reward) => (
            <EarnedRewardCard key={reward.id} reward={reward} styles={styles} />
          ))}
        </View>
      ) : null}

      <Pressable
        onPress={() => router.back()}
        style={({ pressed }) => [styles.backAction, pressed && { opacity: 0.75 }]}
      >
        <Ionicons color={colors.primary} name="arrow-back-outline" size={18} />
        <AppText style={styles.backActionText}>Back to Wallet</AppText>
      </Pressable>
    </Screen>
  );
}

function createStyles(colors: ReturnType<typeof colorsForScheme>) {
  return StyleSheet.create({
    hero: {
      backgroundColor: colors.backgroundSoft,
      borderColor: colors.border,
      borderRadius: 24,
      borderWidth: 1,
      gap: 7,
      padding: 20,
    },
    heroIcon: {
      alignItems: "center",
      backgroundColor: colors.surfaceAlt,
      borderRadius: 15,
      height: 46,
      justifyContent: "center",
      marginBottom: 3,
      width: 46,
    },
    heroEyebrow: {
      color: colors.accent,
      fontSize: 12,
      fontWeight: "900",
      letterSpacing: 1.3,
      textTransform: "uppercase",
    },
    heroTitle: {
      color: colors.text,
      fontSize: 28,
      fontWeight: "900",
      lineHeight: 34,
    },
    heroDetail: {
      color: colors.muted,
      fontSize: 14,
      lineHeight: 21,
    },
    summaryScroller: {
      gap: 10,
      paddingTop: 10,
      paddingRight: 6,
    },
    summaryChip: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 18,
      borderWidth: 1,
      minWidth: 116,
      paddingHorizontal: 14,
      paddingVertical: 11,
    },
    summaryLabel: {
      color: colors.muted,
      fontSize: 10,
      fontWeight: "800",
      textTransform: "uppercase",
    },
    summaryValue: {
      color: colors.text,
      fontSize: 20,
      fontWeight: "900",
      marginTop: 3,
    },
    section: {
      gap: 10,
    },
    sectionHeader: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
    },
    countPill: {
      backgroundColor: colors.accentSoft,
      borderRadius: 999,
      color: colors.accent,
      fontSize: 12,
      fontWeight: "900",
      overflow: "hidden",
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 20,
      borderWidth: 1,
      gap: 10,
      padding: 16,
    },
    readyCard: {
      borderColor: colors.accent,
    },
    rowBetween: {
      alignItems: "flex-start",
      flexDirection: "row",
      gap: 12,
      justifyContent: "space-between",
    },
    progressBadge: {
      backgroundColor: colors.surfaceAlt,
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    progressBadgeText: {
      color: colors.primary,
      fontSize: 12,
      fontWeight: "900",
    },
    progressTrack: {
      backgroundColor: colors.surfaceAlt,
      borderRadius: 999,
      height: 9,
      overflow: "hidden",
    },
    progressFill: {
      borderRadius: 999,
      height: "100%",
    },
    rewardPreview: {
      alignItems: "center",
      backgroundColor: colors.surfaceAlt,
      borderRadius: 15,
      flexDirection: "row",
      gap: 10,
      padding: 11,
    },
    rewardPreviewTitle: {
      color: colors.text,
      fontSize: 14,
      fontWeight: "900",
    },
    statusBadge: {
      backgroundColor: colors.surfaceAlt,
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    statusBadgeReady: {
      backgroundColor: colors.accentSoft,
    },
    statusBadgeText: {
      color: colors.muted,
      fontSize: 11,
      fontWeight: "900",
      textTransform: "capitalize",
    },
    statusBadgeTextReady: {
      color: colors.accent,
    },
    rewardValueRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
    },
    rewardValue: {
      color: colors.text,
      fontSize: 17,
      fontWeight: "900",
    },
    notice: {
      backgroundColor: colors.surfaceAlt,
      borderRadius: 14,
      padding: 11,
    },
    backAction: {
      alignItems: "center",
      alignSelf: "flex-start",
      flexDirection: "row",
      gap: 8,
      minHeight: 44,
      paddingHorizontal: 4,
    },
    backActionText: {
      color: colors.primary,
      fontSize: 14,
      fontWeight: "900",
    },
  });
}
