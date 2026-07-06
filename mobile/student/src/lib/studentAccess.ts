import { supabase } from "@/lib/supabase";

const DEFAULT_WEB_BASE_URL = "https://idanceflow.com";

function webBaseUrl() {
  const value = process.env.EXPO_PUBLIC_DANCEFLOW_WEB_URL ?? DEFAULT_WEB_BASE_URL;
  return value.replace(/\/$/, "");
}

export type LinkedStudioAccess = {
  clientId: string;
  studioId: string;
  studioSlug: string;
  studioName: string;
  studioPublicName: string | null;
  clientFirstName: string | null;
  clientLastName: string | null;
  clientEmail: string | null;
  clientPhone: string | null;
  isIndependentInstructor: boolean;
  lumiEnabled: boolean;
};

export function studentPassCode(access: Pick<LinkedStudioAccess, "clientId" | "studioId">) {
  return `danceflow-pass:${access.studioId}:${access.clientId}`;
}

export function studentPassQrImageUrl(access: Pick<LinkedStudioAccess, "clientId" | "studioId">) {
  return `${webBaseUrl()}/api/tickets/qr?code=${encodeURIComponent(studentPassCode(access))}`;
}

type ClientAccessRow = {
  id: string;
  studio_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  is_independent_instructor: boolean | null;
  studios:
    | {
        id: string;
        name: string | null;
        slug: string | null;
        public_name: string | null;
      }
    | {
        id: string;
        name: string | null;
        slug: string | null;
        public_name: string | null;
      }[]
    | null;
};

function firstJoin<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export async function getStudentAccess(userId: string) {
  const { data: clients, error } = await supabase
    .from("clients")
    .select(
      `
      id,
      studio_id,
      first_name,
      last_name,
      email,
      phone,
      is_independent_instructor,
      studios (
        id,
        name,
        slug,
        public_name
      )
    `
    )
    .eq("portal_user_id", userId)
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  const rows = (clients ?? []) as ClientAccessRow[];
  const studioIds = rows.map((row) => row.studio_id).filter(Boolean);

  const { data: settings, error: settingsError } = studioIds.length
    ? await supabase
        .from("studio_settings")
        .select("studio_id, lumi_enabled")
        .in("studio_id", studioIds)
    : { data: [], error: null };

  if (settingsError) {
    throw settingsError;
  }

  const lumiByStudioId = new Map(
    ((settings ?? []) as Array<{ studio_id: string; lumi_enabled: boolean | null }>).map(
      (item) => [item.studio_id, item.lumi_enabled === true]
    )
  );

  const linkedStudios: LinkedStudioAccess[] = rows
    .map((row) => {
      const studio = firstJoin(row.studios);

      if (!studio?.id || !studio.slug) {
        return null;
      }

      return {
        clientId: row.id,
        studioId: studio.id,
        studioSlug: studio.slug,
        studioName: studio.name ?? "Studio",
        studioPublicName: studio.public_name,
        clientFirstName: row.first_name,
        clientLastName: row.last_name,
        clientEmail: row.email,
        clientPhone: row.phone,
        isIndependentInstructor: row.is_independent_instructor === true,
        lumiEnabled: lumiByStudioId.get(studio.id) === true
      };
    })
    .filter((item): item is LinkedStudioAccess => Boolean(item));

  return {
    hasPortalAccess: linkedStudios.length > 0,
    linkedStudios,
    primaryStudio: linkedStudios[0] ?? null,
    lumiEnabled: linkedStudios.some((studio) => studio.lumiEnabled)
  };
}
