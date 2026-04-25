import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type PageParams = Promise<{
  studioSlug: string;
  id: string;
}>;

type StudioRow = {
  id: string;
  slug: string;
  name: string;
  public_name: string | null;
};

type ClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  portal_user_id: string | null;
};

type LessonRecapMediaRow = {
  id: string;
  storage_path: string | null;
  mime_type: string | null;
  created_at: string;
};

type LessonRecapRow = {
  id: string;
  summary: string | null;
  homework: string | null;
  next_focus: string | null;
  visible_to_client: boolean;
  updated_at: string;
  lesson_recap_media: LessonRecapMediaRow[] | null;
};

type AppointmentRow = {
  id: string;
  studio_id: string;
  client_id: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  appointment_type: string;
  title: string | null;
  notes: string | null;
};

function getClientName(client: ClientRow) {
  const full = `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim();
  return full || "Client";
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatUpdatedAt(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatAppointmentType(value: string) {
  if (value === "private_lesson") return "Private Lesson";
  if (value === "intro_lesson") return "Intro Lesson";
  if (value === "group_class") return "Group Class";
  if (value === "floor_space_rental") return "Floor Space Rental";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatStatus(value: string) {
  if (value === "scheduled") return "Scheduled";
  if (value === "attended") return "Completed";
  if (value === "cancelled") return "Cancelled";
  if (value === "no_show") return "Missed";
  if (value === "rescheduled") return "Rescheduled";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusBadgeClass(status: string) {
  if (status === "attended") return "bg-green-50 text-green-700 ring-green-100";
  if (status === "scheduled") return "bg-blue-50 text-blue-700 ring-blue-100";
  if (status === "cancelled") return "bg-red-50 text-red-700 ring-red-100";
  if (status === "no_show") return "bg-amber-50 text-amber-700 ring-amber-100";
  if (status === "rescheduled") return "bg-violet-50 text-violet-700 ring-violet-100";
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

function isPlayableMedia(mimeType: string | null) {
  return Boolean(
    mimeType &&
      (mimeType.startsWith("video/") || mimeType.startsWith("audio/"))
  );
}

function getMediaLabel(storagePath: string | null) {
  if (!storagePath) return "Lesson recap media";
  const parts = storagePath.split("/");
  return parts[parts.length - 1] || "Lesson recap media";
}

export default async function PortalAppointmentDetailPage({
  params,
}: {
  params: PageParams;
}) {
  const { studioSlug, id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, slug, name, public_name")
    .eq("slug", studioSlug)
    .single();

  if (studioError || !studio) {
    notFound();
  }

  const typedStudio = studio as StudioRow;

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, first_name, last_name, portal_user_id")
    .eq("studio_id", typedStudio.id)
    .eq("portal_user_id", user.id)
    .single();

  if (clientError || !client) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const typedClient = client as ClientRow;

  const { data: appointment, error: appointmentError } = await supabase
    .from("appointments")
    .select(`
      id,
      studio_id,
      client_id,
      starts_at,
      ends_at,
      status,
      appointment_type,
      title,
      notes
    `)
    .eq("id", id)
    .eq("studio_id", typedStudio.id)
    .eq("client_id", typedClient.id)
    .single();

  if (appointmentError || !appointment) {
    notFound();
  }

  const typedAppointment = appointment as AppointmentRow;

  const { data: recapData, error: recapError } = await supabase
    .from("lesson_recaps")
    .select(`
      id,
      summary,
      homework,
      next_focus,
      visible_to_client,
      updated_at,
      lesson_recap_media (
        id,
        storage_path,
        mime_type,
        created_at
      )
    `)
    .eq("appointment_id", typedAppointment.id)
    .eq("visible_to_client", true)
    .maybeSingle();

  if (recapError) {
    throw new Error(`Failed to load lesson recap: ${recapError.message}`);
  }

  console.log("PORTAL_RECAP_DEBUG", {
    studioSlug,
    appointmentId: typedAppointment.id,
    portalUserId: user.id,
    portalClientId: typedClient.id,
    appointmentStatus: typedAppointment.status,
    recapFound: Boolean(recapData),
    recapId: recapData?.id ?? null,
    recapVisibleToClient: recapData?.visible_to_client ?? null,
    recapMediaCount: recapData?.lesson_recap_media?.length ?? 0,
  });

  const recap = (recapData ?? null) as LessonRecapRow | null;

  const recapVisible =
    Boolean(recap) && typedAppointment.status === "attended";

  const recapMedia = recapVisible ? recap?.lesson_recap_media ?? [] : [];

  const mediaWithUrls = await Promise.all(
    recapMedia.map(async (media) => {
      if (!media.storage_path) {
        return {
          ...media,
          signedUrl: null,
        };
      }

      const { data: signedData } = await supabase.storage
        .from("lesson-recap-videos")
        .createSignedUrl(media.storage_path, 60 * 60);

      return {
        ...media,
        signedUrl: signedData?.signedUrl ?? null,
      };
    })
  );

  const studioLabel = typedStudio.public_name?.trim() || typedStudio.name;
  const appointmentLabel =
    typedAppointment.title?.trim() ||
    formatAppointmentType(typedAppointment.appointment_type);

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.35)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[36px] border border-slate-200 bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] p-8 shadow-sm sm:p-10">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-white/70">
              DanceFlow Lesson Details
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              {appointmentLabel}
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-white/85 sm:text-base">
              See the details your studio shared for this lesson, including recap notes, practice ideas, next steps, and any shared media.
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ring-1 ${statusBadgeClass(
                  typedAppointment.status
                )}`}
              >
                {formatStatus(typedAppointment.status)}
              </span>

              <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
                {formatAppointmentType(typedAppointment.appointment_type)}
              </span>

              {recapVisible ? (
                <span className="inline-flex rounded-full bg-green-50 px-3 py-1 text-xs font-semibold text-green-700 ring-1 ring-green-100">
                  Recap Shared
                </span>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href={`/portal/${encodeURIComponent(studioSlug)}`}
              className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
            >
              Back to Portal
            </Link>
            <Link
              href={`/portal/${encodeURIComponent(studioSlug)}/profile`}
              className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
            >
              My Profile
            </Link>
          </div>
        </div>
      </section>

      <div className="grid gap-8 xl:grid-cols-[1.2fr_0.8fr]">
        <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-violet-700">
              Lesson What was covered
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
              What was shared for this lesson
            </h2>
          </div>

          {!recapVisible || !recap ? (
            <div className="mt-6 rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
              <p className="text-lg font-medium text-slate-900">
                Nothing has been shared yet
              </p>
              <p className="mt-2 text-sm leading-7 text-slate-600">
                Your studio has not added a visible lesson summary for this appointment yet.
              </p>
            </div>
          ) : (
            <div className="mt-6 space-y-6">
              <div className="rounded-3xl border border-violet-100 bg-violet-50 p-6 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                  Summary
                </p>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-700">
                  {recap.summary?.trim() || "No lesson summary was added."}
                </p>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6 shadow-sm">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Practice ideas
                  </p>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-700">
                    {recap.homework?.trim() || "No practice ideas were added."}
                  </p>
                </div>

                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6 shadow-sm">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Next lesson focus
                  </p>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-700">
                    {recap.next_focus?.trim() || "No next-step note was added."}
                  </p>
                </div>
              </div>

              <div className="rounded-3xl border border-emerald-100 bg-emerald-50 p-6 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
                  Shared video or audio
                </p>

                {mediaWithUrls.length === 0 ? (
                  <p className="mt-3 text-sm leading-7 text-slate-700">
                    No video or audio was attached to this lesson.
                  </p>
                ) : (
                  <div className="mt-4 space-y-4">
                    {mediaWithUrls.map((media) => (
                      <div
                        key={media.id}
                        className="rounded-2xl border border-white/70 bg-white p-4 shadow-sm"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-slate-900">
                              {getMediaLabel(media.storage_path)}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              {media.mime_type || "Unknown file type"}
                            </p>
                          </div>

                          {media.signedUrl ? (
                            <a
                              href={media.signedUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                            >
                              Open File
                            </a>
                          ) : null}
                        </div>

                        {media.signedUrl && isPlayableMedia(media.mime_type) ? (
                          <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-black">
                            {media.mime_type?.startsWith("video/") ? (
                              <video
                                controls
                                className="w-full"
                                src={media.signedUrl}
                              />
                            ) : (
                              <audio
                                controls
                                className="w-full"
                                src={media.signedUrl}
                              />
                            )}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <p className="text-xs text-slate-500">
                Updated {formatUpdatedAt(recap.updated_at)}
              </p>
            </div>
          )}
        </section>

        <section className="space-y-8">
          <div className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-sky-700">
              Lesson Details
            </p>

            <div className="mt-6 space-y-4">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Date & Time
                </p>
                <p className="mt-2 text-sm text-slate-800">
                  {formatDateTime(typedAppointment.starts_at)}
                </p>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Instructor
                </p>
                <p className="mt-2 text-sm text-slate-800">
                  Your studio team
                </p>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Status
                </p>
                <p className="mt-2 text-sm text-slate-800">
                  {formatStatus(typedAppointment.status)}
                </p>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Appointment Type
                </p>
                <p className="mt-2 text-sm text-slate-800">
                  {formatAppointmentType(typedAppointment.appointment_type)}
                </p>
              </div>

              {typedAppointment.notes?.trim() ? (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Studio Notes
                  </p>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-slate-700">
                    {typedAppointment.notes}
                  </p>
                </div>
              ) : null}
            </div>
          </div>

          <div className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-orange-600">
              Need help with this lesson?
            </p>
            <p className="mt-3 text-sm leading-7 text-slate-600">
              If you expected lesson notes, media, or other details that are not showing here yet, reach out to your studio.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}



