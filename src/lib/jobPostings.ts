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
  compensationSummary: string | null;
  danceStyles: string[];
  requirements: string | null;
  description: string | null;
  applyUrl: string | null;
  applyEmail: string | null;
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
  compensation_summary: string | null;
  dance_styles: string[] | null;
  requirements: string | null;
  description: string | null;
  apply_url: string | null;
  apply_email: string | null;
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

export async function getPublishedStudioJobPostings() {
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
      compensation_summary,
      dance_styles,
      requirements,
      description,
      apply_url,
      apply_email,
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

  return ((data ?? []) as StudioJobPostingRow[]).map<StudioJobPosting>((row) => {
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
      contactName: row.contact_name,
      publishedAt: row.published_at,
    };
  });
}
