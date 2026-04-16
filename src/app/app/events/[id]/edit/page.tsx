import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import EventForm from "../../EventForm";

type Params = Promise<{
  id: string;
}>;

type OrganizerOption = {
  id: string;
  name: string;
  active: boolean;
};

type EventRow = {
  id: string;
  organizer_id: string;
  name: string;
  slug: string;
  event_type: string;
  short_description: string | null;
  description: string | null;
  public_summary: string | null;
  public_description: string | null;
  venue_name: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  timezone: string;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  cover_image_url: string | null;
  public_cover_image_url: string | null;
  visibility: string;
  status: string;
  featured: boolean;
  beginner_friendly: boolean;
  public_directory_enabled: boolean;
  registration_required: boolean;
  account_required_for_registration: boolean;
  registration_opens_at: string | null;
  registration_closes_at: string | null;
  capacity: number | null;
  waitlist_enabled: boolean;
  refund_policy: string | null;
  faq: string | null;
};

type EventTagRow = {
  id: string;
  tag: string;
};

type EventStyleRow = {
  style_key: string;
};

function toDatetimeLocal(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const yyyy = date.getFullYear();
  const mm = `${date.getMonth() + 1}`.padStart(2, "0");
  const dd = `${date.getDate()}`.padStart(2, "0");
  const hh = `${date.getHours()}`.padStart(2, "0");
  const mi = `${date.getMinutes()}`.padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

export default async function EditEventPage({
  params,
}: {
  params: Params;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  const [
    { data: event, error: eventError },
    { data: organizers, error: organizersError },
    { data: tags, error: tagsError },
    { data: eventStyles, error: eventStylesError },
  ] = await Promise.all([
    supabase
      .from("events")
      .select(`
        id,
        organizer_id,
        name,
        slug,
        event_type,
        short_description,
        description,
        public_summary,
        public_description,
        venue_name,
        address_line_1,
        address_line_2,
        city,
        state,
        postal_code,
        timezone,
        start_date,
        end_date,
        start_time,
        end_time,
        cover_image_url,
        public_cover_image_url,
        visibility,
        status,
        featured,
        beginner_friendly,
        public_directory_enabled,
        registration_required,
        account_required_for_registration,
        registration_opens_at,
        registration_closes_at,
        capacity,
        waitlist_enabled,
        refund_policy,
        faq
      `)
      .eq("id", id)
      .eq("studio_id", studioId)
      .single(),

    supabase
      .from("organizers")
      .select("id, name, active")
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("name", { ascending: true }),

    supabase
      .from("event_tags")
      .select("id, tag")
      .eq("event_id", id)
      .order("tag", { ascending: true }),

    supabase
      .from("event_public_styles")
      .select("style_key")
      .eq("event_id", id),
  ]);

  if (eventError || !event) {
    notFound();
  }

  if (organizersError) {
    throw new Error(`Failed to load organizers: ${organizersError.message}`);
  }

  if (tagsError) {
    throw new Error(`Failed to load event tags: ${tagsError.message}`);
  }

  if (eventStylesError) {
    throw new Error(`Failed to load event styles: ${eventStylesError.message}`);
  }

  const typedEvent = event as EventRow;
  const typedOrganizers = (organizers ?? []) as OrganizerOption[];
  const typedTags = (tags ?? []) as EventTagRow[];
  const typedEventStyles = (eventStyles ?? []) as EventStyleRow[];
  const selectedStyleKeys = typedEventStyles.map((row) => row.style_key);

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight">Edit Event</h2>
          <p className="mt-2 text-slate-600">
            Update event details, status, public content, and discovery metadata.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Link
            href={`/app/events/${typedEvent.id}`}
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Back to Event
          </Link>
        </div>
      </div>

      <EventForm
        organizers={typedOrganizers}
        mode="edit"
        initialValues={{
          id: typedEvent.id,
          organizerId: typedEvent.organizer_id,
          name: typedEvent.name,
          slug: typedEvent.slug,
          eventType: typedEvent.event_type,
          shortDescription:
            typedEvent.public_summary ?? typedEvent.short_description ?? "",
          description:
            typedEvent.public_description ?? typedEvent.description ?? "",
          venueName: typedEvent.venue_name ?? "",
          addressLine1: typedEvent.address_line_1 ?? "",
          addressLine2: typedEvent.address_line_2 ?? "",
          city: typedEvent.city ?? "",
          state: typedEvent.state ?? "",
          postalCode: typedEvent.postal_code ?? "",
          timezone: typedEvent.timezone,
          startDate: typedEvent.start_date,
          endDate: typedEvent.end_date,
          startTime: typedEvent.start_time ?? "",
          endTime: typedEvent.end_time ?? "",
          coverImageUrl:
            typedEvent.public_cover_image_url ??
            typedEvent.cover_image_url ??
            "",
          visibility: typedEvent.visibility,
          status: typedEvent.status,
          featured: typedEvent.featured,
          beginnerFriendly: Boolean(typedEvent.beginner_friendly),
          publicDirectoryEnabled: Boolean(typedEvent.public_directory_enabled),
          registrationRequired: typedEvent.registration_required,
          accountRequiredForRegistration:
            typedEvent.account_required_for_registration,
          registrationOpensAt: toDatetimeLocal(typedEvent.registration_opens_at),
          registrationClosesAt: toDatetimeLocal(typedEvent.registration_closes_at),
          capacity:
            typedEvent.capacity == null ? "" : String(typedEvent.capacity),
          waitlistEnabled: typedEvent.waitlist_enabled,
          refundPolicy: typedEvent.refund_policy ?? "",
          faq: typedEvent.faq ?? "",
          tags: typedTags.map((tag) => tag.tag).join(", "),
          styleKeys: selectedStyleKeys,
        }}
      />
    </div>
  );
}