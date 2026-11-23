"use client";

import { useActionState } from "react";
import CopyCalendarFeedButton from "@/components/app/CopyCalendarFeedButton";

export type PanelState = {
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
} | null;

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
  const [created, createForm, creating] = useActionState(createAction, {});
  const [revoked, revokeForm, revoking] = useActionState(revokeAction, {});
  const [updated, updateForm, updating] = useActionState(updateAction, {});
  const hiddenInputs = Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />);
  const included = new Set(status?.includeClientIds ?? profiles.map((p) => p.id));
  const detail = status?.detailLevel ?? "minimal";
  const justRevoked = Boolean(revoked.message) && !created.urls;
  const active = Boolean(status) && !justRevoked;

  return (
    <div className="space-y-6">
      {created.urls ? (
        <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5" aria-live="polite">
          <p className="text-sm font-semibold text-emerald-900">{created.message}</p>
          <p className="mt-1 text-xs text-emerald-800">
            Anyone with this link can see the schedule it shows. We cannot show it again; if you lose it, replace the link.
          </p>
          <div className="mt-3">
            <CopyCalendarFeedButton feedUrl={created.urls.https} buttonLabel="Copy link" />
          </div>
          <a className="mt-3 inline-block text-sm font-medium text-emerald-900 underline" href={created.urls.webcal}>
            Open in my calendar app
          </a>
        </section>
      ) : null}

      {created.error || revoked.error || updated.error ? (
        <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {created.error || revoked.error || updated.error}
        </p>
      ) : null}
      {revoked.message && !created.urls ? <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{revoked.message}</p> : null}
      {updated.message ? <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{updated.message}</p> : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-slate-900">{active ? "Your calendar link is on" : "Add your schedule to your calendar"}</h2>
        {active && status ? (
          <p className="mt-1 text-sm text-slate-600">
            Link ending style: {status.tokenPrefix}… · created {new Date(status.createdAt).toLocaleDateString()} ·{" "}
            {status.lastAccessedAt ? `last used ${new Date(status.lastAccessedAt).toLocaleDateString()}` : "not used yet"}
          </p>
        ) : (
          <p className="mt-1 text-sm text-slate-600">
            Create a private link and subscribe to it in Apple Calendar, Google Calendar or Outlook. Calendar apps refresh on their own schedule, so changes may take a few hours to appear.
          </p>
        )}

        <form action={createForm} className="mt-4 space-y-3">
          {hiddenInputs}
          <DetailFields audience={audience} detail={detail} profiles={profiles} included={included} />
          {active ? (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" name="keepOldLink" /> Keep the old link working for 1 hour
            </label>
          ) : null}
          <button type="submit" disabled={creating} className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
            {active ? "Replace link" : "Create my link"}
          </button>
        </form>
      </section>

      {active ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <h3 className="text-base font-semibold text-slate-900">Settings</h3>
          <form action={updateForm} className="mt-3 space-y-3">
            {hiddenInputs}
            <DetailFields audience={audience} detail={detail} profiles={profiles} included={included} />
            <button type="submit" disabled={updating} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800 disabled:opacity-60">
              Save settings
            </button>
          </form>
          <form action={revokeForm} className="mt-4 border-t border-slate-100 pt-4">
            {hiddenInputs}
            <button type="submit" disabled={revoking} className="rounded-xl border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 disabled:opacity-60">
              Turn off link
            </button>
            <p className="mt-2 text-xs text-slate-500">Calendars using this link will stop updating immediately.</p>
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
          <span>{audience === "dancer" ? "Also show the instructor's first name" : "Also show the student's first name and last initial (first name only for anyone under 18)"}</span>
        </label>
      </fieldset>
      {audience === "dancer" && profiles.length > 1 ? (
        <fieldset>
          <legend className="text-sm font-medium text-slate-800">Whose schedule to include</legend>
          {profiles.map((p) => (
            <label key={p.id} className="mt-1 flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" name="includeClientId" value={p.id} defaultChecked={included.has(p.id)} /> {p.name}
            </label>
          ))}
        </fieldset>
      ) : null}
    </>
  );
}
