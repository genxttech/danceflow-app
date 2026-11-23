"use client";

import { useActionState } from "react";
import CopyCalendarFeedButton from "@/components/app/CopyCalendarFeedButton";
import ConfirmButton from "./ConfirmButton";

export type PanelState = {
  op?: "create" | "revoke" | "update";
  error?: string;
  message?: string;
  urls?: { https: string; webcal: string };
  prefix?: string;
};

type Action = (prev: PanelState, formData: FormData) => Promise<PanelState>;

export type PanelStatus = {
  tokenPrefix: string;
  detailLevel: "minimal" | "standard";
  includeClientIds: string[] | null;
  createdAt: string;
  lastAccessedAt: string | null;
  expiresAt: string;
} | null;

/**
 * One state slot for all three forms: only the LATEST result is shown, so a one-time link never stays on screen after the link
 * was turned off or replaced, and an old error never outlives a later success. The server re-renders `status` after each action.
 */
export default function FeedPanel({
  hidden,
  status,
  profiles,
  audience,
  createAction,
  revokeAction,
  updateAction,
}: {
  hidden: Record<string, string>;
  status: PanelStatus;
  profiles: Array<{ id: string; name: string }>;
  audience: "dancer" | "staff";
  createAction: Action;
  revokeAction: Action;
  updateAction: Action;
}) {
  const dispatch = async (prev: PanelState, formData: FormData): Promise<PanelState> => {
    const op = String(formData.get("op") ?? "create");
    const action = op === "revoke" ? revokeAction : op === "update" ? updateAction : createAction;
    return action(prev, formData);
  };
  const [state, formAction, pending] = useActionState(dispatch, {} as PanelState);
  const hiddenInputs = Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />);
  const included = new Set(status?.includeClientIds ?? profiles.map((p) => p.id));
  const detail = status?.detailLevel ?? "minimal";
  const active = Boolean(status) && state.op !== "revoke";
  const formKey = `${status?.tokenPrefix ?? "none"}-${detail}-${[...included].sort().join(",")}`;
  const showUrl = state.op === "create" && state.urls;

  return (
    <div className="space-y-6">
      <div role="status" aria-live="polite" className="space-y-3">
        {state.error ? (
          <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
            {state.error}
          </p>
        ) : null}
        {state.message && !showUrl ? <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{state.message}</p> : null}
        {showUrl ? (
          <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
            <p className="text-sm font-semibold text-emerald-900">{state.message}</p>
            <p className="mt-1 text-xs text-emerald-800">
              Anyone with this link can see the schedule it shows. We cannot show it again; if you lose it, replace the link.
            </p>
            <div className="mt-3">
              <CopyCalendarFeedButton feedUrl={state.urls!.https} buttonLabel="Copy link" />
            </div>
            <a className="mt-3 inline-block text-sm font-medium text-emerald-900 underline" href={state.urls!.webcal}>
              Open in my calendar app
            </a>
          </section>
        ) : null}
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-slate-900">{active ? "Your calendar link is on" : "Add your schedule to your calendar"}</h2>
        {active && status ? (
          <p className="mt-1 text-sm text-slate-600">
            Link starts with {status.tokenPrefix}… · created {new Date(status.createdAt).toLocaleDateString()} ·{" "}
            {status.lastAccessedAt ? `last used ${new Date(status.lastAccessedAt).toLocaleDateString()}` : "not used yet"} · expires {new Date(status.expiresAt).toLocaleDateString()}
          </p>
        ) : (
          <p className="mt-1 text-sm text-slate-600">
            Create a private link and subscribe to it in Apple Calendar, Google Calendar or Outlook. Calendar apps refresh on their own schedule, so changes may take a few hours to appear.
          </p>
        )}

        <form key={`create-${formKey}`} action={formAction} className="mt-4 space-y-3">
          <input type="hidden" name="op" value="create" />
          {hiddenInputs}
          <DetailFields audience={audience} detail={detail} profiles={profiles} included={included} />
          {active ? (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" name="keepOldLink" /> Keep the old link working for 1 hour
            </label>
          ) : null}
          {active ? (
            <ConfirmButton
              confirmLabel="Yes, replace link"
              disabled={pending}
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              Replace link
            </ConfirmButton>
          ) : (
            <button type="submit" disabled={pending} className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
              Create my link
            </button>
          )}
          {active ? <p className="text-xs text-slate-500">Replacing the link stops the current link from working, unless you keep it for an hour.</p> : null}
        </form>
      </section>

      {active ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <h3 className="text-base font-semibold text-slate-900">Settings</h3>
          <form key={`update-${formKey}`} action={formAction} className="mt-3 space-y-3">
            <input type="hidden" name="op" value="update" />
            {hiddenInputs}
            <DetailFields audience={audience} detail={detail} profiles={profiles} included={included} />
            <button type="submit" disabled={pending} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800 disabled:opacity-60">
              Save settings
            </button>
          </form>
          <form action={formAction} className="mt-4 border-t border-slate-100 pt-4">
            <input type="hidden" name="op" value="revoke" />
            {hiddenInputs}
            <ConfirmButton confirmLabel="Yes, turn off" disabled={pending} className="rounded-xl border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 disabled:opacity-60">
              Turn off link
            </ConfirmButton>
            <p className="mt-2 text-xs text-slate-500">Calendars using this link will stop updating immediately, including any previous link kept for an hour.</p>
          </form>
        </section>
      ) : null}
    </div>
  );
}

function DetailFields({
  audience,
  detail,
  profiles,
  included,
}: {
  audience: "dancer" | "staff";
  detail: "minimal" | "standard";
  profiles: Array<{ id: string; name: string }>;
  included: Set<string>;
}) {
  return (
    <>
      <fieldset>
        <legend className="text-sm font-medium text-slate-800">What your calendar shows</legend>
        <label className="mt-1 flex items-start gap-2 text-sm text-slate-700">
          <input type="radio" name="detailLevel" value="minimal" defaultChecked={detail === "minimal"} />
          <span>Times, place and lesson or class type only (recommended)</span>
        </label>
        <label className="mt-1 flex items-start gap-2 text-sm text-slate-700">
          <input type="radio" name="detailLevel" value="standard" defaultChecked={detail === "standard"} />
          <span>{audience === "dancer" ? "Also show the instructor's first name" : "Also show the student's first name and last initial (first name only for anyone under 18 or with no birth date on file)"}</span>
        </label>
      </fieldset>
      {audience === "dancer" && profiles.length > 1 ? (
        <fieldset>
          <legend className="text-sm font-medium text-slate-800">Whose schedule to include (choose at least one)</legend>
          {profiles.map((p) => (
            <label key={p.id} className="mt-1 flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" name="includeClientId" value={p.id} defaultChecked={included.has(p.id)} /> {p.name}
            </label>
          ))}
          <p className="mt-1 text-xs text-slate-500">Choosing everyone also includes profiles linked to your account later.</p>
        </fieldset>
      ) : null}
    </>
  );
}
