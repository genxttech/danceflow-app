import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPdfPageSizes, sha256Hex } from "@/lib/documents/pdf";
import { renderTemplateVersionPdf } from "@/lib/documents/template-pdf";
import {
  createSigningToken,
  DOCUMENT_FILES_BUCKET,
  hashSigningToken,
  sourceStoragePath,
} from "@/lib/documents/signing";

const EVENT_SIGNING_CONSENT =
  "I have reviewed this event document, agree to use electronic records and signatures, and confirm that the signature I apply is my own.";
const CHECKPOINT_MINUTES = 30;
const ALLOWED_MOBILE_PREFIXES = ["danceflow://events/orders/", "danceflow://wallet"];

type Surface = "web" | "student_app";
type PaymentMode = "checkout" | "payment_sheet";

type RequirementRow = {
  id: string;
  event_id: string;
  template_id: string;
  template_version_id: string | null;
  studio_id: string | null;
  organizer_id: string | null;
  document_templates:
    | {
        id: string;
        title: string;
        description: string | null;
        body: string;
        current_version: number | null;
      }
    | {
        id: string;
        title: string;
        description: string | null;
        body: string;
        current_version: number | null;
      }[]
    | null;
};

type CheckpointRow = {
  id: string;
  order_id: string;
  event_id: string;
  studio_id: string;
  organizer_id: string | null;
  user_id: string | null;
  buyer_email: string;
  surface: Surface;
  payment_mode: PaymentMode;
  status: string;
  requirement_ids: string[];
  registration_ids: string[];
  current_position: number;
  total_required: number;
  mobile_return_url: string | null;
  expires_at: string;
};

function pickOne<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function appUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || "https://idanceflow.com").replace(/\/$/, "");
}

const ALLOWED_SIGNING_RETURN_PREFIXES = [
  "/events/",
  "/api/events/",
  "/api/student/events/",
];

export function normalizeSigningReturnUrl(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("danceflow://")) return trimmed;

  try {
    const base = appUrl();
    const url = new URL(trimmed, base);
    const allowedOrigin = new URL(base).origin;

    if (url.origin !== allowedOrigin) return null;
    if (!ALLOWED_SIGNING_RETURN_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
      return null;
    }

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function continuationSecret() {
  const secret = process.env.EVENT_CHECKOUT_CONTINUATION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("Missing EVENT_CHECKOUT_CONTINUATION_SECRET.");
  return secret;
}

export function createEventCheckoutProof(checkpointId: string, orderId: string) {
  return createHmac("sha256", continuationSecret())
    .update(`${checkpointId}:${orderId}`)
    .digest("base64url");
}

export function verifyEventCheckoutProof(checkpointId: string, orderId: string, proof: string) {
  const expected = Buffer.from(createEventCheckoutProof(checkpointId, orderId));
  const actual = Buffer.from(proof || "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function normalizeMobileEventReturnUrl(value: string | null | undefined, orderId: string) {
  const fallback = `danceflow://events/orders/${encodeURIComponent(orderId)}?checkout=event`;
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  return ALLOWED_MOBILE_PREFIXES.some((prefix) => trimmed.startsWith(prefix)) ? trimmed : fallback;
}

async function loadTemplateSnapshot(requirement: RequirementRow) {
  const admin = createAdminClient();
  const template = pickOne(requirement.document_templates);
  if (!template) throw new Error("Required event document template was not found.");

  if (requirement.template_version_id) {
    const { data: version } = await admin
      .from("document_template_versions")
      .select("version_number, description, body")
      .eq("id", requirement.template_version_id)
      .maybeSingle();

    if (version?.body) {
      return {
        title: template.title,
        description: version.description ?? template.description,
        body: version.body,
        versionNumber: Number(version.version_number ?? template.current_version ?? 1),
      };
    }
  }

  return {
    title: template.title,
    description: template.description,
    body: template.body,
    versionNumber: Number(template.current_version ?? 1),
  };
}

async function createEnvelopeForPosition(checkpoint: CheckpointRow, position: number) {
  const admin = createAdminClient();
  const requirementId = checkpoint.requirement_ids[position];
  if (!requirementId) throw new Error("Required event document sequence is invalid.");

  const { data: requirement, error: requirementError } = await admin
    .from("event_document_requirements")
    .select(`
      id,event_id,template_id,template_version_id,studio_id,organizer_id,
      document_templates:template_id(id,title,description,body,current_version)
    `)
    .eq("id", requirementId)
    .eq("event_id", checkpoint.event_id)
    .eq("active", true)
    .eq("is_required", true)
    .maybeSingle<RequirementRow>();
  if (requirementError || !requirement) throw new Error("Required event document is no longer available.");

  const { data: existing } = await admin
    .from("document_sign_envelopes")
    .select("id,status")
    .eq("event_signing_checkpoint_id", checkpoint.id)
    .eq("event_document_requirement_id", requirement.id)
    .maybeSingle();
  if (existing) throw new Error("This event document has already been created for the checkout.");

  const [{ data: studio }, snapshot] = await Promise.all([
    admin.from("studios").select("name").eq("id", checkpoint.studio_id).maybeSingle(),
    loadTemplateSnapshot(requirement),
  ]);

  const sourceBytes = await renderTemplateVersionPdf({
    title: snapshot.title,
    description: snapshot.description,
    body: snapshot.body,
    versionNumber: snapshot.versionNumber,
    consentText: EVENT_SIGNING_CONSENT,
    studioName: studio?.name ?? null,
  });
  const pageSizes = await getPdfPageSizes(sourceBytes);
  const envelopeId = randomUUID();
  const sourcePath = sourceStoragePath(checkpoint.studio_id, envelopeId);
  const token = createSigningToken();
  const now = new Date().toISOString();

  const { error: uploadError } = await admin.storage
    .from(DOCUMENT_FILES_BUCKET)
    .upload(sourcePath, sourceBytes, {
      contentType: "application/pdf",
      upsert: false,
      cacheControl: "0",
    });
  if (uploadError) throw new Error("Required event document could not be prepared.");

  const registrationId = checkpoint.registration_ids[0] ?? null;
  const { data: assignment, error: assignmentError } = await admin
    .from("document_assignments")
    .insert({
      template_id: requirement.template_id,
      template_version_id: requirement.template_version_id,
      studio_id: checkpoint.studio_id,
      organizer_id: checkpoint.organizer_id,
      event_id: checkpoint.event_id,
      event_order_id: checkpoint.order_id,
      event_registration_id: registrationId,
      event_document_requirement_id: requirement.id,
      event_signing_checkpoint_id: checkpoint.id,
      assigned_to_email: checkpoint.buyer_email,
      status: "sent",
    })
    .select("id")
    .single();
  if (assignmentError || !assignment) {
    await admin.storage.from(DOCUMENT_FILES_BUCKET).remove([sourcePath]);
    throw new Error("Required event document assignment could not be created.");
  }

  const { error: envelopeError } = await admin.from("document_sign_envelopes").insert({
    id: envelopeId,
    assignment_id: assignment.id,
    studio_id: checkpoint.studio_id,
    title: snapshot.title,
    signer_name: "Event attendee",
    signer_email: checkpoint.buyer_email,
    status: "sent",
    token_hash: hashSigningToken(token),
    source_bucket: DOCUMENT_FILES_BUCKET,
    source_path: sourcePath,
    source_sha256: sha256Hex(sourceBytes),
    page_count: pageSizes.length,
    page_sizes: pageSizes,
    expires_at: checkpoint.expires_at,
    sent_at: now,
    context_type: "event_checkout",
    context_id: checkpoint.id,
    event_signing_checkpoint_id: checkpoint.id,
    event_document_requirement_id: requirement.id,
    event_order_id: checkpoint.order_id,
    sequence_group_id: checkpoint.id,
    sequence_position: position + 1,
    sequence_total: checkpoint.total_required,
  });
  if (envelopeError) {
    await admin.from("document_assignments").delete().eq("id", assignment.id);
    await admin.storage.from(DOCUMENT_FILES_BUCKET).remove([sourcePath]);
    throw new Error("Required event document envelope could not be created.");
  }

  const lastPage = Math.max(1, pageSizes.length);
  const { error: fieldsError } = await admin.from("document_sign_fields").insert([
    {
      envelope_id: envelopeId,
      field_type: "printed_name",
      page_number: lastPage,
      x: 0.09,
      y: 0.70,
      width: 0.38,
      height: 0.05,
      label: "Printed name",
      required: true,
      sort_order: 10,
    },
    {
      envelope_id: envelopeId,
      field_type: "date",
      page_number: lastPage,
      x: 0.55,
      y: 0.70,
      width: 0.30,
      height: 0.05,
      label: "Date",
      required: true,
      sort_order: 20,
    },
    {
      envelope_id: envelopeId,
      field_type: "signature",
      page_number: lastPage,
      x: 0.09,
      y: 0.79,
      width: 0.76,
      height: 0.10,
      label: "Signature",
      required: true,
      sort_order: 30,
    },
  ]);
  if (fieldsError) {
    await admin.from("document_sign_envelopes").delete().eq("id", envelopeId);
    await admin.from("document_assignments").delete().eq("id", assignment.id);
    await admin.storage.from(DOCUMENT_FILES_BUCKET).remove([sourcePath]);
    throw new Error("Required event signature fields could not be created.");
  }

  await admin.from("document_sign_events").insert({
    envelope_id: envelopeId,
    event_type: "sent",
    actor_email: checkpoint.buyer_email,
    summary: "Required event document opened during registration checkout.",
    metadata: {
      source: checkpoint.surface,
      order_id: checkpoint.order_id,
      checkpoint_id: checkpoint.id,
      event_document_requirement_id: requirement.id,
      sequence_position: position + 1,
      sequence_total: checkpoint.total_required,
    },
  });

  return `${appUrl()}/sign/${encodeURIComponent(token)}`;
}

export async function beginEventSigningCheckpoint(params: {
  orderId: string;
  eventId: string;
  studioId: string;
  organizerId?: string | null;
  userId?: string | null;
  buyerEmail: string;
  requirementIds: string[];
  registrationIds: string[];
  surface: Surface;
  paymentMode: PaymentMode;
  mobileReturnUrl?: string | null;
}) {
  if (!params.requirementIds.length) return null;
  const admin = createAdminClient();
  const expiresAt = new Date(Date.now() + CHECKPOINT_MINUTES * 60_000).toISOString();

  const { data: existing } = await admin
    .from("event_signing_checkpoints")
    .select("*")
    .eq("order_id", params.orderId)
    .maybeSingle<CheckpointRow>();
  if (existing) {
    const { data: envelope } = await admin
      .from("document_sign_envelopes")
      .select("id,status")
      .eq("event_signing_checkpoint_id", existing.id)
      .in("status", ["sent", "viewed", "started"])
      .order("sequence_position", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (envelope) throw new Error("Signing has already started for this order. Reopen the current secure link.");
  }

  const { data: checkpoint, error } = await admin
    .from("event_signing_checkpoints")
    .insert({
      order_id: params.orderId,
      event_id: params.eventId,
      studio_id: params.studioId,
      organizer_id: params.organizerId ?? null,
      user_id: params.userId ?? null,
      buyer_email: params.buyerEmail.toLowerCase(),
      surface: params.surface,
      payment_mode: params.paymentMode,
      status: "signing",
      requirement_ids: params.requirementIds,
      registration_ids: params.registrationIds,
      current_position: 0,
      total_required: params.requirementIds.length,
      mobile_return_url:
        params.surface === "student_app"
          ? normalizeMobileEventReturnUrl(params.mobileReturnUrl, params.orderId)
          : null,
      expires_at: expiresAt,
      metadata: { source: "danceflow_sign_event_registration_v1_7" },
    })
    .select("*")
    .single<CheckpointRow>();
  if (error || !checkpoint) throw new Error("Required-document checkpoint could not be created.");

  await admin.from("event_orders").update({ expires_at: expiresAt, updated_at: new Date().toISOString() }).eq("id", params.orderId);
  return {
    checkpointId: checkpoint.id,
    signingUrl: await createEnvelopeForPosition(checkpoint, 0),
  };
}

export async function advanceEventSigningCheckpoint(envelopeId: string) {
  const admin = createAdminClient();
  const { data: envelope } = await admin
    .from("document_sign_envelopes")
    .select("id,event_signing_checkpoint_id,event_document_requirement_id,event_order_id,assignment_id,status")
    .eq("id", envelopeId)
    .maybeSingle();
  if (!envelope?.event_signing_checkpoint_id) return null;

  const { data: checkpoint } = await admin
    .from("event_signing_checkpoints")
    .select("*")
    .eq("id", envelope.event_signing_checkpoint_id)
    .maybeSingle<CheckpointRow>();
  if (!checkpoint) throw new Error("Event signing checkpoint was not found.");
  if (new Date(checkpoint.expires_at).getTime() <= Date.now()) {
    await admin.from("event_signing_checkpoints").update({ status: "expired", updated_at: new Date().toISOString() }).eq("id", checkpoint.id);
    throw new Error("Event checkout expired before signing was completed.");
  }

  if (envelope.assignment_id) {
    await admin.from("document_assignments").update({ status: "signed", signed_at: new Date().toISOString(), completed_at: new Date().toISOString() }).eq("id", envelope.assignment_id);
  }

  const nextPosition = Math.max(checkpoint.current_position + 1, Number(checkpoint.current_position ?? 0) + 1);
  if (nextPosition < checkpoint.total_required) {
    await admin.from("event_signing_checkpoints").update({
      current_position: nextPosition,
      last_progress_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", checkpoint.id).eq("status", "signing");

    return {
      kind: "next" as const,
      url: await createEnvelopeForPosition({ ...checkpoint, current_position: nextPosition }, nextPosition),
    };
  }

  await admin.from("event_signing_checkpoints").update({
    current_position: checkpoint.total_required,
    status: "ready_for_payment",
    last_progress_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", checkpoint.id).eq("status", "signing");

  if (checkpoint.surface === "student_app") {
    const base = normalizeMobileEventReturnUrl(checkpoint.mobile_return_url, checkpoint.order_id);
    const separator = base.includes("?") ? "&" : "?";
    return { kind: "complete" as const, url: `${base}${separator}signing=completed&orderId=${encodeURIComponent(checkpoint.order_id)}` };
  }

  const proof = createEventCheckoutProof(checkpoint.id, checkpoint.order_id);
  return {
    kind: "complete" as const,
    url: `${appUrl()}/api/events/cart/resume-after-signing?checkpointId=${encodeURIComponent(checkpoint.id)}&orderId=${encodeURIComponent(checkpoint.order_id)}&proof=${encodeURIComponent(proof)}`,
  };
}

export async function getEventSigningCheckpointByOrder(orderId: string) {
  const admin = createAdminClient();
  const { data } = await admin.from("event_signing_checkpoints").select("*").eq("order_id", orderId).maybeSingle<CheckpointRow>();
  return data ?? null;
}