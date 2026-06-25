import { useEffect, useState } from "react";
import { Image, StyleSheet, TextInput, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess, type LinkedStudioAccess } from "@/lib/studentAccess";
import { loadStudentLearnOverview, type StudentLearnOverview } from "@/lib/studentLearn";

const lumiAvatar = require("../assets/lumi-avatar.png");

const emptyOverview: StudentLearnOverview = {
  recentLessons: [],
  practiceFocus: [],
  lumiPrompts: [
    "What should I practice this week?",
    "Turn my recent lessons into a practice plan.",
    "What should I ask my instructor next time?"
  ]
};

export default function LumiScreen() {
  const { session } = useAuth();
  const [loadingAccess, setLoadingAccess] = useState(true);
  const [linkedStudios, setLinkedStudios] = useState<LinkedStudioAccess[]>([]);
  const [lumiEnabled, setLumiEnabled] = useState(false);
  const [overview, setOverview] = useState<StudentLearnOverview>(emptyOverview);
  const [draftPrompt, setDraftPrompt] = useState("");

  useEffect(() => {
    let mounted = true;
    const userId = session?.user.id;

    async function load() {
      if (!userId) {
        setLoadingAccess(false);
        setLinkedStudios([]);
        setLumiEnabled(false);
        setOverview(emptyOverview);
        return;
      }

      setLoadingAccess(true);

      try {
        const access = await getStudentAccess(userId);
        const learnOverview = await loadStudentLearnOverview(access.linkedStudios);

        if (!mounted) return;

        setLinkedStudios(access.linkedStudios);
        setLumiEnabled(access.lumiEnabled);
        setOverview(learnOverview);
      } catch {
        if (!mounted) return;
        setLinkedStudios([]);
        setLumiEnabled(false);
        setOverview(emptyOverview);
      } finally {
        if (!mounted) return;
        setLoadingAccess(false);
      }
    }

    load();

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
            <AppText variant="caption">Loading your linked studio portal access.</AppText>
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
              LUMI uses your studio-linked lessons, recaps, syllabus progress, memberships,
              packages, and event activity. Ask your studio to connect your DanceFlow portal.
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
              Your portal is connected, but LUMI access depends on the studio's DanceFlow settings.
            </AppText>
          </View>
        </View>
      </Screen>
    );
  }

  const primaryStudio = linkedStudios[0];
  const latestLesson = overview.recentLessons[0] ?? null;
  const prompts = overview.lumiPrompts.length ? overview.lumiPrompts : emptyOverview.lumiPrompts;

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
            Ask about student-visible schedule, approved recaps, syllabus progress, memberships,
            packages, tickets, and practice goals.
          </AppText>
        </View>
      </View>

      <View style={styles.contextCard}>
        <AppText variant="eyebrow">Context LUMI can use</AppText>
        <AppText variant="subtitle">
          {primaryStudio?.studioPublicName || primaryStudio?.studioName || "Linked studio"}
        </AppText>
        <AppText variant="caption">
          {latestLesson
            ? `Latest lesson: ${latestLesson.title} · ${latestLesson.timeText}`
            : "No recent student-visible lessons found yet."}
        </AppText>
        <AppText variant="caption">
          {overview.practiceFocus.length
            ? `Practice focus: ${overview.practiceFocus[0].title}`
            : "Practice focus will appear after lesson history is available."}
        </AppText>
      </View>

      <View style={styles.promptSection}>
        <AppText variant="subtitle">Try asking</AppText>
        {prompts.map((prompt) => (
          <AppButton
            key={prompt}
            label={prompt}
            onPress={() => setDraftPrompt(prompt)}
            variant="secondary"
          />
        ))}
      </View>

      <TextInput
        multiline
        onChangeText={setDraftPrompt}
        placeholder="Ask about your schedule, practice plan, or progress..."
        placeholderTextColor={colors.muted}
        style={styles.input}
        value={draftPrompt}
      />
      <AppButton label="Send" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  avatar: {
    borderRadius: 42,
    height: 84,
    width: 84
  },
  card: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderRadius: 18,
    flexDirection: "row",
    gap: 14,
    padding: 18
  },
  cardCopy: {
    flex: 1,
    gap: 8
  },
  contextCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 8,
    padding: 16
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
  },
  lockedCard: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 14,
    padding: 18
  },
  promptSection: {
    gap: 10
  }
});
