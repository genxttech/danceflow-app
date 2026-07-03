import { useEffect, useMemo, useState } from "react";
import { Linking, Pressable, Share, StyleSheet, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import {
  getPublicStudiosForMobile,
  setPublicFavoriteForMobile,
  type PublicStudioItem
} from "@/lib/publicDiscovery";

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

export default function DiscoverStudiosScreen() {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [studios, setStudios] = useState<PublicStudioItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function loadStudios() {
    setLoading(true);
    setErrorMessage(null);

    try {
      setStudios(await getPublicStudiosForMobile(userId));
    } catch {
      setErrorMessage("Studios are not available yet. Try again in a moment.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadStudios();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const filteredStudios = useMemo(() => {
    const search = normalize(query);
    if (!search) return studios;

    return studios.filter((studio) =>
      [studio.name, studio.description, studio.location, studio.city, studio.state].some((value) =>
        normalize(value).includes(search)
      )
    );
  }, [query, studios]);

  async function toggleFavorite(studio: PublicStudioItem) {
    setMessage(null);
    setErrorMessage(null);

    try {
      const favorited = await setPublicFavoriteForMobile({
        favorited: !studio.favorited,
        targetId: studio.id,
        targetType: "studio",
        userId
      });

      setStudios((current) =>
        current.map((item) => (item.id === studio.id ? { ...item, favorited } : item))
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sign in to save studios.");
    }
  }

  async function shareStudio(studio: PublicStudioItem) {
    await Share.share({
      message: `${studio.name} on DanceFlow: ${studio.webUrl}`,
      url: studio.webUrl
    });
  }

  return (
    <Screen>
      <View style={styles.hero}>
        <View style={styles.heroIcon}>
          <Ionicons color="#fff" name="business-outline" size={24} />
        </View>
        <View style={{ flex: 1 }}>
          <AppText variant="eyebrow">Studios</AppText>
          <AppText style={styles.heroTitle}>Find your dance home</AppText>
          <AppText style={styles.heroDetail}>
            Search public DanceFlow studios by name, city, and beginner-friendly profile details.
          </AppText>
        </View>
      </View>

      <TextInput
        autoCapitalize="none"
        onChangeText={setQuery}
        placeholder="Search studios, cities, or states"
        placeholderTextColor={colors.muted}
        style={styles.input}
        value={query}
      />

      {loading ? <FeatureCard title="Loading studios" detail="Finding public studio profiles." /> : null}
      {message ? <FeatureCard title="Studios" detail={message} /> : null}
      {errorMessage ? <FeatureCard title="Studios need attention" detail={errorMessage} /> : null}

      {filteredStudios.length ? (
        filteredStudios.map((studio) => (
          <View key={studio.id} style={styles.studioCard}>
            <View style={styles.cardTop}>
              <View style={{ flex: 1 }}>
                <AppText style={styles.studioTitle}>{studio.name}</AppText>
                <AppText variant="caption">{studio.location}</AppText>
              </View>
              {studio.beginnerFriendly ? (
                <View style={styles.badge}>
                  <AppText style={styles.badgeText}>Beginner friendly</AppText>
                </View>
              ) : null}
            </View>

            {studio.description ? (
              <AppText style={styles.description}>{studio.description}</AppText>
            ) : null}

            <View style={styles.actionRow}>
              <AppButton
                label={studio.favorited ? "Saved" : "Save"}
                onPress={() => toggleFavorite(studio)}
                variant="secondary"
              />
              <AppButton label="Open" onPress={() => Linking.openURL(studio.webUrl)} variant="secondary" />
              <Pressable onPress={() => shareStudio(studio)} style={styles.iconButton}>
                <Ionicons color={colors.primary} name="share-outline" size={20} />
              </Pressable>
            </View>
          </View>
        ))
      ) : !loading ? (
        <FeatureCard
          title="No studios found"
          detail="Try a broader search or check back as more studios publish public profiles."
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  actionRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  badge: {
    backgroundColor: "#fff4e7",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  badgeText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "900"
  },
  cardTop: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 12
  },
  description: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 20
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
  },
  iconButton: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderRadius: 14,
    height: 44,
    justifyContent: "center",
    width: 48
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 12
  },
  studioCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 20,
    borderWidth: 1,
    elevation: 2,
    gap: 12,
    padding: 16,
    shadowColor: colors.primaryDark,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.06,
    shadowRadius: 18
  },
  studioTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "900"
  }
});
