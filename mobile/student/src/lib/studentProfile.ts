import { danceflowApiFetch } from "@/lib/danceflowApi";
import { type LinkedStudioAccess } from "@/lib/studentAccess";

export type StudentProfile = {
  clientId: string;
  studioId: string;
  studioName: string;
  firstName: string;
  lastName: string;
  preferredName?: string;
  email: string;
  phone: string;
  birthday: string;
  photoUrl?: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  danceInterests: string;
  danceGoals?: string[];
  skillLevel?: string;
  bio?: string;
  profileVisibility?: "private" | "connected_studios" | "public";
  isAccountProfile?: boolean;
};

type AuthUserForProfile = {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
};

type ApiProfile = {
  userId: string;
  firstName: string;
  lastName: string;
  preferredName: string;
  email: string;
  phone: string;
  birthday: string;
  photoUrl: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  danceInterests: string;
  danceGoals: string[];
  skillLevel: string;
  bio: string;
  profileVisibility: "private" | "connected_studios" | "public";
};

function toStudentProfile(profile: ApiProfile): StudentProfile {
  return {
    clientId: "danceflow-account",
    studioId: "danceflow",
    studioName: "DanceFlow account",
    firstName: profile.firstName,
    lastName: profile.lastName,
    preferredName: profile.preferredName,
    email: profile.email,
    phone: profile.phone,
    birthday: profile.birthday,
    photoUrl: profile.photoUrl,
    addressLine1: profile.addressLine1,
    addressLine2: profile.addressLine2,
    city: profile.city,
    state: profile.state,
    postalCode: profile.postalCode,
    country: profile.country,
    danceInterests: profile.danceInterests,
    danceGoals: profile.danceGoals,
    skillLevel: profile.skillLevel,
    bio: profile.bio,
    profileVisibility: profile.profileVisibility,
    isAccountProfile: true,
  };
}

export async function loadStudentProfiles(
  _linkedStudios: LinkedStudioAccess[],
  _user: AuthUserForProfile,
): Promise<StudentProfile[]> {
  const result = await danceflowApiFetch<{ profile: ApiProfile }>(
    "/api/student/profile",
  );

  return [toStudentProfile(result.profile)];
}

export async function updateStudentProfile(profile: StudentProfile) {
  if (!profile.isAccountProfile) {
    throw new Error(
      "Studio-specific records are managed separately from your DanceFlow profile.",
    );
  }

  const result = await danceflowApiFetch<{ profile: ApiProfile }>(
    "/api/student/profile",
    {
      method: "PATCH",
      body: JSON.stringify({
        firstName: profile.firstName,
        lastName: profile.lastName,
        preferredName: profile.preferredName ?? "",
        phone: profile.phone,
        birthday: profile.birthday,
        photoUrl: profile.photoUrl ?? "",
        addressLine1: profile.addressLine1,
        addressLine2: profile.addressLine2,
        city: profile.city,
        state: profile.state,
        postalCode: profile.postalCode,
        country: profile.country,
        danceInterests: profile.danceInterests,
        danceGoals: profile.danceGoals ?? [],
        skillLevel: profile.skillLevel ?? "",
        bio: profile.bio ?? "",
        profileVisibility: profile.profileVisibility ?? "private",
      }),
    },
  );

  Object.assign(profile, toStudentProfile(result.profile));
}
