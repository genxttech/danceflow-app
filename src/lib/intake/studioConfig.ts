/**
 * Student Intake studio configuration view model (pure shaping; no I/O).
 * Rows come from the staff-readable config tables (RLS: active staff of that studio), loaded with the signed-in
 * user's client. Every row is filtered by studio id again here so a mixed result can never leak across studios.
 */

export const SERVICE_TYPES = ["private_lesson", "intro_lesson", "coaching"] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];
export const SERVICE_TYPE_LABEL: Record<ServiceType, string> = {
  private_lesson: "Private lessons",
  intro_lesson: "Intro lessons",
  coaching: "Coaching",
};

export type SettingsRow = {
  studio_id: string;
  enabled: boolean;
  enabled_at: string | null;
  default_template_id: string | null;
};
export type TemplateRow = { id: string; studio_id: string; name: string; status: "active" | "archived"; created_at?: string };
export type VersionRow = {
  id: string;
  studio_id: string;
  template_id: string;
  version_number: number;
  status: "draft" | "published" | "archived";
  published_at: string | null;
};
/** A row means the lesson type is selected; a NULL template means "use the studio default form". */
export type AssignmentRow = { studio_id: string; appointment_type: string; template_id: string | null };

export type TemplateView = {
  id: string;
  name: string;
  archived: boolean;
  isDefault: boolean;
  publishedVersion: { id: string; number: number; publishedAt: string | null } | null;
  draftVersion: { id: string; number: number } | null;
  assignedTypes: ServiceType[];
};

export type ConfigView = {
  enabled: boolean;
  enabledAt: string | null;
  defaultTemplateId: string | null;
  templates: TemplateView[];
  /** Lesson types that ask for intake (a row exists). Types without a row never qualify. */
  selected: Record<ServiceType, boolean>;
  /** Explicit form per selected type; null = the studio default. */
  assignments: Record<ServiceType, string | null>;
};

export function shapeConfig(
  studioId: string,
  rows: { settings: SettingsRow | null; templates: TemplateRow[]; versions: VersionRow[]; assignments: AssignmentRow[] },
): ConfigView {
  const settings = rows.settings && rows.settings.studio_id === studioId ? rows.settings : null;
  const versions = rows.versions.filter((v) => v.studio_id === studioId);
  const assignments = rows.assignments.filter((a) => a.studio_id === studioId);
  const assignmentByType: Record<ServiceType, string | null> = { private_lesson: null, intro_lesson: null, coaching: null };
  const selectedByType: Record<ServiceType, boolean> = { private_lesson: false, intro_lesson: false, coaching: false };
  for (const a of assignments) {
    if ((SERVICE_TYPES as readonly string[]).includes(a.appointment_type)) {
      assignmentByType[a.appointment_type as ServiceType] = a.template_id;
      selectedByType[a.appointment_type as ServiceType] = true;
    }
  }
  const templates: TemplateView[] = rows.templates
    .filter((t) => t.studio_id === studioId)
    .map((t) => {
      const own = versions.filter((v) => v.template_id === t.id);
      const published = own.filter((v) => v.status === "published").sort((a, b) => b.version_number - a.version_number)[0];
      const draft = own.find((v) => v.status === "draft");
      return {
        id: t.id,
        name: t.name,
        archived: t.status === "archived",
        isDefault: settings?.default_template_id === t.id,
        publishedVersion: published ? { id: published.id, number: published.version_number, publishedAt: published.published_at } : null,
        draftVersion: draft ? { id: draft.id, number: draft.version_number } : null,
        assignedTypes: SERVICE_TYPES.filter((type) => assignmentByType[type] === t.id),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    enabled: settings?.enabled === true,
    enabledAt: settings?.enabled_at ?? null,
    defaultTemplateId: settings?.default_template_id ?? null,
    templates,
    selected: selectedByType,
    assignments: assignmentByType,
  };
}

export type NextAction =
  | { kind: "create_template"; title: string; detail: string }
  | { kind: "publish_template"; title: string; detail: string; templateId: string }
  | { kind: "choose_default"; title: string; detail: string }
  | { kind: "turn_on"; title: string; detail: string }
  | { kind: "review_preview"; title: string; detail: string };

/** The single most useful next step, in order. */
export function nextAction(view: ConfigView): NextAction {
  const live = view.templates.filter((t) => !t.archived);
  if (live.length === 0)
    return { kind: "create_template", title: "Create your first intake form", detail: "Start from a short template and make it yours." };
  const published = live.filter((t) => t.publishedVersion);
  if (published.length === 0)
    return {
      kind: "publish_template",
      title: "Publish your form",
      detail: "Students only ever see published versions. Review it, then publish.",
      templateId: live[0].id,
    };
  const def = live.find((t) => t.isDefault);
  if (!def || !def.publishedVersion)
    return { kind: "choose_default", title: "Choose your default form", detail: "The default is used for every lesson type you have not assigned a form to." };
  if (!view.enabled)
    return { kind: "turn_on", title: "Turn on Student Intake", detail: "Only lessons booked after you turn it on are ever considered." };
  return { kind: "review_preview", title: "Review who would be asked", detail: "See upcoming lessons and why each does or does not qualify." };
}

/** Whether Student Intake can be switched on: a default template with a published version must exist. */
export function canTurnOn(view: ConfigView): boolean {
  const def = view.templates.find((t) => t.isDefault && !t.archived);
  return Boolean(def?.publishedVersion);
}
