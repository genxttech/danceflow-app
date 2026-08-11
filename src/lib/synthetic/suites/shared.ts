import type { SyntheticSession } from "@/lib/synthetic/auth";
import { syntheticTag } from "@/lib/synthetic/runId";
import type { CreatedRecordRefs } from "@/lib/synthetic/types";
import { addRef, assertTestCondition } from "@/lib/synthetic/suites/contract";

/**
 * Reused across the Client, Schedule, and Entitlement suites: each of
 * those needs a throwaway synthetic client fixture, created the same way
 * (mirroring the shape createClientAction inserts, minus the optional
 * side effects like document envelopes/partner linking that aren't
 * relevant to a synthetic run), and every one of them tags the record with
 * the run id in `notes` in addition to recording it in
 * created_record_refs, per PRODUCTION-SYNTHETIC-TESTING.md's "synthetic
 * data tagging/ownership" requirement -- belt-and-suspenders so a human
 * looking at raw data (not the audit table) can also tell it's synthetic.
 */
export async function createSyntheticClientFixture(
  session: SyntheticSession,
  runId: string,
  refs: CreatedRecordRefs,
): Promise<{ clientId: string; refs: CreatedRecordRefs }> {
  const { data, error } = await session.client
    .from("clients")
    .insert({
      studio_id: session.studioId,
      first_name: "Synthetic",
      last_name: `TestClient-${runId.slice(4, 12)}`,
      status: "lead",
      notes: `${syntheticTag(runId)} Created by the production synthetic testing harness. Safe to archive/delete.`,
    })
    .select("id, studio_id")
    .single();

  assertTestCondition(!error && data, `Synthetic client fixture insert failed: ${error?.message ?? "no row returned"}`);
  assertTestCondition(
    data!.studio_id === session.studioId,
    "Synthetic client fixture was created under an unexpected studio_id.",
  );

  return { clientId: data!.id as string, refs: addRef(refs, "clients", data!.id as string) };
}

export async function archiveSyntheticClientFixture(
  session: SyntheticSession,
  clientId: string,
): Promise<void> {
  const { error } = await session.client
    .from("clients")
    .update({ status: "archived" })
    .eq("id", clientId)
    .eq("studio_id", session.studioId);

  assertTestCondition(!error, `Failed to archive synthetic client ${clientId}: ${error?.message}`);
}
