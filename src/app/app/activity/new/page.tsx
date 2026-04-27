import Link from "next/link";

export default function NewActivityPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <section className="overflow-hidden rounded-[28px] border border-violet-100 bg-gradient-to-br from-violet-50 via-white to-amber-50 p-6 shadow-sm md:p-8">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-violet-700">
              DanceFlow CRM
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
              Log Lead Activity
            </h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
              Activity is connected to a specific lead or client so notes,
              calls, texts, emails, and follow-ups stay attached to the right
              person.
            </p>
          </div>

          <Link
            href="/app/leads"
            className="inline-flex items-center justify-center rounded-xl bg-slate-950 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            Choose a Lead
          </Link>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-950">
          How to log activity
        </h2>

        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-950">
              1. Open Leads
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Start from the lead list so you can choose the person this
              activity belongs to.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-950">
              2. Open the client record
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Use the client detail page to keep contact history in one place.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-950">
              3. Save the follow-up
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Log calls, texts, emails, notes, and next follow-up dates.
            </p>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/app/leads"
            className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700"
          >
            Go to Leads
          </Link>

          <Link
            href="/app/clients"
            className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Go to Clients
          </Link>
        </div>
      </section>
    </div>
  );
}