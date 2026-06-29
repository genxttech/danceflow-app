"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSettingsManageAccess } from "@/lib/auth/serverRoleGuard";
import { requireStudioFeature } from "@/lib/billing/access";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStudioAccountingEntries } from "@/lib/accounting/entries";
import { buildWavePostingLines, WAVE_ACCOUNTING_CATEGORIES, WAVE_PAYMENT_METHODS, type WavePaymentMethodKey } from "@/lib/integrations/wave/categories";
import { createWaveMoneyTransaction, getWaveAccounts, WavePostingUncertainError } from "@/lib/integrations/wave/client";
import { getValidWaveAccessToken } from "@/lib/integrations/wave/token";

async function waveContext() {
  const { supabase, studioId } = await requireSettingsManageAccess();
  await requireStudioFeature("wave_accounting");
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("You must be signed in.");
  const { data: connection, error } = await supabase.from("studio_wave_connections")
    .select("id, wave_business_id, status, is_classic_accounting, scopes, posting_enabled, posting_mode").eq("studio_id", studioId).single();
  if (error || !connection || connection.status !== "connected") throw new Error("Connect Wave before configuring it.");
  return { supabase, studioId, userId: user.id, connection };
}

async function refreshAccounts(connectionId: string, studioId: string, businessId: string) {
  const token = await getValidWaveAccessToken(connectionId);
  const accounts = await getWaveAccounts(token, businessId);
  const admin = createAdminClient();
  await admin.from("studio_wave_accounts").delete().eq("connection_id", connectionId);
  if (accounts.length) {
    const { error } = await admin.from("studio_wave_accounts").insert(accounts.map((account) => ({
      connection_id: connectionId, studio_id: studioId, wave_account_id: account.id, name: account.name,
      account_type: account.type?.value ?? account.type?.name ?? null,
      account_subtype: account.subtype?.value ?? account.subtype?.name ?? null,
      normal_balance_type: account.normalBalanceType ?? null, is_archived: account.isArchived,
      refreshed_at: new Date().toISOString(),
    })));
    if (error) throw new Error(error.message);
  }
  await admin.from("studio_wave_connections").update({ last_accounts_sync_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }).eq("id", connectionId);
}

export async function selectWaveBusinessAction(formData: FormData) {
  const { supabase, studioId, connection } = await waveContext();
  const businessId = String(formData.get("businessId") ?? "");
  const { data: business, error } = await supabase.from("studio_wave_businesses")
    .select("wave_business_id, name, currency, is_classic_accounting")
    .eq("connection_id", connection.id).eq("wave_business_id", businessId).single();
  if (error || !business) redirect("/app/settings/integrations/wave?status=invalid_business");
  const { error: updateError } = await supabase.from("studio_wave_connections").update({
    wave_business_id: business.wave_business_id, wave_business_name: business.name,
    business_currency: business.currency, is_classic_accounting: business.is_classic_accounting,
    default_anchor_account_id: null, default_anchor_account_name: null, updated_at: new Date().toISOString(),
  }).eq("id", connection.id).eq("studio_id", studioId);
  if (updateError) throw new Error(updateError.message);
  await supabase.from("studio_wave_account_mappings").delete().eq("connection_id", connection.id);
  await supabase.from("studio_wave_payment_method_mappings").delete().eq("connection_id", connection.id);
  await refreshAccounts(connection.id, studioId, business.wave_business_id);
  revalidatePath("/app/settings/integrations/wave");
  redirect("/app/settings/integrations/wave?status=business_saved");
}

export async function refreshWaveAccountsAction() {
  const { studioId, connection } = await waveContext();
  if (!connection.wave_business_id) redirect("/app/settings/integrations/wave?status=select_business");
  await refreshAccounts(connection.id, studioId, connection.wave_business_id);
  revalidatePath("/app/settings/integrations/wave");
  redirect("/app/settings/integrations/wave?status=accounts_refreshed");
}

export async function saveWaveMappingsAction(formData: FormData) {
  const { supabase, studioId, userId, connection } = await waveContext();
  const { data: accounts, error } = await supabase.from("studio_wave_accounts")
    .select("wave_account_id, name, account_type").eq("connection_id", connection.id).eq("is_archived", false);
  if (error) throw new Error(error.message);
  const byId = new Map((accounts ?? []).map((account) => [account.wave_account_id, account]));

  const rows = WAVE_ACCOUNTING_CATEGORIES.flatMap((category) => {
    const account = byId.get(String(formData.get(`mapping:${category}`) ?? ""));
    return account ? [{ studio_id: studioId, connection_id: connection.id, accounting_category: category,
      wave_account_id: account.wave_account_id, wave_account_name: account.name, wave_account_type: account.account_type,
      created_by: userId, updated_at: new Date().toISOString() }] : [];
  });
  await supabase.from("studio_wave_account_mappings").delete().eq("connection_id", connection.id);
  if (rows.length) {
    const { error: insertError } = await supabase.from("studio_wave_account_mappings").insert(rows);
    if (insertError) throw new Error(insertError.message);
  }
  revalidatePath("/app/settings/integrations/wave");
  redirect("/app/settings/integrations/wave?status=mappings_saved");
}

export async function saveWavePaymentMethodsAction(formData: FormData) {
  const { supabase, studioId, userId, connection } = await waveContext();
  const { data: accounts, error } = await supabase.from("studio_wave_accounts")
    .select("wave_account_id, name, normal_balance_type").eq("connection_id", connection.id).eq("is_archived", false);
  if (error) throw new Error(error.message);
  const byId = new Map((accounts ?? []).map((account) => [account.wave_account_id, account]));
  const rows = WAVE_PAYMENT_METHODS.flatMap(({ key }) => {
    const account = byId.get(String(formData.get(`anchor:${key}`) ?? ""));
    return account ? [{ studio_id: studioId, connection_id: connection.id, payment_method_key: key,
      wave_account_id: account.wave_account_id, wave_account_name: account.name, created_by: userId,
      anchor_normal_balance_type: account.normal_balance_type,
      updated_at: new Date().toISOString() }] : [];
  });
  if (!rows.some((row) => row.payment_method_key === "stripe")) {
    redirect("/app/settings/integrations/wave?status=stripe_anchor_required");
  }
  await supabase.from("studio_wave_payment_method_mappings").delete().eq("connection_id", connection.id);
  const { error: insertError } = await supabase.from("studio_wave_payment_method_mappings").insert(rows);
  if (insertError) throw new Error(insertError.message);
  revalidatePath("/app/settings/integrations/wave");
  redirect("/app/settings/integrations/wave?status=payment_methods_saved");
}

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export async function createWaveReviewRunAction(formData: FormData) {
  const { supabase, studioId, userId, connection } = await waveContext();
  const start = String(formData.get("start") ?? "");
  const end = String(formData.get("end") ?? "");
  if (!validDate(start) || !validDate(end) || end < start) redirect("/app/settings/integrations/wave?status=invalid_period");
  const [{ data: categoryRows }, { data: anchorRows }] = await Promise.all([
    supabase.from("studio_wave_account_mappings").select("accounting_category, wave_account_id, wave_account_name").eq("connection_id", connection.id),
    supabase.from("studio_wave_payment_method_mappings").select("payment_method_key, wave_account_id, wave_account_name, anchor_normal_balance_type").eq("connection_id", connection.id),
  ]);
  const categories = new Map((categoryRows ?? []).map((row) => [row.accounting_category, { waveAccountId: row.wave_account_id, waveAccountName: row.wave_account_name }]));
  const anchors = new Map((anchorRows ?? []).map((row) => [row.payment_method_key as WavePaymentMethodKey, { waveAccountId: row.wave_account_id, waveAccountName: row.wave_account_name }]));
  const entries = await getStudioAccountingEntries({ supabase, studioId, startDate: `${start}T00:00:00.000Z`, endDate: `${end}T23:59:59.999Z` });
  const lines = buildWavePostingLines(entries, categories, anchors);
  if (!lines.length) redirect(`/app/settings/integrations/wave?status=no_entries&start=${start}&end=${end}`);
  if (lines.some((line) => line.mappingStatus !== "ready")) redirect(`/app/settings/integrations/wave?status=preview_not_ready&start=${start}&end=${end}`);
  const currencies = Array.from(new Set(lines.map((line) => line.currency)));
  if (currencies.length !== 1) redirect(`/app/settings/integrations/wave?status=multiple_currencies&start=${start}&end=${end}`);
  const total = Math.round(lines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;
  const { data: run, error: runError } = await supabase.from("studio_wave_sync_runs").insert({
    studio_id: studioId, connection_id: connection.id, status: "review", period_start: start, period_end: end,
    currency: currencies[0], source_entry_count: entries.length, posting_line_count: lines.length,
    total_debits: total, total_credits: total, created_by: userId,
    configuration_snapshot: { waveBusinessId: connection.wave_business_id, categoryMappings: Object.fromEntries(categories), anchorMappings: Object.fromEntries(anchors) },
  }).select("id").single();
  if (runError || !run) throw new Error(runError?.message ?? "Review run could not be created.");
  const { error: linesError } = await supabase.from("studio_wave_sync_lines").insert(lines.map((line) => ({
    run_id: run.id, studio_id: studioId, entry_date: line.entryDate, payment_method_key: line.paymentMethodKey,
    category: line.category, direction: line.direction, amount: line.amount, currency: line.currency,
    wave_category_account_id: line.categoryAccount!.waveAccountId, wave_category_account_name: line.categoryAccount!.waveAccountName,
    wave_anchor_account_id: line.anchorAccount!.waveAccountId, wave_anchor_account_name: line.anchorAccount!.waveAccountName,
    anchor_normal_balance_type: anchorRows?.find((row) => row.payment_method_key === line.paymentMethodKey)?.anchor_normal_balance_type ?? null,
    wave_external_id: `danceflow-wave-${randomUUID()}`,
    source_keys: line.sourceKeys, source_count: line.sourceKeys.length,
  })));
  if (linesError) { await supabase.from("studio_wave_sync_runs").delete().eq("id", run.id); throw new Error(linesError.message); }
  revalidatePath("/app/settings/integrations/wave");
  redirect(`/app/settings/integrations/wave?status=review_created&run=${run.id}`);
}

export async function approveWaveReviewRunAction(formData: FormData) {
  const { supabase } = await waveContext();
  const runId = String(formData.get("runId") ?? "");
  const confirmation = String(formData.get("confirmation") ?? "");
  if (confirmation !== "APPROVE") redirect(`/app/settings/integrations/wave?status=approval_confirmation_required&run=${runId}`);
  const { error } = await supabase.rpc("approve_studio_wave_sync_run", { target_run_id: runId });
  if (error?.code === "23505") redirect(`/app/settings/integrations/wave?status=duplicate_sources&run=${runId}`);
  if (error) throw new Error(error.message);
  revalidatePath("/app/settings/integrations/wave");
  redirect(`/app/settings/integrations/wave?status=run_approved&run=${runId}`);
}

export async function cancelWaveReviewRunAction(formData: FormData) {
  const { supabase } = await waveContext();
  const runId = String(formData.get("runId") ?? "");
  const { error } = await supabase.rpc("cancel_studio_wave_sync_run", { target_run_id: runId });
  if (error) throw new Error(error.message);
  revalidatePath("/app/settings/integrations/wave");
  redirect(`/app/settings/integrations/wave?status=run_cancelled&run=${runId}`);
}

export async function setWavePostingEnabledAction(formData: FormData) {
  const { supabase, studioId } = await waveContext();
  const desiredEnabled = String(formData.get("enabled") ?? "") === "true";
  const confirmation = String(formData.get("confirmation") ?? "");
  if (desiredEnabled && confirmation !== "ENABLE POSTING") {
    redirect("/app/settings/integrations/wave?status=enable_confirmation_required");
  }
  const { error } = await supabase.rpc("set_studio_wave_posting_enabled", {
    target_studio_id: studioId,
    desired_enabled: desiredEnabled,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/app/settings/integrations/wave");
  redirect(`/app/settings/integrations/wave?status=${desiredEnabled ? "studio_posting_enabled" : "studio_posting_disabled"}`);
}


export async function setWavePostingModeAction(formData: FormData) {
  const { supabase, studioId } = await waveContext();
  const mode = String(formData.get("postingMode") ?? "");
  if (!["manual_review", "approval_required", "auto_post_safe"].includes(mode)) {
    redirect("/app/settings/integrations/wave?status=invalid_posting_mode");
  }
  const confirmation = String(formData.get("confirmation") ?? "").trim();
  if (mode === "auto_post_safe" && confirmation !== "AUTO POST SAFE") {
    redirect("/app/settings/integrations/wave?status=auto_post_confirmation_required");
  }
  const { error } = await supabase.rpc("set_studio_wave_posting_mode", {
    target_studio_id: studioId,
    target_mode: mode,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/app/settings/integrations/wave");
  redirect(`/app/settings/integrations/wave?status=posting_mode_saved`);
}

export async function reconcileWaveRunAction(formData: FormData) {
  const { supabase } = await waveContext();
  const runId = String(formData.get("runId") ?? "");
  const reconciliationStatus = String(formData.get("reconciliationStatus") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  if (reconciliationStatus === "matched" && String(formData.get("confirmation") ?? "") !== "RECONCILED") {
    redirect(`/app/settings/integrations/wave?status=reconciliation_confirmation_required&run=${runId}`);
  }
  if (reconciliationStatus !== "matched" && !note) {
    redirect(`/app/settings/integrations/wave?status=reconciliation_note_required&run=${runId}`);
  }
  const { error } = await supabase.rpc("set_wave_run_reconciliation", {
    target_run_id: runId,
    target_status: reconciliationStatus,
    target_note: note || null,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/app/settings/integrations/wave");
  redirect(`/app/settings/integrations/wave?status=run_reconciled&run=${runId}`);
}

export async function postNextWaveLineAction(formData: FormData) {
  const { supabase, studioId, userId, connection } = await waveContext();
  const runId = String(formData.get("runId") ?? "");
  if (String(formData.get("confirmation") ?? "") !== "POST TO WAVE") {
    redirect(`/app/settings/integrations/wave?status=posting_confirmation_required&run=${runId}`);
  }
  if (process.env.WAVE_POSTING_ENABLED !== "true") {
    redirect(`/app/settings/integrations/wave?status=posting_disabled&run=${runId}`);
  }
  const { data: entitlement } = await supabase.from("studio_wave_posting_entitlements")
    .select("status").eq("studio_id", studioId).maybeSingle();
  if (!entitlement || !["pilot", "active"].includes(entitlement.status)) {
    redirect(`/app/settings/integrations/wave?status=studio_not_allowlisted&run=${runId}`);
  }
  if (!connection.posting_enabled) {
    redirect(`/app/settings/integrations/wave?status=studio_posting_disabled&run=${runId}`);
  }
  if (!connection.scopes?.includes("transaction:write")) {
    redirect(`/app/settings/integrations/wave?status=write_scope_required&run=${runId}`);
  }
  if (connection.is_classic_accounting !== false || !connection.wave_business_id) {
    redirect(`/app/settings/integrations/wave?status=business_not_supported&run=${runId}`);
  }
  const { data: run, error: runError } = await supabase.from("studio_wave_sync_runs")
    .select("id, status, configuration_snapshot").eq("id", runId).eq("studio_id", studioId).single();
  if (runError || !run) throw new Error("Wave review run is unavailable.");
  const snapshot = run.configuration_snapshot as { waveBusinessId?: string } | null;
  if (snapshot?.waveBusinessId !== connection.wave_business_id) {
    redirect(`/app/settings/integrations/wave?status=business_changed&run=${runId}`);
  }
  const { data: lineId, error: claimError } = await supabase.rpc("claim_next_wave_sync_line", { target_run_id: runId });
  if (claimError) throw new Error(claimError.message);
  if (!lineId) redirect(`/app/settings/integrations/wave?status=run_posted&run=${runId}`);

  const admin = createAdminClient();
  const { data: line, error: lineError } = await supabase.from("studio_wave_sync_lines").select(
    "id, entry_date, category, direction, amount, currency, wave_category_account_id, wave_anchor_account_id, wave_external_id, anchor_normal_balance_type, source_count",
  ).eq("id", lineId).eq("run_id", runId).single();
  if (lineError || !line) {
    await admin.from("studio_wave_sync_lines").update({ posting_status: "pending", posting_started_at: null }).eq("id", lineId);
    await admin.from("studio_wave_sync_runs").update({ status: "approved", posting_error: null }).eq("id", runId);
    throw new Error("Claimed Wave posting line is unavailable.");
  }
  const { error: auditStartError } = await admin.from("studio_wave_audit_events").insert({
    studio_id: studioId, connection_id: connection.id, run_id: runId, line_id: line.id,
    event_type: "line_posting", outcome: "started", actor_user_id: userId,
    details: { waveExternalId: line.wave_external_id, amount: line.amount, currency: line.currency },
  });
  if (auditStartError) {
    await admin.from("studio_wave_sync_lines").update({ posting_status: "pending", posting_started_at: null }).eq("id", line.id);
    await admin.from("studio_wave_sync_runs").update({ status: run.status, posting_error: "Posting audit could not be started." }).eq("id", runId);
    throw new Error(auditStartError.message);
  }
  const normalBalance = String(line.anchor_normal_balance_type ?? "").toUpperCase();
  if (normalBalance !== "DEBIT" && normalBalance !== "CREDIT") {
    await admin.from("studio_wave_sync_lines").update({ posting_status: "failed", posting_error: "Anchor normal balance type is unavailable." }).eq("id", line.id);
    await admin.from("studio_wave_sync_runs").update({ status: "failed", posting_error: "Refresh Wave accounts and recreate the review run." }).eq("id", runId);
    redirect(`/app/settings/integrations/wave?status=anchor_type_required&run=${runId}`);
  }
  const direction = line.direction as "debit" | "credit";
  const anchorDirection = normalBalance === "DEBIT"
    ? (direction === "credit" ? "DEPOSIT" : "WITHDRAWAL")
    : (direction === "credit" ? "WITHDRAWAL" : "DEPOSIT");
  const amount = Number(line.amount).toFixed(2);

  let runFinished = false;
  let auditCompletionFailed = false;
  try {
    const token = await getValidWaveAccessToken(connection.id);
    const transactionId = await createWaveMoneyTransaction(token, {
      businessId: connection.wave_business_id,
      externalId: line.wave_external_id,
      date: line.entry_date,
      description: `DanceFlow ${line.category.replaceAll("_", " ")}`,
      notes: `DanceFlow run ${runId}; ${line.source_count} source component(s).`,
      anchor: { accountId: line.wave_anchor_account_id, amount, direction: anchorDirection },
      lineItems: [{ accountId: line.wave_category_account_id, amount, balance: direction.toUpperCase() as "DEBIT" | "CREDIT" }],
    });
    const { error: saveResultError } = await admin.from("studio_wave_sync_lines").update({
      posting_status: "posted", wave_transaction_id: transactionId, posted_at: new Date().toISOString(), posting_error: null,
    }).eq("id", line.id);
    if (saveResultError) throw new WavePostingUncertainError(`Wave created transaction ${transactionId}, but DanceFlow could not save the result.`);
    const { error: auditSuccessError } = await admin.from("studio_wave_audit_events").insert({
      studio_id: studioId, connection_id: connection.id, run_id: runId, line_id: line.id,
      event_type: "line_posting", outcome: "succeeded", actor_user_id: userId,
      details: { waveExternalId: line.wave_external_id, waveTransactionId: transactionId },
    });
    if (auditSuccessError) {
      auditCompletionFailed = true;
      await admin.from("studio_wave_sync_runs").update({ status: "attention_required", posting_error: "Wave posted successfully, but the audit completion event could not be saved.", updated_at: new Date().toISOString() }).eq("id", runId);
    }
    const { count } = await admin.from("studio_wave_sync_lines").select("id", { count: "exact", head: true }).eq("run_id", runId).neq("posting_status", "posted");
    if ((count ?? 0) === 0 && !auditCompletionFailed) {
      await admin.from("studio_wave_sync_runs").update({ status: "posted", posting_completed_at: new Date().toISOString(), posting_error: null, updated_at: new Date().toISOString() }).eq("id", runId);
      runFinished = true;
    }
  } catch (error) {
    const uncertain = error instanceof WavePostingUncertainError;
    const message = error instanceof Error ? error.message : "Wave posting failed.";
    await admin.from("studio_wave_sync_lines").update({ posting_status: uncertain ? "uncertain" : "failed", posting_error: message }).eq("id", line.id);
    await admin.from("studio_wave_sync_runs").update({ status: uncertain ? "attention_required" : "failed", posting_error: message, updated_at: new Date().toISOString() }).eq("id", runId);
    await admin.from("studio_wave_audit_events").insert({
      studio_id: studioId, connection_id: connection.id, run_id: runId, line_id: line.id,
      event_type: "line_posting", outcome: uncertain ? "uncertain" : "failed", actor_user_id: userId,
      details: { waveExternalId: line.wave_external_id, error: message },
    });
    redirect(`/app/settings/integrations/wave?status=${uncertain ? "posting_uncertain" : "posting_failed"}&run=${runId}`);
  }
  revalidatePath("/app/settings/integrations/wave");
  if (auditCompletionFailed) redirect(`/app/settings/integrations/wave?status=audit_completion_failed&run=${runId}`);
  redirect(`/app/settings/integrations/wave?status=${runFinished ? "run_posted" : "line_posted"}&run=${runId}`);
}

export async function disconnectWaveAction() {
  const { supabase, studioId, connection } = await waveContext();
  const admin = createAdminClient();
  const { error: credentialError } = await admin.from("studio_wave_credentials").delete().eq("connection_id", connection.id);
  if (credentialError) throw new Error(credentialError.message);
  const { error } = await supabase.from("studio_wave_connections").update({
    status: "disconnected", wave_user_id: null, scopes: [], last_error: null, updated_at: new Date().toISOString(),
  }).eq("id", connection.id).eq("studio_id", studioId);
  if (error) throw new Error(error.message);
  revalidatePath("/app/settings/integrations/wave");
  redirect("/app/settings/integrations/wave?status=disconnected");
}
