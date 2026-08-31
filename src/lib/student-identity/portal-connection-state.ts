/**
 * Portal / Multi-Studio H2-A: the canonical portal connection state
 * resolver. Both the admin client-detail display and the invite
 * eligibility check must derive their answer from this single function,
 * fed with the same studio+client-scoped row set -- this is what makes it
 * impossible for the two call sites to disagree about the same fixture.
 *
 * Pure by design: operates only on an already-fetched row array, never
 * touches Supabase/network. `now` is injectable so expiry evaluation never
 * depends on wall-clock time in tests.
 */

export type PortalConnectionLinkRow = {
  id: string;
  userId: string | null;
  status: string;
  relationshipType: string;
  isPrimary: boolean | null;
  createdAt: string;
  inviteTokenHash: string | null;
  inviteExpiresAt: string | null;
};

export type PortalConnectionState =
  | {
      kind: "linked";
      linkId: string;
      userId: string;
      relationshipType: string;
      isPrimary: boolean;
    }
  | {
      kind: "invited";
      linkId: string;
      userId: string | null;
      relationshipType: string;
      expiresAt: string | null;
    }
  | {
      /**
       * An explicit staff-initiated revocation of a formerly-active
       * relationship (client_account_links.status is 'disconnected' or
       * 'former_client' -- the only two statuses disconnectClientAccount
       * ever writes). Distinct from "inactive": this relationship DID
       * grant access at some point and was deliberately ended.
       */
      kind: "disconnected";
      linkId: string;
      userId: string | null;
      relationshipType: string;
      rawStatus: string;
    }
  | {
      /**
       * A historical relationship record that does not currently grant
       * access and is not an open invite, but was never an actual
       * disconnected/revoked relationship either -- a dead-token or
       * expired invited/claim_pending row (status left unchanged by
       * linkExistingClientAccount's stale-invite cleanup, see
       * isGenuinelyOpenInvite below), a rejected invitation, or the
       * pre-invite `unclaimed` state. rawStatus preserves exactly which,
       * for staff/debugging logic that needs the distinction.
       */
      kind: "inactive";
      linkId: string;
      userId: string | null;
      relationshipType: string;
      rawStatus: string;
    }
  | {
      kind: "conflict";
      linkId: string;
      userId: string | null;
      relationshipType: string;
    }
  | { kind: "none" };

const OPEN_INVITE_STATUSES = new Set(["invited", "claim_pending"]);

/**
 * A row's status alone is not sufficient to know whether an invite is
 * actually claimable: linkExistingClientAccount nulls invite_token_hash
 * (and invite_expires_at) on sibling invited/claim_pending rows once a
 * different row for the same client is linked, without changing their
 * status. An expired-but-unclaimed invite is equally not actionable.
 */
function isGenuinelyOpenInvite(row: PortalConnectionLinkRow, now: Date): boolean {
  if (!OPEN_INVITE_STATUSES.has(row.status)) return false;
  if (!row.inviteTokenHash) return false;
  if (row.inviteExpiresAt && new Date(row.inviteExpiresAt).getTime() <= now.getTime()) {
    return false;
  }
  return true;
}

function byCreatedAtDesc(a: PortalConnectionLinkRow, b: PortalConnectionLinkRow) {
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

/** Primary before non-primary; otherwise oldest first -- matches the
 * existing resolvePortalRelationship tie-break
 * (order("is_primary", desc).order("created_at", asc)). */
function byLinkedPrecedence(a: PortalConnectionLinkRow, b: PortalConnectionLinkRow) {
  const aPrimary = a.isPrimary === true;
  const bPrimary = b.isPrimary === true;
  if (aPrimary !== bPrimary) return aPrimary ? -1 : 1;
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

// The only two statuses disconnectClientAccount ever writes -- an actual,
// explicit revocation of a formerly-active relationship. Everything else
// non-actionable (dead/expired invited/claim_pending, rejected, unclaimed)
// is "inactive": historical, but never an active relationship that was
// revoked.
const EXPLICITLY_DISCONNECTED_STATUSES = new Set(["disconnected", "former_client"]);

function classifyNonLinkedRow(row: PortalConnectionLinkRow): PortalConnectionState {
  if (row.status === "conflict") {
    return {
      kind: "conflict",
      linkId: row.id,
      userId: row.userId,
      relationshipType: row.relationshipType,
    };
  }

  if (EXPLICITLY_DISCONNECTED_STATUSES.has(row.status)) {
    return {
      kind: "disconnected",
      linkId: row.id,
      userId: row.userId,
      relationshipType: row.relationshipType,
      rawStatus: row.status,
    };
  }

  return {
    kind: "inactive",
    linkId: row.id,
    userId: row.userId,
    relationshipType: row.relationshipType,
    rawStatus: row.status,
  };
}

/**
 * Resolves the canonical portal connection state from an already-fetched,
 * studio+client-scoped set of client_account_links rows.
 *
 * Overall/admin mode (targetUserId omitted): answers "does this client
 * currently have a meaningful portal relationship" across every person
 * who might hold one. Precedence: any linked relationship (primary, then
 * oldest, wins among several) beats a genuinely open invite, which beats
 * a terminal/history row, which beats having no rows at all. A newer
 * unrelated non-linked row can never suppress an older still-linked
 * relationship, because linked rows are found first regardless of
 * recency.
 *
 * Target-user mode (targetUserId provided): scopes to only that user's
 * own rows for this client/studio, then applies the same
 * linked > open-invite > terminal precedence within that scope. This is
 * exactly what invite eligibility needs: "does THIS resolved person
 * already have access," independent of what any other person's rows say.
 */
export function resolvePortalConnectionState(params: {
  rows: PortalConnectionLinkRow[];
  targetUserId?: string | null;
  now?: Date;
}): PortalConnectionState {
  const now = params.now ?? new Date();
  const scoped = params.targetUserId
    ? params.rows.filter((row) => row.userId === params.targetUserId)
    : params.rows;

  if (scoped.length === 0) {
    return { kind: "none" };
  }

  const linkedRows = scoped.filter((row) => row.status === "linked");
  if (linkedRows.length > 0) {
    const best = [...linkedRows].sort(byLinkedPrecedence)[0];
    return {
      kind: "linked",
      linkId: best.id,
      userId: best.userId as string,
      relationshipType: best.relationshipType,
      isPrimary: best.isPrimary === true,
    };
  }

  const openInvites = scoped.filter((row) => isGenuinelyOpenInvite(row, now));
  if (openInvites.length > 0) {
    const newest = [...openInvites].sort(byCreatedAtDesc)[0];
    return {
      kind: "invited",
      linkId: newest.id,
      userId: newest.userId,
      relationshipType: newest.relationshipType,
      expiresAt: newest.inviteExpiresAt,
    };
  }

  const newest = [...scoped].sort(byCreatedAtDesc)[0];
  return classifyNonLinkedRow(newest);
}
