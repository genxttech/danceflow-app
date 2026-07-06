import { useEffect, useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess } from "@/lib/studentAccess";
import {
  loadStudentLearnOverview,
  type StudentGroupLessonRecap
} from "@/lib/studentLearn";

function normalizeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function lumiPromptHref(prompt: string): Href {
  return {
    pathname: "/lumi",
    params: { prompt }
  } as Href;
}

function formatPublishedAt(value: string | null) {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

function RecapSection({ body, title }: { body: string | null; title: string }) {
  if (!body) return null;

  return (
    <View style={styles.detailCard}>
      <AppText variant="subtitle">{title}</AppText>
      <AppText style={styles.bodyText}>{body}</AppText>
    </View>
  );
}

export default function GroupRecapDetailScreen() {
  const { recapId: recapIdParam } = useLocalSearchParams<{ recapId: string }>();
  const recapId = normalizeParam(recapIdParam);
  const router = useRouter();
  const { session } = useAuth();
  const [recap, setRecap] = useState<StudentGroupLessonRecap | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const userId = session?.user.id;

    async function load() {
      if (!userId || !recapId) {
        setErrorMessage("Sign in to view this group recap.");
        setLoading(false);
        return;
      }

      setLoading(true);
      setErrorMessage(null);

      try {
        const access = await getStudentAccess(userId);
        const overview = await loadStudentLearnOverview(access.linkedStudios);
        const match = overview.groupLessonRecaps.find((item) => item.id === recapId) ?? null;

        if (!mounted) return;
        setRecap(match);
        if (!match) {
          setErrorMessage("This group recap could not be found.");
        }
      } catch {
        if (!mounted) return;
        setErrorMessage("This group recap could not be loaded.");
      } finally {
        if (!mounted) return;
        setLoading(false);
      }
    }

    load();

    return () => {
      mounted = false;
    };
  }, [recapId, session?.user.id]);

  if (loading) {
    return (
      <Screen>
        <FeatureCard title="Loading recap" detail="Finding your group lesson notes." />
      </Screen>
    );
  }

  if (!recap) {
    return (
      <Screen>
        <FeatureCard title="Recap unavailable" detail={errorMessage ?? "This recap could not be found."} />
        <AppButton label="Back to Learn" onPress={() => router.replace("/(tabs)/learn")} />
      </Screen>
    );
  }

  const publishedAt = formatPublishedAt(recap.publishedAt);
  const lumiPrompt = [
    `Help me review this group recap: ${recap.title}.`,
    recap.summary ? `Summary: ${recap.summary}` : null,
    recap.techniqueNotes ? `Technique notes: ${recap.techniqueNotes}` : null,
    recap.practiceAssignment ? `Practice assignment: ${recap.practiceAssignment}` : null,
    recap.safetyNotes ? `Safety notes: ${recap.safetyNotes}` : null
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Screen>
      <AppText variant="eyebrow">Group Recap</AppText>
      <AppText variant="title">{recap.title}</AppText>
      <AppText variant="caption">{recap.studioName}</AppText>
      {publishedAt ? <AppText variant="caption">Published {publishedAt}</AppText> : null}

      <RecapSection title="Summary" body={recap.summary} />
      <RecapSection title="Technique notes" body={recap.techniqueNotes} />
      <RecapSection title="Practice assignment" body={recap.practiceAssignment} />
      <RecapSection title="Safety notes" body={recap.safetyNotes} />

      {recap.mediaLinks.length > 0 ? (
        <View style={styles.detailCard}>
          <AppText variant="subtitle">Shared links</AppText>
          {recap.mediaLinks.map((link) => (
            <AppButton
              key={link}
              label={link}
              onPress={() => Linking.openURL(link)}
              variant="secondary"
            />
          ))}
        </View>
      ) : null}

      <View style={styles.actions}>
        <AppButton label="Ask LUMI about this recap" onPress={() => router.push(lumiPromptHref(lumiPrompt))} />
        <AppButton label="Back to Learn" onPress={() => router.replace("/(tabs)/learn")} variant="secondary" />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: 10
  },
  bodyText: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 23
  },
  detailCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    gap: 8,
    padding: 16
  }
});
