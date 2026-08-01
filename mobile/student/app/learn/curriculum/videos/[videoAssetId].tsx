import { useCallback, useEffect, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";
import { VideoView, useVideoPlayer } from "expo-video";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { loadStudentCurriculumVideo } from "@/lib/studentCurriculum";

function normalizeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

type VideoAccess = {
  id: string;
  title: string;
  description: string | null;
  durationSeconds: number | null;
  url: string;
  expiresAt: string;
};

export default function CurriculumVideoScreen() {
  const {
    assignmentId: rawAssignmentId,
    videoAssetId: rawVideoAssetId,
  } = useLocalSearchParams<{
    assignmentId: string;
    videoAssetId: string;
  }>();
  const assignmentId = normalizeParam(rawAssignmentId);
  const videoAssetId = normalizeParam(rawVideoAssetId);
  const router = useRouter();
  const [video, setVideo] = useState<VideoAccess | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const player = useVideoPlayer(video?.url ?? null, (nextPlayer) => {
    nextPlayer.loop = false;
  });

  const load = useCallback(async () => {
    if (!assignmentId || !videoAssetId) {
      setErrorMessage("Curriculum video could not be found.");
      setLoading(false);
      return;
    }

    try {
      setVideo(
        await loadStudentCurriculumVideo(assignmentId, videoAssetId),
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Curriculum video could not be opened.",
      );
    } finally {
      setLoading(false);
    }
  }, [assignmentId, videoAssetId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <Screen>
        <FeatureCard
          title="Preparing secure video"
          detail="Confirming your studio assignment and creating private playback access."
        />
      </Screen>
    );
  }

  if (!video) {
    return (
      <Screen>
        <FeatureCard
          title="Video unavailable"
          detail={errorMessage ?? "This video could not be opened."}
        />
        <AppButton
          label="Back to assignment"
          onPress={() =>
            router.replace(
              `/learn/curriculum/${assignmentId}` as never,
            )
          }
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <AppText variant="eyebrow">Curriculum Video</AppText>
      <AppText variant="title">{video.title}</AppText>
      {video.description ? (
        <AppText variant="caption">{video.description}</AppText>
      ) : null}

      <View style={styles.videoShell}>
        <VideoView
          player={player}
          style={styles.video}
          nativeControls
          allowsFullscreen
          allowsPictureInPicture
        />
      </View>

      <AppText variant="caption">
        Secure playback expires automatically. Reopen the video to refresh access.
      </AppText>

      <AppButton
        label="Back to assignment"
        onPress={() =>
          router.replace(`/learn/curriculum/${assignmentId}` as never)
        }
        variant="secondary"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  video: {
    aspectRatio: 16 / 9,
    width: "100%",
  },
  videoShell: {
    backgroundColor: "#000",
    borderRadius: 18,
    overflow: "hidden",
  },
});
