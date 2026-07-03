import { createClient } from "@/lib/supabase/server";

export type StudioJobPosting = {
  id: string;
  studioId: string;
  studioName: string;
  studioSlug: string | null;
  title: string;
  roleType: string;
  employmentType: string;
  locationType: string;
  city: string | null;
  state: string | null;
  location: string;
  latitude: number | null;
  longitude: number | null;
  compensationSummary: string | null;
  danceStyles: string[];
  requirements: string | null;
  description: string | null;
  applyUrl: string | null;
  applyEmail: string | null;
  applyPhone: string | null;
  contactName: string | null;
  publishedAt: string | null;
};

type StudioJobPostingRow = {
  id: string;
  studio_id: string;
  title: string;
  role_type: string;
  employment_type: string;
  location_type: string;
  city: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  compensation_summary: string | null;
  dance_styles: string[] | null;
  requirements: string | null;
  description: string | null;
  apply_url: string | null;
  apply_email: string | null;
  apply_phone: string | null;
  contact_name: string | null;
  published_at: string | null;
  studios:
    | {
        slug: string | null;
        public_name: string | null;
        name: string;
      }
    | {
        slug: string | null;
        public_name: string | null;
        name: string;
      }[]
    | null;
};

function firstJoin<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function locationLabel(value: {
  city?: string | null;
  state?: string | null;
  locationType?: string | null;
}) {
  const cityState = [value.city, value.state].filter(Boolean).join(", ");
  if (value.locationType === "remote") return "Remote";
  if (value.locationType === "hybrid" && cityState) return `Hybrid · ${cityState}`;
  return cityState || "Location coming soon";
}

function normalizeLabel(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function formatJobRole(value: string) {
  if (value === "front_desk") return "Front Desk";
  if (value === "event_staff") return "Event Staff";
  return normalizeLabel(value);
}

export function formatEmploymentType(value: string) {
  if (value === "part_time") return "Part Time";
  if (value === "full_time") return "Full Time";
  return normalizeLabel(value);
}

export type JobPostingFilters = {
  employmentType?: string;
  latitude?: number | null;
  locationType?: string;
  longitude?: number | null;
  query?: string;
  radiusMiles?: number;
  roleType?: string;
  style?: string;
};

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function milesBetween(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
) {
  const earthRadiusMiles = 3958.8;
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const deltaLat = toRadians(b.latitude - a.latitude);
  const deltaLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earthRadiusMiles * Math.asin(Math.sqrt(h));
}

export async function getPublishedStudioJobPostings(filters: JobPostingFilters = {}) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("studio_job_postings")
    .select(
      `
      id,
      studio_id,
      title,
      role_type,
      employment_type,
      location_type,
      city,
      state,
      latitude,
      longitude,
      compensation_summary,
      dance_styles,
      requirements,
      description,
      apply_url,
      apply_email,
      apply_phone,
      contact_name,
      published_at,
      studios (
        slug,
        public_name,
        name
      )
    `,
    )
    .eq("status", "published")
    .or(`expires_at.is.null,expires_at.gte.${new Date().toISOString()}`)
    .order("published_at", { ascending: false })
    .limit(100);

  if (error) {
    throw new Error(`Failed to load job postings: ${error.message}`);
  }

  const postings = ((data ?? []) as StudioJobPostingRow[]).map<StudioJobPosting>((row) => {
    const studio = firstJoin(row.studios);

    return {
      id: row.id,
      studioId: row.studio_id,
      studioName: studio?.public_name?.trim() || studio?.name || "Dance studio",
      studioSlug: studio?.slug ?? null,
      title: row.title,
      roleType: row.role_type,
      employmentType: row.employment_type,
      locationType: row.location_type,
      city: row.city,
      state: row.state,
      latitude: row.latitude,
      longitude: row.longitude,
      location: locationLabel({
        city: row.city,
        state: row.state,
        locationType: row.location_type,
      }),
      compensationSummary: row.compensation_summary,
      danceStyles: row.dance_styles ?? [],
      requirements: row.requirements,
      description: row.description,
      applyUrl: row.apply_url,
      applyEmail: row.apply_email,
      applyPhone: row.apply_phone,
      contactName: row.contact_name,
      publishedAt: row.published_at,
    };
  });

  return postings.filter((posting) => {
    const search = normalize(filters.query);
    const matchesSearch =
      !search ||
      [
        posting.title,
        posting.studioName,
        posting.location,
        posting.roleType,
        posting.employmentType,
        posting.locationType,
        posting.description,
        posting.requirements,
        ...posting.danceStyles,
      ].some((value) => normalize(value).includes(search));

    const matchesDistance =
      filters.latitude === undefined ||
      filters.latitude === null ||
      filters.longitude === undefined ||
      filters.longitude === null ||
      (posting.latitude !== null &&
        posting.longitude !== null &&
        milesBetween(
          { latitude: filters.latitude, longitude: filters.longitude },
          { latitude: posting.latitude, longitude: posting.longitude },
        ) <= (filters.radiusMiles ?? 50));

    return (
      matchesSearch &&
      (!filters.roleType || posting.roleType === filters.roleType) &&
      (!filters.employmentType || posting.employmentType === filters.employmentType) &&
      (!filters.locationType || posting.locationType === filters.locationType) &&
      (!filters.style || posting.danceStyles.includes(filters.style)) &&
      matchesDistance
    );
  });
}
