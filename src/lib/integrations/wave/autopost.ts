import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { createWaveMoneyTransaction, WavePostingUncertainError } from "@/lib/integrations/wave/client";
import { getValidWaveAccessToken } from "@/lib/integrations/wave/token";

type AutoPostResult = {
  scannedRuns: number;
  claimedLines: number;
  postedLines: number;
  completedRuns: number;
  skippedRuns: number;
  failedRuns: number;
  uncertainRuns: number;
  messages: string[];
};

type WaveConnectionRow = {
  id: string;
  studio_id: string;
  wave_business_id: string | null;
  is_classic_accounting: boolean | null;
  scopes: string[] | null;
  posting_enabled: boolean | null;
  posting_mode: string | null;
  status: string | null;
};

type WaveRunRow = {
  id: string;
  studio_id: string;
  connection_id: string;
  status: string;
  configuration_snapshot: { waveBusinessId?: string } | null;
};

type WaveLineRow = {
  id: string;
  entry_date: string;
  category: string;
  direction: "debit" | "credit";
  amount: number | string;
  currency: string;
  wave_category_account_id: string;
  wave_anchor_account_id: string;
  wave_external_id: string;
  anchor_normal_balance_type: string | null;
  source_count: number | null;
};

function autoPostAvailable(connection: WaveConnectionRow) {
  return process.env.WAVE_POSTING_ENABLED === "true"
    && connection.status === "connected"
    && connection.posting_enabled === true
    && connection.posting_mode === "auto_post_safe"
    && connection.is_classic_accounting === false
    && Boolean(connection.wave_business_id)
    && Array.isArray(connection.scopes)
    && connection.scopes.includes("transaction:write");
}

function anchorDirectionFor(line: WaveLineRow) {
  const normalBalance = String(line.anchor_normal_balance_type ?? "").toUpperCase();
  if (normalBalance !== "DEBIT" && normalBalance !== "CREDIT") {
    throw new Error("Anchor normal balance type is unavailable.");
  }
  return normalBalance === "DEBIT"
    ? (line.direction === "credit" ? "DEPOSIT" : "WITHDRAWAL")
    : (line.direction === "credit" ? "WITHDRAWAL" : "DEPOSIT");
}

async function markRunCompleteIfFinished(admin: ReturnType<typeof createAdminClient>, runId: string) {
  const { count } = await admin
    .from("studio_wave_sync_lines")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId)
    .neq("posting_status", "posted");

  if ((count ?? 0) === 0) {
    const { error } = await admin
      .from("studio_wave_sync_runs")
      .update({
        status: "posted",
        posting_completed_at: new Date().toISOString(),
        posting_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", runId);
    if (error) throw new WavePostingUncertainError(`All Wave lines posted, but DanceFlow could not mark run complete: ${error.message}`);
    return true;
  }

  return false;
}

async function postClaimedLine({
  connection,
  run,
  lineId,
}: {
  connection: WaveConnectionRow;
  run: WaveRunRow;
  lineId: string;
}) {
  const admin = createAdminClient();
  const { data: line, error: lineError } = await admin
    .from("studio_wave_sync_lines")
    .select("id, entry_date, category, direction, amount, currency, wave_category_account_id, wave_anchor_account_id, wave_external_id, anchor_normal_balance_type, source_count")
    .eq("id", lineId)
    .eq("run_id", run.id)
    .single();

  if (lineError || !line) {
    await admin.from("studio_wave_sync_lines").update({ posting_status: "pending", posting_started_at: null }).eq("id", lineId);
    throw new Error("Claimed Wave posting line is unavailable.");
  }

  await admin.from("studio_wave_audit_events").insert({
    studio_id: run.studio_id,
    connection_id: connection.id,
    run_id: run.id,
    line_id: line.id,
    event_type: "auto_post_line",
    outcome: "started",
    actor_user_id: null,
    details: { waveExternalId: line.wave_external_id, amount: line.amount, currency: line.currency },
  });

  try {
    const anchorDirection = anchorDirectionFor(line);
    const amount = Number(line.amount).toFixed(2);
    const token = await getValidWaveAccessToken(connection.id);
    const transactionId = await createWaveMoneyTransaction(token, {
      businessId: connection.wave_business_id!,
      externalId: line.wave_external_id,
      date: line.entry_date,
      description: `DanceFlow ${line.category.replaceAll("_", " ")}`,
      notes: `DanceFlow auto-post run ${run.id}; ${line.source_count ?? 0} source component(s).`,
      anchor: { accountId: line.wave_anchor_account_id, amount, direction: anchorDirection },
      lineItems: [{
        accountId: line.wave_category_account_id,
        amount,
        balance: line.direction.toUpperCase() as "DEBIT" | "CREDIT",
      }],
    });

    const { error: saveError } = await admin.from("studio_wave_sync_lines").update({
      posting_status: "posted",
      wave_transaction_id: transactionId,
      posted_at: new Date().toISOString(),
      posting_error: null,
    }).eq("id", line.id);
    if (saveError) throw new WavePostingUncertainError(`Wave created transaction ${transactionId}, but DanceFlow could not save the result.`);

    await admin.from("studio_wave_audit_events").insert({
      studio_id: run.studio_id,
      connection_id: connection.id,
      run_id: run.id,
      line_id: line.id,
      event_type: "auto_post_line",
      outcome: "succeeded",
      actor_user_id: null,
      details: { waveExternalId: line.wave_external_id, waveTransactionId: transactionId },
    });

    const completedRun = await markRunCompleteIfFinished(admin, run.id);
    return { posted: true, completedRun };
  } catch (error) {
    const uncertain = error instanceof WavePostingUncertainError;
    const message = error instanceof Error ? error.message : "Wave auto-post failed.";
    await admin.from("studio_wave_sync_lines").update({
      posting_status: uncertain ? "uncertain" : "failed",
      posting_error: message,
    }).eq("id", line.id);
    await admin.from("studio_wave_sync_runs").update({
      status: uncertain ? "attention_required" : "failed",
      posting_error: message,
      updated_at: new Date().toISOString(),
    }).eq("id", run.id);
    await admin.from("studio_wave_audit_events").insert({
      studio_id: run.studio_id,
      connection_id: connection.id,
      run_id: run.id,
      line_id: line.id,
      event_type: "auto_post_line",
      outcome: uncertain ? "uncertain" : "failed",
      actor_user_id: null,
      details: { waveExternalId: line.wave_external_id, error: message },
    });
    throw error;
  }
}

export async function runWaveAutoPost(options: { maxRuns?: number; maxLines?: number } = {}): Promise<AutoPostResult> {
  const maxRuns = Math.max(1, Math.min(options.maxRuns ?? 10, 25));
  const maxLines = Math.max(1, Math.min(options.maxLines ?? 10, 50));
  const admin = createAdminClient();
  const result: AutoPostResult = {
    scannedRuns: 0,
    claimedLines: 0,
    postedLines: 0,
    completedRuns: 0,
    skippedRuns: 0,
    failedRuns: 0,
    uncertainRuns: 0,
    messages: [],
  };

  if (process.env.WAVE_POSTING_ENABLED !== "true") {
    result.messages.push("Wave posting is disabled by environment setting.");
    return result;
  }

  const { data: connections, error: connectionError } = await admin
    .from("studio_wave_connections")
    .select("id, studio_id, wave_business_id, is_classic_accounting, scopes, posting_enabled, posting_mode, status")
    .eq("status", "connected")
    .eq("posting_enabled", true)
    .eq("posting_mode", "auto_post_safe")
    .limit(maxRuns);

  if (connectionError) throw new Error(connectionError.message);

  for (const connection of (connections ?? []) as WaveConnectionRow[]) {
    if (!autoPostAvailable(connection)) {
      result.skippedRuns += 1;
      continue;
    }

    const { data: entitlement } = await admin
      .from("studio_wave_posting_entitlements")
      .select("status")
      .eq("studio_id", connection.studio_id)
      .maybeSingle();
    if (!entitlement || !["pilot", "active"].includes(entitlement.status)) {
      result.skippedRuns += 1;
      continue;
    }

    const { data: runs, error: runsError } = await admin
      .from("studio_wave_sync_runs")
      .select("id, studio_id, connection_id, status, configuration_snapshot")
      .eq("connection_id", connection.id)
      .in("status", ["approved", "posting"])
      .order("approved_at", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true })
      .limit(maxRuns);

    if (runsError) throw new Error(runsError.message);

    for (const run of (runs ?? []) as WaveRunRow[]) {
      if (result.claimedLines >= maxLines) return result;
      result.scannedRuns += 1;
      if (run.configuration_snapshot?.waveBusinessId !== connection.wave_business_id) {
        await admin.from("studio_wave_sync_runs").update({
          status: "attention_required",
          posting_error: "Wave business changed after this run was created.",
          updated_at: new Date().toISOString(),
        }).eq("id", run.id);
        result.skippedRuns += 1;
        continue;
      }

      let lineId: string | null = null;
      const { data: claimedLineId, error: claimError } = await admin.rpc("claim_next_wave_sync_line_for_autopost", {
        target_run_id: run.id,
      });
      if (claimError) {
        result.failedRuns += 1;
        result.messages.push(`${run.id}: ${claimError.message}`);
        continue;
      }
      lineId = claimedLineId as string | null;
      if (!lineId) {
        result.skippedRuns += 1;
        continue;
      }

      result.claimedLines += 1;
      try {
        const posted = await postClaimedLine({ connection, run, lineId });
        if (posted.posted) result.postedLines += 1;
        if (posted.completedRun) result.completedRuns += 1;
      } catch (error) {
        if (error instanceof WavePostingUncertainError) result.uncertainRuns += 1;
        else result.failedRuns += 1;
        result.messages.push(`${run.id}: ${error instanceof Error ? error.message : "Wave auto-post failed."}`);
      }
    }
  }

  return result;
}
