import Image from "next/image";
import Link from "next/link";
import { BookOpen, CalendarDays, CheckCircle2, Flag, Target } from "lucide-react";
import { resolveLumiPortalAccess } from "@/lib/lumi/portal";
import {
  completeLumiGoalAction,
  createLumiGoalAction,
} from "./actions";
import LumiPlanGenerator from "./LumiPlanGenerator";

type Params = Promise<{ studioSlug: string }>;
type SearchParams = Promise<{ error?: string; success?: string }>;

function formatDate(value: string | null | undefined) {
  if (!value) return "No target date";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value.slice(0, 10)}T12:00:00`));
}

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

type GroupLessonRecapRow = {
  id: string;
  appointment_id: string;
  title: string | null;
  summary: string | null;
  technique_notes: string | null;
  safety_notes: string | null;
  practice_assignment: string | null;
  media_links: string[] | null;
  published_at: string | null;
};

type GroupLessonRecapRecipientRow = {
  id: string;
  group_lesson_recaps: GroupLessonRecapRow | GroupLessonRecapRow[] | null;
};

export default async function LumiJourneyPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { studioSlug } = await params;
  const notices = await searchParams;
  const access = await resolveLumiPortalAccess(studioSlug);
  const homeHref = `/portal/${encodeURIComponent(studioSlug)}`;

  if (!access.allowed) {
    const message =
      access.reason === "inactive_student"
        ? "LUMI becomes available again when you have an active package, membership, upcoming lesson, recent lesson, or current event registration."
        : access.reason === "instructor_portal"
          ? "LUMI is designed for the student dance journey and is not shown in independent instructor portals."
          : "LUMI is not available through this studio right now.";

    return (
      <main className="space-y-6">
        <Link href={homeHref} className="text-sm font-semibold text-fuchsia-700 hover:underline">
          Back to portal
        </Link>
        <section className="grid overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm md:grid-cols-[260px_1fr]">
          <div className="relative min-h-72 bg-slate-950">
            <Image src="/lumi-avatar.png" alt="LUMI" fill className="object-cover" priority />
          </div>
          <div className="flex flex-col justify-center p-6 md:p-8">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-fuchsia-700">
              LUMI Dance Journey Assistant
            </p>
            <h1 className="mt-3 text-3xl font-semibold text-slate-950">Your journey is still yours.</h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-600">{message}</p>
            <Link href={homeHref} className="mt-5 inline-flex w-fit rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white">
              Return to portal
            </Link>
          </div>
        </section>
      </main>
    );
  }

  const nowIso = new Date().toISOString();
  const [{ data: goals }, { data: appointments }, { data: assignments }, { data: groupRecapRows }] =
    await Promise.all([
      access.admin
        .from("student_dance_goals")
        .select("id, title, category, notes, target_date, status, created_at")
        .eq("studio_id", access.studio.id)
        .eq("client_id", access.client.id)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(10),
      access.admin
        .from("appointments")
        .select("id, title, appointment_type, starts_at, status")
        .eq("studio_id", access.studio.id)
        .eq("client_id", access.client.id)
        .order("starts_at", { ascending: false })
        .limit(20),
      access.admin
        .from("client_syllabus_assignments")
        .select(
          `id, visible_in_portal, archived_at,
           syllabus_templates (name, dance_style, level, syllabus_template_items (id)),
           client_syllabus_progress (status, show_notes_in_portal)`,
        )
        .eq("studio_id", access.studio.id)
        .eq("client_id", access.client.id)
        .eq("visible_in_portal", true)
        .is("archived_at", null)
        .limit(10),
      access.admin
        .from("group_lesson_recap_recipients")
        .select(
          `id,
           group_lesson_recaps!inner (
             id,
             appointment_id,
             title,
             summary,
             technique_notes,
             safety_notes,
             practice_assignment,
             media_links,
             published_at
           )`,
        )
        .eq("studio_id", access.studio.id)
        .eq("client_id", access.client.id)
        .eq("group_lesson_recaps.status", "published")
        .order("created_at", { ascending: false })
        .limit(6),
    ]);

  const appointmentIds = (appointments ?? []).map((item) => item.id);
  const { data: recaps } = appointmentIds.length
    ? await access.admin
        .from("lesson_recaps")
        .select("id, appointment_id, summary, homework, next_focus, updated_at")
        .eq("studio_id", access.studio.id)
        .in("appointment_id", appointmentIds)
        .eq("visible_to_client", true)
        .order("updated_at", { ascending: false })
        .limit(4)
    : { data: [] };

  const upcoming = (appointments ?? [])
    .filter((item) => item.starts_at >= nowIso && item.status !== "cancelled")
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
  const syllabusSummary = (assignments ?? []).reduce(
    (summary, assignment) => {
      const template = firstRelation(assignment.syllabus_templates);
      const itemCount = template?.syllabus_template_items?.length ?? 0;
      const progress = assignment.client_syllabus_progress ?? [];
      summary.assigned += 1;
      summary.figures += itemCount;
      summary.mastered += progress.filter((item) => item.status === "mastered").length;
      summary.active += progress.filter((item) =>
        ["introduced", "practicing", "comfortable"].includes(item.status),
      ).length;
      return summary;
    },
    { assigned: 0, figures: 0, active: 0, mastered: 0 },
  );
  const firstName = access.client.first_name?.trim() || "there";
  const groupRecaps = ((groupRecapRows ?? []) as GroupLessonRecapRecipientRow[])
    .map((row) => firstRelation(row.group_lesson_recaps))
    .filter((recap): recap is GroupLessonRecapRow => Boolean(recap));

  return (
    <main className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <Link href={homeHref} className="text-sm font-semibold text-fuchsia-700 hover:underline">
          Back to portal
        </Link>
        <span className="rounded-full bg-fuchsia-50 px-3 py-1 text-xs font-semibold text-fuchsia-700">
          Available through {access.studio.name}
        </span>
      </div>

      {notices.error ? (
        <p className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{notices.error}</p>
      ) : null}
      {notices.success ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {notices.success === "goal-completed" ? "Goal completed." : "Goal added to your journey."}
        </p>
      ) : null}

      <section className="grid overflow-hidden rounded-lg border border-slate-200 bg-slate-950 text-white shadow-sm md:grid-cols-[300px_1fr]">
        <div className="relative min-h-80">
          <Image src="/lumi-avatar.png" alt="LUMI, Dance Journey Assistant" fill className="object-cover" priority />
        </div>
        <div className="flex flex-col justify-center p-6 md:p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-fuchsia-300">Meet LUMI</p>
          <h1 className="mt-3 text-3xl font-semibold">Hi {firstName}. Let&apos;s keep your dance journey moving.</h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-white/80">
            I turn the goals, recaps, and progress your studio shares with you into practical priorities for your next practice and lesson.
          </p>
          <p className="mt-3 text-xs leading-5 text-white/60">
            Your instructor remains your coach. LUMI helps you understand and apply the guidance already in your journey.
          </p>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Active goals", value: goals?.length ?? 0, icon: Target },
          { label: "Shared recaps", value: (recaps?.length ?? 0) + groupRecaps.length, icon: CheckCircle2 },
          { label: "Active figures", value: syllabusSummary.active, icon: Flag },
          { label: "Mastered figures", value: syllabusSummary.mastered, icon: CheckCircle2 },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <Icon className="h-5 w-5 text-fuchsia-700" />
              <p className="mt-3 text-2xl font-semibold text-slate-950">{item.value}</p>
              <p className="mt-1 text-sm text-slate-500">{item.label}</p>
            </div>
          );
        })}
      </section>

      <LumiPlanGenerator studioSlug={studioSlug} />

      <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-fuchsia-700">My goals</p>
              <h2 className="mt-2 text-xl font-semibold text-slate-950">What are you working toward?</h2>
            </div>
            <Target className="h-6 w-6 text-fuchsia-700" />
          </div>

          <form action={createLumiGoalAction} className="mt-5 grid gap-3">
            <input type="hidden" name="studioSlug" value={studioSlug} />
            <input name="title" required maxLength={160} placeholder="Example: Feel confident social dancing Two Step" className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <div className="grid gap-3 sm:grid-cols-2">
              <select name="category" className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <option value="general">General growth</option>
                <option value="social">Social dancing</option>
                <option value="syllabus">Syllabus progress</option>
                <option value="showcase">Showcase</option>
                <option value="competition">Competition</option>
                <option value="confidence">Confidence</option>
                <option value="fitness">Dance fitness</option>
              </select>
              <input name="targetDate" type="date" className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            </div>
            <textarea name="notes" rows={2} maxLength={1000} placeholder="Why this matters or what success looks like" className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <button className="w-fit rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white">Add goal</button>
          </form>

          <div className="mt-6 space-y-3">
            {(goals ?? []).length ? (
              goals?.map((goal) => (
                <article key={goal.id} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-semibold text-slate-950">{goal.title}</p>
                      <p className="mt-1 text-xs text-slate-500">{formatDate(goal.target_date)}</p>
                      {goal.notes ? <p className="mt-2 text-sm leading-6 text-slate-600">{goal.notes}</p> : null}
                    </div>
                    <form action={completeLumiGoalAction}>
                      <input type="hidden" name="studioSlug" value={studioSlug} />
                      <input type="hidden" name="goalId" value={goal.id} />
                      <button className="rounded-lg border border-emerald-200 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-700">Complete</button>
                    </form>
                  </div>
                </article>
              ))
            ) : (
              <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">Add your first goal so LUMI can shape guidance around what matters to you.</p>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <CalendarDays className="h-5 w-5 text-orange-600" />
            <h2 className="mt-3 text-lg font-semibold text-slate-950">Next lesson</h2>
            {upcoming ? (
              <>
                <p className="mt-2 font-medium text-slate-800">{upcoming.title || "Dance lesson"}</p>
                <p className="mt-1 text-sm text-slate-500">{formatDate(upcoming.starts_at)}</p>
              </>
            ) : (
              <p className="mt-2 text-sm leading-6 text-slate-500">No upcoming lesson is currently scheduled.</p>
            )}
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-950">Syllabus snapshot</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              {syllabusSummary.assigned
                ? `${syllabusSummary.assigned} assigned syllabus${syllabusSummary.assigned === 1 ? "" : "es"}, ${syllabusSummary.active} active figures, and ${syllabusSummary.mastered} mastered.`
                : "Your studio has not shared a syllabus with you yet."}
            </p>
          </section>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-950">Group class recaps</h2>
        <p className="mt-2 text-sm text-slate-500">Published notes from group classes where you were checked in appear here.</p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {groupRecaps.length ? (
            groupRecaps.map((recap) => (
              <article key={recap.id} className="rounded-lg border border-fuchsia-100 bg-fuchsia-50 p-4">
                <div className="flex items-start gap-3">
                  <BookOpen className="mt-1 h-5 w-5 shrink-0 text-fuchsia-700" />
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-fuchsia-700">Group class recap</p>
                    <h3 className="mt-2 font-semibold text-slate-950">{recap.title || "Group class recap"}</h3>
                    {recap.summary ? <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">{recap.summary}</p> : null}
                    {recap.practice_assignment ? (
                      <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                        <span className="font-semibold">Practice:</span> {recap.practice_assignment}
                      </p>
                    ) : null}
                    {recap.technique_notes ? (
                      <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                        <span className="font-semibold">Technique:</span> {recap.technique_notes}
                      </p>
                    ) : null}
                    {recap.safety_notes ? (
                      <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                        <span className="font-semibold">Safety:</span> {recap.safety_notes}
                      </p>
                    ) : null}
                    {recap.media_links?.length ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {recap.media_links.map((href, index) => (
                          <a
                            key={`${recap.id}-${href}`}
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-fuchsia-700 ring-1 ring-fuchsia-100"
                          >
                            Media {index + 1}
                          </a>
                        ))}
                      </div>
                    ) : null}
                    <Link
                      href={`/portal/${encodeURIComponent(studioSlug)}/appointments/${encodeURIComponent(recap.appointment_id)}`}
                      className="mt-4 inline-flex rounded-lg bg-white px-3 py-2 text-xs font-semibold text-fuchsia-700 ring-1 ring-fuchsia-100 hover:bg-fuchsia-100"
                    >
                      Open class details
                    </Link>
                    {recap.published_at ? (
                      <p className="mt-3 text-xs text-slate-500">Shared {formatDate(recap.published_at)}</p>
                    ) : null}
                  </div>
                </div>
              </article>
            ))
          ) : (
            <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">No group class recaps have been shared yet.</p>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-950">Recent private lesson feedback</h2>
        <p className="mt-2 text-sm text-slate-500">Only recaps your studio has shared with you appear here.</p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {(recaps ?? []).length ? (
            recaps?.map((recap) => (
              <article key={recap.id} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-fuchsia-700">Lesson recap</p>
                {recap.summary ? <p className="mt-3 text-sm leading-6 text-slate-700">{recap.summary}</p> : null}
                {recap.homework ? <p className="mt-3 text-sm leading-6 text-slate-700"><span className="font-semibold">Practice:</span> {recap.homework}</p> : null}
                {recap.next_focus ? <p className="mt-3 text-sm leading-6 text-slate-700"><span className="font-semibold">Next focus:</span> {recap.next_focus}</p> : null}
              </article>
            ))
          ) : (
            <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">No shared lesson recaps yet.</p>
          )}
        </div>
      </section>
    </main>
  );
}
