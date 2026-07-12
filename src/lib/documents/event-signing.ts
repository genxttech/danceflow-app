import { createAdminClient } from "@/lib/supabase/admin";

const ALLOWED_RETURN_PREFIXES = [
  "/events/",
  "/api/events/",
  "/api/student/events/",
];

export function normalizeSigningReturnUrl(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("danceflow://")) return trimmed;

  try {
    const url = new URL(trimmed, "https://idanceflow.com");
    if (url.origin !== "https://idanceflow.com") return null;
    if (!ALLOWED_RETURN_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
      return null;
    }

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export async function nextEventSigningDestination(params: {
  envelopeId: string;
  sequenceGroupId?: string | null;
  returnUrl?: string | null;
}) {
  const admin = createAdminClient();

  if (params.sequenceGroupId) {
    const { data: nextEnvelope } = await admin
      .from("document_sign_envelopes")
      .select("token_hash, status, sequence_position")
      .eq("sequence_group_id", params.sequenceGroupId)
      .in("status", ["sent", "viewed", "started"])
      .order("sequence_position", { ascending: true })
      .limit(1)
      .maybeSingle();

    // Tokens are never reconstructed from hashes. A sequence launcher must
    // supply the next raw token through a secure server-side continuation route.
    if (nextEnvelope) {
      return {
        kind: "sequence_pending" as const,
        returnUrl: normalizeSigningReturnUrl(params.returnUrl),
      };
    }
  }

  return {
    kind: "complete" as const,
    returnUrl: normalizeSigningReturnUrl(params.returnUrl),
  };
}
