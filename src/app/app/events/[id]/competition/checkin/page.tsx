import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import { startCompetitionCheckinAction } from "./actions";

type Cart = { id: string; order_id: string | null; buyer_name: string | null; buyer_email: string | null; registering_studio_name: string | null; registration_mode: string; status: string; quoted_total: number | string; currency: string };
type Session = { id: string; registration_cart_id: string | null; status: string; payment_status: string; waiver_status: string; entry_status: string; credential_status: string; balance_due: number | string };
type Entry = { id: string; registration_cart_id: string | null; status: string; eligibility_status: string };
type Registration = { id: string; order_id: string | null };
type Order = { id: string; payment_status: string; status: string; total_amount: number | string; currency: string };

function label(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase()); }
function badge(value: string) { if (["complete", "paid", "submitted", "ready"].includes(value)) return "bg-emerald-50 text-emerald-800"; if (["blocked", "failed", "cancelled", "ineligible"].includes(value)) return "bg-rose-50 text-rose-800"; return "bg-amber-50 text-amber-800"; }
function money(value: number | string, currency: string) { return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(Number(value ?? 0)); }

export default async function CompetitionCheckinPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ q?: string; status?: string }> }) {
  const { id } = await params;
  const query = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const context = await getCurrentStudioContext();
  const { data: event, error: eventError } = await supabase.from("events").select("id, name").eq("id", id).eq("studio_id", context.studioId).maybeSingle();
  if (eventError || !event) notFound();
  const [cartResult, sessionResult, entryResult, registrationResult, orderResult] = await Promise.all([
    (supabase as any).from("event_competition_registration_carts").select("id, order_id, buyer_name, buyer_email, registering_studio_name, registration_mode, status, quoted_total, currency").eq("event_id", id).in("status", ["submitted", "checkout_pending"]).order("created_at", { ascending: false }),
    (supabase as any).from("event_competition_checkin_sessions").select("id, registration_cart_id, status, payment_status, waiver_status, entry_status, credential_status, balance_due").eq("event_id", id),
    (supabase as any).from("event_competition_entries").select("id, registration_cart_id, status, eligibility_status").eq("event_id", id),
    (supabase as any).from("event_registrations").select("id, order_id").eq("event_id", id),
    (supabase as any).from("event_orders").select("id, payment_status, status, total_amount, currency").eq("event_id", id),
  ]);
  const loadError = cartResult.error || sessionResult.error || entryResult.error || registrationResult.error || orderResult.error;
  if (loadError) throw new Error(`Could not load competition check-in: ${loadError.message}`);
  const sessions = (sessionResult.data ?? []) as Session[];
  const entries = (entryResult.data ?? []) as Entry[];
  const registrations = (registrationResult.data ?? []) as Registration[];
  const orders = (orderResult.data ?? []) as Order[];
  const search = (query.q ?? "").trim().toLowerCase();
  const status = query.status ?? "all";
  const carts = ((cartResult.data ?? []) as Cart[]).filter((cart) => {
    const session = sessions.find((item) => item.registration_cart_id === cart.id);
    if (status !== "all" && (session?.status ?? "not_started") !== status) return false;
    return !search || `${cart.registering_studio_name ?? ""} ${cart.buyer_name ?? ""} ${cart.buyer_email ?? ""}`.toLowerCase().includes(search);
  });
  const completeCount = sessions.filter((item) => item.status === "complete").length;
  const attentionCount = sessions.filter((item) => ["blocked", "in_progress"].includes(item.status)).length;

  return <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6"><header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-5"><div><Link href={`/app/events/${id}/competition`} className="text-sm font-medium text-slate-600 hover:text-slate-950">Back to Competition Setup</Link><h1 className="mt-2 text-2xl font-semibold text-slate-950">Competition Check-In</h1><p className="mt-1 text-sm text-slate-600">{event.name}</p></div><div className="flex gap-2"><span className="rounded bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">{completeCount} complete</span><span className="rounded bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">{attentionCount} in progress</span></div></header>
  <form className="grid gap-3 border-b border-slate-200 py-5 sm:grid-cols-[1fr_180px_auto]"><input name="q" defaultValue={query.q ?? ""} placeholder="Search studio, contact, or email" className="h-10 rounded border border-slate-300 px-3 text-sm" /><select name="status" defaultValue={status} className="h-10 rounded border border-slate-300 bg-white px-3 text-sm"><option value="all">All check-in status</option><option value="not_started">Not started</option><option value="in_progress">In progress</option><option value="blocked">Blocked</option><option value="ready">Ready</option><option value="complete">Complete</option></select><button className="h-10 rounded bg-slate-950 px-4 text-sm font-semibold text-white">Filter</button></form>
  {carts.length === 0 ? <div className="mt-8 border border-dashed border-slate-300 p-10 text-center text-sm text-slate-600">No registration batches match this view.</div> : <div className="mt-6 divide-y divide-slate-200 border-y border-slate-200">{carts.map((cart) => {
    const session = sessions.find((item) => item.registration_cart_id === cart.id);
    const cartEntries = entries.filter((item) => item.registration_cart_id === cart.id);
    const order = orders.find((item) => item.id === cart.order_id);
    const registration = registrations.find((item) => item.order_id === cart.order_id);
    const name = cart.registering_studio_name || cart.buyer_name || "Competition registration";
    return <div key={cart.id} className="grid gap-4 py-5 lg:grid-cols-[1fr_auto]"><div><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold text-slate-950">{name}</h2><span className={`rounded px-2 py-1 text-xs font-semibold ${badge(session?.status ?? "not_started")}`}>{label(session?.status ?? "not_started")}</span><span className={`rounded px-2 py-1 text-xs font-semibold ${badge(order?.payment_status ?? "pending")}`}>{label(order?.payment_status ?? "pending")}</span></div><p className="mt-1 text-sm text-slate-600">{cart.buyer_name} · {cart.buyer_email}</p><p className="mt-2 text-xs text-slate-500">{cartEntries.length} entries · {money(order?.total_amount ?? cart.quoted_total, order?.currency ?? cart.currency)}{session && Number(session.balance_due) > 0 ? ` · ${money(session.balance_due, order?.currency ?? cart.currency)} due` : ""}</p></div>{session ? <Link href={`/app/events/${id}/competition/checkin/${session.id}`} className="self-center rounded bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">Continue check-in</Link> : <form action={startCompetitionCheckinAction} className="self-center"><input type="hidden" name="eventId" value={id} /><input type="hidden" name="cartId" value={cart.id} /><input type="hidden" name="registrationId" value={registration?.id ?? ""} /><button className="rounded bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">Start check-in</button></form>}</div>;
  })}</div>}</main>;
}
