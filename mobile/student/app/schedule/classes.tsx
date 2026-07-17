import { Link, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
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

function SectionHeader({
  eyebrow,
  title,
  count
}: {
  eyebrow: string;
  title: string;
  count: number;
}) {
  return (
    <View style={styles.sectionHeader}>
      <View>
        <AppText style={styles.sectionEyebrow}>{eyebrow}</AppText>
        <AppText style={styles.sectionTitle}>{title}</AppText>
      </View>
      <View style={styles.countBadge}>
        <AppText style={styles.countBadgeText}>{count}</AppText>
      </View>
    </View>
  );
}

function ClassCard({
  item,
  muted = false
}: {
  item: StudentScheduleItem;
  muted?: boolean;
}) {
  const router = useRouter();
  const subtitle = displayScheduleSubtitle(item);

  return (
    <Pressable
      onPress={() =>
        router.push({
          pathname: "/appointments/[id]",
          params: { id: item.id }
        })
      }
      style={({ pressed }) => [
        styles.classCard,
        muted && styles.classCardMuted,
        pressed && styles.pressed
      ]}
    >
      <View style={styles.classAccent} />

      <View style={styles.classBody}>
        <View style={styles.classTopRow}>
          <View style={styles.classIcon}>
            <Ionicons color="#0F766E" name="people-outline" size={18} />
          </View>

          <View style={{ flex: 1 }}>
            <AppText style={styles.classStatus}>
              {statusLabel(item.status)}
            </AppText>
            <AppText style={styles.classStudio}>{item.studioName}</AppText>
          </View>

          <Ionicons color="#94A3B8" name="chevron-forward" size={18} />
        </View>

        <AppText style={styles.classTitle}>
          {displayScheduleTitle(item)}
        </AppText>

        <View style={styles.metaRow}>
          <Ionicons color="#64748B" name="time-outline" size={15} />
          <AppText style={styles.metaText}>
            {formatScheduleTimeRange(
              item.startsAt,
              item.endsAt,
              item.timeZone
            )}
          </AppText>
        </View>

        {subtitle ? (
          <View style={styles.metaRow}>
            <Ionicons color="#64748B" name="location-outline" size={15} />
            <AppText style={styles.metaText}>{subtitle}</AppText>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export default function ScheduleClassesScreen() {
  const { session } = useAuth();
  const [loading, setLoading] = useState(true);
  const [linkedStudios, setLinkedStudios] = useState<LinkedStudioAccess[]>([]);
  const [overview, setOverview] =
    useState<StudentScheduleOverview | null>(null);
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
      setOverview(
        access.linkedStudios.length
          ? await loadStudentScheduleOverview(access.linkedStudios)
          : null
      );
    } catch {
      setErrorMessage(
        "Classes could not be loaded. Try again in a moment."
      );
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
  const upcomingClasses = (overview?.upcoming ?? []).filter(
    isClassScheduleItem
  );
  const recentClasses = (overview?.recent ?? []).filter(
    isClassScheduleItem
  );

  return (
    <Screen>
      <View style={styles.hero}>
        <View style={styles.heroIcon}>
          <Ionicons color="#FFFFFF" name="people-outline" size={24} />
        </View>

        <View style={{ flex: 1 }}>
          <AppText style={styles.heroEyebrow}>Group activity</AppText>
          <AppText style={styles.heroTitle}>Classes & studio time</AppText>
          <AppText style={styles.heroDetail}>
            Group classes, practice parties, rentals, and studio commitments.
          </AppText>
        </View>
      </View>

      {loading ? (
        <FeatureCard
          title="Loading classes"
          detail="Checking your connected studios."
        />
      ) : null}

      {!loading && errorMessage ? (
        <FeatureCard title="Classes unavailable" detail={errorMessage} />
      ) : null}

      {!loading && !session ? (
        <Link href="/(auth)/sign-in" asChild>
          <AppButton label="Sign in to view classes" />
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
          <View style={styles.section}>
            <SectionHeader
              eyebrow="Coming up"
              title="Upcoming classes"
              count={upcomingClasses.length}
            />

            {upcomingClasses.length > 0 ? (
              <View style={styles.list}>
                {upcomingClasses.slice(0, 12).map((item) => (
                  <ClassCard key={item.id} item={item} />
                ))}
              </View>
            ) : (
              <FeatureCard
                title="No upcoming classes"
                detail="Scheduled group classes and studio commitments will appear here."
              />
            )}
          </View>

          {recentClasses.length > 0 ? (
            <View style={styles.section}>
              <SectionHeader
                eyebrow="History"
                title="Recent classes"
                count={recentClasses.length}
              />
              <View style={styles.list}>
                {recentClasses.slice(0, 8).map((item) => (
                  <ClassCard key={item.id} item={item} muted />
                ))}
              </View>
            </View>
          ) : null}
        </>
      ) : null}

      {session ? (
        <Pressable
          onPress={loadClasses}
          style={({ pressed }) => [
            styles.refreshLink,
            pressed && styles.pressed
          ]}
        >
          <Ionicons color="#64748B" name="refresh-outline" size={16} />
          <AppText style={styles.refreshLinkText}>Refresh classes</AppText>
        </Pressable>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  classAccent: {
    alignSelf: "stretch",
    backgroundColor: "#0F766E",
    borderBottomLeftRadius: 20,
    borderTopLeftRadius: 20,
    width: 5
  },
  classBody: {
    flex: 1,
    gap: 8,
    padding: 16
  },
  classCard: {
    backgroundColor: "#FFFFFF",
    borderColor: "#99F6E4",
    borderRadius: 20,
    borderWidth: 1,
    elevation: 1,
    flexDirection: "row",
    overflow: "hidden"
  },
  classCardMuted: {
    borderColor: "#E2E8F0",
    opacity: 0.78
  },
  classIcon: {
    alignItems: "center",
    backgroundColor: "#F0FDFA",
    borderRadius: 12,
    height: 36,
    justifyContent: "center",
    width: 36
  },
  classStatus: {
    color: "#0F766E",
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0.7,
    textTransform: "uppercase"
  },
  classStudio: {
    color: "#64748B",
    fontSize: 12,
    marginTop: 2
  },
  classTitle: {
    color: "#0F172A",
    fontSize: 18,
    fontWeight: "900"
  },
  classTopRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10
  },
  countBadge: {
    alignItems: "center",
    backgroundColor: "#F0FDFA",
    borderRadius: 999,
    minWidth: 32,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  countBadgeText: {
    color: "#0F766E",
    fontSize: 13,
    fontWeight: "900"
  },
  hero: {
    alignItems: "center",
    backgroundColor: "#102A2A",
    borderRadius: 28,
    flexDirection: "row",
    gap: 14,
    padding: 20
  },
  heroDetail: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 13,
    lineHeight: 19,
    marginTop: 6
  },
  heroEyebrow: {
    color: "#99F6E4",
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 1,
    textTransform: "uppercase"
  },
  heroIcon: {
    alignItems: "center",
    backgroundColor: "#0F766E",
    borderRadius: 18,
    height: 54,
    justifyContent: "center",
    width: 54
  },
  heroTitle: {
    color: "#FFFFFF",
    fontSize: 23,
    fontWeight: "900",
    marginTop: 3
  },
  list: {
    gap: 12
  },
  metaRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 7
  },
  metaText: {
    color: "#64748B",
    flex: 1,
    fontSize: 13,
    lineHeight: 19
  },
  pressed: {
    opacity: 0.75
  },
  refreshLink: {
    alignItems: "center",
    alignSelf: "center",
    flexDirection: "row",
    gap: 7,
    paddingVertical: 8
  },
  refreshLinkText: {
    color: "#64748B",
    fontSize: 13,
    fontWeight: "800"
  },
  section: {
    gap: 12
  },
  sectionEyebrow: {
    color: "#0F766E",
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 1,
    textTransform: "uppercase"
  },
  sectionHeader: {
    alignItems: "flex-end",
    flexDirection: "row",
    justifyContent: "space-between"
  },
  sectionTitle: {
    color: "#0F172A",
    fontSize: 21,
    fontWeight: "900",
    marginTop: 3
  }
});
