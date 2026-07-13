import type { User } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

export type StudentStudioLink = {
  linkId: string;
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
  status: string;
  relationshipType: string;
};

type LinkRow = {
  id: string;
  client_id: string;
  studio_id: string;
  status: string;
  relationship_type: string;
};

type ClientRow = {
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
        slug: string | null;
        name: string | null;
        public_name: string | null;
      }
    | {
        id: string;
        slug: string | null;
        name: string | null;
        public_name: string | null;
      }[]
    | null;
};

function firstJoin<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export async function getStudentStudioLinks(user: User) {
  const admin = createAdminClient();

  const { data: links, error: linksError } = await admin
    .from("client_account_links")
    .select("id, client_id, studio_id, status, relationship_type")
    .eq("user_id", user.id)
    .eq("status", "linked")
    .order("created_at", { ascending: true });

  if (linksError) {
    throw new Error(`Student studio-link lookup failed: ${linksError.message}`);
  }

  let typedLinks = (links ?? []) as LinkRow[];


  const clientIds = typedLinks.map((link) => link.client_id);
  if (!clientIds.length) return [];

  const { data: clients, error: clientsError } = await admin
    .from("clients")
    .select(`
      id,
      studio_id,
      first_name,
      last_name,
      email,
      phone,
      is_independent_instructor,
      studios (
        id,
        slug,
        name,
        public_name
      )
    `)
    .in("id", clientIds);

  if (clientsError) {
    throw new Error(`Student client lookup failed: ${clientsError.message}`);
  }

  const studioIds = typedLinks.map((link) => link.studio_id);
  const { data: settings, error: settingsError } = studioIds.length
    ? await admin
        .from("studio_settings")
        .select("studio_id, lumi_enabled")
        .in("studio_id", studioIds)
    : { data: [], error: null };

  if (settingsError) {
    throw new Error(`Student studio-settings lookup failed: ${settingsError.message}`);
  }

  const clientsById = new Map(
    ((clients ?? []) as ClientRow[]).map((client) => [client.id, client]),
  );
  const lumiByStudioId = new Map(
    (settings ?? []).map((item) => [
      String(item.studio_id),
      item.lumi_enabled === true,
    ]),
  );

  return typedLinks
    .map((link): StudentStudioLink | null => {
      const client = clientsById.get(link.client_id);
      const studio = firstJoin(client?.studios);
      if (!client || !studio?.id || !studio.slug) return null;

      return {
        linkId: link.id,
        clientId: client.id,
        studioId: studio.id,
        studioSlug: studio.slug,
        studioName: studio.name ?? "Studio",
        studioPublicName: studio.public_name,
        clientFirstName: client.first_name,
        clientLastName: client.last_name,
        clientEmail: client.email,
        clientPhone: client.phone,
        isIndependentInstructor: client.is_independent_instructor === true,
        lumiEnabled: lumiByStudioId.get(studio.id) === true,
        status: link.status,
        relationshipType: link.relationship_type,
      };
    })
    .filter((item): item is StudentStudioLink => Boolean(item));
}
