"use server";

import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { studioHasFeature } from "@/lib/billing/access";
import { canManageDocumentsRole } from "@/lib/documents/studio-access";
import { loadEligibleDocumentSigners, usableEmail } from "@/lib/documents/recipients";
import { RELATIONSHIP_LABELS } from "@/lib/student-identity/relationship-links";

/*
  Phase 8D -- data for the single assignment form (searchable client picker + recipient choice). Server-side guard on
  every call: Documents-management role + Documents plan feature, scoped to the current studio. The assignment itself
  is still created only by assignDocumentToClientAction, which re-validates everything.
*/

export type AssignableClient = { id: string; name: string; email: string | null };
export type RecipientOptions = {
  clientEmail: string | null;
  signers: Array<{ linkId: string; label: string; email: string }>;
};

async function assignContext() {
  const context = await getCurrentStudioContext();
  if (!canManageDocumentsRole(context.studioRole)) return null;
  if (!(await studioHasFeature("documents"))) return null;
  return { studioId: context.studioId };
}

/** Search active / lead clients by name or email (at most 8 results; never the whole roster). */
export async function searchAssignableClientsAction(query: string): Promise<AssignableClient[]> {
  const context = await assignContext();
  if (!context) return [];
  // Characters that are structural in a PostgREST filter list are dropped, so input can only ever be a search term.
  const term = String(query ?? "").replace(/[^\p{L}\p{N}@.\-' ]/gu, "").trim().slice(0, 60);
  if (term.length < 2) return [];

  const supabase = await createClient();
  const { data } = await supabase
    .from("clients")
    .select("id, first_name, last_name, email")
    .eq("studio_id", context.studioId)
    .in("status", ["active", "lead"])
    .or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,email.ilike.%${term}%`)
    .order("first_name", { ascending: true })
    .limit(8);

  return ((data ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null }>).map(
    (client) => ({
      id: client.id,
      name: [client.first_name, client.last_name].filter(Boolean).join(" ").trim() || client.email || "Client",
      email: client.email,
    }),
  );
}

/** Who can receive a document for this client: the client (if they have an email) and eligible linked signers. */
export async function loadRecipientOptionsAction(clientId: string): Promise<RecipientOptions | null> {
  const context = await assignContext();
  if (!context || !clientId) return null;
  const supabase = await createClient();
  const { data: client } = await supabase
    .from("clients")
    .select("id, email")
    .eq("id", clientId)
    .eq("studio_id", context.studioId)
    .maybeSingle();
  if (!client) return null;

  const signers = await loadEligibleDocumentSigners({ studioId: context.studioId, clientId });
  return {
    clientEmail: usableEmail(client.email),
    signers: signers.map((signer) => ({
      linkId: signer.linkId,
      email: signer.email,
      label: `${signer.name ?? signer.email} (${RELATIONSHIP_LABELS[signer.relationshipType] ?? signer.relationshipType})`,
    })),
  };
}
