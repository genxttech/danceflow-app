import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEventListener } from "expo";
import {
  Pressable,
  StyleSheet,
  useColorScheme,
  View
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { VideoView, useVideoPlayer } from "expo-video";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colorsForScheme } from "@/constants/theme";
import {
  loadStudentDigitalContent,
  saveStudentDigitalProgress,
  type StudentDigitalContentAccess
} from "@/lib/studentDigitalContent";

function normalizeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function durationLabel(seconds: number | null) {
  if (!seconds) return null;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} min`;
}

export default function DigitalContentPlaybackScreen() {
  const {
    entitlementId: entitlementParam,
    catalogItemId: catalogItemParam
  } = useLocalSearchParams<{
    entitlementId: string;
    catalogItemId?: string;
  }>();
  const entitlementId = normalizeParam(entitlementParam);
  const initialCatalogItemId = normalizeParam(catalogItemParam);
  const router = useRouter();
  const colors = colorsForScheme(useColorScheme());
  const styles = createStyles(colors);
  const [content, setContent] =
    useState<StudentDigitalContentAccess | null>(null);
  const [selectedCatalogItemId, setSelectedCatalogItemId] =
    useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const lastSavedAtRef = useRef(0);
  const resumeAppliedForRef = useRef<string | null>(null);

  const playbackUrl = content?.playback?.url ?? null;
  const player = useVideoPlayer(playbackUrl, (nextPlayer) => {
    nextPlayer.loop = false;
    nextPlayer.timeUpdateEventInterval = 5;
  });

  const selectedVideo = useMemo(
    () =>
      content?.videos.find(
        (video) =>
          video.catalogItemId ===
          (selectedCatalogItemId ?? content.playback?.catalogItemId)
      ) ?? null,
    [content, selectedCatalogItemId]
  );

  const load = useCallback(
    async (catalogItemId?: string | null) => {
      if (!entitlementId) {
        setErrorMessage("Digital access could not be found.");
        setLoading(false);
        return;
      }

      setLoading(true);
      setErrorMessage(null);

      try {
        const nextContent = await loadStudentDigitalContent(
          entitlementId,
          catalogItemId
        );
        setContent(nextContent);
        setSelectedCatalogItemId(
          nextContent.playback?.catalogItemId ??
            nextContent.videos[0]?.catalogItemId ??
            null
        );
      } catch (error) {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "This content could not be opened."
        );
      } finally {
        setLoading(false);
      }
    },
    [entitlementId]
  );

  useEffect(() => {
    void load(initialCatalogItemId);
  }, [initialCatalogItemId, load]);

  useEventListener(player, "statusChange", ({ status }) => {
    if (
      status !== "readyToPlay" ||
      !content?.playback?.catalogItemId ||
      resumeAppliedForRef.current === content.playback.catalogItemId
    ) {
      return;
    }

    const resumeSeconds = Math.max(
      0,
      Number(content.selectedProgress?.positionSeconds ?? 0)
    );

    if (
      resumeSeconds > 5 &&
      !content.selectedProgress?.completed &&
      (!player.duration || resumeSeconds < player.duration - 10)
    ) {
      player.currentTime = resumeSeconds;
    }

    resumeAppliedForRef.current = content.playback.catalogItemId;
  });

  useEventListener(player, "timeUpdate", ({ currentTime }) => {
    const catalogItemId = content?.playback?.catalogItemId;
    if (!entitlementId || !catalogItemId) return;

    const now = Date.now();
    if (now - lastSavedAtRef.current < 15000) return;
    lastSavedAtRef.current = now;

    void saveStudentDigitalProgress(entitlementId, {
      catalogItemId,
      positionSeconds: currentTime,
      durationSeconds: player.duration || selectedVideo?.durationSeconds || 0
    }).catch(() => {
      // Playback should continue when a background progress write fails.
    });
  });

  useEventListener(player, "playToEnd", () => {
    const catalogItemId = content?.playback?.catalogItemId;
    if (!entitlementId || !catalogItemId) return;

    void saveStudentDigitalProgress(entitlementId, {
      catalogItemId,
      positionSeconds: player.duration || selectedVideo?.durationSeconds || 0,
      durationSeconds: player.duration || selectedVideo?.durationSeconds || 0,
      completed: true
    });
  });

  if (loading && !content) {
    return (
      <Screen>
        <FeatureCard
          title="Preparing your video"
          detail="Confirming your purchase and creating secure playback access."
        />
      </Screen>
    );
  }

  if (!content || errorMessage) {
    return (
      <Screen>
        <FeatureCard
          title="Content unavailable"
          detail={errorMessage ?? "This content could not be opened."}
        />
        <AppButton
          label="Back to purchases"
          onPress={() => router.replace("/wallet/digital-purchases" as never)}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <AppText variant="eyebrow">
        {content.itemType === "video_series" ? "Video Series" : "Digital Video"}
      </AppText>
      <AppText variant="title">{content.name}</AppText>
      {content.description ? (
        <AppText variant="caption">{content.description}</AppText>
      ) : null}

      {playbackUrl ? (
        <View style={styles.videoShell}>
          <VideoView
            player={player}
            style={styles.video}
            nativeControls
            allowsFullscreen
            allowsPictureInPicture
          />
        </View>
      ) : (
        <FeatureCard
          title="Video is not ready"
          detail="The studio is still preparing this video. Check again shortly."
        />
      )}

      {selectedVideo ? (
        <View style={styles.detailCard}>
          <AppText variant="subtitle">{selectedVideo.title}</AppText>
          {selectedVideo.summary ? (
            <AppText variant="caption">{selectedVideo.summary}</AppText>
          ) : null}
          {selectedVideo.progress ? (
            <AppText variant="caption">
              {selectedVideo.progress.completed
                ? "Completed"
                : `${Math.round(selectedVideo.progress.percentComplete)}% complete`}
            </AppText>
          ) : null}
          <View style={styles.metaRow}>
            {selectedVideo.instructorName ? (
              <AppText variant="caption">
                Instructor: {selectedVideo.instructorName}
              </AppText>
            ) : null}
            {durationLabel(selectedVideo.durationSeconds) ? (
              <AppText variant="caption">
                {durationLabel(selectedVideo.durationSeconds)}
              </AppText>
            ) : null}
          </View>
        </View>
      ) : null}

      {content.videos.length > 1 ? (
        <View style={styles.section}>
          <AppText variant="subtitle">Series lessons</AppText>
          {content.videos.map((video, index) => {
            const selected =
              video.catalogItemId === selectedCatalogItemId;

            return (
              <Pressable
                key={video.catalogItemId}
                onPress={() => {
                  resumeAppliedForRef.current = null;
                  lastSavedAtRef.current = 0;
                  setSelectedCatalogItemId(video.catalogItemId);
                  void load(video.catalogItemId);
                }}
                style={[
                  styles.lessonCard,
                  selected && styles.lessonCardSelected
                ]}
              >
                <AppText variant="eyebrow">
                  Lesson {index + 1}
                </AppText>
                <AppText variant="subtitle">{video.title}</AppText>
                <AppText variant="caption">
                  {[
                    video.danceStyle,
                    durationLabel(video.durationSeconds),
                    video.progress?.completed
                      ? "Completed"
                      : video.progress
                        ? `${Math.round(video.progress.percentComplete)}%`
                        : null
                  ]
                    .filter(Boolean)
                    .join(" • ")}
                </AppText>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <AppButton
        label="Back to purchases"
        onPress={() => router.replace("/wallet/digital-purchases" as never)}
      />
    </Screen>
  );
}

function createStyles(colors: ReturnType<typeof colorsForScheme>) {
  return StyleSheet.create({
    detailCard: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 18,
      borderWidth: 1,
      gap: 8,
      padding: 16
    },
    lessonCard: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 16,
      borderWidth: 1,
      gap: 5,
      padding: 15
    },
    lessonCardSelected: {
      borderColor: colors.primary,
      borderWidth: 2
    },
    metaRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 10
    },
    section: {
      gap: 10
    },
    video: {
      aspectRatio: 16 / 9,
      width: "100%"
    },
    videoShell: {
      backgroundColor: "#000",
      borderRadius: 18,
      overflow: "hidden"
    }
  });
}
