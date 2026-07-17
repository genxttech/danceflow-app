import { useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Image, StyleSheet, TextInput, useColorScheme, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { colorsForScheme } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess, type LinkedStudioAccess } from "@/lib/studentAccess";
import { loadStudentLearnOverview, type StudentLearnOverview } from "@/lib/studentLearn";
import {
  formatScheduleDateTime,
  loadStudentScheduleOverview,
  type StudentScheduleOverview
} from "@/lib/studentSchedule";

const lumiAvatar = require("../assets/lumi-avatar.png");

const emptyOverview: StudentLearnOverview = {
  recentLessons: [],
  groupLessonRecaps: [],
  practiceFocus: [],
  syllabi: [],
  lumiPrompts: [
    "What should I practice this week?",
    "Turn my recent lessons into a practice plan.",
    "What should I ask my instructor next time?"
  ]
};

const emptySchedule: StudentScheduleOverview = {
  upcoming: [],
  recent: [],
  bookingRequests: [],
  nextItem: null
};

function lower(value: string) {
  return value.trim().toLowerCase();
}

function includesAny(value: string, words: string[]) {
  return words.some((word) => value.includes(word));
}

export default function LumiScreen() {
  const colors = colorsForScheme(useColorScheme());
  const styles = createStyles(colors);
  const params = useLocalSearchParams<{ prompt?: string }>();
  const { session } = useAuth();
  const [loadingAccess, setLoadingAccess] = useState(true);
  const [linkedStudios, setLinkedStudios] = useState<LinkedStudioAccess[]>([]);
  const [lumiEnabled, setLumiEnabled] = useState(false);
  const [overview, setOverview] = useState<StudentLearnOverview>(emptyOverview);
  const [schedule, setSchedule] = useState<StudentScheduleOverview>(emptySchedule);
  const [draftPrompt, setDraftPrompt] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);

  const incomingPrompt = useMemo(() => {
    const prompt = Array.isArray(params.prompt) ? params.prompt[0] : params.prompt;
    return typeof prompt === "string" ? prompt.trim() : "";
  }, [params.prompt]);

  useEffect(() => {
    let mounted = true;
    const userId = session?.user.id;

    async function load() {
      if (!userId) {
        setLoadingAccess(false);
        setLinkedStudios([]);
        setLumiEnabled(false);
        setOverview(emptyOverview);
        setSchedule(emptySchedule);
        return;
      }

      setLoadingAccess(true);

      try {
        const access = await getStudentAccess(userId);
        const [learnOverview, scheduleOverview] = await Promise.all([
          loadStudentLearnOverview(access.linkedStudios),
          loadStudentScheduleOverview(access.linkedStudios)
        ]);

        if (!mounted) return;

        setLinkedStudios(access.linkedStudios);
        setLumiEnabled(access.lumiEnabled);
        setOverview(learnOverview);
        setSchedule(scheduleOverview);
      } catch {
        if (!mounted) return;
        setLinkedStudios([]);
        setLumiEnabled(false);
        setOverview(emptyOverview);
        setSchedule(emptySchedule);
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

  useEffect(() => {
    if (!incomingPrompt) return;

    setDraftPrompt(incomingPrompt);
    setAnswer(null);
  }, [incomingPrompt]);

  function buildLocalAnswer(prompt: string) {
    const intent = lower(prompt);
    const latestLesson = overview.recentLessons[0] ?? null;
    const latestGroupRecap = overview.groupLessonRecaps[0] ?? null;
    const focus = overview.practiceFocus[0] ?? null;
    const syllabus = overview.syllabi[0] ?? null;
    const nextLesson = schedule.nextItem ?? schedule.upcoming[0] ?? null;
    const pendingRequest = schedule.bookingRequests.find((request) =>
      ["pending", "in_review"].includes(lower(request.status))
    );

    if (includesAny(intent, ["schedule", "book", "lesson this week", "next lesson", "appointment", "private lesson", "take a lesson"])) {
      if (nextLesson) {
        const lessonTime = formatScheduleDateTime(nextLesson.startsAt, nextLesson.timeZone);

        return [
          `You asked: "${prompt}"`,
          "",
          `You already have ${nextLesson.title} scheduled for ${nextLesson.subtitle} at ${nextLesson.timeZone ? nextLesson.timeZone : "your studio time"}.`,
          `Time: ${lessonTime}`,
          "",
          "My advice: do not add another lesson just to add one. Use this next lesson as your checkpoint, and bring one specific question from your recent practice or recap.",
          latestLesson ? `Good question to bring: "What should I clean up from ${latestLesson.title} before we add anything new?"` : "Good question to bring: \"What is the one thing I should practice most this week?\""
        ].join("\n");
      }

      if (pendingRequest) {
        const requestedTime = pendingRequest.requestedStartsAt
          ? formatScheduleDateTime(pendingRequest.requestedStartsAt, pendingRequest.timeZone)
          : null;

        return [
          `You asked: "${prompt}"`,
          "",
          `You already have a ${pendingRequest.status.replaceAll("_", " ")} lesson request with ${pendingRequest.studioName}.`,
          requestedTime ? `Requested time: ${requestedTime}` : null,
          "",
          "My advice: wait for that request before submitting another one. While you wait, spend 10 minutes on your latest practice focus so you arrive with something concrete to ask."
        ].filter(Boolean).join("\n");
      }

      return [
        `You asked: "${prompt}"`,
        "",
        "Yes, scheduling a lesson this week would make sense if you have one clear thing you want feedback on.",
        latestLesson ? `Use ${latestLesson.title} as the starting point.` : null,
        focus ? `Bring this focus: ${focus.title}. ${focus.detail}` : null,
        "",
        "Best plan: book one lesson, choose one skill to review, and ask your instructor for a 10-minute home practice assignment before you leave."
      ].filter(Boolean).join("\n");
    }

    if (includesAny(intent, ["practice", "homework", "work on", "drill", "improve", "clean up"])) {
      return [
        `You asked: "${prompt}"`,
        "",
        focus
          ? `Start with ${focus.title}. ${focus.detail}`
          : latestLesson
            ? `Start with the main idea from ${latestLesson.title}.`
            : "Start with one skill that felt unclear in your last class or lesson.",
        latestGroupRecap?.practiceAssignment
          ? `From your latest group recap: ${latestGroupRecap.practiceAssignment}`
          : null,
        latestLesson
          ? `Use ${latestLesson.title} as your checkpoint, not a whole new list of goals.`
          : null,
        "",
        "Plan: 5 slow reps without music, 5 reps with music, then write one question for your instructor."
      ].filter(Boolean).join("\n");
    }

    if (includesAny(intent, ["recap", "review", "what did", "class notes", "group"])) {
      const recap = latestGroupRecap;
      if (recap) {
        return [
          `You asked: "${prompt}"`,
          "",
          `For ${recap.title}, focus on the part that creates the most repeatable progress:`,
          recap.summary ? `Summary: ${recap.summary}` : null,
          recap.techniqueNotes ? `Technique: ${recap.techniqueNotes}` : null,
          recap.practiceAssignment ? `Practice assignment: ${recap.practiceAssignment}` : null,
          recap.safetyNotes ? `Safety note: ${recap.safetyNotes}` : null,
          "",
          "Practice it in three passes: slow without music, slow with music, then normal tempo once. Stop before it gets messy."
        ].filter(Boolean).join("\n");
      }
    }

    if (includesAny(intent, ["syllabus", "progress", "level", "mastered", "next level"])) {
      if (syllabus) {
        return [
          `You asked: "${prompt}"`,
          "",
          `${syllabus.name} is ${syllabus.percentMastered}% mastered.`,
          `${syllabus.masteredItems} mastered, ${syllabus.activeItems} active, ${syllabus.startedItems} started.`,
          "",
          "My advice: do not chase the percentage. Pick one active item and ask your instructor what would make it count as mastered."
        ].join("\n");
      }
    }

    const contextLines = [
      latestLesson
        ? `Start with ${latestLesson.title}${latestLesson.instructorName ? ` from ${latestLesson.instructorName}` : ""}.`
        : null,
      latestGroupRecap ? `Review the group recap "${latestGroupRecap.title}".` : null,
      focus ? `Practice focus: ${focus.title} - ${focus.detail}` : null,
      syllabus ? `Syllabus checkpoint: ${syllabus.name} is ${syllabus.percentMastered}% mastered.` : null
    ].filter(Boolean);

    if (!contextLines.length) {
      return [
        `You asked: "${prompt}"`,
        "",
        "I do not see enough student-visible lesson context yet, so start small:",
        "1. Pick one skill you want to feel better about.",
        "2. Practice it slowly for 10 minutes.",
        "3. Write one question to bring to your instructor."
      ].join("\n");
    }

    return [
      `You asked: "${prompt}"`,
      "",
      "Here is a focused answer from your visible DanceFlow context:",
      ...contextLines.map((line, index) => `${index + 1}. ${line}`),
      "",
      "Keep it simple: do one slow review pass, one music pass, then write down what still feels unclear."
    ].join("\n");
  }

  function handleSend() {
    const prompt = draftPrompt.trim();

    if (!prompt) {
      setAnswer("Type a question or choose one of the prompts above so LUMI knows what to help with.");
      return;
    }

    setAnswer(buildLocalAnswer(prompt));
  }

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
            <AppText variant="title">Getting LUMI ready</AppText>
            <AppText variant="caption">Checking your studio connection.</AppText>
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
              LUMI uses your lessons, recaps, syllabus progress, memberships,
              packages, and event activity. Ask your studio to connect your DanceFlow account.
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
              Your studio connection is ready, but LUMI is not enabled for this studio yet.
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
          {primaryStudio?.studioPublicName || primaryStudio?.studioName || "Your studio"}
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
      <AppButton disabled={!draftPrompt.trim()} label="Send" onPress={handleSend} />

      {answer ? (
        <View style={styles.answerCard}>
          <AppText variant="eyebrow">LUMI response</AppText>
          <AppText variant="caption">{answer}</AppText>
        </View>
      ) : null}
    </Screen>
  );
}

function createStyles(colors: ReturnType<typeof colorsForScheme>) {
  return StyleSheet.create({
  avatar: {
    borderRadius: 42,
    height: 84,
    width: 84
  },
  card: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 20,
    borderWidth: 1,
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
    borderRadius: 20,
    borderWidth: 1,
    gap: 8,
    padding: 16
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    minHeight: 140,
    padding: 16,
    textAlignVertical: "top"
  },
  answerCard: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 20,
    borderWidth: 1,
    gap: 8,
    padding: 16
  },
  lockedCard: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 20,
    borderWidth: 1,
    flexDirection: "row",
    gap: 14,
    padding: 18
  },
  promptSection: {
    gap: 10
  }
  });
}
