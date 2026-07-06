import { Link, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess, type LinkedStudioAccess } from "@/lib/studentAccess";
import {
  formatScheduleTimeRange,
  loadStudentScheduleOverview,
  statusLabel,
  type StudentScheduleItem,
  type StudentScheduleOverview
} from "@/lib/studentSchedule";
import {
  displayScheduleSubtitle,
  displayScheduleTitle,
  isClassScheduleItem
} from "@/lib/studentScheduleSections";

function ClassCard({ item }: { item: StudentScheduleItem }) {
  const router = useRouter();
  const subtitle = displayScheduleSubtitle(item);

  return (
    <View style={styles.itemCard}>
      <View style={styles.itemHeader}>
        <AppText variant="eyebrow">{statusLabel(item.status)}</AppText>
        <AppText variant="caption">{item.studioName}</AppText>
      </View>
      <AppText variant="subtitle">{displayScheduleTitle(item)}</AppText>
      <AppText variant="caption">{formatScheduleTimeRange(item.startsAt, item.endsAt, item.timeZone)}</AppText>
      {subtitle ? <AppText variant="caption">{subtitle}</AppText> : null}
      <AppButton
        label="View details"
        onPress={() => router.push({ pathname: "/appointments/[id]", params: { id: item.id } })}
        variant="secondary"
      />
    </View>
  );
}

export default function ScheduleClassesScreen() {
  const { session } = useAuth();
  const [loading, setLoading] = useState(true);
  const [linkedStudios, setLinkedStudios] = useState<LinkedStudioAccess[]>([]);
  const [overview, setOverview] = useState<StudentScheduleOverview | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function loadClasses() {
    const userId = session?.user.id;

    if (!userId) {
      setLinkedStudios([]);
      setOverview(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setErrorMessage(null);

    try {
      const access = await getStudentAccess(userId);
      setLinkedStudios(access.linkedStudios);
      setOverview(access.linkedStudios.length ? await loadStudentScheduleOverview(access.linkedStudios) : null);
    } catch {
      setErrorMessage("Classes could not be loaded. Try again in a moment.");
      setOverview(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadClasses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id]);

  const hasPortalAccess = linkedStudios.length > 0;
  const upcomingClasses = (overview?.upcoming ?? []).filter(isClassScheduleItem);
  const recentClasses = (overview?.recent ?? []).filter(isClassScheduleItem);

  return (
    <Screen>
      <AppText variant="eyebrow">Schedule</AppText>
      <AppText variant="title">Classes</AppText>
      <AppText variant="caption">Group classes, practice parties, floor rentals, and studio commitments.</AppText>

      {loading ? <FeatureCard title="Loading classes..." detail="Checking your connected studios." /> : null}
      {!loading && errorMessage ? <FeatureCard title="Classes unavailable" detail={errorMessage} /> : null}
      {!loading && !session ? (
        <Link href="/(auth)/sign-in" asChild>
          <AppButton label="Create or access your free account" />
        </Link>
      ) : null}
      {!loading && session && !hasPortalAccess ? (
        <FeatureCard
          title="No connected studio yet"
          detail="Ask your studio to connect your DanceFlow account so classes can appear here."
        />
      ) : null}

      {!loading && hasPortalAccess ? (
        <>
          {upcomingClasses.length > 0 ? (
            <View style={styles.section}>
              <AppText variant="subtitle">Upcoming Classes</AppText>
              {upcomingClasses.slice(0, 12).map((item) => (
                <ClassCard key={item.id} item={item} />
              ))}
            </View>
          ) : (
            <FeatureCard title="No upcoming classes" detail="Scheduled group classes and studio commitments will appear here." />
          )}

          {recentClasses.length > 0 ? (
            <View style={styles.section}>
              <AppText variant="subtitle">Recent Classes</AppText>
              {recentClasses.slice(0, 8).map((item) => (
                <ClassCard key={item.id} item={item} />
              ))}
            </View>
          ) : null}
        </>
      ) : null}

      {session ? <AppButton label="Refresh classes" onPress={loadClasses} variant="secondary" /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  itemCard: {
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
