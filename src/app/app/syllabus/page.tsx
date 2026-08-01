import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  addSyllabusTemplateItemAction,
  archiveSyllabusTemplateAction,
  archiveSyllabusTemplateItemAction,
  createSyllabusTemplateAction,
  updateSyllabusStepDetailsAction,
  saveSyllabusStepChartAction,
  addSyllabusStepChartRowAction,
  updateSyllabusStepChartRowAction,
  deleteSyllabusStepChartRowAction,
  createSyllabusStepVideoAction,
  removeSyllabusStepVideoAction,
} from "./actions";
import SyllabusMuxVideoUploader from "./SyllabusMuxVideoUploader";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{
  success?: string;
  error?: string;
}>;

type SyllabusTemplate = {
  id: string;
  name: string;
  dance_style: string | null;
  level: string | null;
  syllabus_dances:
    | {
        id: string;
        name: string;
        syllabus_styles:
          | { id: string; name: string }
          | { id: string; name: string }[]
          | null;
      }
    | {
        id: string;
        name: string;
        syllabus_styles:
          | { id: string; name: string }
          | { id: string; name: string }[]
          | null;
      }[]
    | null;
  description: string | null;
  active: boolean;
  syllabus_template_items:
    | {
        id: string;
        title: string;
        category: string | null;
        description: string | null;
        sort_order: number | null;
        active: boolean | null;
        syllabus_steps:
          | {
              id: string;
              name: string;
              alternate_name: string | null;
              summary: string | null;
              prerequisite_notes: string | null;
              timing: string | null;
              counts: string | null;
              starting_position: string | null;
              ending_position: string | null;
              technique_notes: string | null;
              instructor_notes: string | null;
              student_notes: string | null;
              status: string;
              syllabus_step_charts:
                | {
                    id: string;
                    title: string;
                    chart_format: string;
                    notes: string | null;
                    syllabus_step_chart_rows:
                      | {
                          id: string;
                          sort_order: number;
                          count_label: string | null;
                          leader_foot: string | null;
                          leader_action: string | null;
                          follower_foot: string | null;
                          follower_action: string | null;
                          direction: string | null;
                          notes: string | null;
                        }[]
                      | null;
                  }[]
                | null;
              syllabus_step_videos:
                | {
                    id: string;
                    display_order: number;
                    student_visible: boolean;
                    studio_video_assets:
                      | {
                          id: string;
                          title: string;
                          description: string | null;
                          content_type: string;
                          presentation_type: string;
                          visibility: string;
                          mux_upload_status: string | null;
                          mux_error_message: string | null;
                          status: string;
                        }
                      | {
                          id: string;
                          title: string;
                          description: string | null;
                          content_type: string;
                          presentation_type: string;
                          visibility: string;
                          mux_upload_status: string | null;
                          mux_error_message: string | null;
                          status: string;
                        }[]
                      | null;
                  }[]
                | null;
            }
          | {
              id: string;
              name: string;
              alternate_name: string | null;
              summary: string | null;
              prerequisite_notes: string | null;
              timing: string | null;
              counts: string | null;
              starting_position: string | null;
              ending_position: string | null;
              technique_notes: string | null;
              instructor_notes: string | null;
              student_notes: string | null;
              status: string;
              syllabus_step_charts:
                | {
                    id: string;
                    title: string;
                    chart_format: string;
                    notes: string | null;
                    syllabus_step_chart_rows:
                      | {
                          id: string;
                          sort_order: number;
                          count_label: string | null;
                          leader_foot: string | null;
                          leader_action: string | null;
                          follower_foot: string | null;
                          follower_action: string | null;
                          direction: string | null;
                          notes: string | null;
                        }[]
                      | null;
                  }[]
                | null;
              syllabus_step_videos:
                | {
                    id: string;
                    display_order: number;
                    student_visible: boolean;
                    studio_video_assets:
                      | {
                          id: string;
                          title: string;
                          description: string | null;
                          content_type: string;
                          presentation_type: string;
                          visibility: string;
                          mux_upload_status: string | null;
                          mux_error_message: string | null;
                          status: string;
                        }
                      | {
                          id: string;
                          title: string;
                          description: string | null;
                          content_type: string;
                          presentation_type: string;
                          visibility: string;
                          mux_upload_status: string | null;
                          mux_error_message: string | null;
                          status: string;
                        }[]
                      | null;
                  }[]
                | null;
            }[]
          | null;
      }[]
    | null;
};

const danceStyleGroups = [
  {
    label: "Country",
    options: [
      "Country Two Step",
      "Triple Two Step",
      "Polka",
      "Country Waltz",
      "Nightclub Two Step",
      "Line Dance",
      "Cha Cha",
      "East Coast Swing",
      "West Coast Swing",
    ],
  },
  {
    label: "Ballroom",
    options: [
      "Waltz",
      "Foxtrot",
      "Tango",
      "Viennese Waltz",
      "Quickstep",
      "Rumba",
      "Cha Cha",
      "Bolero",
      "Mambo",
      "Samba",
      "East Coast Swing",
      "West Coast Swing",
    ],
  },
  {
    label: "Social / Latin",
    options: [
      "Salsa",
      "Bachata",
      "Argentine Tango",
      "Merengue",
      "Cha Cha",
      "East Coast Swing",
      "West Coast Swing",
      "Other",
    ],
  },
];

const levelOptions = [
  "Newcomer",
  "Beginner",
  "Bronze",
  "Silver",
  "Gold",
  "Open",
  "All Levels",
  "Custom",
];

function firstJoin<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function templateStyleName(template: SyllabusTemplate) {
  const dance = firstJoin(template.syllabus_dances);
  return firstJoin(dance?.syllabus_styles)?.name ?? null;
}

function itemStep(
  item: NonNullable<SyllabusTemplate["syllabus_template_items"]>[number],
) {
  return firstJoin(item.syllabus_steps);
}

function stepChart(
  step: ReturnType<typeof itemStep>,
) {
  return firstJoin(step?.syllabus_step_charts);
}

type SyllabusStep = NonNullable<ReturnType<typeof itemStep>>;
type SyllabusStepVideoLink = NonNullable<
  SyllabusStep["syllabus_step_videos"]
>[number];
type StudioVideoAsset = {
  id: string;
  title: string;
  description: string | null;
  content_type: string;
  presentation_type: string;
  visibility: string;
  mux_upload_status: string | null;
  mux_error_message: string | null;
  status: string;
};

function stepVideos(step: ReturnType<typeof itemStep>) {
  const videos: Array<{
    link: SyllabusStepVideoLink;
    asset: StudioVideoAsset;
  }> = [];

  for (const link of step?.syllabus_step_videos ?? []) {
    const asset = firstJoin(link.studio_video_assets);

    if (asset && asset.status !== "archived") {
      videos.push({ link, asset });
    }
  }

  return videos.sort(
    (a, b) => a.link.display_order - b.link.display_order,
  );
}

function getBanner(params: { success?: string; error?: string }) {
  if (params.success) {
    const messages: Record<string, string> = {
      syllabus_template_created: "Curriculum program created.",
      syllabus_item_added: "Curriculum step added.",
      syllabus_template_archived: "Curriculum program archived.",
      syllabus_item_archived: "Curriculum step archived.",
      syllabus_step_updated: "Curriculum step details updated.",
      syllabus_chart_saved: "Dance chart settings saved.",
      syllabus_chart_row_added: "Dance chart row added.",
      syllabus_chart_row_updated: "Dance chart row updated.",
      syllabus_chart_row_deleted: "Dance chart row removed.",
      syllabus_video_created: "Curriculum video created. Upload the video file next.",
      syllabus_video_archived: "Curriculum video archived.",
    };

    return {
      tone: "success" as const,
      message: messages[params.success] ?? "Syllabus updated.",
    };
  }

  if (params.error) {
    const messages: Record<string, string> = {
      unauthorized: "You do not have permission to manage syllabus templates.",
      syllabus_name_required: "Program name is required.",
      dance_style_required: "Dance style is required.",
      syllabus_template_required: "Choose a syllabus template.",
      syllabus_template_not_found: "That syllabus template could not be found.",
      syllabus_template_create_failed: "The syllabus template could not be created.",
      syllabus_hierarchy_create_failed: "The curriculum style, dance, or level could not be created.",
      syllabus_style_dance_mismatch: "That dance is not available under the selected style.",
      syllabus_step_create_failed: "The curriculum step could not be created.",
      syllabus_item_title_required: "Figure or pattern name is required.",
      syllabus_item_create_failed: "The figure or pattern could not be added.",
      syllabus_template_archive_failed: "The syllabus template could not be archived.",
      syllabus_item_archive_failed: "The figure or pattern could not be archived.",
      syllabus_step_required: "Choose a curriculum step.",
      syllabus_step_name_required: "Step name is required.",
      syllabus_step_status_invalid: "Choose a valid step status.",
      syllabus_step_update_failed: "The curriculum step could not be updated.",
      syllabus_chart_format_invalid: "Choose a valid dance chart format.",
      syllabus_chart_save_failed: "The dance chart could not be saved.",
      syllabus_chart_required: "Create the dance chart before adding rows.",
      syllabus_chart_row_required: "Choose a dance chart row.",
      syllabus_chart_row_add_failed: "The dance chart row could not be added.",
      syllabus_chart_row_update_failed: "The dance chart row could not be updated.",
      syllabus_chart_row_delete_failed: "The dance chart row could not be removed.",
      syllabus_video_title_required: "Video title is required.",
      syllabus_video_content_type_invalid: "Choose a valid video content type.",
      syllabus_video_presentation_type_invalid: "Choose a valid video presentation type.",
      syllabus_video_visibility_invalid: "Choose a valid video visibility.",
      syllabus_video_create_failed: "The curriculum video could not be created.",
      syllabus_video_required: "Choose a curriculum video.",
      syllabus_video_archive_failed: "The curriculum video could not be archived.",
    };

    return {
      tone: "error" as const,
      message: messages[params.error] ?? "Something went wrong.",
    };
  }

  return null;
}

function sortItems(template: SyllabusTemplate) {
  return [...(template.syllabus_template_items ?? [])]
    .filter((item) => item.active !== false)
    .sort((a, b) => {
      const orderA = a.sort_order ?? 0;
      const orderB = b.sort_order ?? 0;
      if (orderA !== orderB) return orderA - orderB;
      return a.title.localeCompare(b.title);
    });
}

export default async function SyllabusPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const query = await searchParams;
  const banner = getBanner(query);

  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  const { data: templates, error } = await supabase
    .from("syllabus_templates")
    .select(`
      id,
      name,
      dance_style,
      level,
      description,
      active,
      syllabus_dances (
        id,
        name,
        syllabus_styles (
          id,
          name
        )
      ),
      syllabus_template_items (
        id,
        title,
        category,
        description,
        sort_order,
        active,
        syllabus_steps (
          id,
          name,
          alternate_name,
          summary,
          prerequisite_notes,
          timing,
          counts,
          starting_position,
          ending_position,
          technique_notes,
          instructor_notes,
          student_notes,
          status,
          syllabus_step_charts (
            id,
            title,
            chart_format,
            notes,
            syllabus_step_chart_rows (
              id,
              sort_order,
              count_label,
              leader_foot,
              leader_action,
              follower_foot,
              follower_action,
              direction,
              notes
            )
          ),
          syllabus_step_videos (
            id,
            display_order,
            student_visible,
            studio_video_assets (
              id,
              title,
              description,
              content_type,
              presentation_type,
              visibility,
              mux_upload_status,
              mux_error_message,
              status
            )
          )
        )
      )
    `)
    .eq("studio_id", studioId)
    .eq("active", true)
    .order("name", { ascending: true });

  if (error) {
    throw new Error(`Failed to load syllabus templates: ${error.message}`);
  }

  const activeTemplates = (templates ?? []) as SyllabusTemplate[];
  const returnTo = "/app/syllabus";

  return (
    <main className="min-h-screen bg-[var(--brand-bg)] px-4 py-6 text-[var(--brand-text)] sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="overflow-hidden rounded-[32px] border border-purple-100 bg-white shadow-sm">
          <div className="bg-gradient-to-r from-purple-50 via-fuchsia-50 to-orange-50 p-6 sm:p-8">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-purple-700">
              Studio setup
            </p>
            <div className="mt-3 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h1 className="text-3xl font-semibold tracking-tight text-[var(--brand-text)]">
                  Studio Curriculum
                </h1>
                <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-700">
                  Build your studio-owned curriculum by style, dance, level, and figure. Programs remain reusable,
                  assignable to students, and compatible with existing progress tracking.
                </p>
              </div>
              <div className="rounded-2xl border border-white/80 bg-white/85 px-4 py-3 text-sm shadow-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Active programs</p>
                <p className="mt-1 text-2xl font-semibold text-purple-800">{activeTemplates.length}</p>
              </div>
            </div>
          </div>
        </section>

        {banner ? (
          <div
            className={`rounded-2xl border px-4 py-3 text-sm ${
              banner.tone === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-red-200 bg-red-50 text-red-700"
            }`}
          >
            {banner.message}
          </div>
        ) : null}

        <section className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="rounded-[28px] border border-[var(--brand-border)] bg-white p-5 shadow-sm">
            <h2 className="text-xl font-semibold text-[var(--brand-text)]">
              Create curriculum program
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Choose the broad style, dance, and level. Add canonical figures after the program is created.
            </p>

            <form action={createSyllabusTemplateAction} className="mt-5 space-y-4">
              <input type="hidden" name="returnTo" value={returnTo} />

              <label className="block text-sm font-medium text-slate-700">
                Program name
                <input
                  name="name"
                  required
                  placeholder="Bronze Country Two Step Program"
                  className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
                />
              </label>

              <label className="block text-sm font-medium text-slate-700">
                Style
                <select
                  name="styleName"
                  required
                  className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
                  defaultValue=""
                >
                  <option value="" disabled>
                    Select broad style
                  </option>
                  {danceStyleGroups.map((group) => (
                    <option key={group.label} value={group.label}>
                      {group.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block text-sm font-medium text-slate-700">
                Dance
                <select
                  name="danceName"
                  required
                  className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
                  defaultValue=""
                >
                  <option value="" disabled>
                    Select dance
                  </option>
                  {danceStyleGroups.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.options.map((dance) => (
                        <option key={dance} value={dance}>
                          {dance}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>

              <label className="block text-sm font-medium text-slate-700">
                Level
                <select
                  name="level"
                  className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
                  defaultValue=""
                >
                  <option value="">Select level</option>
                  {levelOptions.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block text-sm font-medium text-slate-700">
                Description / notes
                <textarea
                  name="description"
                  rows={4}
                  placeholder="Optional notes for this syllabus template."
                  className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
                />
              </label>

              <button
                type="submit"
                className="w-full rounded-full bg-[var(--brand-primary)] px-5 py-3 text-sm font-semibold text-white shadow-sm hover:opacity-90"
              >
                Create Curriculum Program
              </button>
            </form>
          </div>

          <div className="space-y-4">
            {activeTemplates.length > 0 ? (
              activeTemplates.map((template) => {
                const items = sortItems(template);

                return (
                  <article
                    key={template.id}
                    className="rounded-[28px] border border-[var(--brand-border)] bg-white p-5 shadow-sm"
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <div className="flex flex-wrap gap-2">
                          {templateStyleName(template) ? (
                            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                              {templateStyleName(template)}
                            </span>
                          ) : null}
                          {template.dance_style ? (
                            <span className="rounded-full bg-purple-50 px-3 py-1 text-xs font-semibold text-purple-700">
                              {template.dance_style}
                            </span>
                          ) : null}
                          {template.level ? (
                            <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-semibold text-orange-700">
                              {template.level}
                            </span>
                          ) : null}
                        </div>
                        <h3 className="mt-3 text-lg font-semibold text-[var(--brand-text)]">
                          {template.name}
                        </h3>
                        {template.description ? (
                          <p className="mt-2 text-sm leading-6 text-slate-600">
                            {template.description}
                          </p>
                        ) : null}
                      </div>

                      <form action={archiveSyllabusTemplateAction}>
                        <input type="hidden" name="returnTo" value={returnTo} />
                        <input type="hidden" name="templateId" value={template.id} />
                        <button
                          type="submit"
                          className="rounded-full border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50"
                        >
                          Archive
                        </button>
                      </form>
                    </div>

                    <div className="mt-5 rounded-2xl border border-slate-100 bg-slate-50 p-4">
                      <div>
                        <h4 className="text-sm font-semibold text-slate-800">Steps / figures</h4>
                        <p className="mt-1 text-xs leading-5 text-slate-500">
                          Open a step to manage teaching details without leaving the curriculum workspace.
                        </p>
                      </div>

                      {items.length > 0 ? (
                        <div className="mt-3 space-y-2">
                          {items.map((item, index) => {
                            const step = itemStep(item);

                            return (
                              <details
                                key={item.id}
                                className="group rounded-2xl border border-slate-100 bg-white"
                              >
                                <summary className="flex cursor-pointer list-none flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <p className="text-sm font-semibold text-slate-900">
                                        {index + 1}. {step?.name ?? item.title}
                                      </p>
                                      {step?.status ? (
                                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold capitalize text-slate-600">
                                          {step.status}
                                        </span>
                                      ) : null}
                                    </div>
                                    {item.category || step?.summary || item.description ? (
                                      <p className="mt-1 line-clamp-2 text-xs text-slate-500">
                                        {[item.category, step?.summary ?? item.description]
                                          .filter(Boolean)
                                          .join(" • ")}
                                      </p>
                                    ) : null}
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className="rounded-full border border-purple-200 px-3 py-1.5 text-xs font-semibold text-purple-700 group-open:hidden">
                                      Open details
                                    </span>
                                    <span className="hidden rounded-full border border-purple-200 px-3 py-1.5 text-xs font-semibold text-purple-700 group-open:inline">
                                      Close details
                                    </span>
                                  </div>
                                </summary>

                                <div className="border-t border-slate-100 bg-slate-50/70 p-4">
                                  {step ? (
                                    <form
                                      action={updateSyllabusStepDetailsAction}
                                      className="space-y-4"
                                    >
                                      <input type="hidden" name="returnTo" value={returnTo} />
                                      <input type="hidden" name="stepId" value={step.id} />

                                      <div className="grid gap-3 sm:grid-cols-2">
                                        <label className="text-sm font-medium text-slate-700">
                                          Step / figure name
                                          <input
                                            name="name"
                                            required
                                            defaultValue={step.name}
                                            className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
                                          />
                                        </label>
                                        <label className="text-sm font-medium text-slate-700">
                                          Alternate name
                                          <input
                                            name="alternateName"
                                            defaultValue={step.alternate_name ?? ""}
                                            className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
                                          />
                                        </label>
                                      </div>

                                      <label className="block text-sm font-medium text-slate-700">
                                        Student-facing summary
                                        <textarea
                                          name="summary"
                                          rows={3}
                                          defaultValue={step.summary ?? ""}
                                          className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
                                        />
                                      </label>

                                      <div className="grid gap-3 sm:grid-cols-2">
                                        <label className="text-sm font-medium text-slate-700">
                                          Timing
                                          <input
                                            name="timing"
                                            defaultValue={step.timing ?? ""}
                                            placeholder="Slow, quick, quick"
                                            className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
                                          />
                                        </label>
                                        <label className="text-sm font-medium text-slate-700">
                                          Counts
                                          <input
                                            name="counts"
                                            defaultValue={step.counts ?? ""}
                                            placeholder="1, 2, 3, 4"
                                            className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
                                          />
                                        </label>
                                      </div>

                                      <div className="grid gap-3 sm:grid-cols-2">
                                        <label className="text-sm font-medium text-slate-700">
                                          Starting position
                                          <textarea
                                            name="startingPosition"
                                            rows={2}
                                            defaultValue={step.starting_position ?? ""}
                                            className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
                                          />
                                        </label>
                                        <label className="text-sm font-medium text-slate-700">
                                          Ending position
                                          <textarea
                                            name="endingPosition"
                                            rows={2}
                                            defaultValue={step.ending_position ?? ""}
                                            className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
                                          />
                                        </label>
                                      </div>

                                      <label className="block text-sm font-medium text-slate-700">
                                        Prerequisites
                                        <textarea
                                          name="prerequisiteNotes"
                                          rows={2}
                                          defaultValue={step.prerequisite_notes ?? ""}
                                          className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
                                        />
                                      </label>

                                      <label className="block text-sm font-medium text-slate-700">
                                        Technique notes
                                        <textarea
                                          name="techniqueNotes"
                                          rows={4}
                                          defaultValue={step.technique_notes ?? ""}
                                          className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
                                        />
                                      </label>

                                      <label className="block text-sm font-medium text-slate-700">
                                        Instructor-only notes
                                        <textarea
                                          name="instructorNotes"
                                          rows={3}
                                          defaultValue={step.instructor_notes ?? ""}
                                          className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
                                        />
                                      </label>

                                      <label className="block text-sm font-medium text-slate-700">
                                        Student notes
                                        <textarea
                                          name="studentNotes"
                                          rows={3}
                                          defaultValue={step.student_notes ?? ""}
                                          className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
                                        />
                                      </label>

                                      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                                        <label className="text-sm font-medium text-slate-700">
                                          Status
                                          <select
                                            name="status"
                                            defaultValue={step.status}
                                            className="mt-1 block rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
                                          >
                                            <option value="draft">Draft</option>
                                            <option value="active">Active</option>
                                            <option value="archived">Archived</option>
                                          </select>
                                        </label>
                                        <button
                                          type="submit"
                                          className="rounded-full bg-[var(--brand-primary)] px-5 py-3 text-sm font-semibold text-white shadow-sm hover:opacity-90"
                                        >
                                          Save step details
                                        </button>
                                      </div>
                                    </form>
                                  ) : (
                                    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                                      This legacy figure has not been linked to a canonical curriculum step yet.
                                    </div>
                                  )}

                                  {step ? (() => {
                                    const chart = stepChart(step);
                                    const rows = [...(chart?.syllabus_step_chart_rows ?? [])].sort(
                                      (a, b) => a.sort_order - b.sort_order,
                                    );

                                    return (
                                      <section className="mt-6 rounded-[24px] border border-purple-100 bg-white p-4">
                                        <div>
                                          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-purple-700">
                                            Structured teaching aid
                                          </p>
                                          <h5 className="mt-2 text-lg font-semibold text-slate-950">
                                            Dance chart
                                          </h5>
                                          <p className="mt-1 text-sm leading-6 text-slate-600">
                                            Record counts, leader and follower details, direction, and teaching notes.
                                          </p>
                                        </div>

                                        <form action={saveSyllabusStepChartAction} className="mt-4 grid gap-3 sm:grid-cols-2">
                                          <input type="hidden" name="returnTo" value={returnTo} />
                                          <input type="hidden" name="stepId" value={step.id} />

                                          <label className="text-sm font-medium text-slate-700">
                                            Chart title
                                            <input
                                              name="title"
                                              defaultValue={chart?.title ?? "Dance chart"}
                                              className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
                                            />
                                          </label>

                                          <label className="text-sm font-medium text-slate-700">
                                            Chart format
                                            <select
                                              name="chartFormat"
                                              defaultValue={chart?.chart_format ?? "partner"}
                                              className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
                                            >
                                              <option value="partner">Partner — leader and follower</option>
                                              <option value="solo">Solo / line dance</option>
                                              <option value="custom">Custom</option>
                                            </select>
                                          </label>

                                          <label className="text-sm font-medium text-slate-700 sm:col-span-2">
                                            Chart notes
                                            <textarea
                                              name="chartNotes"
                                              rows={2}
                                              defaultValue={chart?.notes ?? ""}
                                              className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
                                            />
                                          </label>

                                          <button
                                            type="submit"
                                            className="rounded-full border border-purple-200 px-4 py-2 text-sm font-semibold text-purple-700 hover:bg-purple-50 sm:col-span-2 sm:justify-self-start"
                                          >
                                            {chart ? "Save chart settings" : "Create dance chart"}
                                          </button>
                                        </form>

                                        {chart ? (
                                          <div className="mt-5 space-y-3">
                                            {rows.length > 0 ? (
                                              rows.map((row, rowIndex) => (
                                                <form
                                                  key={row.id}
                                                  action={updateSyllabusStepChartRowAction}
                                                  className="rounded-2xl border border-slate-200 bg-slate-50 p-3"
                                                >
                                                  <input type="hidden" name="returnTo" value={returnTo} />
                                                  <input type="hidden" name="rowId" value={row.id} />

                                                  <div className="grid gap-3 md:grid-cols-4">
                                                    <label className="text-xs font-semibold text-slate-600">
                                                      Order
                                                      <input
                                                        name="sortOrder"
                                                        type="number"
                                                        min="0"
                                                        defaultValue={row.sort_order}
                                                        className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                                                      />
                                                    </label>
                                                    <label className="text-xs font-semibold text-slate-600">
                                                      Count
                                                      <input
                                                        name="countLabel"
                                                        defaultValue={row.count_label ?? ""}
                                                        className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                                                      />
                                                    </label>
                                                    <label className="text-xs font-semibold text-slate-600">
                                                      Direction
                                                      <input
                                                        name="direction"
                                                        defaultValue={row.direction ?? ""}
                                                        className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                                                      />
                                                    </label>
                                                    <div className="flex items-end text-xs font-semibold text-slate-400">
                                                      Row {rowIndex + 1}
                                                    </div>

                                                    <label className="text-xs font-semibold text-slate-600">
                                                      Leader foot
                                                      <input
                                                        name="leaderFoot"
                                                        defaultValue={row.leader_foot ?? ""}
                                                        className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                                                      />
                                                    </label>
                                                    <label className="text-xs font-semibold text-slate-600 md:col-span-3">
                                                      Leader action
                                                      <input
                                                        name="leaderAction"
                                                        defaultValue={row.leader_action ?? ""}
                                                        className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                                                      />
                                                    </label>

                                                    <label className="text-xs font-semibold text-slate-600">
                                                      Follower foot
                                                      <input
                                                        name="followerFoot"
                                                        defaultValue={row.follower_foot ?? ""}
                                                        className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                                                      />
                                                    </label>
                                                    <label className="text-xs font-semibold text-slate-600 md:col-span-3">
                                                      Follower action
                                                      <input
                                                        name="followerAction"
                                                        defaultValue={row.follower_action ?? ""}
                                                        className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                                                      />
                                                    </label>

                                                    <label className="text-xs font-semibold text-slate-600 md:col-span-4">
                                                      Notes
                                                      <textarea
                                                        name="rowNotes"
                                                        rows={2}
                                                        defaultValue={row.notes ?? ""}
                                                        className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                                                      />
                                                    </label>
                                                  </div>

                                                  <div className="mt-3 flex flex-wrap gap-2">
                                                    <button
                                                      type="submit"
                                                      className="rounded-full bg-slate-950 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                                                    >
                                                      Save row
                                                    </button>
                                                    <button
                                                      type="submit"
                                                      formAction={deleteSyllabusStepChartRowAction}
                                                      className="rounded-full border border-red-200 px-4 py-2 text-xs font-semibold text-red-700 hover:bg-red-50"
                                                    >
                                                      Remove row
                                                    </button>
                                                  </div>
                                                </form>
                                              ))
                                            ) : (
                                              <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                                                No chart rows yet. Add the first movement below.
                                              </p>
                                            )}

                                            <form
                                              action={addSyllabusStepChartRowAction}
                                              className="rounded-2xl border border-dashed border-purple-200 bg-purple-50/50 p-4"
                                            >
                                              <input type="hidden" name="returnTo" value={returnTo} />
                                              <input type="hidden" name="stepId" value={step.id} />

                                              <div className="grid gap-3 md:grid-cols-3">
                                                <input
                                                  name="countLabel"
                                                  placeholder="Count"
                                                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                                                />
                                                <input
                                                  name="leaderFoot"
                                                  placeholder="Leader foot"
                                                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                                                />
                                                <input
                                                  name="leaderAction"
                                                  placeholder="Leader action"
                                                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                                                />
                                                <input
                                                  name="followerFoot"
                                                  placeholder="Follower foot"
                                                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                                                />
                                                <input
                                                  name="followerAction"
                                                  placeholder="Follower action"
                                                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                                                />
                                                <input
                                                  name="direction"
                                                  placeholder="Direction"
                                                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                                                />
                                                <textarea
                                                  name="rowNotes"
                                                  rows={2}
                                                  placeholder="Teaching notes"
                                                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm md:col-span-3"
                                                />
                                              </div>

                                              <button
                                                type="submit"
                                                className="mt-3 rounded-full bg-[var(--brand-primary)] px-4 py-2 text-xs font-semibold text-white hover:opacity-90"
                                              >
                                                Add chart row
                                              </button>
                                            </form>
                                          </div>
                                        ) : null}
                                      </section>
                                    );
                                  })() : null}

                                  {step ? (() => {
                                    const videos = stepVideos(step);

                                    return (
                                      <section className="mt-6 rounded-[24px] border border-orange-100 bg-white p-4">
                                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-700">
                                          Private curriculum media
                                        </p>
                                        <h5 className="mt-2 text-lg font-semibold text-slate-950">
                                          Instructional videos
                                        </h5>
                                        <p className="mt-1 text-sm leading-6 text-slate-600">
                                          Figure and technique videos use signed Mux playback and stay outside the retail catalog.
                                        </p>

                                        {videos.length > 0 ? (
                                          <div className="mt-4 space-y-4">
                                            {videos.map(({ link, asset }) => (
                                              <div
                                                key={link.id}
                                                className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                                              >
                                                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                                  <div>
                                                    <div className="flex flex-wrap gap-2">
                                                      <span className="rounded-full bg-purple-50 px-2.5 py-1 text-xs font-semibold capitalize text-purple-700">
                                                        {asset.content_type.replaceAll("_", " ")}
                                                      </span>
                                                      <span className="rounded-full bg-orange-50 px-2.5 py-1 text-xs font-semibold capitalize text-orange-700">
                                                        {asset.presentation_type.replaceAll("_", " ")}
                                                      </span>
                                                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold capitalize text-slate-600">
                                                        {asset.visibility.replaceAll("_", " ")}
                                                      </span>
                                                    </div>
                                                    <h6 className="mt-2 font-semibold text-slate-950">
                                                      {asset.title}
                                                    </h6>
                                                    {asset.description ? (
                                                      <p className="mt-1 text-sm text-slate-600">
                                                        {asset.description}
                                                      </p>
                                                    ) : null}
                                                  </div>

                                                  <form action={removeSyllabusStepVideoAction}>
                                                    <input type="hidden" name="returnTo" value={returnTo} />
                                                    <input type="hidden" name="videoAssetId" value={asset.id} />
                                                    <button
                                                      type="submit"
                                                      className="rounded-full border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50"
                                                    >
                                                      Archive
                                                    </button>
                                                  </form>
                                                </div>

                                                <div className="mt-4">
                                                  <SyllabusMuxVideoUploader
                                                    videoAssetId={asset.id}
                                                    muxStatus={asset.mux_upload_status}
                                                    errorMessage={asset.mux_error_message}
                                                  />
                                                </div>
                                              </div>
                                            ))}
                                          </div>
                                        ) : null}

                                        <form
                                          action={createSyllabusStepVideoAction}
                                          className="mt-4 grid gap-3 rounded-2xl border border-dashed border-orange-200 bg-orange-50/50 p-4 sm:grid-cols-2"
                                        >
                                          <input type="hidden" name="returnTo" value={returnTo} />
                                          <input type="hidden" name="stepId" value={step.id} />

                                          <label className="text-sm font-medium text-slate-700 sm:col-span-2">
                                            Video title
                                            <input
                                              name="title"
                                              required
                                              placeholder={`${step.name} demonstration`}
                                              className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                                            />
                                          </label>

                                          <label className="text-sm font-medium text-slate-700">
                                            Content type
                                            <select
                                              name="contentType"
                                              defaultValue="figure"
                                              className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                                            >
                                              <option value="figure">Figure</option>
                                              <option value="technique">Technique</option>
                                              <option value="practice_drill">Practice drill</option>
                                              <option value="general_instruction">General instruction</option>
                                              <option value="course_lesson">Course lesson</option>
                                            </select>
                                          </label>

                                          <label className="text-sm font-medium text-slate-700">
                                            Presentation
                                            <select
                                              name="presentationType"
                                              defaultValue="demonstration"
                                              className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                                            >
                                              <option value="demonstration">Demonstration</option>
                                              <option value="explanation">Explanation</option>
                                              <option value="leader">Leader</option>
                                              <option value="follower">Follower</option>
                                              <option value="slow_motion">Slow motion</option>
                                              <option value="full_speed">Full speed</option>
                                            </select>
                                          </label>

                                          <label className="text-sm font-medium text-slate-700">
                                            Visibility
                                            <select
                                              name="visibility"
                                              defaultValue="assigned_students"
                                              className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                                            >
                                              <option value="private">Instructor only</option>
                                              <option value="assigned_students">Assigned students</option>
                                              <option value="studio_students">All linked studio students</option>
                                            </select>
                                          </label>

                                          <label className="text-sm font-medium text-slate-700 sm:col-span-2">
                                            Description
                                            <textarea
                                              name="description"
                                              rows={2}
                                              className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                                            />
                                          </label>

                                          <button
                                            type="submit"
                                            className="rounded-full bg-[var(--brand-primary)] px-5 py-3 text-sm font-semibold text-white sm:col-span-2 sm:justify-self-start"
                                          >
                                            Create video record
                                          </button>
                                        </form>
                                      </section>
                                    );
                                  })() : null}

                                  <form action={archiveSyllabusTemplateItemAction} className="mt-4 border-t border-slate-200 pt-4">
                                    <input type="hidden" name="returnTo" value={returnTo} />
                                    <input type="hidden" name="itemId" value={item.id} />
                                    <button
                                      type="submit"
                                      className="rounded-full border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50"
                                    >
                                      Remove from program
                                    </button>
                                  </form>
                                </div>
                              </details>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="mt-3 text-sm text-slate-500">
                          No figures added yet.
                        </p>
                      )}

                      <form action={addSyllabusTemplateItemAction} className="mt-4 grid gap-3 md:grid-cols-[1fr_0.7fr]">
                        <input type="hidden" name="returnTo" value={returnTo} />
                        <input type="hidden" name="templateId" value={template.id} />
                        <input
                          name="title"
                          required
                          placeholder="Figure or pattern name"
                          className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
                        />
                        <input
                          name="category"
                          placeholder="Group/category"
                          className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
                        />
                        <textarea
                          name="description"
                          rows={2}
                          placeholder="Optional teaching notes for this figure"
                          className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100 md:col-span-2"
                        />
                        <button
                          type="submit"
                          className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-800 md:col-span-2"
                        >
                          Add Figure / Pattern
                        </button>
                      </form>
                    </div>
                  </article>
                );
              })
            ) : (
              <div className="rounded-[28px] border border-dashed border-[var(--brand-border)] bg-white p-8 text-center shadow-sm">
                <h3 className="text-lg font-semibold text-[var(--brand-text)]">
                  No curriculum programs yet
                </h3>
                <p className="mt-2 text-sm text-slate-600">
                  Create the first style, dance, level, and program for your studio curriculum.
                </p>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
