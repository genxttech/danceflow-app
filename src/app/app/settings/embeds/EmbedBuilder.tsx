"use client";

import { useMemo, useState } from "react";
import {
  buildEmbedCode,
  DEFAULT_ACCENT,
  embedCalendarPath,
  embedClassPath,
  normalizeAccent,
  type EmbedOptions,
  type EmbedTheme,
  type EmbedView,
} from "@/lib/public/embedOptions";

type Props = {
  origin: string;
  studioSlug: string;
  studioName: string;
  defaultAccent: string | null;
  classes: { id: string; label: string }[];
  instructors: string[];
};

const GUIDES = [
  { name: "WordPress", steps: "Edit the page, add a Custom HTML block, paste the code, then Update." },
  { name: "Wix", steps: "Add > Embed Code > Embed HTML, choose Code, paste, then Apply. Drag the box to the width you want." },
  { name: "Squarespace", steps: "Edit the page, add a Code block, paste (turn off Display Source), then Save. Check that your Squarespace plan allows code blocks." },
  { name: "Plain HTML", steps: "Paste the code into your page where the schedule should appear." },
];

export default function EmbedBuilder({ origin, studioSlug, studioName, defaultAccent, classes, instructors }: Props) {
  const [kind, setKind] = useState<"calendar" | "class">("calendar");
  const [classId, setClassId] = useState(classes[0]?.id ?? "");
  const [view, setView] = useState<EmbedView>("agenda");
  const [theme, setTheme] = useState<EmbedTheme>("light");
  const [accentText, setAccentText] = useState(defaultAccent ?? DEFAULT_ACCENT);
  const [instructor, setInstructor] = useState("");
  const [copied, setCopied] = useState<"code" | "link" | null>(null);

  const accent = normalizeAccent(accentText) ?? DEFAULT_ACCENT;
  const accentInvalid = accentText.trim() !== "" && !normalizeAccent(accentText);

  const { path, title } = useMemo(() => {
    const o: Partial<EmbedOptions> = { accent, theme };
    if (kind === "class") return { path: embedClassPath(classId, o), title: "Dance class registration" };
    return {
      path: embedCalendarPath(studioSlug, { ...o, view, instructor: instructor || null }),
      title: `${studioName} class schedule`,
    };
  }, [kind, classId, view, theme, accent, instructor, studioSlug, studioName]);

  const disabled = kind === "class" && !classId;
  const code = disabled ? "" : buildEmbedCode({ origin, path, title, minHeight: kind === "class" ? 320 : 520 });
  const fallbackLink = kind === "class" ? `${origin}/studios/${encodeURIComponent(studioSlug)}/classes/${classId}` : `${origin}/studios/${encodeURIComponent(studioSlug)}/classes`;

  async function copy(text: string, which: "code" | "link") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  }

  const field = "mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900";
  const label = "block text-sm font-semibold text-slate-800";

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <section className="space-y-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm" aria-label="Embed options">
        <fieldset>
          <legend className={label}>What do you want to show?</legend>
          <div className="mt-2 flex gap-2">
            {(["calendar", "class"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={`rounded-full px-4 py-2 text-sm font-semibold ${kind === k ? "bg-slate-950 text-white" : "bg-slate-100 text-slate-800"}`}
              >
                {k === "calendar" ? "Class calendar" : "One class"}
              </button>
            ))}
          </div>
        </fieldset>

        {kind === "class" ? (
          <div>
            <label htmlFor="embed-class" className={label}>
              Class
            </label>
            {classes.length ? (
              <select id="embed-class" className={field} value={classId} onChange={(e) => setClassId(e.target.value)}>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            ) : (
              <p className="mt-1 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
                No upcoming public classes. Make a class publicly discoverable to embed it.
              </p>
            )}
            <p className="mt-1 text-xs text-slate-500">For a recurring class, the embed shows this date and links to all dates.</p>
          </div>
        ) : (
          <>
            <div>
              <label htmlFor="embed-view" className={label}>
                Starting view
              </label>
              <select id="embed-view" className={field} value={view} onChange={(e) => setView(e.target.value as EmbedView)}>
                <option value="agenda">List</option>
                <option value="week">Week</option>
                <option value="month">Month</option>
              </select>
              <p className="mt-1 text-xs text-slate-500">Visitors can switch views themselves.</p>
            </div>
            {instructors.length > 1 ? (
              <div>
                <label htmlFor="embed-instructor" className={label}>
                  Instructor
                </label>
                <select id="embed-instructor" className={field} value={instructor} onChange={(e) => setInstructor(e.target.value)}>
                  <option value="">All instructors</option>
                  {instructors.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </>
        )}

        <div>
          <label htmlFor="embed-accent" className={label}>
            Button color
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="color"
              aria-label="Pick a button color"
              value={accent}
              onChange={(e) => setAccentText(e.target.value)}
              className="h-10 w-12 rounded-lg border border-slate-300"
            />
            <input
              id="embed-accent"
              className={field.replace("mt-1 ", "")}
              value={accentText}
              onChange={(e) => setAccentText(e.target.value)}
              aria-invalid={accentInvalid}
              aria-describedby={accentInvalid ? "embed-accent-err" : undefined}
              placeholder="#1e293b"
            />
          </div>
          {accentInvalid ? (
            <p id="embed-accent-err" role="alert" className="mt-1 text-xs text-rose-700">
              Use a 6-digit color such as #7a1f5c. The default is used until then.
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="embed-theme" className={label}>
            Background
          </label>
          <select id="embed-theme" className={field} value={theme} onChange={(e) => setTheme(e.target.value as EmbedTheme)}>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
      </section>

      <div className="space-y-6">
        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm" aria-label="Preview">
          <h2 className="text-base font-semibold text-slate-950">Preview</h2>
          <p className="mt-1 text-xs text-slate-500">This is the live embed, exactly as visitors will see it.</p>
          {disabled ? (
            <p className="mt-4 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">Choose a class to preview it.</p>
          ) : (
            <iframe
              key={path}
              src={path}
              title="Embed preview"
              className="mt-3 h-[520px] w-full rounded-2xl border border-slate-200"
            />
          )}
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm" aria-label="Embed code">
          <h2 className="text-base font-semibold text-slate-950">Your embed code</h2>
          <textarea
            readOnly
            aria-label="Embed code"
            value={code}
            rows={9}
            onFocus={(e) => e.currentTarget.select()}
            className="mt-3 w-full rounded-xl border border-slate-300 bg-slate-50 p-3 font-mono text-xs text-slate-800"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() => copy(code, "code")}
              className="rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {copied === "code" ? "Copied" : "Copy embed code"}
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => copy(fallbackLink, "link")}
              className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-800 disabled:opacity-50"
            >
              {copied === "link" ? "Copied" : "Copy plain link"}
            </button>
          </div>
          <p role="status" className="sr-only" aria-live="polite">
            {copied ? "Copied to clipboard" : ""}
          </p>
          <p className="mt-3 text-xs text-slate-500">
            If your website builder will not accept embed code, share the plain link instead: <span className="break-all font-mono">{disabled ? "" : fallbackLink}</span>
          </p>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm" aria-label="Installation">
          <h2 className="text-base font-semibold text-slate-950">How to add it to your website</h2>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            {GUIDES.map((g) => (
              <div key={g.name} className="rounded-2xl bg-slate-50 p-3">
                <dt className="font-semibold text-slate-900">{g.name}</dt>
                <dd className="mt-1 text-slate-600">{g.steps}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-slate-500">
            The schedule resizes itself to fit your page. If the box looks cut off, give it more height in your website editor.
          </p>
        </section>
      </div>
    </div>
  );
}
