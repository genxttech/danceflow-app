import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";

type RouterPushTarget = Parameters<ReturnType<typeof useRouter>["push"]>[0];

const EVENT_CATEGORY_BUTTONS: Array<{
  href: string;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  detail: string;
}> = [
  {
    href: "/discover/events/all",
    icon: "calendar-outline",
    title: "All Events",
    detail: "Browse every public event in one place."
  },
  {
    href: "/discover/events/group-classes",
    icon: "people-outline",
    title: "Group Class",
    detail: "Search public group classes from studios."
  },
  {
    href: "/discover/events/social-dances",
    icon: "musical-notes-outline",
    title: "Social Dance",
    detail: "Find socials, parties, and places to dance."
  },
  {
    href: "/discover/events/workshops",
    icon: "school-outline",
    title: "Workshop",
    detail: "Find focused learning events and intensives."
  },
  {
    href: "/discover/events/competitions",
    icon: "trophy-outline",
    title: "Competition",
    detail: "Search competitive events and registrations."
  },
  {
    href: "/discover/events/showcases",
    icon: "star-outline",
    title: "Showcase",
    detail: "Find performance and showcase opportunities."
  },
  {
    href: "/discover/events/other",
    icon: "sparkles-outline",
    title: "Other",
    detail: "Explore festivals, special events, parties, and more."
  }
];

export default function EventsHubScreen() {
  const router = useRouter();

  return (
    <Screen>
      <View style={styles.hero}>
        <View style={styles.heroIcon}>
          <Ionicons color="#fff" name="ticket-outline" size={24} />
        </View>
        <View style={{ flex: 1 }}>
          <AppText variant="eyebrow">Events</AppText>
          <AppText style={styles.heroTitle}>What are you looking for?</AppText>
          <AppText style={styles.heroDetail}>
            Choose a category first so you can search the kind of dance event you actually want.
          </AppText>
        </View>
      </View>

      <View style={styles.categoryList}>
        {EVENT_CATEGORY_BUTTONS.map((item) => (
          <Pressable
            key={item.href}
            onPress={() => router.push(item.href as unknown as RouterPushTarget)}
            style={({ pressed }) => [styles.categoryCard, pressed && styles.cardPressed]}
          >
            <View style={styles.categoryIcon}>
              <Ionicons color={colors.primary} name={item.icon} size={22} />
            </View>
            <View style={{ flex: 1 }}>
              <AppText style={styles.categoryTitle}>{item.title}</AppText>
              <AppText style={styles.categoryDetail}>{item.detail}</AppText>
            </View>
            <Ionicons color={colors.primary} name="chevron-forward" size={18} />
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  cardPressed: {
    opacity: 0.78
  },
  categoryCard: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    padding: 14
  },
  categoryDetail: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19
  },
  categoryIcon: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderRadius: 14,
    height: 44,
    justifyContent: "center",
    width: 44
  },
  categoryList: {
    gap: 10
  },
  categoryTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "900",
    marginBottom: 3
  },
  hero: {
    alignItems: "center",
    backgroundColor: colors.primaryDark,
    borderRadius: 22,
    flexDirection: "row",
    gap: 14,
    padding: 18
  },
  heroDetail: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 13,
    lineHeight: 19
  },
  heroIcon: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.16)",
    borderRadius: 999,
    height: 50,
    justifyContent: "center",
    width: 50
  },
  heroTitle: {
    color: "#fff",
    fontSize: 22,
    fontWeight: "900",
    marginBottom: 4
  }
});
