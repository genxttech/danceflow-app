import {
  addSyllabusTemplateItemAction,
  assignSyllabusTemplateToClientAction,
  createSyllabusTemplateAction,
  removeClientSyllabusAssignmentAction,
  updateClientSyllabusProgressAction,
} from "./actions";

type TemplateItem = {
  id: string;
  title: string;
  category: string | null;
  description: string | null;
  sort_order: number | null;
  active: boolean | null;
};

type SyllabusTemplate = {
  id: string;
  name: string;
  dance_style: string | null;
  level: string | null;
  description: string | null;
  active: boolean | null;
  syllabus_template_items?: TemplateItem[] | null;
};

type ProgressRow = {
  id: string;
  template_item_id: string;
  status: string;
  instructor_notes: string | null;
  show_notes_in_portal: boolean | null;
  updated_at: string | null;
};

type AssignmentRow = {
  id: string;
  template_id: string;
  status: string;
  show_in_portal: boolean | null;
  assigned_at: string | null;
  syllabus_templates?: SyllabusTemplate | SyllabusTemplate[] | null;
  client_syllabus_progress?: ProgressRow[] | null;
};

type ClientSyllabusTabProps = {
  clientId: string;
  clientName: string;
  canEdit: boolean;
  returnTo: string;
  templates: SyllabusTemplate[];
  assignments: AssignmentRow[];
};

const progressOptions = [
  { value: "not_started", label: "Not started" },
  { value: "introduced", label: "Introduced" },
  { value: "practicing", label: "Practicing" },
  { value: "comfortable", label: "Comfortable" },
  { value: "mastered", label: "Mastered" },
];

function getTemplate(value: AssignmentRow["syllabus_templates"]) {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function getSortedItems(template: SyllabusTemplate | null) {
  return (template?.syllabus_template_items ?? [])
    .filter((item) => item.active !== false)
    .sort((a, b) => {
      const sortA = a.sort_order ?? 9999;
      const sortB = b.sort_order ?? 9999;
      if (sortA !== sortB) return sortA - sortB;
      return a.title.localeCompare(b.title);
    });
}

function progressBadgeClass(status: string) {
  if (status === "mastered") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (status === "comfortable") return "bg-teal-50 text-teal-700 border-teal-200";
  if (status === "practicing") return "bg-amber-50 text-amber-700 border-amber-200";
  if (status === "introduced") return "bg-purple-50 text-purple-700 border-purple-200";
  return "bg-slate-50 text-slate-600 border-slate-200";
}

function progressLabel(status: string) {
  return progressOptions.find((option) => option.value === status)?.label ?? "Not started";
}

export default function ClientSyllabusTab({
  clientId,
  clientName,
  canEdit,
  returnTo,
  templates,
  assignments,
}: ClientSyllabusTabProps) {
  const activeTemplates = templates.filter((template) => template.active !== false);
  const assignedTemplateIds = new Set(assignments.map((assignment) => assignment.template_id));
  const assignableTemplates = activeTemplates.filter((template) => !assignedTemplateIds.has(template.id));

  const totalItems = assignments.reduce((count, assignment) => {
    return count + getSortedItems(getTemplate(assignment.syllabus_templates)).length;
  }, 0);

  const masteredItems = assignments.reduce((count, assignment) => {
    return (
      count +
      (assignment.client_syllabus_progress ?? []).filter((progress) => progress.status === "mastered").length
    );
  }, 0);

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[28px] border border-purple-100 bg-white shadow-sm">
        <div className="bg-gradient-to-r from-purple-50 via-fuchsia-50 to-orange-50 p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-purple-700">
                Student progress
              </p>
              <h3 className="mt-2 text-2xl font-semibold text-[var(--brand-text)]">
                Syllabus
              </h3>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-700">
                Assign dance syllabi to {clientName || "this student"}, track figures and patterns,
                and keep instructor notes tied to each item.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm sm:min-w-72">
              <div className="rounded-2xl border border-white/80 bg-white/85 p-4 shadow-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Assigned</p>
                <p className="mt-1 text-2xl font-semibold text-purple-800">{assignments.length}</p>
              </div>
              <div className="rounded-2xl border border-white/80 bg-white/85 p-4 shadow-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Mastered</p>
                <p className="mt-1 text-2xl font-semibold text-emerald-700">
                  {masteredItems}/{totalItems}
                </p>
              </div>
            </div>
          </div>
        </div>

        {!canEdit ? (
          <div className="border-t border-purple-100 p-5 text-sm text-slate-600">
            You can view syllabus progress, but your current role cannot edit it.
          </div>
        ) : null}
      </section>

      {canEdit ? (
        <section className="grid gap-5 xl:grid-cols-[1fr_1fr]">
          <div className="rounded-[28px] border border-[var(--brand-border)] bg-white p-5 shadow-sm">
            <h4 className="text-lg font-semibold text-[var(--brand-text)]">Create a syllabus template</h4>
            <p className="mt-1 text-sm text-slate-600">
              Build reusable lists such as Bronze Country Two Step or Beginner Salsa.
            </p>

            <form action={createSyllabusTemplateAction} className="mt-5 space-y-4">
              <input type="hidden" name="returnTo" value={returnTo} />
              <div className="grid gap-3 md:grid-cols-2">
                <label className="space-y-1 text-sm font-medium text-slate-700">
                  Template name
                  <input
                    name="name"
                    required
                    placeholder="Bronze Country Two Step"
                    className="w-full rounded-2xl border border-[var(--brand-border)] px-4 py-3 text-sm"
                  />
                </label>
                <label className="space-y-1 text-sm font-medium text-slate-700">
                  Dance style
                  <input
                    name="danceStyle"
                    placeholder="Country Two Step"
                    className="w-full rounded-2xl border border-[var(--brand-border)] px-4 py-3 text-sm"
                  />
                </label>
                <label className="space-y-1 text-sm font-medium text-slate-700">
                  Level
                  <input
                    name="level"
                    placeholder="Beginner / Bronze"
                    className="w-full rounded-2xl border border-[var(--brand-border)] px-4 py-3 text-sm"
                  />
                </label>
              </div>
              <label className="space-y-1 text-sm font-medium text-slate-700">
                Description
                <textarea
                  name="description"
                  rows={3}
                  placeholder="Optional notes about this syllabus."
                  className="w-full rounded-2xl border border-[var(--brand-border)] px-4 py-3 text-sm"
                />
              </label>
              <button
                type="submit"
                className="rounded-full bg-[var(--brand-primary)] px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:opacity-90"
              >
                Create Template
              </button>
            </form>
          </div>

          <div className="rounded-[28px] border border-[var(--brand-border)] bg-white p-5 shadow-sm">
            <h4 className="text-lg font-semibold text-[var(--brand-text)]">Assign syllabus to student</h4>
            <p className="mt-1 text-sm text-slate-600">
              Assign one or more reusable templates to this student's profile.
            </p>

            <form action={assignSyllabusTemplateToClientAction} className="mt-5 space-y-4">
              <input type="hidden" name="returnTo" value={returnTo} />
              <input type="hidden" name="clientId" value={clientId} />
              <label className="space-y-1 text-sm font-medium text-slate-700">
                Syllabus template
                <select
                  name="templateId"
                  required
                  className="w-full rounded-2xl border border-[var(--brand-border)] px-4 py-3 text-sm"
                  defaultValue=""
                >
                  <option value="" disabled>
                    Choose a template
                  </option>
                  {assignableTemplates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                      {template.level ? ` · ${template.level}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-start gap-3 rounded-2xl border border-purple-100 bg-purple-50/60 p-4 text-sm text-slate-700">
                <input name="showInPortal" type="checkbox" className="mt-1" />
                <span>
                  <span className="font-medium text-purple-900">Show in student portal later</span>
                  <span className="block text-xs leading-5 text-purple-800">
                    This stores the visibility preference now. Portal display can be enabled in a follow-up build.
                  </span>
                </span>
              </label>
              <button
                type="submit"
                disabled={assignableTemplates.length === 0}
                className="rounded-full bg-[var(--brand-primary)] px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Assign Syllabus
              </button>
            </form>
          </div>
        </section>
      ) : null}

      {canEdit && activeTemplates.length > 0 ? (
        <section className="rounded-[28px] border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <h4 className="text-lg font-semibold text-[var(--brand-text)]">Template figures</h4>
          <p className="mt-1 text-sm text-slate-600">
            Add figures or patterns to reusable templates. They appear for every student assigned to that syllabus.
          </p>
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            {activeTemplates.map((template) => (
              <div key={template.id} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-[var(--brand-text)]">{template.name}</p>
                    <p className="text-xs text-slate-500">
                      {[template.dance_style, template.level].filter(Boolean).join(" · ") || "No style/level set"}
                    </p>
                  </div>
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-600">
                    {getSortedItems(template).length} items
                  </span>
                </div>

                <form action={addSyllabusTemplateItemAction} className="mt-4 grid gap-3">
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <input type="hidden" name="templateId" value={template.id} />
                  <input
                    name="title"
                    required
                    placeholder="Figure / pattern name"
                    className="rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm"
                  />
                  <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
                    <input
                      name="category"
                      placeholder="Category"
                      className="rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm"
                    />
                    <input
                      name="sortOrder"
                      type="number"
                      min="0"
                      placeholder="Order"
                      className="rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm"
                    />
                  </div>
                  <textarea
                    name="description"
                    rows={2}
                    placeholder="Optional teaching notes for this item."
                    className="rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm"
                  />
                  <button
                    type="submit"
                    className="justify-self-start rounded-full border border-purple-200 bg-purple-50 px-4 py-2 text-sm font-semibold text-purple-800 hover:bg-purple-100"
                  >
                    Add Figure
                  </button>
                </form>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="space-y-5">
        {assignments.length === 0 ? (
          <div className="rounded-[28px] border border-dashed border-[var(--brand-border)] bg-[var(--brand-surface)] p-6">
            <p className="font-medium text-[var(--brand-text)]">No syllabus assigned yet.</p>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Create a syllabus template, add figures, then assign it to this student to begin tracking progress.
            </p>
          </div>
        ) : null}

        {assignments.map((assignment) => {
          const template = getTemplate(assignment.syllabus_templates);
          const items = getSortedItems(template);
          const progressRows = assignment.client_syllabus_progress ?? [];
          const progressByItem = new Map(progressRows.map((progress) => [progress.template_item_id, progress]));

          return (
            <div key={assignment.id} className="overflow-hidden rounded-[28px] border border-[var(--brand-border)] bg-white shadow-sm">
              <div className="border-b border-purple-100 bg-gradient-to-r from-purple-50 to-orange-50 p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h4 className="text-xl font-semibold text-[var(--brand-text)]">
                      {template?.name ?? "Assigned syllabus"}
                    </h4>
                    <p className="mt-1 text-sm text-slate-600">
                      {[template?.dance_style, template?.level].filter(Boolean).join(" · ") || "No style/level set"}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {assignment.show_in_portal ? (
                      <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
                        Portal ready
                      </span>
                    ) : (
                      <span className="rounded-full border border-slate-200 bg-white/80 px-3 py-1 text-xs font-medium text-slate-600">
                        Internal only
                      </span>
                    )}

                    {canEdit ? (
                      <form action={removeClientSyllabusAssignmentAction}>
                        <input type="hidden" name="returnTo" value={returnTo} />
                        <input type="hidden" name="clientId" value={clientId} />
                        <input type="hidden" name="assignmentId" value={assignment.id} />
                        <button
                          type="submit"
                          className="rounded-full border border-red-200 bg-white px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-50"
                        >
                          Remove
                        </button>
                      </form>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="divide-y divide-slate-100">
                {items.length === 0 ? (
                  <div className="p-5 text-sm text-slate-600">
                    This template does not have any figures yet.
                  </div>
                ) : null}

                {items.map((item) => {
                  const progress = progressByItem.get(item.id);
                  const status = progress?.status ?? "not_started";

                  return (
                    <div key={item.id} className="p-5">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-semibold text-[var(--brand-text)]">{item.title}</p>
                            <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${progressBadgeClass(status)}`}>
                              {progressLabel(status)}
                            </span>
                            {item.category ? (
                              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
                                {item.category}
                              </span>
                            ) : null}
                          </div>
                          {item.description ? (
                            <p className="mt-2 text-sm leading-6 text-slate-600">{item.description}</p>
                          ) : null}
                          {progress?.instructor_notes ? (
                            <p className="mt-3 rounded-2xl bg-slate-50 p-3 text-sm leading-6 text-slate-700">
                              {progress.instructor_notes}
                            </p>
                          ) : null}
                        </div>

                        {canEdit ? (
                          <form action={updateClientSyllabusProgressAction} className="grid w-full gap-3 lg:max-w-md">
                            <input type="hidden" name="returnTo" value={returnTo} />
                            <input type="hidden" name="clientId" value={clientId} />
                            <input type="hidden" name="assignmentId" value={assignment.id} />
                            <input type="hidden" name="templateItemId" value={item.id} />
                            <select
                              name="status"
                              defaultValue={status}
                              className="rounded-2xl border border-[var(--brand-border)] px-4 py-3 text-sm"
                            >
                              {progressOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                            <textarea
                              name="instructorNotes"
                              rows={2}
                              defaultValue={progress?.instructor_notes ?? ""}
                              placeholder="Instructor notes"
                              className="rounded-2xl border border-[var(--brand-border)] px-4 py-3 text-sm"
                            />
                            <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
                              <input
                                name="showNotesInPortal"
                                type="checkbox"
                                defaultChecked={progress?.show_notes_in_portal === true}
                              />
                              Notes visible in portal later
                            </label>
                            <button
                              type="submit"
                              className="justify-self-start rounded-full bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-90"
                            >
                              Save Progress
                            </button>
                          </form>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
