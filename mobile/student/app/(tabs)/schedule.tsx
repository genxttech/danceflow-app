import { Link } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
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
  type StudentScheduleOverview
} from "@/lib/studentSchedule";
import { isClassScheduleItem, isLessonScheduleItem } from "@/lib/studentScheduleSections";
import { loadStudentWallet, type StudentWallet } from "@/lib/studentWallet";

type ScheduleHubCardProps = {
  countLabel: string;
  detail: string;
  href: "/schedule/lessons" | "/schedule/classes" | "/schedule/events";
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  title: string;
};

function ScheduleHubCard({ countLabel, detail, href, icon, label, title }: ScheduleHubCardProps) {
  return (
    <Link href={href} asChild>
      <Pressable style={({ pressed }) => [styles.hubCard, pressed && styles.cardPressed]}>
        <View style={styles.hubIcon}>
          <Ionicons color="#fff" name={icon} size={22} />
        </View>
        <View style={{ flex: 1 }}>
          <View style={styles.cardHeader}>
            <AppText variant="eyebrow">{label}</AppText>
            <AppText style={styles.countLabel}>{countLabel}</AppText>
          </View>
          <AppText variant="subtitle">{title}</AppText>
          <AppText variant="caption">{detail}</AppText>
        </View>
      </Pressable>
    </Link>
  );
}

function ScheduleValueCard({ signedIn }: { signedIn: boolean }) {
  return (
    <>
      <View style={styles.emptyHero}>
        <View style={styles.emptyIcon}>
          <Ionicons color="#fff" name="calendar-outline" size={24} />
        </View>
        <View style={{ flex: 1 }}>
          <AppText style={styles.emptyTitle}>Your dance schedule in one place</AppText>
          <AppText style={styles.emptyDetail}>
            Lessons, classes, and purchased events each have their own page.
          </AppText>
        </View>
      </View>

      {signedIn ? (
        <>
          <Link href="/(tabs)/discover" asChild>
            <AppButton label="Find studios and events" />
          </Link>
          <AppText variant="caption">
            Already taking lessons? Ask your studio to connect your DanceFlow account.
          </AppText>
        </>
      ) : (
        <Link href="/(auth)/sign-in" asChild>
          <AppButton label="Create or access your free account" />
        </Link>
      )}
    </>
  );
}

export default function ScheduleScreen() {
  const { session } = useAuth();
  const [loading, setLoading] = useState(true);
  const [linkedStudios, setLinkedStudios] = useState<LinkedStudioAccess[]>([]);
  const [overview, setOverview] = useState<StudentScheduleOverview | null>(null);
  const [wallet, setWallet] = useState<StudentWallet | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function loadSchedule() {
    const userId = session?.user.id;

    if (!userId) {
      setLinkedStudios([]);
      setOverview(null);
      setWallet(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setErrorMessage(null);

    try {
      const access = await getStudentAccess(userId);
      setLinkedStudios(access.linkedStudios);

      const [nextOverview, nextWallet] = await Promise.all([
        access.linkedStudios.length ? loadStudentScheduleOverview(access.linkedStudios) : Promise.resolve(null),
        loadStudentWallet(access.linkedStudios, session?.user.email ?? null)
      ]);

      setOverview(nextOverview);
      setWallet(nextWallet);
    } catch {
      setErrorMessage("Your schedule could not be loaded. Try again in a moment.");
      setOverview(null);
      setWallet(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSchedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.email, session?.user.id]);

  const isSignedIn = Boolean(session);
  const lessonCount = (overview?.upcoming ?? []).filter(isLessonScheduleItem).length;
  const classCount = (overview?.upcoming ?? []).filter(isClassScheduleItem).length;
  const eventCount = useMemo(() => {
    const registrationIds = new Set((wallet?.registrations ?? []).map((registration) => registration.id));
    const ticketOnlyCount = (wallet?.tickets ?? []).filter((ticket) => !registrationIds.has(ticket.registrationId)).length;
    return registrationIds.size + ticketOnlyCount;
  }, [wallet]);
  const nextItem = overview?.nextItem;

  return (
    <Screen>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <AppText variant="eyebrow">Schedule</AppText>
          <AppText variant="title">What’s next?</AppText>
          <AppText variant="caption">
            Choose Lessons, Classes, or Events to see the right details and actions.
          </AppText>
        </View>
      </View>

      {loading ? <FeatureCard title="Loading schedule..." detail="Checking lessons, classes, and events." /> : null}
      {!loading && errorMessage ? <FeatureCard title="Schedule unavailable" detail={errorMessage} /> : null}

      {!loading && !isSignedIn ? <ScheduleValueCard signedIn={false} /> : null}

      {!loading && isSignedIn ? (
        <>
          <View style={styles.hubGrid}>
            <ScheduleHubCard
              countLabel={`${lessonCount}`}
              detail="Private lessons, intro lessons, coaching, and booking requests."
              href="/schedule/lessons"
              icon="person-outline"
              label="Lessons"
              title="Lesson schedule"
            />
            <ScheduleHubCard
              countLabel={`${classCount}`}
              detail="Group classes, practice parties, rentals, and studio commitments."
              href="/schedule/classes"
              icon="people-outline"
              label="Classes"
              title="Class schedule"
            />
            <ScheduleHubCard
              countLabel={`${eventCount}`}
              detail="Purchased or registered events, tickets, and check-in details."
              href="/schedule/events"
              icon="ticket-outline"
              label="Events"
              title="Event schedule"
            />
          </View>

          {nextItem ? (
            <FeatureCard
              title={`Next up: ${nextItem.title}`}
              detail={formatScheduleTimeRange(nextItem.startsAt, nextItem.endsAt, nextItem.timeZone)}
            />
          ) : linkedStudios.length === 0 && eventCount === 0 ? (
            <ScheduleValueCard signedIn />
          ) : null}
        </>
      ) : null}

      {isSignedIn ? <AppButton label="Refresh schedule" onPress={loadSchedule} variant="secondary" /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  cardHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between"
  },
  cardPressed: {
    opacity: 0.78
  },
  countLabel: {
    color: colors.primary,
    fontSize: 18,
    fontWeight: "900"
  },
  emptyDetail: {
    color: "rgba(255,255,255,0.78)",
    fontSize: 13,
    lineHeight: 19
  },
  emptyHero: {
    alignItems: "center",
    backgroundColor: colors.primaryDark,
    borderRadius: 20,
    flexDirection: "row",
    gap: 12,
    padding: 16
  },
  emptyIcon: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.16)",
    borderRadius: 999,
    height: 44,
    justifyContent: "center",
    width: 44
  },
  emptyTitle: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "900",
    marginBottom: 4
  },
  headerRow: {
    flexDirection: "row",
    gap: 12
  },
  hubCard: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    elevation: 2,
    flexDirection: "row",
    gap: 14,
    padding: 16,
    shadowColor: colors.primaryDark,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.06,
    shadowRadius: 18
  },
  hubGrid: {
    gap: 12
  },
  hubIcon: {
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: 999,
    height: 44,
    justifyContent: "center",
    width: 44
  }
});
