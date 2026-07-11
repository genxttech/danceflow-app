import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import { assignCompetitionEntryNumberAction, updateCompetitionEntryEligibilityAction } from "./actions";

type Entry = { id: string; program_id: string; division_id: string; registration_cart_id: string | null; order_id: string | null; display_name: string; represented_studio_name: string | null; entry_number: string | null; status: string; eligibility_status: string; metadata: Record<string, unknown>; created_at: string };
type Participant = { entry_id: string; participant_role: string; display_name: string };
type EntryDance = { entry_id: string; dance_label: string; fee_amount: number | string; currency: string; status: string };
type Program = { id: string; name: string; discipline_family: string };
type Division = { id: string; contest_id: string | null; name: string; age_label: string | null; skill_label: string | null; role_label: string | null };
type Contest = { id: string; name: string };
type Cart = { id: string; order_id: string | null; registration_mode: string; buyer_name: string | null; buyer_email: string | null; registering_studio_name: string | null; status: string; quoted_total: number | string; currency: string; created_at: string };
type Order = { id: string; payment_status: string; status: string; total_amount: number | string; currency: string };

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function money(value: number | string, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(Number(value ?? 0));
}

function badge(value: string) {
  if (["paid", "confirmed", "eligible", "submitted"].includes(value)) return "bg-emerald-50 text-emerald-800";
  if (["pending", "unverified", "needs_review", "checkout_pending"].includes(value)) return "bg-amber-50 text-amber-800";
  if (["failed", "cancelled", "withdrawn", "ineligible", "refunded"].includes(value)) return "bg-rose-50 text-rose-800";
  return "bg-slate-100 text-slate-700";
}

export default async function CompetitionRegistrationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string; eligibility?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const context = await getCurrentStudioContext();
  const { data: event, error: eventError } = await supabase.from("events").select("id, name").eq("id", id).eq("studio_id", context.studioId).maybeSingle();
  if (eventError || !event) notFound();

  const [entryResult, participantResult, danceResult, programResult, divisionResult, contestResult, cartResult, orderResult] = await Promise.all([
    (supabase as any).from("event_competition_entries").select("id, program_id, division_id, registration_cart_id, order_id, display_name, represented_studio_name, entry_number, status, eligibility_status, metadata, created_at").eq("event_id", id).order("created_at", { ascending: false }),
    (supabase as any).from("event_competition_entry_participants").select("entry_id, participant_role, display_name").eq("event_id", id).order("sort_order"),
    (supabase as any).from("event_competition_entry_dances").select("entry_id, dance_label, fee_amount, currency, status").eq("event_id", id).order("sort_order"),
    (supabase as any).from("event_competition_programs").select("id, name, discipline_family").eq("event_id", id),
    (supabase as any).from("event_competition_divisions").select("id, contest_id, name, age_label, skill_label, role_label").eq("event_id", id),
    (supabase as any).from("event_competition_contests").select("id, name").eq("event_id", id),
    (supabase as any).from("event_competition_registration_carts").select("id, order_id, registration_mode, buyer_name, buyer_email, registering_studio_name, status, quoted_total, currency, created_at").eq("event_id", id).order("created_at", { ascending: false }),
    (supabase as any).from("event_orders").select("id, payment_status, status, total_amount, currency").eq("event_id", id),
  ]);
  const loadError = entryResult.error || participantResult.error || danceResult.error || programResult.error || divisionResult.error || contestResult.error || cartResult.error || orderResult.error;
  if (loadError) throw new Error(`Could not load competition registrations: ${loadError.message}`);

  const participants = (participantResult.data ?? []) as Participant[];
  const dances = (danceResult.data ?? []) as EntryDance[];
  const programs = (programResult.data ?? []) as Program[];
  const divisions = (divisionResult.data ?? []) as Division[];
  const contests = (contestResult.data ?? []) as Contest[];
  const carts = (cartResult.data ?? []) as Cart[];
  const orders = (orderResult.data ?? []) as Order[];
  const search = (query.q ?? "").trim().toLowerCase();
  const eligibility = query.eligibility ?? "all";
  const entries = ((entryResult.data ?? []) as Entry[]).filter((entry) => {
    if (eligibility !== "all" && entry.eligibility_status !== eligibility) return false;
    if (!search) return true;
    const entryParticipants = participants.filter((item) => item.entry_id === entry.id).map((item) => item.display_name).join(" ");
    return `${entry.display_name} ${entry.represented_studio_name ?? ""} ${entry.entry_number ?? ""} ${entryParticipants}`.toLowerCase().includes(search);
  });
  const groupKeys = [...new Set(entries.map((entry) => entry.registration_cart_id ?? `manual:${entry.id}`))];
  const unverifiedCount = ((entryResult.data ?? []) as Entry[]).filter((entry) => entry.eligibility_status === "unverified" || entry.eligibility_status === "needs_review").length;

  return <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-5"><div><Link href={`/app/events/${id}/competition`} className="text-sm font-medium text-slate-600 hover:text-slate-950">Back to Competition Setup</Link><h1 className="mt-2 text-2xl font-semibold text-slate-950">Competition Registrations</h1><p className="mt-1 text-sm text-slate-600">{event.name}</p></div><div className="flex gap-2"><span className="rounded border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700">{entries.length} entries</span><span className={`rounded px-3 py-2 text-sm font-semibold ${unverifiedCount > 0 ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-800"}`}>{unverifiedCount} need review</span></div></header>

    <form className="grid gap-3 border-b border-slate-200 py-5 sm:grid-cols-[1fr_180px_auto]"><input name="q" defaultValue={query.q ?? ""} placeholder="Search dancer, studio, or entry number" className="h-10 rounded border border-slate-300 px-3 text-sm" /><select name="eligibility" defaultValue={eligibility} className="h-10 rounded border border-slate-300 bg-white px-3 text-sm"><option value="all">All eligibility</option><option value="unverified">Unverified</option><option value="needs_review">Needs review</option><option value="eligible">Eligible</option><option value="ineligible">Ineligible</option><option value="waived">Waived</option></select><button className="h-10 rounded bg-slate-950 px-4 text-sm font-semibold text-white">Filter</button></form>

    {entries.length === 0 ? <div className="mt-8 border border-dashed border-slate-300 p-10 text-center text-sm text-slate-600">No competition entries match this view.</div> : <div className="mt-7 space-y-10">{groupKeys.map((groupKey) => {
      const groupEntries = entries.filter((entry) => (entry.registration_cart_id ?? `manual:${entry.id}`) === groupKey);
      const cart = carts.find((item) => item.id === groupEntries[0]?.registration_cart_id) ?? null;
      const order = orders.find((item) => item.id === (cart?.order_id ?? groupEntries[0]?.order_id)) ?? null;
      const groupName = cart?.registering_studio_name || cart?.buyer_name || groupEntries[0]?.represented_studio_name || "Manual registration";
      return <section key={groupKey} className="border-b border-slate-300 pb-8"><div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-lg font-semibold text-slate-950">{groupName}</h2><p className="mt-1 text-sm text-slate-600">{cart?.registration_mode ? `${label(cart.registration_mode)} registration` : "Staff-entered registration"}{cart?.buyer_email ? ` · ${cart.buyer_email}` : ""}</p></div><div className="flex flex-wrap gap-2">{cart ? <span className={`rounded px-2 py-1 text-xs font-semibold ${badge(cart.status)}`}>{label(cart.status)}</span> : null}{order ? <><span className={`rounded px-2 py-1 text-xs font-semibold ${badge(order.payment_status)}`}>{label(order.payment_status)}</span><span className="rounded bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">{money(order.total_amount, order.currency)}</span></> : null}</div></div><div className="mt-4 divide-y divide-slate-200 border-y border-slate-200">{groupEntries.map((entry) => {
        const entryParticipants = participants.filter((item) => item.entry_id === entry.id);
        const entryDances = dances.filter((item) => item.entry_id === entry.id && item.status !== "scratched");
        const program = programs.find((item) => item.id === entry.program_id);
        const division = divisions.find((item) => item.id === entry.division_id);
        const contest = contests.find((item) => item.id === division?.contest_id);
        const routineTitle = typeof entry.metadata?.routine_title === "string" ? entry.metadata.routine_title : null;
        return <div key={entry.id} className="grid gap-4 py-5 xl:grid-cols-[1fr_210px]"><div><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-slate-950">{entry.display_name}</h3><span className={`rounded px-2 py-1 text-xs font-semibold ${badge(entry.status)}`}>{label(entry.status)}</span><span className={`rounded px-2 py-1 text-xs font-semibold ${badge(entry.eligibility_status)}`}>{label(entry.eligibility_status)}</span></div><p className="mt-2 text-sm text-slate-600">{program?.name} · {contest?.name} · {division?.name}</p><p className="mt-1 text-xs text-slate-500">{[division?.age_label, division?.skill_label, division?.role_label].filter(Boolean).join(" · ")}</p><div className="mt-3 flex flex-wrap gap-2">{entryParticipants.map((participant, index) => <span key={`${participant.entry_id}-${index}`} className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700">{participant.display_name} · {label(participant.participant_role)}</span>)}</div><div className="mt-2 flex flex-wrap gap-2">{entryDances.map((dance, index) => <span key={`${dance.entry_id}-${dance.dance_label}-${index}`} className="rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-800">{dance.dance_label} · {money(dance.fee_amount, dance.currency)}</span>)}</div>{routineTitle ? <p className="mt-3 text-sm text-slate-700">Routine: {routineTitle}</p> : null}</div><div className="space-y-3"><form action={updateCompetitionEntryEligibilityAction} className="grid grid-cols-[1fr_auto] gap-2"><input type="hidden" name="eventId" value={id} /><input type="hidden" name="entryId" value={entry.id} /><select name="eligibilityStatus" defaultValue={entry.eligibility_status} className="h-10 rounded border border-slate-300 bg-white px-3 text-sm"><option value="unverified">Unverified</option><option value="needs_review">Needs review</option><option value="eligible">Eligible</option><option value="ineligible">Ineligible</option><option value="waived">Waived</option></select><button className="rounded border border-slate-300 px-3 text-xs font-semibold text-slate-700">Save</button></form><form action={assignCompetitionEntryNumberAction} className="grid grid-cols-[1fr_auto] gap-2"><input type="hidden" name="eventId" value={id} /><input type="hidden" name="entryId" value={entry.id} /><input name="entryNumber" defaultValue={entry.entry_number ?? ""} placeholder="Entry number" className="h-10 rounded border border-slate-300 px-3 text-sm" /><button className="rounded border border-slate-300 px-3 text-xs font-semibold text-slate-700">Assign</button></form></div></div>;
      })}</div></section>;
    })}</div>}
  </main>;
}
