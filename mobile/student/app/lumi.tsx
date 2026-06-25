import { useEffect, useState } from "react";
import { Image, StyleSheet, TextInput, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess, type LinkedStudioAccess } from "@/lib/studentAccess";

const lumiAvatar = require("../assets/lumi-avatar.png");

export default function LumiScreen() {
  const { session } = useAuth();
  const [loadingAccess, setLoadingAccess] = useState(true);
  const [linkedStudios, setLinkedStudios] = useState<LinkedStudioAccess[]>([]);
  const [lumiEnabled, setLumiEnabled] = useState(false);

  useEffect(() => {
    let mounted = true;
    const userId = session?.user.id;

    if (!userId) {
      setLoadingAccess(false);
      setLinkedStudios([]);
      setLumiEnabled(false);
      return;
    }

    getStudentAccess(userId)
      .then((access) => {
        if (!mounted) return;
        setLinkedStudios(access.linkedStudios);
        setLumiEnabled(access.lumiEnabled);
      })
      .catch(() => {
        if (!mounted) return;
        setLinkedStudios([]);
        setLumiEnabled(false);
      })
      .finally(() => {
        if (!mounted) return;
        setLoadingAccess(false);
      });

    return () => {
      mounted = false;
    };
  }, [session?.user.id]);

  if (loadingAccess) {
    return (
      <Screen>
        <View style={styles.card}>
          <Image
            accessibilityIgnoresInvertColors
            resizeMode="cover"
            source={lumiAvatar}
            style={styles.avatar}
          />
          <View style={styles.cardCopy}>
            <AppText variant="eyebrow">LUMI</AppText>
            <AppText variant="title">Checking access</AppText>
            <AppText variant="caption">
              Loading your linked studio portal access.
            </AppText>
          </View>
        </View>
      </Screen>
    );
  }

  if (!linkedStudios.length) {
    return (
      <Screen>
        <View style={styles.lockedCard}>
          <Image
            accessibilityIgnoresInvertColors
            resizeMode="cover"
            source={lumiAvatar}
            style={styles.avatar}
          />
          <View style={styles.cardCopy}>
            <AppText variant="eyebrow">LUMI</AppText>
            <AppText variant="title">Connect a studio to unlock LUMI</AppText>
            <AppText variant="caption">
              LUMI uses your studio-linked lessons, recaps, syllabus progress,
              memberships, packages, and event activity. Ask your studio to connect
              your DanceFlow portal.
            </AppText>
          </View>
        </View>
      </Screen>
    );
  }

  if (!lumiEnabled) {
    return (
      <Screen>
        <View style={styles.lockedCard}>
          <Image
            accessibilityIgnoresInvertColors
            resizeMode="cover"
            source={lumiAvatar}
            style={styles.avatar}
          />
          <View style={styles.cardCopy}>
            <AppText variant="eyebrow">LUMI</AppText>
            <AppText variant="title">LUMI is not enabled for this studio yet</AppText>
            <AppText variant="caption">
              Your portal is connected, but LUMI access depends on the studio's
              DanceFlow settings.
            </AppText>
          </View>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={styles.card}>
        <Image
          accessibilityIgnoresInvertColors
          resizeMode="cover"
          source={lumiAvatar}
          style={styles.avatar}
        />
        <View style={styles.cardCopy}>
          <AppText variant="eyebrow">LUMI</AppText>
          <AppText variant="title">Student assistant</AppText>
          <AppText variant="caption">
            LUMI should only use student-visible data: schedule, approved recaps,
            syllabus progress, favorites, memberships, packages, and tickets.
          </AppText>
        </View>
      </View>

      <TextInput
        multiline
        placeholder="Ask about your schedule, practice plan, or progress..."
        placeholderTextColor={colors.muted}
        style={styles.input}
      />
      <AppButton label="Send" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  avatar: {
    borderRadius: 38,
    height: 76,
    width: 76
  },
  card: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderRadius: 18,
    flexDirection: "row",
    gap: 14,
    padding: 20
  },
  cardCopy: {
    flex: 1,
    gap: 8
  },
  lockedCard: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 14,
    padding: 20
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    minHeight: 140,
    padding: 16,
    textAlignVertical: "top"
  }
});
