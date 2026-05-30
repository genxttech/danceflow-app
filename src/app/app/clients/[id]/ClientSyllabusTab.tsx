"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
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

type StatusFilter = "all" | "active" | "not_started" | "mastered";

const progressOptions = [
  { value: "not_started", label: "Not Started" },
  { value: "introduced", label: "Introduced" },
  { value: "practicing", label: "Practicing" },
  { value: "comfortable", label: "Comfortable" },
  { value: "mastered", label: "Mastered" },
];

const activeStatuses = new Set(["introduced", "practicing", "comfortable"]);

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

function progressBarClass(percent: number) {
  if (percent >= 80) return "bg-emerald-500";
  if (percent >= 40) return "bg-purple-500";
  return "bg-orange-400";
}

function countAssignmentProgress(assignment: Assignment) {
  const template = normalizeTemplate(assignment.syllabus_templates);
  const items = sortItems(template?.syllabus_template_items);

  let notStarted = 0;
  let introduced = 0;
  let practicing = 0;
  let comfortable = 0;
  let mastered = 0;

  for (const item of items) {
    const status = getProgressForItem(assignment.client_syllabus_progress, item.id)?.status ?? "not_started";

    if (status === "mastered") mastered += 1;
    else if (status === "comfortable") comfortable += 1;
    else if (status === "practicing") practicing += 1;
    else if (status === "introduced") introduced += 1;
    else notStarted += 1;
  }

  const active = introduced + practicing + comfortable;
  const total = items.length;
  const started = total - notStarted;
  const percentMastered = total > 0 ? Math.round((mastered / total) * 100) : 0;

  return {
    total,
    started,
    active,
    notStarted,
    introduced,
    practicing,
    comfortable,
    mastered,
    percentMastered,
  };
}

function shouldShowItem(status: string, filter: StatusFilter) {
  if (filter === "all") return true;
  if (filter === "active") return activeStatuses.has(status);
  return status === filter;
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
  const assignableTemplates = templates.filter(
    (template) => template.active !== false && !assignedTemplateIds.has(template.id),
  );

  const [expandedAssignmentIds, setExpandedAssignmentIds] = useState<Set<string>>(() => {
    if (activeAssignments.length === 1 && activeAssignments[0]) {
      return new Set([activeAssignments[0].id]);
    }

    return new Set();
  });
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const summary = useMemo(() => {
    return activeAssignments.reduce(
      (totals, assignment) => {
        const counts = countAssignmentProgress(assignment);

        totals.totalItems += counts.total;
        totals.masteredItems += counts.mastered;
        totals.activeItems += counts.active;
        totals.notStartedItems += counts.notStarted;

        return totals;
      },
      {
        totalItems: 0,
        masteredItems: 0,
        activeItems: 0,
        notStartedItems: 0,
      },
    );
  }, [activeAssignments]);

  function toggleAssignment(assignmentId: string) {
    setExpandedAssignmentIds((current) => {
      const next = new Set(current);

      if (next.has(assignmentId)) next.delete(assignmentId);
      else next.add(assignmentId);

      return next;
    });
  }

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
                Assign existing syllabus templates to {clientName || "this student"}, then track progress
                without turning the profile into a long ledger.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm sm:min-w-[22rem] lg:grid-cols-4 lg:min-w-[32rem]">
              <div className="rounded-2xl border border-white/80 bg-white/85 p-4 shadow-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Assigned</p>
                <p className="mt-1 text-2xl font-semibold text-purple-800">{activeAssignments.length}</p>
              </div>
              <div className="rounded-2xl border border-white/80 bg-white/85 p-4 shadow-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Figures</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">{summary.totalItems}</p>
              </div>
              <div className="rounded-2xl border border-white/80 bg-white/85 p-4 shadow-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Active</p>
                <p className="mt-1 text-2xl font-semibold text-blue-700">{summary.activeItems}</p>
              </div>
              <div className="rounded-2xl border border-white/80 bg-white/85 p-4 shadow-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Mastered</p>
                <p className="mt-1 text-2xl font-semibold text-emerald-700">
                  {summary.masteredItems}/{summary.totalItems}
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
                Templates are created from the Syllabus page. This student page only assigns existing
                templates and tracks student-specific progress.
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
        <section className="space-y-4">
          <div className="flex flex-col gap-3 rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h4 className="font-semibold text-[var(--brand-text)]">Assigned syllabi</h4>
              <p className="mt-1 text-sm text-slate-600">
                Open a syllabus only when you need to review or update its figures.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {[
                { value: "all", label: "All" },
                { value: "active", label: "Active" },
                { value: "not_started", label: "Not Started" },
                { value: "mastered", label: "Mastered" },
              ].map((filter) => {
                const value = filter.value as StatusFilter;
                const isActive = statusFilter === value;

                return (
                  <button
                    key={filter.value}
                    type="button"
                    onClick={() => setStatusFilter(value)}
                    className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                      isActive
                        ? "border-purple-600 bg-purple-600 text-white"
                        : "border-slate-200 bg-white text-slate-600 hover:border-purple-200 hover:bg-purple-50"
                    }`}
                  >
                    {filter.label}
                  </button>
                );
              })}
            </div>
          </div>

          {activeAssignments.map((assignment) => {
            const template = normalizeTemplate(assignment.syllabus_templates);
            const items = sortItems(template?.syllabus_template_items);
            const counts = countAssignmentProgress(assignment);
            const isExpanded = expandedAssignmentIds.has(assignment.id);
            const filteredItems = items.filter((item) => {
              const status = getProgressForItem(assignment.client_syllabus_progress, item.id)?.status ?? "not_started";
              return shouldShowItem(status, statusFilter);
            });

            if (!template) return null;

            return (
              <section
                key={assignment.id}
                className="overflow-hidden rounded-[28px] border border-[var(--brand-border)] bg-white shadow-sm"
              >
                <div className="p-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <button
                      type="button"
                      onClick={() => toggleAssignment(assignment.id)}
                      className="min-w-0 flex-1 text-left"
                    >
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
                        ) : (
                          <span className="rounded-full bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600">
                            Internal only
                          </span>
                        )}
                      </div>
                      <h4 className="mt-3 text-xl font-semibold text-[var(--brand-text)]">
                        {template.name}
                      </h4>
                      <div className="mt-3 grid gap-2 text-sm text-slate-600 sm:grid-cols-3">
                        <p>{counts.started} of {counts.total} started</p>
                        <p>{counts.active} active</p>
                        <p>{counts.mastered} mastered</p>
                      </div>
                      <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className={`h-full rounded-full ${progressBarClass(counts.percentMastered)}`}
                          style={{ width: `${counts.percentMastered}%` }}
                        />
                      </div>
                      {template.description ? (
                        <p className="mt-3 line-clamp-2 text-sm leading-6 text-slate-600">
                          {template.description}
                        </p>
                      ) : null}
                    </button>

                    <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                      <button
                        type="button"
                        onClick={() => toggleAssignment(assignment.id)}
                        className="rounded-full border border-purple-200 px-4 py-2 text-sm font-semibold text-purple-700 hover:bg-purple-50"
                      >
                        {isExpanded ? "Hide figures" : "View progress"}
                      </button>

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
                  </div>
                </div>

                {isExpanded ? (
                  <div className="border-t border-slate-100 bg-slate-50/70 p-3 sm:p-4">
                    {items.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-5 text-sm text-slate-600">
                        This syllabus template does not have figures yet. Add figures from the Syllabus page.
                      </div>
                    ) : filteredItems.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-5 text-sm text-slate-600">
                        No figures match this filter.
                      </div>
                    ) : (
                      <div className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white">
                        {filteredItems.map((item, index) => {
                          const progress = getProgressForItem(assignment.client_syllabus_progress, item.id);
                          const currentStatus = progress?.status ?? "not_started";

                          return (
                            <details key={item.id} className="group">
                              <summary className="flex cursor-pointer list-none flex-col gap-2 px-4 py-3 hover:bg-purple-50/50 sm:flex-row sm:items-center sm:justify-between">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-xs font-medium text-slate-400">
                                      {index + 1}
                                    </span>
                                    <p className="font-medium text-slate-900">{item.title}</p>
                                    {item.category ? (
                                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                                        {item.category}
                                      </span>
                                    ) : null}
                                  </div>
                                  {progress?.notes ? (
                                    <p className="mt-1 line-clamp-1 text-xs text-slate-500">
                                      {progress.notes}
                                    </p>
                                  ) : item.description ? (
                                    <p className="mt-1 line-clamp-1 text-xs text-slate-500">
                                      {item.description}
                                    </p>
                                  ) : null}
                                </div>
                                <div className="flex items-center gap-2">
                                  <span
                                    className={`w-fit rounded-full border px-3 py-1 text-xs font-semibold ${progressPillClass(currentStatus)}`}
                                  >
                                    {getStatusLabel(currentStatus)}
                                  </span>
                                  <span className="text-xs font-semibold text-purple-700 group-open:hidden">
                                    Edit
                                  </span>
                                  <span className="hidden text-xs font-semibold text-purple-700 group-open:inline">
                                    Close
                                  </span>
                                </div>
                              </summary>

                              <form
                                action={updateClientSyllabusProgressAction}
                                className="border-t border-slate-100 bg-white px-4 py-4"
                              >
                                <input type="hidden" name="clientId" value={clientId} />
                                <input type="hidden" name="assignmentId" value={assignment.id} />
                                <input type="hidden" name="templateItemId" value={item.id} />
                                <input type="hidden" name="returnTo" value={`/app/clients/${clientId}?tab=syllabus`} />

                                {item.description ? (
                                  <p className="mb-3 rounded-2xl bg-slate-50 p-3 text-sm leading-6 text-slate-600">
                                    {item.description}
                                  </p>
                                ) : null}

                                <div className="grid gap-3 lg:grid-cols-[220px_1fr_auto]">
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
                            </details>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : null}
              </section>
            );
          })}
        </section>
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


