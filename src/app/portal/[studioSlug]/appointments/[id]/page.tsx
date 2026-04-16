import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type Params = Promise<{
  studioSlug: string;
  id: string;
}>;

type StudioRow = {
  id: string;
  name: string;
  slug: string;
};

type ClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  auth_user_id: string | null;
};

type AppointmentRow = {
  id: string;
  title: string | null;
  notes: string | null;
  appointment_type: string;
  status: string;
  starts_at: string;
  ends_at: string;
  client_id: string | null;
  instructors:
    | {
        id: string;
        full_name: string | null;
      }[]
    | {
        id: string;
        full_name: string | null;
      }
    | null;
  lesson_recaps:
    | {
        id: string;
        summary: string | null;
        homework: string | null;
        next_focus: string | null;
        visible_to_client: boolean;
        updated_at: string;
        video_storage_path: string | null;
        video_original_name: string | null;
        video_mime_type: string | null;
        video_uploaded_at: string | null;
      }[]
    | {
        id: string;
        summary: string | null;
        homework: string | null;
        next_focus: string | null;
        visible_to_client: boolean;
        updated_at: string;
        video_storage_path: string | null;
        video_original_name: string | null;
        video_mime_type: string | null;
        video_uploaded_at: string | null;
      }
    | null;
};

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function appointmentTypeLabel(value: string) {
  if (value === "private_lesson") return "Private Lesson";
  if (value === "group_class") return "Group Class";
  if (value === "intro_lesson") return "Intro Lesson";
  if (value === "floor_space_rental") return "Floor Space Rental";
  if (value === "party") return "Party";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusLabel(value: string) {
  if (value === "scheduled") return "Scheduled";
  if (value === "attended") return "Completed";
  if (value === "cancelled") return "Cancelled";
  if (value === "no_show") return "Missed";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusBadgeClass(status: string) {
  if (status === "scheduled") return "bg-blue-50 text-blue-700 ring-1 ring-blue-100";
  if (status === "attended") return "bg-green-50 text-green-700 ring-1 ring-green-100";
  if (status === "cancelled") return "bg-red-50 text-red-700 ring-1 ring-red-100";
  if (status === "no_show") return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function getInstructorName(value: AppointmentRow["instructors"]) {
  const row = Array.isArray(value) ? value[0] : value;
  return row?.full_name?.trim() || "Studio staff";
}

function getLessonRecap(value: AppointmentRow["lesson_recaps"]) {
  return Array.isArray(value) ? value[0] : value;
}

function getClientFirstName(value: ClientRow) {
  return value.first_name?.trim() || "there";
}

function SectionCard({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-2xl border bg-slate-50 p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
        {eyebrow}
      </p>
      <h3 className="mt-2 text-lg font-semibold text-slate-900">{title}</h3>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{body}</p>
    </div>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-2xl border border-dashed bg-slate-50 p-5">
      <p className="text-sm font-medium text-slate-900">{title}</p>
      <p className="mt-1 text-sm leading-6 text-slate-600">{description}</p>
    </div>
  );
}

export default async function PortalAppointmentDetailPage({
  params,
}: {
  params: Params;
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
    .select("id, name, slug")
    .eq("slug", studioSlug)
    .single();

  if (studioError || !studio) {
    redirect("/login");
  }

  const typedStudio = studio as StudioRow;

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, first_name, last_name, auth_user_id")
    .eq("studio_id", typedStudio.id)
    .eq("auth_user_id", user.id)
    .single();

  if (clientError || !client) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const typedClient = client as ClientRow;

  const { data: appointment, error: appointmentError } = await supabase
    .from("appointments")
    .select(`
      id,
      title,
      notes,
      appointment_type,
      status,
      starts_at,
      ends_at,
      client_id,
      instructors (
        id,
        full_name
      ),
      lesson_recaps (
        id,
        summary,
        homework,
        next_focus,
        visible_to_client,
        updated_at,
        video_storage_path,
        video_original_name,
        video_mime_type,
        video_uploaded_at
      )
    `)
    .eq("studio_id", typedStudio.id)
    .eq("client_id", typedClient.id)
    .eq("id", id)
    .single();

  if (appointmentError || !appointment) {
    notFound();
  }

  const typedAppointment = appointment as AppointmentRow;
  const recap = getLessonRecap(typedAppointment.lesson_recaps);

  const isPrivateLesson = typedAppointment.appointment_type === "private_lesson";
  const isAttendedLesson = typedAppointment.status === "attended";
  const canShowRecap =
    isPrivateLesson && isAttendedLesson && Boolean(recap?.visible_to_client);

  let lessonVideoUrl: string | null = null;

  if (canShowRecap && recap?.video_storage_path) {
    const { data: signedVideo } = await supabase.storage
      .from("lesson-recap-videos")
      .createSignedUrl(recap.video_storage_path, 60 * 60);

    lessonVideoUrl = signedVideo?.signedUrl ?? null;
  }

  const lessonTitle =
    typedAppointment.title?.trim() ||
    (isPrivateLesson ? "Your Private Lesson" : appointmentTypeLabel(typedAppointment.appointment_type));

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <section className="overflow-hidden rounded-[2rem] border bg-white shadow-sm">
        <div className="border-b bg-gradient-to-br from-slate-50 via-white to-slate-50 px-6 py-8 sm:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-2xl">
              <p className="text-sm font-medium text-slate-500">{typedStudio.name}</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
                {lessonTitle}
              </h1>
              <p className="mt-3 text-sm leading-6 text-slate-600 sm:text-base">
                {isPrivateLesson
                  ? `Hi ${getClientFirstName(typedClient)} — here is your lesson recap, practice plan, and any video your instructor shared with you.`
                  : `Here are the details for your ${appointmentTypeLabel(
                      typedAppointment.appointment_type
                    ).toLowerCase()}.`}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <span
                className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${statusBadgeClass(
                  typedAppointment.status
                )}`}
              >
                {statusLabel(typedAppointment.status)}
              </span>

              <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
                {appointmentTypeLabel(typedAppointment.appointment_type)}
              </span>

              {canShowRecap ? (
                <span className="inline-flex items-center rounded-full bg-green-50 px-3 py-1 text-xs font-semibold text-green-700 ring-1 ring-green-100">
                  Recap Available
                </span>
              ) : null}
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              href={`/portal/${encodeURIComponent(typedStudio.slug)}`}
              className="inline-flex rounded-xl border bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Back to Portal
            </Link>
          </div>
        </div>

        <div className="grid gap-4 px-6 py-6 sm:grid-cols-2 sm:px-8">
          <div className="rounded-2xl border bg-slate-50 p-5">
            <p className="text-sm font-medium text-slate-500">When</p>
            <p className="mt-2 text-base font-semibold text-slate-900">
              {formatShortDate(typedAppointment.starts_at)}
            </p>
            <p className="mt-1 text-sm text-slate-600">
              {formatTime(typedAppointment.starts_at)} – {formatTime(typedAppointment.ends_at)}
            </p>
            <p className="mt-2 text-xs text-slate-500">
              {formatDateTime(typedAppointment.starts_at)}
            </p>
          </div>

          <div className="rounded-2xl border bg-slate-50 p-5">
            <p className="text-sm font-medium text-slate-500">Instructor</p>
            <p className="mt-2 text-base font-semibold text-slate-900">
              {getInstructorName(typedAppointment.instructors)}
            </p>
            <p className="mt-1 text-sm text-slate-600">
              Your instructor for this lesson
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-[2rem] border bg-white p-6 shadow-sm sm:p-8">
        <div className="max-w-2xl">
          <p className="text-sm font-medium text-slate-500">Your recap</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
            What to remember from this lesson
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Review the main takeaways from your lesson and what to work on before next time.
          </p>
        </div>

        <div className="mt-6">
          {!isPrivateLesson ? (
            <EmptyState
              title="No recap for this appointment type"
              description="Lesson recaps are shared for private lessons."
            />
          ) : !isAttendedLesson ? (
            <EmptyState
              title="Recap not ready yet"
              description="Your instructor can share a recap after the lesson has been marked complete."
            />
          ) : !recap || !recap.visible_to_client ? (
            <EmptyState
              title="Nothing has been shared yet"
              description="Your instructor has not shared a recap for this lesson yet."
            />
          ) : (
            <div className="grid gap-4 lg:grid-cols-3">
              {recap.summary ? (
                <SectionCard
                  eyebrow="Lesson Summary"
                  title="What you covered"
                  body={recap.summary}
                />
              ) : null}

              {recap.homework ? (
                <SectionCard
                  eyebrow="Practice"
                  title="What to work on"
                  body={recap.homework}
                />
              ) : null}

              {recap.next_focus ? (
                <SectionCard
                  eyebrow="Next Lesson"
                  title="What comes next"
                  body={recap.next_focus}
                />
              ) : null}
            </div>
          )}
        </div>

        {typedAppointment.notes ? (
          <div className="mt-6 rounded-2xl border bg-slate-50 p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Additional Notes
            </p>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">
              {typedAppointment.notes}
            </p>
          </div>
        ) : null}

        {canShowRecap && recap ? (
          <div className="mt-6 rounded-2xl border bg-slate-50 p-4 text-xs text-slate-500">
            Shared {formatDateTime(recap.updated_at)}
          </div>
        ) : null}
      </section>

      <section className="rounded-[2rem] border bg-white p-6 shadow-sm sm:p-8">
        <div className="max-w-2xl">
          <p className="text-sm font-medium text-slate-500">Lesson video</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
            Watch your lesson again
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            If your instructor uploaded a video for this lesson, you can watch it here.
          </p>
        </div>

        <div className="mt-6">
          {!canShowRecap ? (
            <EmptyState
              title="No video available"
              description="A lesson video will appear here if your instructor shares one with your recap."
            />
          ) : !recap?.video_storage_path || !lessonVideoUrl ? (
            <EmptyState
              title="No video has been uploaded"
              description="Your recap is available, but there is not a video attached to this lesson."
            />
          ) : (
            <div className="space-y-4">
              <video
                controls
                preload="metadata"
                className="w-full rounded-3xl border bg-black shadow-sm"
                src={lessonVideoUrl}
              />
              <div className="rounded-2xl border bg-slate-50 p-4 text-xs text-slate-500">
                {recap.video_original_name ? <p>File: {recap.video_original_name}</p> : null}
                {recap.video_uploaded_at ? (
                  <p className="mt-1">Uploaded {formatDateTime(recap.video_uploaded_at)}</p>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

