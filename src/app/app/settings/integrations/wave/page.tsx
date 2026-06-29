import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import {
  ArrowLeft,
  BadgeCheck,
  Building2,
  CheckCircle2,
  CircleDollarSign,
  FileCheck2,
  Link2,
  RefreshCw,
  Route,
  ShieldCheck,
  SlidersHorizontal,
  Waves,
} from "lucide-react";
import { canManageSettings } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { requireStudioFeature } from "@/lib/billing/access";
import { createClient } from "@/lib/supabase/server";
import { getStudioAccountingEntries } from "@/lib/accounting/entries";
import { buildWavePostingLines, WAVE_ACCOUNTING_CATEGORIES, WAVE_PAYMENT_METHODS, type WavePaymentMethodKey } from "@/lib/integrations/wave/categories";
import { accountingCategoryLabel } from "@/lib/accounting/entries";
import { approveWaveReviewRunAction, cancelWaveReviewRunAction, createWaveReviewRunAction, disconnectWaveAction, postNextWaveLineAction, reconcileWaveRunAction, refreshWaveAccountsAction, saveWaveMappingsAction, saveWavePaymentMethodsAction, selectWaveBusinessAction, setWavePostingEnabledAction, setWavePostingModeAction } from "./actions";

type PageProps = { searchParams: Promise<{ status?: string; start?: string; end?: string; run?: string }> };

function validDate(value: string | undefined, fallback: string) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

function money(amount: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

function StatusBadge({ tone, children }: { tone: "green" | "amber" | "slate" | "red"; children: ReactNode }) {
  const tones = {
    green: "border-emerald-200 bg-emerald-50 text-emerald-800",
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    slate: "border-slate-200 bg-white text-slate-700",
    red: "border-red-200 bg-red-50 text-red-800",
  };
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${tones[tone]}`}>{children}</span>;
}

function SectionTitle({ step, icon: Icon, title, description }: { step: string; icon: typeof Building2; title: string; description: string }) {
  return (
    <div className="flex items-start gap-3 border-b border-fuchsia-100 bg-fuchsia-50/70 px-5 py-4">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#5B197A] text-white"><Icon className="h-4 w-4" /></span>
      <div><p className="text-xs font-bold uppercase tracking-[0.14em] text-fuchsia-700">Step {step}</p><h2 className="mt-0.5 text-lg font-semibold text-slate-950">{title}</h2><p className="mt-1 text-sm text-slate-600">{description}</p></div>
    </div>
  );
}

function runStatusTone(status: string): "green" | "amber" | "slate" | "red" {
  if (["posted", "approved"].includes(status)) return "green";
  if (["failed", "attention_required"].includes(status)) return "red";
  if (["review", "posting"].includes(status)) return "amber";
  return "slate";
}

const statusText: Record<string, string> = {
  connected: "Wave is connected and the business was selected.",
  select_business: "Wave is connected. Select the business DanceFlow should use.",
  business_saved: "Wave business and accounts were loaded.",
  accounts_refreshed: "Wave accounts were refreshed.",
  mappings_saved: "Wave account mappings were saved.",
  payment_methods_saved: "Payment-method anchors were saved.",
  stripe_anchor_required: "Stripe Clearing is required before saving payment-method anchors.",
  preview_not_ready: "Resolve every unmapped preview line before creating a review run.",
  multiple_currencies: "Create separate review runs for each currency.",
  no_entries: "No accounting entries were found in that period.",
  review_created: "An immutable review snapshot is ready for approval.",
  run_approved: "The review run was approved and its source entries are reserved against duplicates. Nothing was posted to Wave.",
  run_cancelled: "The review run was cancelled and its source reservations were released.",
  duplicate_sources: "Approval was blocked because one or more source entries are already reserved by another approved run.",
  approval_confirmation_required: "Type APPROVE exactly to approve the review run.",
  invalid_period: "Choose a valid start and end date.",
  forbidden: "Your current studio role cannot manage this Wave connection.",
  posting_disabled: "Live Wave posting is disabled by the server feature flag.",
  write_scope_required: "Reconnect Wave to grant transaction write access before posting.",
  business_not_supported: "This Wave business is not eligible for the money transaction API.",
  business_changed: "The approved snapshot belongs to a different Wave business and cannot be posted.",
  posting_confirmation_required: "Type POST TO WAVE exactly before posting.",
  anchor_type_required: "The anchor account type is incomplete. Refresh accounts and create a new review run.",
  line_posted: "One posting line was created in Wave. Review the result before continuing.",
  run_posted: "Every line in this run was posted to Wave.",
  posting_failed: "Wave definitively rejected this posting line. No automatic retry was attempted.",
  posting_uncertain: "Wave may have accepted the request, but DanceFlow did not receive a reliable result. Do not retry until the Wave business is reconciled manually.",
  enable_confirmation_required: "Type ENABLE POSTING exactly to activate this studio connection.",
  studio_posting_enabled: "Wave posting was enabled for this studio connection.",
  studio_posting_disabled: "Wave posting is disabled for this studio connection.",
  studio_not_allowlisted: "This studio is not allowlisted for Wave production posting.",
  reconciliation_confirmation_required: "Type RECONCILED exactly to confirm that the run matches Wave.",
  reconciliation_note_required: "Add a note describing the variance or review requirement.",
  run_reconciled: "The Wave run reconciliation status was saved.",
  audit_completion_failed: "Wave posted successfully, but audit completion failed. Posting is stopped for manual review.",
  disconnected: "Wave was disconnected.",
  oauth_denied: "Wave authorization was cancelled.",
  invalid_state: "The Wave authorization session expired. Start the connection again.",
  connection_failed: "Wave could not be connected. Check the server logs and OAuth configuration.",
  anchor_required: "Select the Wave bank or cash account used as the transaction anchor.",
  invalid_posting_mode: "Choose a valid Wave posting mode.",
  posting_mode_saved: "Wave posting mode was saved.",
  auto_post_confirmation_required: "Type AUTO POST SAFE exactly before enabling auto-post safe mode.",
};

export default async function WaveSettingsPage({ searchParams }: PageProps) {
  const context = await getCurrentStudioContext();
  if (!canManageSettings(context.studioRole ?? "")) redirect("/app");
  await requireStudioFeature("wave_accounting");
  const supabase = await createClient();
  const params = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 8)}01`;
  const start = validDate(params.start, monthStart);
  const end = validDate(params.end, today);
  const postingEnabled = process.env.WAVE_POSTING_ENABLED === "true";

  const { data: connection } = await supabase.from("studio_wave_connections").select("*").eq("studio_id", context.studioId).maybeSingle();
  const connectionId = connection?.id as string | undefined;
  const postingMode = String(connection?.posting_mode ?? "manual_review");
  const [{ data: businesses }, { data: accounts }, { data: mappings }, { data: paymentMappings }, { data: recentRuns }, { data: entitlement }] = connectionId
    ? await Promise.all([
        supabase.from("studio_wave_businesses").select("wave_business_id, name, currency").eq("connection_id", connectionId).order("name"),
        supabase.from("studio_wave_accounts").select("wave_account_id, name, account_type, account_subtype, normal_balance_type, is_archived").eq("connection_id", connectionId).eq("is_archived", false).order("name"),
        supabase.from("studio_wave_account_mappings").select("accounting_category, wave_account_id, wave_account_name").eq("connection_id", connectionId),
        supabase.from("studio_wave_payment_method_mappings").select("payment_method_key, wave_account_id, wave_account_name").eq("connection_id", connectionId),
        supabase.from("studio_wave_sync_runs").select("id, status, period_start, period_end, currency, source_entry_count, posting_line_count, total_debits, posting_error, reconciliation_status, reconciliation_note, reconciled_at, created_at").eq("connection_id", connectionId).order("created_at", { ascending: false }).limit(10),
        supabase.from("studio_wave_posting_entitlements").select("status, notes").eq("studio_id", context.studioId).maybeSingle(),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: null }];
  const mappingByCategory = new Map((mappings ?? []).map((row) => [row.accounting_category, { waveAccountName: row.wave_account_name, waveAccountId: row.wave_account_id }]));
  const anchorByMethod = new Map((paymentMappings ?? []).map((row) => [row.payment_method_key as WavePaymentMethodKey, { waveAccountName: row.wave_account_name, waveAccountId: row.wave_account_id }]));
  const entries = connection?.wave_business_id
    ? await getStudioAccountingEntries({ supabase, studioId: context.studioId, startDate: `${start}T00:00:00.000Z`, endDate: `${end}T23:59:59.999Z` })
    : [];
  const preview = buildWavePostingLines(entries, mappingByCategory, anchorByMethod);
  const readyCount = preview.filter((line) => line.mappingStatus === "ready").length;
  const selectedRun = params.run ? (recentRuns ?? []).find((run) => run.id === params.run) ?? null : null;
  const { data: selectedRunLines } = selectedRun
    ? await supabase.from("studio_wave_sync_lines").select("id, entry_date, payment_method_key, category, direction, amount, currency, wave_category_account_name, wave_anchor_account_name, source_count, posting_status, posting_attempts, wave_transaction_id, posting_error").eq("run_id", selectedRun.id).order("entry_date", { ascending: true })
    : { data: [] };
  const { data: selectedRunAudit } = selectedRun
    ? await supabase.from("studio_wave_audit_events").select("id, event_type, outcome, details, created_at").eq("run_id", selectedRun.id).order("created_at", { ascending: true })
    : { data: [] };
  const allowlisted = Boolean(entitlement && ["pilot", "active"].includes(entitlement.status));

  return (
    <div className="space-y-5 pb-10">
      <header className="overflow-hidden rounded-lg border border-[#4A1265] bg-[#2D0B45] text-white shadow-sm">
        <div className="h-1.5 bg-[#F97316]" />
        <div className="p-5 sm:p-7">
          <Link href="/app/settings" className="inline-flex items-center gap-2 text-sm font-semibold text-fuchsia-200 hover:text-white"><ArrowLeft className="h-4 w-4" />Back to settings</Link>
          <div className="mt-5 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <div className="flex items-center gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-lg bg-white text-[#5B197A]"><Waves className="h-6 w-6" /></span><div><p className="text-xs font-bold uppercase tracking-[0.16em] text-fuchsia-200">DanceFlow Accounting</p><p className="text-sm font-semibold text-white/80">Wave integration</p></div></div>
              <h1 className="mt-5 text-3xl font-semibold sm:text-4xl">Move reviewed studio activity into Wave</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-purple-100 sm:text-base">Route each payment correctly, review balanced posting runs, and reconcile every completed transfer from one controlled workspace.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <StatusBadge tone={connection?.status === "connected" ? "green" : "slate"}>{connection?.status === "connected" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />}{connection?.status === "connected" ? "Wave connected" : "Not connected"}</StatusBadge>
              {connection?.wave_business_name ? <StatusBadge tone="slate"><Building2 className="h-3.5 w-3.5" />{connection.wave_business_name}</StatusBadge> : null}
              {connection?.status === "connected" ? <StatusBadge tone="slate"><SlidersHorizontal className="h-3.5 w-3.5" />{postingMode.replaceAll("_", " ")}</StatusBadge> : null}
              {connection?.posting_enabled ? <StatusBadge tone="green"><ShieldCheck className="h-3.5 w-3.5" />Posting enabled</StatusBadge> : <StatusBadge tone="amber"><ShieldCheck className="h-3.5 w-3.5" />Posting protected</StatusBadge>}
            </div>
          </div>
        </div>
        {connection?.status === "connected" ? <div className="flex justify-end border-t border-white/10 px-5 py-3 sm:px-7"><form action={disconnectWaveAction}><button className="text-sm font-semibold text-purple-100 hover:text-white">Disconnect Wave</button></form></div> : null}
      </header>

      {connection?.status === "connected" ? <nav aria-label="Wave setup progress" className="grid overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm sm:grid-cols-5">
        {[{ href: "#business", label: "Business", icon: Building2 }, { href: "#payment-routing", label: "Payment routing", icon: Route }, { href: "#categories", label: "Categories", icon: SlidersHorizontal }, { href: "#preview", label: "Preview", icon: FileCheck2 }, { href: "#runs", label: "Review runs", icon: CircleDollarSign }].map((item, index) => { const Icon = item.icon; return <a key={item.href} href={item.href} className="flex items-center gap-3 border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-fuchsia-50 hover:text-fuchsia-800 sm:border-b-0 sm:border-r sm:last:border-r-0"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-fuchsia-50 text-xs font-bold text-fuchsia-700">{index + 1}</span><Icon className="h-4 w-4" />{item.label}</a>; })}
      </nav> : null}

      {params.status && statusText[params.status] ? <div className="flex items-start gap-3 rounded-lg border border-fuchsia-200 bg-fuchsia-50 px-4 py-3 text-sm text-fuchsia-950"><BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-fuchsia-700" /><p>{statusText[params.status]}</p></div> : null}
      {connection?.status === "connected" && !connection.scopes?.includes("transaction:write") ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"><p className="font-semibold">Wave authorization needs an update</p><p className="mt-1 text-amber-900">Reconnect once to approve posting access.</p><a href="/api/integrations/wave/connect" className="mt-3 inline-flex rounded-md bg-amber-900 px-3 py-2 font-semibold text-white">Reauthorize Wave</a></div> : null}
      {!postingEnabled ? <div className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#5B197A]" /><div><p className="font-semibold text-slate-900">Posting is paused platform-wide</p><p className="mt-1">You can continue configuring, previewing, approving, and reconciling runs.</p></div></div> : null}

      {connection?.status === "connected" ? <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex items-start gap-3 border-b border-orange-100 bg-orange-50 px-5 py-4"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#F97316] text-white"><ShieldCheck className="h-4 w-4" /></span><div><p className="text-xs font-bold uppercase tracking-[0.14em] text-orange-700">Safety controls</p><h2 className="mt-0.5 text-lg font-semibold text-slate-950">Posting safeguards</h2><p className="mt-1 text-sm text-slate-600">All three controls must be active before an approved line can reach Wave.</p></div></div>
        <div className="p-5">
          <div className="grid gap-3 text-sm md:grid-cols-4">
            <div className="rounded-lg border border-slate-200 p-4"><p className="font-medium text-slate-900">DanceFlow posting</p><div className="mt-2"><StatusBadge tone={postingEnabled ? "green" : "amber"}>{postingEnabled ? "Available" : "Paused"}</StatusBadge></div></div>
            <div className="rounded-lg border border-slate-200 p-4"><p className="font-medium text-slate-900">Rollout access</p><div className="mt-2"><StatusBadge tone={allowlisted ? "green" : "slate"}>{entitlement?.status ?? "Not enabled"}</StatusBadge></div></div>
            <div className="rounded-lg border border-slate-200 p-4"><p className="font-medium text-slate-900">Studio authorization</p><div className="mt-2"><StatusBadge tone={connection.posting_enabled ? "green" : "amber"}>{connection.posting_enabled ? "Enabled" : "Disabled"}</StatusBadge></div></div>
            <div className="rounded-lg border border-slate-200 p-4"><p className="font-medium text-slate-900">Posting mode</p><div className="mt-2"><StatusBadge tone={postingMode === "auto_post_safe" ? "amber" : postingMode === "approval_required" ? "green" : "slate"}>{postingMode.replaceAll("_", " ")}</StatusBadge></div></div>
          </div>
          {allowlisted && !connection.posting_enabled ? <form action={setWavePostingEnabledAction} className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-end"><input type="hidden" name="enabled" value="true" /><label className="text-sm font-medium text-slate-900">Type ENABLE POSTING<input name="confirmation" autoComplete="off" className="mt-1 block rounded-md border border-slate-300 px-3 py-2" /></label><button className="rounded-md bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800">Enable studio posting</button></form> : null}
          {connection.posting_enabled ? <form action={setWavePostingEnabledAction} className="mt-5"><input type="hidden" name="enabled" value="false" /><button className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Disable studio posting</button></form> : null}
          {allowlisted && connection.posting_enabled ? <form action={setWavePostingModeAction} className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <label className="block text-sm font-semibold text-slate-950">Wave posting mode</label>
            <p className="mt-1 text-sm text-slate-600">Manual review is safest. Auto-post safe mode only prepares the connection for guarded automation; uncertain, failed, unmapped, or unsupported activity still stops for review.</p>
            <select name="postingMode" defaultValue={postingMode} className="mt-3 w-full max-w-md rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
              <option value="manual_review">Manual review</option>
              <option value="approval_required">Approval required</option>
              <option value="auto_post_safe">Auto-post safe eligible runs</option>
            </select>
            <label className="mt-3 block max-w-md text-sm font-medium text-slate-900">Auto-post confirmation
              <input name="confirmation" placeholder="Required only for auto-post safe" autoComplete="off" className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2" />
            </label>
            <button className="mt-3 rounded-md bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white hover:bg-[#46115E]">Save posting mode</button>
          </form> : null}
          {!allowlisted ? <p className="mt-5 text-sm text-slate-600">Wave posting has not yet been enabled for this studio.</p> : null}
        </div>
      </section> : null}

      {!connection || connection.status === "disconnected" ? (
        <section className="overflow-hidden rounded-lg border border-fuchsia-200 bg-white shadow-sm">
          <div className="grid md:grid-cols-[1fr_auto] md:items-center">
            <div className="p-6"><p className="text-xs font-bold uppercase tracking-[0.14em] text-fuchsia-700">Get connected</p><h2 className="mt-2 text-2xl font-semibold text-slate-950">Link your Wave business</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Authorize DanceFlow to read your Wave business and accounts, then configure a controlled accounting workflow.</p><a href="/api/integrations/wave/connect" className="mt-5 inline-flex items-center gap-2 rounded-md bg-[#5B197A] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#46115E]"><Link2 className="h-4 w-4" />Connect Wave</a></div>
            <div className="hidden h-full min-h-48 w-56 items-center justify-center bg-fuchsia-50 text-[#5B197A] md:flex"><Waves className="h-20 w-20" strokeWidth={1.25} /></div>
          </div>
        </section>
      ) : (
        <>
          <section id="business" className="scroll-mt-6 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <SectionTitle step="1" icon={Building2} title="Wave business" description="Choose the Wave business that receives DanceFlow accounting activity." />
            <div className="p-5">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between"><div><p className="text-sm font-medium text-slate-500">Connected business</p><p className="mt-1 text-lg font-semibold text-slate-950">{connection.wave_business_name ?? "Not selected"}</p></div>{connection.wave_business_id ? <form action={refreshWaveAccountsAction}><button className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:border-fuchsia-300 hover:bg-fuchsia-50"><RefreshCw className="h-4 w-4" />Refresh accounts</button></form> : null}</div>
              <form action={selectWaveBusinessAction} className="mt-5 flex flex-col gap-3 sm:flex-row">
              <select name="businessId" defaultValue={connection.wave_business_id ?? ""} required className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm">
                <option value="" disabled>Select a Wave business</option>
                {(businesses ?? []).map((business) => <option key={business.wave_business_id} value={business.wave_business_id}>{business.name}{business.currency ? ` (${business.currency})` : ""}</option>)}
              </select>
                <button className="rounded-md bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white hover:bg-[#46115E]">Use this business</button>
              </form>
            </div>
          </section>

          {connection.wave_business_id ? <section id="payment-routing" className="scroll-mt-6 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <SectionTitle step="2" icon={Route} title="Payment routing" description="Send each payment method to the Wave account where those funds are held." />
            <div className="p-5"><form action={saveWavePaymentMethodsAction} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                {WAVE_PAYMENT_METHODS.map((method) => <label key={method.key} className="text-sm font-medium text-slate-900">{method.label}<span className="ml-2 font-normal text-slate-500">Suggested: {method.help}</span>
                  <select name={`anchor:${method.key}`} defaultValue={anchorByMethod.get(method.key)?.waveAccountId ?? ""} required={method.key === "stripe"} className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
                    <option value="">Not configured</option>
                    {(accounts ?? []).map((account) => <option key={account.wave_account_id} value={account.wave_account_id}>{account.name} · {account.account_subtype ?? account.account_type ?? "Account"}</option>)}
                  </select>
                </label>)}
              </div>
              <button className="rounded-md bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white hover:bg-[#46115E]">Save payment routing</button>
            </form></div>
          </section> : null}

          {connection.wave_business_id ? <section id="categories" className="scroll-mt-6 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <SectionTitle step="3" icon={SlidersHorizontal} title="Category mappings" description="Match DanceFlow revenue, refunds, fees, and expenses to your Wave chart of accounts." />
            <div className="p-5"><form action={saveWaveMappingsAction} className="space-y-5">
              <div className="overflow-x-auto rounded-lg border border-slate-200"><table className="w-full min-w-[680px] text-left text-sm"><thead className="bg-slate-50"><tr className="border-b border-slate-200 text-slate-600"><th className="px-3 py-2.5">DanceFlow category</th><th className="px-3 py-2.5">Wave account</th></tr></thead><tbody>
                {WAVE_ACCOUNTING_CATEGORIES.map((category) => <tr key={category} className="border-b border-slate-100 last:border-b-0 hover:bg-fuchsia-50/40"><td className="px-3 py-2.5 font-medium text-slate-800">{accountingCategoryLabel(category)}</td><td className="px-3 py-2"><select name={`mapping:${category}`} defaultValue={mappingByCategory.get(category)?.waveAccountId ?? ""} className="w-full rounded-md border border-slate-300 px-2 py-1.5"><option value="">Not mapped</option>{(accounts ?? []).map((account) => <option key={account.wave_account_id} value={account.wave_account_id}>{account.name}</option>)}</select></td></tr>)}
              </tbody></table></div>
              <button className="rounded-md bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white hover:bg-[#46115E]">Save category mappings</button>
            </form></div>
          </section> : null}

          {connection.wave_business_id ? <section id="preview" className="scroll-mt-6 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <SectionTitle step="4" icon={FileCheck2} title="Posting preview" description="Review balanced posting lines before saving an approval snapshot." />
            <div className="p-5"><form method="get" className="flex flex-wrap items-end gap-3"><label className="text-sm font-medium text-slate-900">Start<input type="date" name="start" defaultValue={start} className="mt-1 block rounded-md border border-slate-300 px-3 py-2" /></label><label className="text-sm font-medium text-slate-900">End<input type="date" name="end" defaultValue={end} className="mt-1 block rounded-md border border-slate-300 px-3 py-2" /></label><button className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:border-fuchsia-300 hover:bg-fuchsia-50"><RefreshCw className="h-4 w-4" />Refresh preview</button></form>
            <p className="mt-4 text-sm text-slate-600">{entries.length} ledger entries summarized into {preview.length} posting lines. {readyCount} lines are ready.</p>
            <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200"><table className="w-full min-w-[980px] text-left text-sm"><thead className="bg-slate-50"><tr className="border-b border-slate-200 text-slate-600"><th className="px-3 py-2.5">Date</th><th>Method</th><th>Category</th><th>Sources</th><th>Amount</th><th>Category account</th><th>Anchor</th><th>Status</th></tr></thead><tbody>
              {preview.map((line) => <tr key={line.key} className="border-b border-slate-100 last:border-b-0 hover:bg-fuchsia-50/40"><td className="px-3 py-2.5">{line.entryDate}</td><td className="capitalize">{line.paymentMethodKey}</td><td>{line.categoryLabel}</td><td>{line.sourceKeys.length}</td><td className="font-medium text-slate-900">{money(line.amount, line.currency)}</td><td>{line.categoryAccount?.waveAccountName ?? "—"}</td><td>{line.anchorAccount?.waveAccountName ?? "—"}</td><td>{line.mappingStatus === "ready" ? <StatusBadge tone="green">Ready</StatusBadge> : <StatusBadge tone="amber">{line.mappingStatus}</StatusBadge>}</td></tr>)}
              {!preview.length ? <tr><td colSpan={8} className="py-8 text-center text-slate-500">No accounting entries in this date range.</td></tr> : null}
            </tbody></table></div>
            <form action={createWaveReviewRunAction} className="mt-5"><input type="hidden" name="start" value={start} /><input type="hidden" name="end" value={end} /><button disabled={!preview.length || readyCount !== preview.length} className="rounded-md bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white hover:bg-[#46115E] disabled:cursor-not-allowed disabled:bg-slate-300">Create review snapshot</button></form></div>
          </section> : null}

          {connection.wave_business_id ? <section id="runs" className="scroll-mt-6 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <SectionTitle step="5" icon={CircleDollarSign} title="Review runs" description="Approve, post, and reconcile saved accounting runs with a complete audit trail." />
            <div className="p-5"><div className="overflow-x-auto rounded-lg border border-slate-200"><table className="w-full min-w-[720px] text-left text-sm"><thead className="bg-slate-50"><tr className="border-b border-slate-200 text-slate-600"><th className="px-3 py-2.5">Period</th><th>Status</th><th>Sources</th><th>Lines</th><th>Balanced total</th><th></th></tr></thead><tbody>
              {(recentRuns ?? []).map((run) => <tr key={run.id} className="border-b border-slate-100 last:border-b-0 hover:bg-fuchsia-50/40"><td className="px-3 py-2.5">{run.period_start} to {run.period_end}</td><td><StatusBadge tone={runStatusTone(run.status)}>{run.status.replaceAll("_", " ")}</StatusBadge></td><td>{run.source_entry_count}</td><td>{run.posting_line_count}</td><td className="font-medium text-slate-900">{money(Number(run.total_debits), run.currency)}</td><td className="pr-3 text-right"><Link href={`/app/settings/integrations/wave?run=${run.id}&start=${start}&end=${end}`} className="font-semibold text-fuchsia-700 hover:text-fuchsia-900">Open run</Link></td></tr>)}
              {!recentRuns?.length ? <tr><td colSpan={6} className="py-6 text-center text-slate-500">No saved review runs.</td></tr> : null}
            </tbody></table></div>
            {selectedRun ? <div className="mt-6 border-t border-slate-200 pt-5"><div className="flex flex-wrap items-center gap-3"><h3 className="text-lg font-semibold text-slate-950">Selected review run</h3><StatusBadge tone={runStatusTone(selectedRun.status)}>{selectedRun.status.replaceAll("_", " ")}</StatusBadge>{selectedRun.reconciliation_status !== "not_started" ? <StatusBadge tone={selectedRun.reconciliation_status === "matched" ? "green" : "amber"}>{selectedRun.reconciliation_status.replaceAll("_", " ")}</StatusBadge> : null}</div>{selectedRun.posting_error ? <p className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{selectedRun.posting_error}</p> : null}<div className="mt-4 overflow-x-auto rounded-lg border border-slate-200"><table className="w-full min-w-[1050px] text-left text-sm"><thead className="bg-slate-50"><tr className="border-b border-slate-200 text-slate-600"><th className="px-3 py-2.5">Date</th><th>Method</th><th>Category</th><th>Direction</th><th>Amount</th><th>Category account</th><th>Anchor</th><th>Posting</th><th>Wave reference</th></tr></thead><tbody>{(selectedRunLines ?? []).map((line) => <tr key={line.id} className="border-b border-slate-100 last:border-b-0"><td className="px-3 py-2.5">{line.entry_date}</td><td className="capitalize">{line.payment_method_key}</td><td>{accountingCategoryLabel(line.category)}</td><td className="capitalize">{line.direction}</td><td className="font-medium text-slate-900">{money(Number(line.amount), line.currency)}</td><td>{line.wave_category_account_name}</td><td>{line.wave_anchor_account_name}</td><td><StatusBadge tone={line.posting_status === "posted" ? "green" : line.posting_status === "failed" || line.posting_status === "uncertain" ? "red" : "amber"}>{line.posting_status}</StatusBadge></td><td className="max-w-48 truncate" title={line.posting_error ?? ""}>{line.wave_transaction_id ? "Recorded" : line.posting_error ? "Needs attention" : "—"}</td></tr>)}</tbody></table></div>
              {selectedRun.status === "review" ? <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end"><form action={approveWaveReviewRunAction} className="flex flex-col gap-2 sm:flex-row sm:items-end"><input type="hidden" name="runId" value={selectedRun.id} /><label className="text-sm font-medium">Type APPROVE<input name="confirmation" autoComplete="off" className="mt-1 block rounded-md border border-slate-300 px-3 py-2" /></label><button className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white">Approve snapshot</button></form><form action={cancelWaveReviewRunAction}><input type="hidden" name="runId" value={selectedRun.id} /><button className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold">Cancel run</button></form></div> : null}
              {selectedRun.status === "approved" ? <form action={cancelWaveReviewRunAction} className="mt-5"><input type="hidden" name="runId" value={selectedRun.id} /><button className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold">Cancel and release reservations</button></form> : null}
              {(selectedRun.status === "approved" || selectedRun.status === "posting") && postingEnabled && allowlisted && connection.posting_enabled && connection.scopes?.includes("transaction:write") ? <form action={postNextWaveLineAction} className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-end"><input type="hidden" name="runId" value={selectedRun.id} /><label className="text-sm font-medium">Type POST TO WAVE<input name="confirmation" autoComplete="off" className="mt-1 block rounded-md border border-slate-300 px-3 py-2" /></label><button className="rounded-md bg-red-700 px-4 py-2 text-sm font-semibold text-white">Post next line</button></form> : null}
              {selectedRun.status === "failed" ? <form action={cancelWaveReviewRunAction} className="mt-5"><input type="hidden" name="runId" value={selectedRun.id} /><button className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold">Cancel failed run and release reservations</button></form> : null}
              {selectedRun.status === "attention_required" ? <p className="mt-5 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Manual Wave reconciliation is required. This run cannot be retried or cancelled automatically.</p> : null}
              {selectedRun.status === "posted" ? <div className="mt-6 border-t border-slate-200 pt-5"><h4 className="font-semibold text-slate-950">Reconciliation</h4><p className="mt-1 text-sm capitalize text-slate-600">Current status: {selectedRun.reconciliation_status.replaceAll("_", " ")}</p>{selectedRun.reconciliation_note ? <p className="mt-2 text-sm text-slate-600">{selectedRun.reconciliation_note}</p> : null}<div className="mt-4 grid gap-4 md:grid-cols-2"><form action={reconcileWaveRunAction} className="rounded-md border border-slate-200 p-4"><input type="hidden" name="runId" value={selectedRun.id} /><input type="hidden" name="reconciliationStatus" value="matched" /><label className="text-sm font-medium">Type RECONCILED<input name="confirmation" autoComplete="off" className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2" /></label><label className="mt-3 block text-sm font-medium">Optional note<textarea name="note" rows={2} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2" /></label><button className="mt-3 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white">Mark matched</button></form><form action={reconcileWaveRunAction} className="rounded-md border border-slate-200 p-4"><input type="hidden" name="runId" value={selectedRun.id} /><label className="text-sm font-medium">Result<select name="reconciliationStatus" className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2"><option value="variance">Variance found</option><option value="needs_review">Needs review</option></select></label><label className="mt-3 block text-sm font-medium">Required note<textarea name="note" required rows={2} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2" /></label><button className="mt-3 rounded-md border border-amber-300 px-4 py-2 text-sm font-semibold text-amber-900">Save exception</button></form></div></div> : null}
              {selectedRunAudit?.length ? <div className="mt-6 border-t border-slate-200 pt-5"><h4 className="font-semibold text-slate-950">Audit activity</h4><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm"><thead><tr className="border-b text-slate-500"><th className="py-2">Time</th><th>Event</th><th>Outcome</th></tr></thead><tbody>{selectedRunAudit.map((event) => <tr key={event.id} className="border-b border-slate-100"><td className="py-2">{new Date(event.created_at).toLocaleString()}</td><td>{event.event_type.replaceAll("_", " ")}</td><td className="capitalize">{event.outcome}</td></tr>)}</tbody></table></div></div> : null}
            </div> : null}</div>
          </section> : null}
        </>
      )}
    </div>
  );
}
