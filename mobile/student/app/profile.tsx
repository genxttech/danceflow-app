import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, TextInput, useColorScheme, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import {
  colors,
  colorsForScheme,
  getAppearanceMode,
  setAppearanceMode,
  type AppearanceMode
} from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess, type LinkedStudioAccess } from "@/lib/studentAccess";
import { loadStudentProfiles, updateStudentProfile, type StudentProfile } from "@/lib/studentProfile";

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType = "default",
  multiline = false,
  editable = true
}: {
  label: string;
  value: string;
  onChangeText?: (value: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "email-address" | "phone-pad";
  multiline?: boolean;
  editable?: boolean;
}) {
  return (
    <View style={styles.field}>
      <AppText variant="eyebrow">{label}</AppText>
      <TextInput
        editable={editable}
        keyboardType={keyboardType}
        multiline={multiline}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        style={[styles.input, multiline ? styles.multilineInput : null, !editable ? styles.disabledInput : null]}
        value={value}
      />
    </View>
  );
}

type RouterPushTarget = Parameters<ReturnType<typeof useRouter>["push"]>[0];

const appearanceOptions: Array<{ label: string; value: AppearanceMode }> = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" }
];

export default function ProfileScreen() {
  const { session, signOut } = useAuth();
  const router = useRouter();
  const themeColors = colorsForScheme(useColorScheme());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [linkedStudios, setLinkedStudios] = useState<LinkedStudioAccess[]>([]);
  const [profiles, setProfiles] = useState<StudentProfile[]>([]);
  const [appearanceMode, setAppearanceModeState] = useState<AppearanceMode>("system");
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const selectedProfile = useMemo(
    () => profiles.find((item) => item.isAccountProfile) ?? profiles[0] ?? null,
    [profiles]
  );

  function updateSelected(updater: (profile: StudentProfile) => StudentProfile) {
    if (!selectedProfile) return;
    const nextProfile = updater(selectedProfile);
    setProfiles((current) => current.map((item) => (item.clientId === nextProfile.clientId ? nextProfile : item)));
  }

  async function loadProfile() {
    const user = session?.user;

    if (!user) {
      setLinkedStudios([]);
      setProfiles([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setMessage(null);
    setErrorMessage(null);

    try {
      const access = await getStudentAccess(user.id);
      setLinkedStudios(access.linkedStudios);

      const nextProfiles = await loadStudentProfiles(access.linkedStudios, user);
      setProfiles(nextProfiles);
    } catch {
      setErrorMessage("We could not load your profile yet. Try again in a moment.");
    } finally {
      setLoading(false);
    }
  }

  async function saveProfile() {
    if (!selectedProfile) return;

    setSaving(true);
    setMessage(null);
    setErrorMessage(null);

    try {
      await updateStudentProfile(selectedProfile);
      setMessage("Profile updated.");
    } catch {
      setErrorMessage("We could not save your changes yet. Try again in a moment.");
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id]);

  useEffect(() => {
    getAppearanceMode().then(setAppearanceModeState);
  }, []);

  async function chooseAppearanceMode(mode: AppearanceMode) {
    setAppearanceModeState(mode);
    await setAppearanceMode(mode);
  }

  const isLinkedStudent = linkedStudios.length > 0;

  return (
    <Screen>
      <AppText variant="eyebrow">Profile</AppText>
      <AppText variant="title">My DanceFlow profile</AppText>
      <AppText variant="caption">
        Complete your information so studios can recognize you when you register, request lessons, or connect later.
      </AppText>

      {loading ? <FeatureCard title="Loading your profile..." detail="Loading your profile." /> : null}

      {!loading && errorMessage ? <FeatureCard title="Profile not available yet" detail={errorMessage} /> : null}
      {!loading && message ? <FeatureCard title="Saved" detail={message} /> : null}

      {!loading && !session ? (
        <FeatureCard
          title="Continue with email"
          detail="Create or access your free DanceFlow account to save a profile."
        />
      ) : null}

      {!loading && session && !isLinkedStudent ? (
        <FeatureCard
          title="Dancer account"
          detail="You can complete your DanceFlow profile now. Studio-specific schedule, packages, and progress appear after a studio connects your account."
        />
      ) : null}

      {!loading && session ? (
        <Pressable
          onPress={() => router.push("/partners" as unknown as RouterPushTarget)}
          style={({ pressed }) => [styles.partnerCard, pressed && styles.cardPressed]}
        >
          <View style={styles.partnerIcon}>
            <Ionicons color="#fff" name="people-outline" size={22} />
          </View>
          <View style={{ flex: 1 }}>
            <AppText style={styles.partnerTitle}>Partner Search profile</AppText>
            <AppText style={styles.partnerDetail}>
              Create a dancer-owned listing for practice, social dance, showcase, or competition partners. Contact stays inside DanceFlow.
            </AppText>
          </View>
        </Pressable>
      ) : null}

      {!loading && session ? (
        <View style={styles.appearanceCard}>
          <View style={{ flex: 1 }}>
            <AppText variant="eyebrow">Appearance</AppText>
            <AppText variant="subtitle">App theme</AppText>
            <AppText variant="caption">
              Choose a lighter DanceFlow look, keep the dark look, or follow your phone setting.
            </AppText>
          </View>
          <View style={styles.appearanceOptions}>
            {appearanceOptions.map((option) => {
              const active = option.value === appearanceMode;
              return (
                <Pressable
                  key={option.value}
                  onPress={() => chooseAppearanceMode(option.value)}
                  style={[
                    styles.appearancePill,
                    { backgroundColor: themeColors.surfaceAlt, borderColor: themeColors.border },
                    active && { backgroundColor: themeColors.primary, borderColor: themeColors.primary }
                  ]}
                >
                  <AppText style={[styles.appearancePillText, { color: active ? "#fff" : themeColors.text }]}>
                    {option.label}
                  </AppText>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      {!loading && selectedProfile ? (
        <View style={styles.form}>
          <FeatureCard
            title="DanceFlow account"
            detail="This is your main DanceFlow profile. Studio-specific lesson, package, and membership records stay with each connected studio."
          />

          <View style={styles.row}>
            <Field
              label="First name"
              onChangeText={(value) => updateSelected((profile) => ({ ...profile, firstName: value }))}
              value={selectedProfile.firstName}
            />
            <Field
              label="Last name"
              onChangeText={(value) => updateSelected((profile) => ({ ...profile, lastName: value }))}
              value={selectedProfile.lastName}
            />
          </View>

          <Field
            label="Preferred name"
            onChangeText={(value) => updateSelected((profile) => ({ ...profile, preferredName: value }))}
            placeholder="What should DanceFlow call you?"
            value={selectedProfile.preferredName ?? ""}
          />

          <Field label="Email" editable={false} keyboardType="email-address" value={selectedProfile.email} />
          <Field
            label="Phone"
            keyboardType="phone-pad"
            onChangeText={(value) => updateSelected((profile) => ({ ...profile, phone: value }))}
            placeholder="Phone number"
            value={selectedProfile.phone}
          />
          <Field
            label="Birthday"
            onChangeText={(value) => updateSelected((profile) => ({ ...profile, birthday: value }))}
            placeholder="YYYY-MM-DD"
            value={selectedProfile.birthday}
          />

          <Field
            label="Address line 1"
            onChangeText={(value) => updateSelected((profile) => ({ ...profile, addressLine1: value }))}
            value={selectedProfile.addressLine1}
          />
          <Field
            label="Address line 2"
            onChangeText={(value) => updateSelected((profile) => ({ ...profile, addressLine2: value }))}
            value={selectedProfile.addressLine2}
          />

          <View style={styles.row}>
            <Field
              label="City"
              onChangeText={(value) => updateSelected((profile) => ({ ...profile, city: value }))}
              value={selectedProfile.city}
            />
            <Field
              label="State"
              onChangeText={(value) => updateSelected((profile) => ({ ...profile, state: value }))}
              value={selectedProfile.state}
            />
          </View>

          <View style={styles.row}>
            <Field
              label="ZIP"
              onChangeText={(value) => updateSelected((profile) => ({ ...profile, postalCode: value }))}
              value={selectedProfile.postalCode}
            />
            <Field
              label="Country"
              onChangeText={(value) => updateSelected((profile) => ({ ...profile, country: value }))}
              value={selectedProfile.country}
            />
          </View>

          <Field
            label="Dance interests"
            multiline
            onChangeText={(value) => updateSelected((profile) => ({ ...profile, danceInterests: value }))}
            placeholder="Country, ballroom, showcases, competitions, social dancing..."
            value={selectedProfile.danceInterests}
          />

          <Field
            label="Dance goals"
            multiline
            onChangeText={(value) =>
              updateSelected((profile) => ({
                ...profile,
                danceGoals: value.split(",").map((item) => item.trim()).filter(Boolean)
              }))
            }
            placeholder="Social dancing, confidence, competition..."
            value={(selectedProfile.danceGoals ?? []).join(", ")}
          />

          <Field
            label="Skill level"
            onChangeText={(value) => updateSelected((profile) => ({ ...profile, skillLevel: value }))}
            placeholder="beginner, intermediate, competitive..."
            value={selectedProfile.skillLevel ?? ""}
          />

          <Field
            label="About my dance journey"
            multiline
            onChangeText={(value) => updateSelected((profile) => ({ ...profile, bio: value }))}
            placeholder="Share what you are learning and where you want to go."
            value={selectedProfile.bio ?? ""}
          />

          <FeatureCard
            title="Profile ownership"
            detail="This is your dancer-owned DanceFlow profile. Each connected studio keeps a separate record for billing, attendance, packages, notes, and studio communication."
          />

          <AppButton label={saving ? "Saving..." : "Save profile"} onPress={saveProfile} />
          <AppButton label="Refresh profile" onPress={loadProfile} variant="secondary" />

          <AppButton label="Sign out" onPress={signOut} variant="secondary" />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  appearanceCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 20,
    borderWidth: 1,
    gap: 12,
    padding: 16
  },
  appearanceOptions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  appearancePill: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  appearancePillText: {
    fontSize: 13,
    fontWeight: "900"
  },
  disabledInput: {
    opacity: 0.65
  },
  field: {
    flex: 1,
    gap: 6
  },
  form: {
    gap: 14
  },
  cardPressed: {
    opacity: 0.78
  },
  input: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  multilineInput: {
    minHeight: 92,
    textAlignVertical: "top"
  },
  row: {
    flexDirection: "row",
    gap: 12
  },
  partnerCard: {
    alignItems: "center",
    backgroundColor: colors.primaryDark,
    borderRadius: 20,
    flexDirection: "row",
    gap: 12,
    padding: 16
  },
  partnerDetail: {
    color: "rgba(255,255,255,0.78)",
    fontSize: 13,
    lineHeight: 19
  },
  partnerIcon: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.16)",
    borderRadius: 999,
    height: 42,
    justifyContent: "center",
    width: 42
  },
  partnerTitle: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "900",
    marginBottom: 4
  }
});
