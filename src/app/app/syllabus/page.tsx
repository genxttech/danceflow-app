import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  addSyllabusTemplateItemAction,
  archiveSyllabusTemplateAction,
  archiveSyllabusTemplateItemAction,
  createSyllabusTemplateAction,
} from "./actions";

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
    ],
  },
  {
    label: "Swing",
    options: ["West Coast Swing", "East Coast Swing", "Hustle", "Jive"],
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
    ],
  },
  {
    label: "Social / Latin",
    options: ["Salsa", "Bachata", "Argentine Tango", "Merengue", "Other"],
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

function getBanner(params: { success?: string; error?: string }) {
  if (params.success) {
    const messages: Record<string, string> = {
      syllabus_template_created: "Syllabus template created.",
      syllabus_item_added: "Figure or pattern added.",
      syllabus_template_archived: "Syllabus template archived.",
      syllabus_item_archived: "Figure or pattern archived.",
    };

    return {
      tone: "success" as const,
      message: messages[params.success] ?? "Syllabus updated.",
    };
  }

  if (params.error) {
    const messages: Record<string, string> = {
      unauthorized: "You do not have permission to manage syllabus templates.",
      syllabus_name_required: "Template name is required.",
      dance_style_required: "Dance style is required.",
      syllabus_template_required: "Choose a syllabus template.",
      syllabus_template_not_found: "That syllabus template could not be found.",
      syllabus_template_create_failed: "The syllabus template could not be created.",
      syllabus_item_title_required: "Figure or pattern name is required.",
      syllabus_item_create_failed: "The figure or pattern could not be added.",
      syllabus_template_archive_failed: "The syllabus template could not be archived.",
      syllabus_item_archive_failed: "The figure or pattern could not be archived.",
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
      syllabus_template_items (
        id,
        title,
        category,
        description,
        sort_order,
        active
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
                  Syllabus Templates
                </h1>
                <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-700">
                  Create reusable dance syllabus templates here, then assign them to students from the student profile.
                  Templates work like package templates: build them once, reuse them across clients.
                </p>
              </div>
              <div className="rounded-2xl border border-white/80 bg-white/85 px-4 py-3 text-sm shadow-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Active templates</p>
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
              Create syllabus template
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Choose a dance style and level, then add figures or patterns after the template is created.
            </p>

            <form action={createSyllabusTemplateAction} className="mt-5 space-y-4">
              <input type="hidden" name="returnTo" value={returnTo} />

              <label className="block text-sm font-medium text-slate-700">
                Template name
                <input
                  name="name"
                  required
                  placeholder="Bronze Country Two Step"
                  className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
                />
              </label>

              <label className="block text-sm font-medium text-slate-700">
                Dance style
                <select
                  name="danceStyle"
                  required
                  className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
                  defaultValue=""
                >
                  <option value="" disabled>
                    Select dance style
                  </option>
                  {danceStyleGroups.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.options.map((style) => (
                        <option key={style} value={style}>
                          {style}
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
                Create Template
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
                      <h4 className="text-sm font-semibold text-slate-800">Figures / patterns</h4>

                      {items.length > 0 ? (
                        <div className="mt-3 space-y-2">
                          {items.map((item, index) => (
                            <div
                              key={item.id}
                              className="flex flex-col gap-3 rounded-2xl border border-slate-100 bg-white p-3 sm:flex-row sm:items-center sm:justify-between"
                            >
                              <div>
                                <p className="text-sm font-semibold text-slate-900">
                                  {index + 1}. {item.title}
                                </p>
                                {item.category || item.description ? (
                                  <p className="mt-1 text-xs text-slate-500">
                                    {[item.category, item.description].filter(Boolean).join(" • ")}
                                  </p>
                                ) : null}
                              </div>
                              <form action={archiveSyllabusTemplateItemAction}>
                                <input type="hidden" name="returnTo" value={returnTo} />
                                <input type="hidden" name="itemId" value={item.id} />
                                <button
                                  type="submit"
                                  className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                                >
                                  Remove
                                </button>
                              </form>
                            </div>
                          ))}
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
                  No syllabus templates yet
                </h3>
                <p className="mt-2 text-sm text-slate-600">
                  Create your first reusable syllabus template, then assign it to students from their profile.
                </p>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
