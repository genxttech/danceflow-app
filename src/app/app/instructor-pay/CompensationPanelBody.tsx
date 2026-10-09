import Link from "next/link";
import {
  describeCompensationActor,
  describeCompensationChange,
  describeCompensationChangeDetails,
  describeCompensationChangeType,
  describeCurrentCompensation,
  formatCompensationTimestamp,
  type CompensationHistoryRow,
  type CompensationRuleValues,
} from "@/lib/compensation/compensation-history";
import { saveInstructorCompensationRuleAction } from "./actions";

export type CompensationPanelRule = Partial<CompensationRuleValues> | null;

export type CompensationPanelBodyProps = {
  instructorId: string;
  rule: CompensationPanelRule;
  workerClassification: string | null;
  history: CompensationHistoryRow[];
  historyUnavailable?: boolean;
  timeZone?: string | null;
  mode: "view" | "edit";
  editHref: string;
  viewHref: string;
};

function classificationLabel(value: string | null) {
  if (value === "contractor") return "Contractor";
  if (value === "employee") return "Employee";
  if (value === "owner") return "Owner";
  return "Not set";
}

const inputClass = "mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm";

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function CurrentCompensation({
  rule,
  workerClassification,
  editHref,
}: {
  rule: CompensationPanelRule;
  workerClassification: string | null;
  editHref: string;
}) {
  const current = describeCurrentCompensation(rule);
  return (
    <section aria-labelledby="current-compensation-heading" className="space-y-4 p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 id="current-compensation-heading" className="text-base font-semibold text-slate-950">
          Current compensation
        </h3>
        <Link
          href={editHref}
          className="rounded-2xl bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800"
        >
          {rule ? "Edit compensation" : "Set up compensation"}
        </Link>
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Private lessons</dt>
          <dd className="mt-1 font-semibold text-slate-950">{current.privateLesson}</dd>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Group classes</dt>
          <dd className="mt-1 font-semibold text-slate-950">{current.groupClass}</dd>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Worker classification</dt>
          <dd className="mt-1 font-semibold text-slate-950">{classificationLabel(workerClassification)}</dd>
        </div>
        {rule?.notes ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Internal note</dt>
            <dd className="mt-1 text-slate-700">{rule.notes}</dd>
          </div>
        ) : null}
      </dl>
      {!current.configured ? (
        <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          DanceFlow only stages earnings for instructors with a configured rule.
        </p>
      ) : null}
      <p className="text-xs text-slate-500">
        Changing a rule affects earnings staged from now on. Earnings already created, approved or paid keep the values they were created with.
      </p>
    </section>
  );
}

function History({
  history,
  hasRule,
  unavailable,
  timeZone,
}: {
  history: CompensationHistoryRow[];
  hasRule: boolean;
  unavailable?: boolean;
  timeZone?: string | null;
}) {
  return (
    <section aria-labelledby="compensation-history-heading" className="space-y-3 border-t border-violet-100 p-5">
      <h3 id="compensation-history-heading" className="text-base font-semibold text-slate-950">
        History
      </h3>
      {unavailable ? (
        <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          History could not be loaded right now. Refresh to try again.
        </p>
      ) : history.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-4 text-sm text-slate-600">
          {hasRule
            ? "No changes have been recorded yet. This rule was set up before change history began; edits from now on will appear here."
            : "No compensation has been set up for this instructor yet. Once a rule is saved, each change will be recorded here."}
        </p>
      ) : (
        <ol className="space-y-3" data-testid="compensation-history-list">
          {history.map((row) => {
            const lines = describeCompensationChange(row);
            const details = describeCompensationChangeDetails(row);
            return (
              <li key={row.id} className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-violet-700">
                    {describeCompensationChangeType(row.change_type)}
                  </p>
                  <p className="text-xs text-slate-500">{formatCompensationTimestamp(row.changed_at, timeZone)}</p>
                </div>
                <p className="mt-1 text-xs text-slate-600">By {describeCompensationActor(row)}</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-900">
                  {lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                {details.length > 0 ? (
                  <details className="mt-3 text-sm">
                    <summary className="cursor-pointer text-xs font-semibold text-violet-700">Full details</summary>
                    <table className="mt-2 w-full text-left text-xs">
                      <thead>
                        <tr className="text-slate-500">
                          <th className="py-1 pr-2 font-semibold">Setting</th>
                          <th className="py-1 pr-2 font-semibold">Before</th>
                          <th className="py-1 font-semibold">After</th>
                        </tr>
                      </thead>
                      <tbody>
                        {details.map((detail) => (
                          <tr key={detail.label} className="border-t border-slate-100 text-slate-800">
                            <td className="py-1 pr-2">{detail.label}</td>
                            <td className="py-1 pr-2">{detail.before}</td>
                            <td className="py-1 font-semibold">{detail.after}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function EditForm({
  instructorId,
  rule,
  viewHref,
}: {
  instructorId: string;
  rule: CompensationPanelRule;
  viewHref: string;
}) {
  return (
    <form action={saveInstructorCompensationRuleAction} className="space-y-4 p-5" data-testid="compensation-edit-form">
      <input type="hidden" name="instructorId" value={instructorId} />
      <h3 className="text-base font-semibold text-slate-950">Edit compensation</h3>

      <div className="rounded-2xl bg-slate-50 p-4">
        <p className="text-sm font-semibold text-slate-950">Private lessons</p>
        <label className="mt-3 block text-sm font-medium text-slate-700">
          Rule
          <select name="privateLessonPayMode" defaultValue={rule?.private_lesson_pay_mode ?? "none"} className={inputClass}>
            <option value="none">Not configured</option>
            <option value="flat">Flat rate</option>
            <option value="percentage">Percentage of lesson value</option>
          </select>
        </label>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="text-sm font-medium text-slate-700">
            Flat $
            <input name="privateLessonFlatAmount" type="number" step="0.01" min="0" defaultValue={numberValue(rule?.private_lesson_flat_amount)} className={inputClass} />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Percent
            <input name="privateLessonPercentage" type="number" step="0.01" min="0" max="100" defaultValue={numberValue(rule?.private_lesson_percentage)} className={inputClass} />
          </label>
        </div>
        <label className="mt-3 flex items-start gap-2 rounded-2xl border border-slate-200 bg-white p-3 text-sm text-slate-700">
          <input name="privateLessonDurationRatesEnabled" type="checkbox" defaultChecked={Boolean(rule?.private_lesson_duration_rates_enabled)} className="mt-1" />
          <span>Use duration rates for flat-rate private lessons</span>
        </label>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <label className="text-sm font-medium text-slate-700">
            30 min $
            <input name="privateLesson30MinFlatAmount" type="number" step="0.01" min="0" defaultValue={numberValue(rule?.private_lesson_30_min_flat_amount)} className={inputClass} />
          </label>
          <label className="text-sm font-medium text-slate-700">
            45 min $
            <input name="privateLesson45MinFlatAmount" type="number" step="0.01" min="0" defaultValue={numberValue(rule?.private_lesson_45_min_flat_amount)} className={inputClass} />
          </label>
          <label className="text-sm font-medium text-slate-700">
            60 min $
            <input name="privateLesson60MinFlatAmount" type="number" step="0.01" min="0" defaultValue={numberValue(rule?.private_lesson_60_min_flat_amount)} className={inputClass} />
          </label>
        </div>
      </div>

      <div className="rounded-2xl bg-slate-50 p-4">
        <p className="text-sm font-semibold text-slate-950">Group classes</p>
        <label className="mt-3 block text-sm font-medium text-slate-700">
          Rule
          <select name="groupClassPayMode" defaultValue={rule?.group_class_pay_mode ?? "none"} className={inputClass}>
            <option value="none">Not configured</option>
            <option value="flat">Flat rate</option>
            <option value="percentage">Percentage of class value</option>
            <option value="per_attendee">Per attended student</option>
          </select>
        </label>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <label className="text-sm font-medium text-slate-700">
            Flat $
            <input name="groupClassFlatAmount" type="number" step="0.01" min="0" defaultValue={numberValue(rule?.group_class_flat_amount)} className={inputClass} />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Percent
            <input name="groupClassPercentage" type="number" step="0.01" min="0" max="100" defaultValue={numberValue(rule?.group_class_percentage)} className={inputClass} />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Per student $
            <input name="groupClassPerAttendeeAmount" type="number" step="0.01" min="0" defaultValue={numberValue(rule?.group_class_per_attendee_amount)} className={inputClass} />
          </label>
        </div>
      </div>

      <label className="block text-sm font-medium text-slate-700">
        Notes
        <input name="notes" maxLength={1000} defaultValue={rule?.notes ?? ""} className={inputClass} placeholder="Optional internal note" />
      </label>

      <p className="text-xs text-slate-500">
        Amounts that do not apply to the selected rule are cleared when you save. Percentages are 0 to 100; amounts cannot be negative.
      </p>

      <div className="flex items-center gap-3">
        <button className="rounded-2xl bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800">
          Save compensation
        </button>
        <Link href={viewHref} className="text-sm font-semibold text-slate-600 hover:text-slate-900">
          Cancel
        </Link>
      </div>
    </form>
  );
}

export default function CompensationPanelBody({
  instructorId,
  rule,
  workerClassification,
  history,
  historyUnavailable,
  timeZone,
  mode,
  editHref,
  viewHref,
}: CompensationPanelBodyProps) {
  if (mode === "edit") {
    return (
      <div>
        <EditForm instructorId={instructorId} rule={rule} viewHref={viewHref} />
        <History history={history} hasRule={Boolean(rule)} unavailable={historyUnavailable} timeZone={timeZone} />
      </div>
    );
  }
  return (
    <div>
      <CurrentCompensation rule={rule} workerClassification={workerClassification} editHref={editHref} />
      <History history={history} hasRule={Boolean(rule)} unavailable={historyUnavailable} timeZone={timeZone} />
    </div>
  );
}
