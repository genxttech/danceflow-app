import { createAdminClient } from "@/lib/supabase/admin";

/*
  Phase 8D: the account relationships of one client, for staff relationship management (who can act for this client,
  and who may sign documents for them). Scoped to studio + client; independent of the client's own email, so a client
  with no email still shows (and can receive) an authorized guardian / contact.
*/

export type ClientRelationshipLink = {
  id: string;
  relationshipType: string;
  status: string;
  email: string | null;
  canSignDocuments: boolean;
  linkedAt: string | null;
};

const ACTIVE_STATUSES = ["linked", "invited", "claim_pending"];

export async function loadClientRelationshipLinks(params: { studioId: string; clientId: string }) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("client_account_links")
    .select("id, user_id, relationship_type, status, invited_email, can_sign_documents, linked_at, created_at")
    .eq("studio_id", params.studioId)
    .eq("client_id", params.clientId)
    .in("status", ACTIVE_STATUSES)
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) return [] as ClientRelationshipLink[];

  const rows = (data ?? []) as Array<{
    id: string;
    user_id: string | null;
    relationship_type: string;
    status: string;
    invited_email: string | null;
    can_sign_documents: boolean | null;
    linked_at: string | null;
  }>;
  const userIds = rows.map((row) => row.user_id).filter((id): id is string => Boolean(id));
  const profileEmails = new Map<string, string>();
  if (userIds.length) {
    const { data: profiles } = await admin.from("profiles").select("id, email").in("id", userIds);
    for (const profile of (profiles ?? []) as Array<{ id: string; email: string | null }>) {
      if (profile.email) profileEmails.set(profile.id, profile.email);
    }
  }

  return rows.map((row) => ({
    id: row.id,
    relationshipType: row.relationship_type,
    status: row.status,
    email: (row.user_id ? profileEmails.get(row.user_id) : null) ?? row.invited_email ?? null,
    canSignDocuments: row.can_sign_documents === true,
    linkedAt: row.linked_at,
  }));
}

export const RELATIONSHIP_LABELS: Record<string, string> = {
  self: "Client's own account",
  guardian: "Guardian",
  parent: "Parent",
  billing_contact: "Billing contact",
  dependent_manager: "Dependent manager",
  dependent: "Dependent",
};
