import { supabase } from "@/lib/supabase";
import { type LinkedStudioAccess } from "@/lib/studentAccess";

export type StudentProfile = {
  clientId: string;
  studioId: string;
  studioName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  birthday: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  danceInterests: string;
  isAccountProfile?: boolean;
};

type AuthUserForProfile = {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
};

type ClientProfileRow = {
  id: string;
  studio_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  birthday: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  dance_interests: string | null;
};

function studioNameFor(studioId: string, linkedStudios: LinkedStudioAccess[]) {
  const studio = linkedStudios.find((item) => item.studioId === studioId);
  return studio?.studioPublicName || studio?.studioName || "Studio";
}

function clean(value: unknown) {
  return typeof value === "string" ? value : "";
}

function accountProfileFor(user: AuthUserForProfile): StudentProfile {
  const metadata = user.user_metadata ?? {};

  return {
    clientId: "danceflow-account",
    studioId: "danceflow",
    studioName: "DanceFlow account",
    firstName: clean(metadata.first_name ?? metadata.firstName),
    lastName: clean(metadata.last_name ?? metadata.lastName),
    email: user.email ?? clean(metadata.email),
    phone: clean(metadata.phone),
    birthday: clean(metadata.birthday),
    addressLine1: clean(metadata.address_line1 ?? metadata.addressLine1),
    addressLine2: clean(metadata.address_line2 ?? metadata.addressLine2),
    city: clean(metadata.city),
    state: clean(metadata.state),
    postalCode: clean(metadata.postal_code ?? metadata.postalCode),
    country: clean(metadata.country),
    danceInterests: clean(metadata.dance_interests ?? metadata.danceInterests),
    isAccountProfile: true
  };
}

export async function loadStudentProfiles(
  linkedStudios: LinkedStudioAccess[],
  user: AuthUserForProfile
): Promise<StudentProfile[]> {
  const accountProfile = accountProfileFor(user);
  const clientIds = linkedStudios.map((item) => item.clientId).filter(Boolean);

  if (!clientIds.length) return [accountProfile];

  const { data, error } = await supabase
    .from("clients")
    .select(
      `
      id,
      studio_id,
      first_name,
      last_name,
      email,
      phone,
      birthday,
      address_line1,
      address_line2,
      city,
      state,
      postal_code,
      country,
      dance_interests
    `
    )
    .in("id", clientIds)
    .order("created_at", { ascending: true });

  if (error) throw error;

  const studioProfiles = ((data ?? []) as ClientProfileRow[]).map((row) => ({
    clientId: row.id,
    studioId: row.studio_id,
    studioName: studioNameFor(row.studio_id, linkedStudios),
    firstName: clean(row.first_name),
    lastName: clean(row.last_name),
    email: clean(row.email),
    phone: clean(row.phone),
    birthday: clean(row.birthday),
    addressLine1: clean(row.address_line1),
    addressLine2: clean(row.address_line2),
    city: clean(row.city),
    state: clean(row.state),
    postalCode: clean(row.postal_code),
    country: clean(row.country),
    danceInterests: clean(row.dance_interests),
    isAccountProfile: false
  }));

  return [accountProfile, ...studioProfiles];
}

export async function updateStudentProfile(profile: StudentProfile) {
  if (profile.isAccountProfile) {
    const { error } = await supabase.auth.updateUser({
      data: {
        first_name: profile.firstName.trim() || null,
        last_name: profile.lastName.trim() || null,
        phone: profile.phone.trim() || null,
        birthday: profile.birthday.trim() || null,
        address_line1: profile.addressLine1.trim() || null,
        address_line2: profile.addressLine2.trim() || null,
        city: profile.city.trim() || null,
        state: profile.state.trim() || null,
        postal_code: profile.postalCode.trim() || null,
        country: profile.country.trim() || null,
        dance_interests: profile.danceInterests.trim() || null
      }
    });

    if (error) throw error;
    return;
  }

  const { error } = await supabase
    .from("clients")
    .update({
      first_name: profile.firstName.trim() || null,
      last_name: profile.lastName.trim() || null,
      phone: profile.phone.trim() || null,
      birthday: profile.birthday.trim() || null,
      address_line1: profile.addressLine1.trim() || null,
      address_line2: profile.addressLine2.trim() || null,
      city: profile.city.trim() || null,
      state: profile.state.trim() || null,
      postal_code: profile.postalCode.trim() || null,
      country: profile.country.trim() || null,
      dance_interests: profile.danceInterests.trim() || null
    })
    .eq("id", profile.clientId);

  if (error) throw error;
}
