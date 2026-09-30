import { createAdminClient } from "@/lib/supabase/admin";
import { resolveClientSenderDisplayName } from "@/lib/notifications/senderIdentity";

export type EventEmailBranding = {
  /** Brand shown in the email: the organizer for organizer events, otherwise the studio. */
  name: string;
  logoUrl: string | null;
  /** PAY-DC-3: which brand `name` is, plus both names for the merchant line. */
  kind: "studio" | "organizer";
  studioName: string;
  organizerName: string | null;
  /** PAY-DC-3 (D-G): the client sender display name, resolved here at queue time. */
  senderDisplayName: string | null;
};

type EventBrandingRow = {
  studio_id: string;
  organizer_id: string | null;
};

type StudioBrandingRow = {
  name: string;
  public_name: string | null;
  public_logo_url: string | null;
};

type OrganizerBrandingRow = {
  name: string;
};

export async function resolveEventEmailBranding(params: {
  eventId?: string | null;
  studioId: string;
  organizerId?: string | null;
}): Promise<EventEmailBranding> {
  const admin = createAdminClient();

  let studioId = params.studioId;
  let organizerId = params.organizerId ?? null;

  if (params.eventId) {
    const { data: event } = await admin
      .from("events")
      .select("studio_id, organizer_id")
      .eq("id", params.eventId)
      .maybeSingle<EventBrandingRow>();

    if (event) {
      studioId = event.studio_id || studioId;
      organizerId = event.organizer_id ?? organizerId;
    }
  }

  const [{ data: studio }, organizerResult] = await Promise.all([
    admin
      .from("studios")
      .select("name, public_name, public_logo_url")
      .eq("id", studioId)
      .maybeSingle<StudioBrandingRow>(),
    organizerId
      ? admin
          .from("organizers")
          .select("name")
          .eq("id", organizerId)
          .maybeSingle<OrganizerBrandingRow>()
      : Promise.resolve({ data: null }),
  ]);

  const studioName =
    studio?.public_name?.trim() || studio?.name?.trim() || "DanceFlow Studio";
  const organizerName = organizerResult.data?.name?.trim() || null;

  return {
    name: organizerName || studioName,
    logoUrl: studio?.public_logo_url ?? null,
    kind: organizerName ? "organizer" : "studio",
    studioName,
    organizerName,
    senderDisplayName: resolveClientSenderDisplayName({ organizerName, studio }),
  };
}
