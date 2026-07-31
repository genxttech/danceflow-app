import { Pressable, StyleSheet, useColorScheme, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { colorsForScheme } from "@/constants/theme";

type MenuIcon = keyof typeof Ionicons.glyphMap;

function MenuRow({
  detail,
  icon,
  onPress,
  title,
  styles,
}: {
  detail: string;
  icon: MenuIcon;
  onPress: () => void;
  title: string;
  styles: ReturnType<typeof createStyles>;
}) {
  const colors = colorsForScheme(useColorScheme());

  return (
    <Pressable
      accessibilityHint={detail}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.menuRow,
        pressed && styles.menuRowPressed,
      ]}
    >
      <View style={styles.menuIcon}>
        <Ionicons color={colors.primary} name={icon} size={24} />
      </View>
      <View style={styles.menuCopy}>
        <AppText style={styles.menuTitle}>{title}</AppText>
        <AppText style={styles.menuDetail}>{detail}</AppText>
      </View>
      <Ionicons color={colors.muted} name="chevron-forward" size={20} />
    </Pressable>
  );
}

function MenuSection({
  children,
  eyebrow,
  title,
  styles,
}: {
  children: React.ReactNode;
  eyebrow: string;
  title: string;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.section}>
      <View>
        <AppText style={styles.sectionEyebrow}>{eyebrow}</AppText>
        <AppText style={styles.sectionTitle}>{title}</AppText>
      </View>
      <View style={styles.menuList}>{children}</View>
    </View>
  );
}

export default function MoreScreen() {
  const colors = colorsForScheme(useColorScheme());
  const styles = createStyles(colors);

  return (
    <Screen>
      <View style={styles.hero}>
        <View style={styles.heroIcon}>
          <Ionicons color={colors.primary} name="menu-outline" size={26} />
        </View>
        <View style={styles.heroCopy}>
          <AppText style={styles.heroEyebrow}>More</AppText>
          <AppText style={styles.heroTitle}>Everything else, easy to find</AppText>
          <AppText style={styles.heroDetail}>
            Account tools, studio access, rewards, documents, tickets, and DanceFlow assistance without crowding the main tabs.
          </AppText>
        </View>
      </View>

      <MenuSection eyebrow="Your account" title="Money, rewards & profile" styles={styles}>
        <MenuRow
          icon="wallet-outline"
          title="Wallet"
          detail="Payments, packages, memberships, balances, and purchased access"
          onPress={() => router.push("/(tabs)/wallet" as never)}
          styles={styles}
        />
        <MenuRow
          icon="gift-outline"
          title="Rewards"
          detail="See earned rewards, progress, and reward history"
          onPress={() => router.push("/wallet/rewards" as never)}
          styles={styles}
        />
        <MenuRow
          icon="person-circle-outline"
          title="Profile"
          detail="Manage your dancer profile and DanceFlow identity"
          onPress={() => router.push("/profile" as never)}
          styles={styles}
        />
      </MenuSection>

      <MenuSection eyebrow="Studio access" title="What you need from your studios" styles={styles}>
        <MenuRow
          icon="ticket-outline"
          title="Event Tickets"
          detail="Tickets, QR codes, and event check-in access"
          onPress={() => router.push("/wallet/event-tickets" as never)}
          styles={styles}
        />
        <MenuRow
          icon="document-text-outline"
          title="Documents"
          detail="Pending signatures and completed studio documents"
          onPress={() => router.push("/wallet/documents" as never)}
          styles={styles}
        />
        <MenuRow
          icon="business-outline"
          title="Settings & Connected Studios"
          detail="Notifications, account controls, and studio connections"
          onPress={() => router.push("/settings" as never)}
          styles={styles}
        />
      </MenuSection>

      <MenuSection eyebrow="DanceFlow" title="Assistance" styles={styles}>
        <MenuRow
          icon="sparkles-outline"
          title="Ask LUMI"
          detail="Get help with your learning and DanceFlow experience"
          onPress={() => router.push("/lumi" as never)}
          styles={styles}
        />
      </MenuSection>
    </Screen>
  );
}

function createStyles(colors: ReturnType<typeof colorsForScheme>) {
  return StyleSheet.create({
    hero: {
      alignItems: "flex-start",
      backgroundColor: colors.backgroundSoft,
      borderColor: colors.border,
      borderRadius: 26,
      borderWidth: 1,
      flexDirection: "row",
      gap: 14,
      padding: 20,
    },
    heroIcon: {
      alignItems: "center",
      backgroundColor: colors.surfaceAlt,
      borderRadius: 16,
      height: 48,
      justifyContent: "center",
      width: 48,
    },
    heroCopy: {
      flex: 1,
    },
    heroEyebrow: {
      color: colors.accent,
      fontSize: 11,
      fontWeight: "900",
      letterSpacing: 1.4,
      textTransform: "uppercase",
    },
    heroTitle: {
      color: colors.text,
      fontSize: 25,
      fontWeight: "900",
      lineHeight: 31,
      marginTop: 3,
    },
    heroDetail: {
      color: colors.muted,
      fontSize: 13,
      lineHeight: 20,
      marginTop: 5,
    },
    section: {
      gap: 10,
    },
    sectionEyebrow: {
      color: colors.accent,
      fontSize: 11,
      fontWeight: "900",
      letterSpacing: 1.2,
      textTransform: "uppercase",
    },
    sectionTitle: {
      color: colors.text,
      fontSize: 20,
      fontWeight: "900",
      marginTop: 2,
    },
    menuList: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 22,
      borderWidth: 1,
      overflow: "hidden",
    },
    menuRow: {
      alignItems: "center",
      borderBottomColor: colors.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 13,
      minHeight: 72,
      paddingHorizontal: 15,
      paddingVertical: 12,
    },
    menuRowPressed: {
      backgroundColor: colors.surfaceAlt,
    },
    menuIcon: {
      alignItems: "center",
      backgroundColor: colors.surfaceAlt,
      borderRadius: 14,
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    menuCopy: {
      flex: 1,
    },
    menuTitle: {
      color: colors.text,
      fontSize: 16,
      fontWeight: "900",
    },
    menuDetail: {
      color: colors.muted,
      fontSize: 12,
      lineHeight: 18,
      marginTop: 2,
    },
  });
}
