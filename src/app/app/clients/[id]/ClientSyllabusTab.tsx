import Link from "next/link";
import {
  assignSyllabusTemplateToClientAction,
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
  syllabus_template_items: TemplateItem[] | null;
};

type ProgressRow = {
  id: string;
  template_item_id: string;
  status: string;
  notes: string | null;
  show_notes_in_portal: boolean | null;
  updated_at: string | null;
};

type Assignment = {
  id: string;
  syllabus_template_id: string;
  assigned_at: string | null;
  visible_in_portal: boolean | null;
  archived_at: string | null;
  syllabus_templates: SyllabusTemplate | SyllabusTemplate[] | null;
  client_syllabus_progress: ProgressRow[] | null;
};

type ClientSyllabusTabProps = {
  clientId: string;
  clientName: string;
  canEdit: boolean;
  templates: SyllabusTemplate[];
  assignments: Assignment[];
};

const progressOptions = [
  { value: "not_started", label: "Not Started" },
  { value: "introduced", label: "Introduced" },
  { value: "practicing", label: "Practicing" },
  { value: "comfortable", label: "Comfortable" },
  { value: "mastered", label: "Mastered" },
];

function normalizeTemplate(template: SyllabusTemplate | SyllabusTemplate[] | null) {
  if (Array.isArray(template)) return template[0] ?? null;
  return template;
}

function sortItems(items: TemplateItem[] | null | undefined) {
  return [...(items ?? [])]
    .filter((item) => item.active !== false)
    .sort((a, b) => {
      const orderA = a.sort_order ?? 0;
      const orderB = b.sort_order ?? 0;
      if (orderA !== orderB) return orderA - orderB;
      return a.title.localeCompare(b.title);
    });
}

function getProgressForItem(progressRows: ProgressRow[] | null | undefined, itemId: string) {
  return (progressRows ?? []).find((progress) => progress.template_item_id === itemId);
}

function getStatusLabel(status: string | null | undefined) {
  return progressOptions.find((option) => option.value === status)?.label ?? "Not Started";
}

function progressPillClass(status: string | null | undefined) {
  if (status === "mastered") return "bg-emerald-50 text-emerald-700 border-emerald-100";
  if (status === "comfortable") return "bg-teal-50 text-teal-700 border-teal-100";
  if (status === "practicing") return "bg-blue-50 text-blue-700 border-blue-100";
  if (status === "introduced") return "bg-orange-50 text-orange-700 border-orange-100";
  return "bg-slate-50 text-slate-600 border-slate-200";
}

export default function ClientSyllabusTab({
  clientId,
  clientName,
  canEdit,
  templates,
  assignments,
}: ClientSyllabusTabProps) {
  const activeAssignments = assignments.filter((assignment) => !assignment.archived_at);
  const assignedTemplateIds = new Set(activeAssignments.map((assignment) => assignment.syllabus_template_id));
  const assignableTemplates = templates.filter((template) => template.active !== false && !assignedTemplateIds.has(template.id));

  const totalItems = activeAssignments.reduce((count, assignment) => {
    const template = normalizeTemplate(assignment.syllabus_templates);
    return count + sortItems(template?.syllabus_template_items).length;
  }, 0);

  const masteredItems = activeAssignments.reduce((count, assignment) => {
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
                Assign an existing syllabus template to {clientName || "this student"}, then track
                figures, patterns, and instructor notes for this individual student.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm sm:min-w-72">
              <div className="rounded-2xl border border-white/80 bg-white/85 p-4 shadow-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Assigned</p>
                <p className="mt-1 text-2xl font-semibold text-purple-800">{activeAssignments.length}</p>
              </div>
              <div className="rounded-2xl border border-white/80 bg-white/85 p-4 shadow-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Mastered</p>
                <p className="mt-1 text-2xl font-semibold text-orange-700">
                  {masteredItems}/{totalItems}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {canEdit ? (
        <section className="rounded-[28px] border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h4 className="text-lg font-semibold text-[var(--brand-text)]">Assign a syllabus</h4>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Templates are created from the Syllabus page. This student page only assigns an existing
                template and tracks student-specific progress.
              </p>
            </div>
            <Link
              href="/app/syllabus"
              className="inline-flex rounded-full border border-purple-200 px-4 py-2 text-sm font-semibold text-purple-700 hover:bg-purple-50"
            >
              Manage Syllabus Templates
            </Link>
          </div>

          <form action={assignSyllabusTemplateToClientAction} className="mt-5 grid gap-3 md:grid-cols-[1fr_auto]">
            <input type="hidden" name="clientId" value={clientId} />
            <input type="hidden" name="returnTo" value={`/app/clients/${clientId}?tab=syllabus`} />
            <select
              name="templateId"
              required
              disabled={assignableTemplates.length === 0}
              className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100 disabled:bg-slate-50"
              defaultValue=""
            >
              <option value="" disabled>
                {assignableTemplates.length > 0
                  ? "Choose a syllabus template"
                  : "No unassigned templates available"}
              </option>
              {assignableTemplates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                  {template.dance_style ? ` • ${template.dance_style}` : ""}
                  {template.level ? ` • ${template.level}` : ""}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={assignableTemplates.length === 0}
              className="rounded-full bg-[var(--brand-primary)] px-5 py-3 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Assign Syllabus
            </button>
          </form>
        </section>
      ) : null}

      {activeAssignments.length > 0 ? (
        <div className="space-y-5">
          {activeAssignments.map((assignment) => {
            const template = normalizeTemplate(assignment.syllabus_templates);
            const items = sortItems(template?.syllabus_template_items);

            if (!template) return null;

            return (
              <section
                key={assignment.id}
                className="rounded-[28px] border border-[var(--brand-border)] bg-white p-5 shadow-sm"
              >
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
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
                      {assignment.visible_in_portal ? (
                        <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                          Portal visible
                        </span>
                      ) : null}
                    </div>
                    <h4 className="mt-3 text-xl font-semibold text-[var(--brand-text)]">
                      {template.name}
                    </h4>
                    {template.description ? (
                      <p className="mt-2 text-sm leading-6 text-slate-600">{template.description}</p>
                    ) : null}
                  </div>

                  {canEdit ? (
                    <form action={removeClientSyllabusAssignmentAction}>
                      <input type="hidden" name="clientId" value={clientId} />
                      <input type="hidden" name="assignmentId" value={assignment.id} />
                      <input type="hidden" name="returnTo" value={`/app/clients/${clientId}?tab=syllabus`} />
                      <button
                        type="submit"
                        className="rounded-full border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50"
                      >
                        Remove
                      </button>
                    </form>
                  ) : null}
                </div>

                <div className="mt-5 space-y-3">
                  {items.length > 0 ? (
                    items.map((item, index) => {
                      const progress = getProgressForItem(assignment.client_syllabus_progress, item.id);
                      const currentStatus = progress?.status ?? "not_started";

                      return (
                        <form
                          key={item.id}
                          action={updateClientSyllabusProgressAction}
                          className="rounded-2xl border border-slate-100 bg-slate-50 p-4"
                        >
                          <input type="hidden" name="clientId" value={clientId} />
                          <input type="hidden" name="assignmentId" value={assignment.id} />
                          <input type="hidden" name="templateItemId" value={item.id} />
                          <input type="hidden" name="returnTo" value={`/app/clients/${clientId}?tab=syllabus`} />

                          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
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
                            <span
                              className={`w-fit rounded-full border px-3 py-1 text-xs font-semibold ${progressPillClass(currentStatus)}`}
                            >
                              {getStatusLabel(currentStatus)}
                            </span>
                          </div>

                          <div className="mt-4 grid gap-3 lg:grid-cols-[220px_1fr_auto]">
                            <select
                              name="status"
                              defaultValue={currentStatus}
                              disabled={!canEdit}
                              className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100 disabled:bg-slate-100"
                            >
                              {progressOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                            <input
                              name="notes"
                              defaultValue={progress?.notes ?? ""}
                              placeholder="Instructor notes for this student"
                              disabled={!canEdit}
                              className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100 disabled:bg-slate-100"
                            />
                            {canEdit ? (
                              <button
                                type="submit"
                                className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-800"
                              >
                                Save
                              </button>
                            ) : null}
                          </div>
                        </form>
                      );
                    })
                  ) : (
                    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">
                      This syllabus template does not have figures yet. Add figures from the Syllabus page.
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <section className="rounded-[28px] border border-dashed border-[var(--brand-border)] bg-white p-8 text-center shadow-sm">
          <h4 className="text-lg font-semibold text-[var(--brand-text)]">
            No syllabus assigned yet
          </h4>
          <p className="mt-2 text-sm text-slate-600">
            Create syllabus templates from the Syllabus page, then assign one here to start tracking progress.
          </p>
          {canEdit ? (
            <Link
              href="/app/syllabus"
              className="mt-4 inline-flex rounded-full bg-[var(--brand-primary)] px-5 py-3 text-sm font-semibold text-white shadow-sm hover:opacity-90"
            >
              Manage Syllabus Templates
            </Link>
          ) : null}
        </section>
      )}
    </div>
  );
}

