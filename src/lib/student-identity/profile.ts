import type { User } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

export type DancerProfileRecord = {
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

export type DancerProfileUpdate = Omit<DancerProfileRecord, "userId" | "email">;

const PROFILE_VISIBILITY = new Set(["private", "connected_studios", "public"]);
const SKILL_LEVELS = new Set([
  "",
  "newcomer",
  "beginner",
  "social",
  "intermediate",
  "advanced",
  "competitive",
  "professional",
]);

function clean(value: unknown, max: number) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max)
    : "";
}

function cleanList(value: unknown, maxItems = 40, maxLength = 120) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.map((item) => clean(item, maxLength)).filter(Boolean)),
  ).slice(0, maxItems);
}

function metadataValue(user: User, ...keys: string[]) {
  for (const key of keys) {
    const value = user.user_metadata?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function normalizeDancerProfileUpdate(value: unknown): DancerProfileUpdate {
  const input = (value ?? {}) as Record<string, unknown>;
  const profileVisibility = clean(input.profileVisibility, 40);
  const skillLevel = clean(input.skillLevel, 40);

  if (!PROFILE_VISIBILITY.has(profileVisibility || "private")) {
    throw new Error("Choose a valid profile visibility.");
  }

  if (!SKILL_LEVELS.has(skillLevel)) {
    throw new Error("Choose a valid skill level.");
  }

  const birthday = clean(input.birthday, 10);
  if (birthday && !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) {
    throw new Error("Enter a valid birthday.");
  }

  return {
    firstName: clean(input.firstName, 80),
    lastName: clean(input.lastName, 80),
    preferredName: clean(input.preferredName, 80),
    phone: clean(input.phone, 30),
    birthday,
    photoUrl: clean(input.photoUrl, 1000),
    addressLine1: clean(input.addressLine1, 160),
    addressLine2: clean(input.addressLine2, 160),
    city: clean(input.city, 80),
    state: clean(input.state, 80),
    postalCode: clean(input.postalCode, 20),
    country: clean(input.country, 80),
    danceInterests: clean(input.danceInterests, 1000),
    danceGoals: cleanList(input.danceGoals),
    skillLevel,
    bio: clean(input.bio, 2000),
    profileVisibility:
      (profileVisibility || "private") as DancerProfileUpdate["profileVisibility"],
  };
}

export async function ensureDancerProfile(user: User) {
  const admin = createAdminClient();
  const fullName = metadataValue(user, "full_name", "name");
  const nameParts = fullName.split(/\s+/).filter(Boolean);

  const payload = {
    user_id: user.id,
    first_name:
      metadataValue(user, "first_name", "firstName") || nameParts[0] || null,
    last_name:
      metadataValue(user, "last_name", "lastName") ||
      (nameParts.length > 1 ? nameParts.slice(1).join(" ") : null),
    preferred_name: metadataValue(user, "preferred_name") || null,
    phone: metadataValue(user, "phone") || null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await admin
    .from("dancer_profiles")
    .upsert(payload, { onConflict: "user_id", ignoreDuplicates: true })
    .select("*")
    .single();

  if (error) throw new Error(`Dancer profile initialization failed: ${error.message}`);
  return data;
}

export async function getDancerProfile(user: User): Promise<DancerProfileRecord> {
  const admin = createAdminClient();
  let { data, error } = await admin
    .from("dancer_profiles")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) throw new Error(`Dancer profile lookup failed: ${error.message}`);
  if (!data) data = await ensureDancerProfile(user);

  return {
    userId: user.id,
    firstName: data.first_name ?? "",
    lastName: data.last_name ?? "",
    preferredName: data.preferred_name ?? "",
    email: user.email ?? "",
    phone: data.phone ?? "",
    birthday: data.birthday ?? "",
    photoUrl: data.photo_url ?? "",
    addressLine1: data.address_line1 ?? "",
    addressLine2: data.address_line2 ?? "",
    city: data.city ?? "",
    state: data.state ?? "",
    postalCode: data.postal_code ?? "",
    country: data.country ?? "",
    danceInterests: data.dance_interests ?? "",
    danceGoals: Array.isArray(data.dance_goals) ? data.dance_goals : [],
    skillLevel: data.skill_level ?? "",
    bio: data.bio ?? "",
    profileVisibility: data.profile_visibility ?? "private",
  };
}

export async function updateDancerProfile(user: User, input: DancerProfileUpdate) {
  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { error } = await admin.from("dancer_profiles").upsert(
    {
      user_id: user.id,
      first_name: input.firstName || null,
      last_name: input.lastName || null,
      preferred_name: input.preferredName || null,
      phone: input.phone || null,
      birthday: input.birthday || null,
      photo_url: input.photoUrl || null,
      address_line1: input.addressLine1 || null,
      address_line2: input.addressLine2 || null,
      city: input.city || null,
      state: input.state || null,
      postal_code: input.postalCode || null,
      country: input.country || null,
      dance_interests: input.danceInterests || null,
      dance_goals: input.danceGoals,
      skill_level: input.skillLevel || null,
      bio: input.bio || null,
      profile_visibility: input.profileVisibility,
      updated_at: now,
    },
    { onConflict: "user_id" },
  );

  if (error) throw new Error(`Dancer profile update failed: ${error.message}`);

  // Keep existing account display-name consumers working during migration.
  const { error: authError } = await admin.auth.admin.updateUserById(user.id, {
    user_metadata: {
      ...user.user_metadata,
      first_name: input.firstName || null,
      last_name: input.lastName || null,
      preferred_name: input.preferredName || null,
    },
  });

  if (authError) {
    throw new Error(`Account display-name sync failed: ${authError.message}`);
  }

  return getDancerProfile({ ...user, user_metadata: {
    ...user.user_metadata,
    first_name: input.firstName,
    last_name: input.lastName,
    preferred_name: input.preferredName,
  }} as User);
}
