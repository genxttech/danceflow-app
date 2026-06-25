import { useEffect, useMemo, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
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

function studioOptions(linkedStudios: LinkedStudioAccess[]) {
  return linkedStudios.map((studio) => ({
    clientId: studio.clientId,
    label: studio.studioPublicName || studio.studioName
  }));
}

export default function ProfileScreen() {
  const { session } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [linkedStudios, setLinkedStudios] = useState<LinkedStudioAccess[]>([]);
  const [profiles, setProfiles] = useState<StudentProfile[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const selectedProfile = useMemo(
    () => profiles.find((item) => item.clientId === selectedClientId) ?? profiles[0] ?? null,
    [profiles, selectedClientId]
  );

  function updateSelected(updater: (profile: StudentProfile) => StudentProfile) {
    if (!selectedProfile) return;
    const nextProfile = updater(selectedProfile);
    setProfiles((current) => current.map((item) => (item.clientId === nextProfile.clientId ? nextProfile : item)));
  }

  async function loadProfile() {
    const userId = session?.user.id;

    if (!userId) {
      setLinkedStudios([]);
      setProfiles([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setMessage(null);
    setErrorMessage(null);

    try {
      const access = await getStudentAccess(userId);
      setLinkedStudios(access.linkedStudios);

      if (!access.hasPortalAccess) {
        setProfiles([]);
        return;
      }

      const nextProfiles = await loadStudentProfiles(access.linkedStudios);
      setProfiles(nextProfiles);
      setSelectedClientId(nextProfiles[0]?.clientId ?? null);
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
      setErrorMessage("We could not save your changes yet. Try again or contact your studio.");
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id]);

  const options = studioOptions(linkedStudios);

  return (
    <Screen>
      <AppText variant="eyebrow">Profile</AppText>
      <AppText variant="title">My information</AppText>
      <AppText variant="caption">Keep your studio contact information and dance interests up to date.</AppText>

      {loading ? <FeatureCard title="Loading your profile..." detail="Loading your profile." /> : null}

      {!loading && errorMessage ? <FeatureCard title="Profile not available yet" detail={errorMessage} /> : null}
      {!loading && message ? <FeatureCard title="Saved" detail={message} /> : null}

      {!loading && !linkedStudios.length ? (
        <FeatureCard
          title="Connect with your studio"
          detail="Your studio needs to connect your DanceFlow account before you can manage your student profile in the app."
        />
      ) : null}

      {!loading && selectedProfile ? (
        <View style={styles.form}>
          {options.length > 1 ? (
            <View style={styles.studioList}>
              {options.map((option) => {
                const active = option.clientId === selectedProfile.clientId;
                return (
                  <AppButton
                    key={option.clientId}
                    label={option.label}
                    onPress={() => setSelectedClientId(option.clientId)}
                    variant={active ? "primary" : "secondary"}
                  />
                );
              })}
            </View>
          ) : null}

          <FeatureCard
            title={selectedProfile.studioName}
            detail="Updates are shared with this studio. Email changes may need to be handled from your web account."
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

          <AppButton label={saving ? "Saving..." : "Save profile"} onPress={saveProfile} />
          <AppButton label="Refresh profile" onPress={loadProfile} variant="secondary" />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
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
  studioList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  }
});
