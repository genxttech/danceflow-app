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

function clean(value: string | null | undefined) {
  return value ?? "";
}

export async function loadStudentProfiles(linkedStudios: LinkedStudioAccess[]): Promise<StudentProfile[]> {
  const clientIds = linkedStudios.map((item) => item.clientId).filter(Boolean);

  if (!clientIds.length) return [];

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

  return ((data ?? []) as ClientProfileRow[]).map((row) => ({
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
    danceInterests: clean(row.dance_interests)
  }));
}

export async function updateStudentProfile(profile: StudentProfile) {
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
