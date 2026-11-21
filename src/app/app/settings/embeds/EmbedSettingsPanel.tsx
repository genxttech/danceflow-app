"use client";

import { useActionState } from "react";
import type { EmbedSettings } from "@/lib/public/embedSettings";
import { saveEmbedSettingsAction, type EmbedSettingsActionState } from "./actions";

const field = "mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900";
const check = "flex items-start gap-3 rounded-xl border border-slate-200 p-3 text-sm";

export default function EmbedSettingsPanel({ settings, unavailable }: { settings: EmbedSettings; unavailable: boolean }) {
  const [state, action, pending] = useActionState<EmbedSettingsActionState, FormData>(saveEmbedSettingsAction, null);
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm" aria-label="Embed settings">
      <h2 className="text-base font-semibold text-slate-950">Embed settings</h2>
      <p className="mt-1 text-sm text-slate-600">These apply to every embed you have pasted, and changes show on your website right away.</p>
      {unavailable ? (
        <p role="alert" className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-950">
          Embed settings are not available yet. Your embeds will not display until this feature is fully set up.
        </p>
      ) : null}
      <form action={action} className="mt-4 grid gap-3">
        <label className={check}>
          <input type="checkbox" name="embedsEnabled" defaultChecked={settings.embedsEnabled} className="mt-1" />
          <span>
            <span className="block font-semibold text-slate-900">Embeds are on</span>
            <span className="text-slate-600">Turn this off to stop every embed on your website at once. Visitors see nothing until you turn it back on.</span>
          </span>
        </label>
        <label className={check}>
          <input type="checkbox" name="showEvents" defaultChecked={settings.showEvents} className="mt-1" />
          <span>
            <span className="block font-semibold text-slate-900">Show public events in the calendar</span>
            <span className="text-slate-600">Only events you have published to the public directory. Each links to its DanceFlow page.</span>
          </span>
        </label>
        <label className={check}>
          <input type="checkbox" name="showClassDescription" defaultChecked={settings.showClassDescription} className="mt-1" />
          <span>
            <span className="block font-semibold text-slate-900">Show class descriptions</span>
            <span className="text-slate-600">Uses the description you wrote for a recurring class series. Anything you write there becomes public.</span>
          </span>
        </label>
        <label className={check}>
          <input type="checkbox" name="showClassPrice" defaultChecked={settings.showClassPrice} className="mt-1" />
          <span>
            <span className="block font-semibold text-slate-900">Show class prices</span>
            <span className="text-slate-600">Only classes that accept a direct payment, at the price dancers are charged when they register.</span>
          </span>
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="stored-view" className="block text-sm font-semibold text-slate-800">
              Starting view
            </label>
            <select id="stored-view" name="defaultView" defaultValue={settings.defaultView} className={field}>
              <option value="agenda">List</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </select>
          </div>
          <div>
            <label htmlFor="stored-theme" className="block text-sm font-semibold text-slate-800">
              Background
            </label>
            <select id="stored-theme" name="defaultTheme" defaultValue={settings.defaultTheme} className={field}>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
          <div>
            <label htmlFor="stored-accent" className="block text-sm font-semibold text-slate-800">
              Button color
            </label>
            <input id="stored-accent" name="defaultAccent" defaultValue={settings.defaultAccent ?? ""} placeholder="#1e293b" className={field} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={pending || unavailable} className="rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
            {pending ? "Saving…" : "Save settings"}
          </button>
          <p role="status" aria-live="polite" className={`text-sm ${state?.ok ? "text-emerald-800" : "text-rose-800"}`}>
            {state?.message ?? ""}
          </p>
        </div>
      </form>
    </section>
  );
}
