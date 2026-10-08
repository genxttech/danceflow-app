import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { FakeSupabase } from "@/lib/aria/__tests__/fakeSupabase";
import { hashSigningToken } from "@/lib/documents/signing";
import { sha256Hex } from "@/lib/documents/pdf";
import {
  deriveSignEnvelopeLifecycle,
  SIGN_LINK_GRACE_DAYS,
  signLinkExpiryForDueDate,
} from "@/lib/documents/signing-integrity";

/**
 * Phase 8B -- Documents lifecycle correctness + gating (behavioural coverage of the server paths):
 *   - every staff Documents MANAGEMENT surface (sign actions, draft editor, assignment actions, onboarding) requires the
 *     `documents` plan feature server-side; after a downgrade authorized staff keep READ access to historical records
 *     (envelope history, signed / source PDFs, certificates) under the same auth, role and tenancy checks; signers can
 *     still complete already-issued requests;
 *   - a revision keeps client / template / version / context (portal access survives), never reopens a waived / void
 *     requirement, is refused for event-checkout waivers, and relinks only a still-pending assignment;
 *   - expiry / decline keep the assignment pending with a derived state; the cron persists expiry, voids abandoned
 *     checkout waivers, and reminds only eligible requests with deterministic, bounded, starvation-free selection;
 *   - due-date editing is pending-only, restarts reminders and extends (never revives) the signing link.
 */

const STUDIO = "studio-a";
const OTHER_STUDIO = "studio-b";
const CLIENT = "client-a";
const USER = "user-portal";
const STAFF = "user-staff";
const TOKEN = "phase8b-token";
const SOURCE = new Uint8Array([1, 2, 3, 4]);
const SOURCE_SHA = sha256Hex(SOURCE);
const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";
const DAY = 86_400_000;

const hooks: { onUpload?: (path: string) => void } = {};

class DocumentsFake extends FakeSupabase {
  files = new Map<string, Uint8Array>();
  auth = { getUser: async () => ({ data: { user: { id: state.authUserId, email: "someone@example.test" } } }) };
  storage = {
    from: (bucket: string) => ({
      download: async (path: string) => {
        const bytes = this.files.get(`${bucket}/${path}`);
        return bytes ? { data: { arrayBuffer: async () => bytes.slice().buffer }, error: null } : { data: null, error: { message: "missing" } };
      },
      upload: async (path: string, bytes: Uint8Array, options?: { upsert?: boolean }) => {
        const key = `${bucket}/${path}`;
        if (this.files.has(key) && !options?.upsert) return { error: { message: "The resource already exists" } };
        this.files.set(key, bytes);
        hooks.onUpload?.(path);
        return { error: null };
      },
      remove: async (paths: string[]) => {
        for (const path of paths) this.files.delete(`${bucket}/${path}`);
        return { error: null };
      },
      createSignedUrl: async () => ({ data: { signedUrl: "https://signed.example.test/doc" }, error: null }),
    }),
  };
}

const RELATIONS = {
  document_assignments: {
    document_sign_envelopes: { table: "document_sign_envelopes", localKey: "sign_envelope_id" },
    event_signing_checkpoints: { table: "event_signing_checkpoints", localKey: "event_signing_checkpoint_id" },
  },
};

const state: {
  db: DocumentsFake;
  authUserId: string;
  unauthenticated: boolean;
  role: string;
  features: Set<string>;
  studioFeatures: Record<string, string[]>;
  deliveries: Array<{ dedupeKey: string; templateKey: string; relatedId: string; recipientEmail: string }>;
  dedupeKeys: Set<string>;
} = {
  db: new DocumentsFake(),
  authUserId: STAFF,
  unauthenticated: false,
  role: "studio_owner",
  features: new Set(["documents"]),
  studioFeatures: {},
  deliveries: [],
  dedupeKeys: new Set(),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.5" }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  unstable_rethrow: (error: unknown) => {
    if (error instanceof Error && error.message.startsWith("redirect:")) throw error;
  },
}));
vi.mock("@/lib/auth/studio", () => ({
  // Mirrors the real helper: requireAuthenticatedUser() redirects a signed-out request to /login.
  getCurrentStudioContext: async () => {
    if (state.unauthenticated) throw new Error("redirect:/login");
    return { studioId: STUDIO, studioRole: state.role, userId: STAFF };
  },
}));
vi.mock("@/lib/billing/access", () => ({
  requireStudioFeature: async (feature: string) => {
    if (!state.features.has(feature)) throw new Error(`redirect:/app/settings/billing?upgrade=${feature}`);
  },
  studioHasFeature: async (feature: string) => state.features.has(feature),
  studioIdHasFeature: async (_client: unknown, studioId: string, feature: string) =>
    (state.studioFeatures[studioId] ?? []).includes(feature),
}));
vi.mock("@/lib/notifications/expoPush", () => ({ sendMobilePushToUser: async () => undefined }));
vi.mock("@/lib/notifications/outbound", () => ({
  queueOutboundDelivery: async (params: { dedupeKey: string; templateKey: string; relatedId: string; recipientEmail: string }) => {
    if (state.dedupeKeys.has(params.dedupeKey)) return { queued: false, skipped: true, reason: "duplicate" };
    state.dedupeKeys.add(params.dedupeKey);
    state.deliveries.push(params);
    return { queued: true };
  },
}));
vi.mock("@/lib/documents/public-signing-security", () => ({
  consumePublicSigningRateLimit: async () => ({ allowed: true }),
  serverActionIp: async () => "203.0.113.5",
  requestIp: () => "203.0.113.5",
}));
vi.mock("@/lib/documents/pdf", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/documents/pdf")>()),
  applySigningFields: async () => ({ bytes: new Uint8Array([9, 9, 9]), sha256: "signed-sha" }),
}));
vi.mock("@/lib/student-identity/portal-context", () => ({
  resolvePortalRelationship: async () => ({ clientId: CLIENT }),
}));

type Seed = {
  assignmentStatus?: string;
  envelopeStatus?: string;
  expiresAt?: string;
  contextType?: string | null;
  checkpointId?: string | null;
  dueAt?: string | null;
  assignmentStudio?: string;
  reminderSentAt?: string | null;
  overdueReminderSentAt?: string | null;
};

function envelopeRow(id: string, assignmentId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    studio_id: STUDIO,
    client_id: CLIENT,
    organizer_id: null,
    assignment_id: assignmentId,
    template_id: "tpl-1",
    template_version_id: "ver-1",
    source_kind: "template_version",
    context_type: "client_assignment",
    context_id: assignmentId,
    event_signing_checkpoint_id: null,
    title: "Waiver",
    signer_name: "Robin Lee",
    signer_email: "robin@example.test",
    status: "sent",
    token_hash: id === "env-1" ? hashSigningToken(TOKEN) : null,
    expires_at: FUTURE,
    source_bucket: "document-files",
    source_path: `studios/${STUDIO}/envelopes/${id}/source.pdf`,
    source_sha256: SOURCE_SHA,
    page_count: 1,
    page_sizes: [{ width: 612, height: 792 }],
    superseded_by_envelope_id: null,
    revision_number: 1,
    reminder_count: 0,
    completed_at: null,
    ...overrides,
  };
}

function assignmentRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    template_id: "tpl-1",
    template_version_id: "ver-1",
    studio_id: STUDIO,
    client_id: CLIENT,
    status: "pending",
    sign_envelope_id: null,
    assigned_to_email: null,
    due_at: null,
    reminder_sent_at: null,
    overdue_reminder_sent_at: null,
    event_signing_checkpoint_id: null,
    assigned_at: "2026-01-01T00:00:00.000Z",
    clients: { first_name: "Robin", last_name: "Lee", email: "robin@example.test" },
    document_templates: { title: "Waiver" },
    studios: { name: "Studio A", public_name: null, public_logo_url: null, slug: "studio-a" },
    ...overrides,
  };
}

function seed(options: Seed = {}) {
  const db = new DocumentsFake(
    {
      studios: [{ id: STUDIO, name: "Studio A", slug: "studio-a", public_name: null }],
      clients: [{ id: CLIENT, studio_id: STUDIO, first_name: "Robin", last_name: "Lee", email: "robin@example.test" }],
      document_templates: [{ id: "tpl-1", studio_id: STUDIO, title: "Waiver", is_active: true, scope: "studio", requires_signature: true, is_required: true }],
      document_assignments: [
        assignmentRow("asg-1", {
          studio_id: options.assignmentStudio ?? STUDIO,
          status: options.assignmentStatus ?? "pending",
          sign_envelope_id: "env-1",
          due_at: options.dueAt ?? null,
          reminder_sent_at: options.reminderSentAt ?? null,
          overdue_reminder_sent_at: options.overdueReminderSentAt ?? null,
          event_signing_checkpoint_id: options.checkpointId ?? null,
        }),
      ],
      document_sign_envelopes: [
        envelopeRow("env-1", "asg-1", {
          status: options.envelopeStatus ?? "sent",
          expires_at: options.expiresAt ?? FUTURE,
          context_type: options.contextType === undefined ? "client_assignment" : options.contextType,
          event_signing_checkpoint_id: options.checkpointId ?? null,
        }),
      ],
      document_sign_fields: [
        { id: "fld-sig", envelope_id: "env-1", field_type: "signature", page_number: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.05, label: "Signature", required: true, sort_order: 10 },
      ],
      document_sign_values: [],
      document_sign_events: [],
      document_signatures: [],
      document_operation_events: [],
      outbound_deliveries: [],
      event_signing_checkpoints: [],
    },
    { relations: RELATIONS },
  );
  db.files.set(`document-files/studios/${STUDIO}/envelopes/env-1/source.pdf`, SOURCE);
  state.db = db;
  return db;
}

const envelope = (id = "env-1") => state.db.rows("document_sign_envelopes").find((row) => row.id === id)!;
const assignment = (id = "asg-1") => state.db.rows("document_assignments").find((row) => row.id === id)!;
const revisionOf = (id = "env-1") => state.db.rows("document_sign_envelopes").find((row) => row.revision_of_envelope_id === id);

async function outcome(fn: () => Promise<unknown>) {
  try {
    await fn();
    return "no-redirect";
  } catch (error) {
    return (error as Error).message;
  }
}

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const signActions = () => import("@/app/app/documents/sign/actions");
const docActions = () => import("@/app/app/documents/actions");

async function revise(envelopeId = "env-1") {
  const { reviseSignEnvelopeAction } = await signActions();
  return outcome(() => reviseSignEnvelopeAction(form({ envelopeId, reason: "Corrected terms needed" })));
}

async function setDueDate(dueDate: string, assignmentId = "asg-1") {
  const { updateDocumentAssignmentDueDateAction } = await docActions();
  return outcome(() => updateDocumentAssignmentDueDateAction(form({ assignmentId, scope: "studio", dueDate })));
}

async function remind(assignmentId = "asg-1") {
  const { sendDocumentReminderAction } = await docActions();
  return outcome(() => sendDocumentReminderAction(form({ assignmentId, scope: "studio" })));
}

beforeEach(() => {
  state.authUserId = STAFF;
  state.unauthenticated = false;
  state.role = "studio_owner";
  state.features = new Set(["documents"]);
  state.studioFeatures = { [STUDIO]: ["documents"] };
  state.deliveries = [];
  state.dedupeKeys = new Set();
  hooks.onUpload = undefined;
});

// ---------------------------------------------------------------------------------------------------------------
describe("lifecycle helpers", () => {
  it("derives expiry from expires_at for an open envelope and passes terminal statuses through", () => {
    const now = Date.parse("2026-06-01T00:00:00.000Z");
    expect(deriveSignEnvelopeLifecycle({ status: "sent", expires_at: "2026-06-02T00:00:00.000Z" }, now)).toBe("open");
    expect(deriveSignEnvelopeLifecycle({ status: "viewed", expires_at: "2026-05-31T00:00:00.000Z" }, now)).toBe("expired");
    expect(deriveSignEnvelopeLifecycle({ status: "started", expires_at: "2026-06-01T00:00:00.000Z" }, now)).toBe("expired");
    for (const status of ["draft", "completed", "declined", "expired", "void"]) {
      expect(deriveSignEnvelopeLifecycle({ status, expires_at: FUTURE }, now)).toBe(status);
    }
    expect(deriveSignEnvelopeLifecycle(null, now)).toBe("unknown");
  });

  it("keeps the signing link alive past the due date (due + grace, never under now + grace)", () => {
    const now = Date.parse("2026-06-01T00:00:00.000Z");
    expect(signLinkExpiryForDueDate(null, now)).toBe(new Date(now + SIGN_LINK_GRACE_DAYS * DAY).toISOString());
    expect(signLinkExpiryForDueDate("2026-06-20T23:59:59.000Z", now)).toBe("2026-06-27T23:59:59.000Z");
    expect(signLinkExpiryForDueDate("2026-05-01T00:00:00.000Z", now)).toBe(new Date(now + SIGN_LINK_GRACE_DAYS * DAY).toISOString());
    expect(Date.parse(signLinkExpiryForDueDate("2026-06-20T23:59:59.000Z", now))).toBeGreaterThan(Date.parse("2026-06-20T23:59:59.000Z"));
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("plan-feature gating (server-side)", () => {
  beforeEach(() => {
    state.features = new Set();
  });

  it.each([
    ["createSignEnvelopeAction", { title: "T", signerName: "A", signerEmail: "a@example.test" }],
    ["saveSignFieldsAction", { envelopeId: "env-1", fieldsJson: "[]" }],
    ["sendSignEnvelopeAction", { envelopeId: "env-1" }],
    ["resendSignEnvelopeAction", { envelopeId: "env-1" }],
    ["reviseSignEnvelopeAction", { envelopeId: "env-1", reason: "Corrected terms needed" }],
    ["duplicateCompletedSignEnvelopeAction", { envelopeId: "env-1" }],
    ["revokeSignEnvelopeAction", { envelopeId: "env-1" }],
  ])("%s requires the documents feature and writes nothing without it", async (name, values) => {
    const db = seed();
    const before = JSON.stringify(db.tables);
    const mod = (await signActions()) as unknown as Record<string, (data: FormData) => Promise<unknown>>;
    expect(await outcome(() => mod[name](form(values)))).toBe("redirect:/app/settings/billing?upgrade=documents");
    expect(JSON.stringify(db.tables)).toBe(before);
  });

  it.each([
    ["sendDocumentReminderAction", { assignmentId: "asg-1", scope: "studio" }],
    ["updateDocumentAssignmentDueDateAction", { assignmentId: "asg-1", scope: "studio", dueDate: "2099-01-01" }],
    ["waiveDocumentAssignmentAction", { assignmentId: "asg-1", scope: "studio" }],
    ["voidDocumentAssignmentAction", { assignmentId: "asg-1", scope: "studio" }],
  ])("%s requires the documents feature", async (name, values) => {
    const db = seed();
    const before = JSON.stringify(db.tables);
    const mod = (await docActions()) as unknown as Record<string, (data: FormData) => Promise<unknown>>;
    expect(await outcome(() => mod[name](form(values)))).toBe("redirect:/app/settings/billing?upgrade=documents");
    expect(JSON.stringify(db.tables)).toBe(before);
  });

  it.each([
    ["detail", "@/app/app/documents/sign/[envelopeId]/page"],
    ["edit", "@/app/app/documents/sign/[envelopeId]/edit/page"],
  ])("the staff envelope %s page is reachable with the documents feature (positive control)", async (_label, path) => {
    state.features = new Set(["documents"]);
    seed({ envelopeStatus: "draft" });
    const mod = (await import(path)) as { default: (props: unknown) => Promise<unknown> };
    const result = await outcome(() => mod.default({ params: Promise.resolve({ envelopeId: "env-1" }), searchParams: Promise.resolve({}) }));
    expect(result).toBe("no-redirect");
  });

  it("the draft field editor (management) still requires the documents feature", async () => {
    seed({ envelopeStatus: "draft" });
    const mod = (await import("@/app/app/documents/sign/[envelopeId]/edit/page")) as { default: (props: unknown) => Promise<unknown> };
    expect(
      await outcome(() => mod.default({ params: Promise.resolve({ envelopeId: "env-1" }), searchParams: Promise.resolve({}) })),
    ).toBe("redirect:/app/settings/billing?upgrade=documents");
  });

  it("onboarding offers no document templates without the documents feature", async () => {
    seed();
    const { loadOnboardingDocumentOptionsAction } = await import("@/app/app/clients/actions");
    expect(await loadOnboardingDocumentOptionsAction()).toEqual([]);
    state.features = new Set(["documents"]);
    expect((await loadOnboardingDocumentOptionsAction()).map((option) => option.id)).toEqual(["tpl-1"]);
  });

  it("a client can still complete an already-issued request after the studio loses the feature", async () => {
    seed();
    state.authUserId = USER;
    const { completeSigningAction } = await import("@/app/sign/[token]/actions");
    const result = await outcome(() =>
      completeSigningAction(
        form({ token: TOKEN, signerName: "Robin Lee", consent: "on", "field_fld-sig": JSON.stringify({ method: "typed", value: "Robin Lee" }) }),
      ),
    );
    expect(result).toContain("success=completed");
    expect(envelope().status).toBe("completed");
  });

  it("the old standalone /app/documents/sign page no longer exists (orphan removed)", async () => {
    await expect(import("@/app/app/documents/sign/page" as string)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Documents Center after a plan downgrade (read-only history surface)", () => {
  type Rendered = { actions: Set<unknown>; hrefs: string[]; text: string };

  /** Walks the page's element tree, expanding plain function components (TemplateCard, forms) but not library ones. */
  function walk(node: unknown, out: Rendered = { actions: new Set(), hrefs: [], text: "" }): Rendered {
    if (node === null || node === undefined || typeof node === "boolean") return out;
    if (typeof node === "string" || typeof node === "number") {
      out.text += `${node} `;
      return out;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child, out);
      return out;
    }
    if (typeof node === "object" && "props" in node) {
      const element = node as { type: unknown; props: Record<string, unknown> };
      if (typeof element.type === "function" && /^[A-Z]/.test((element.type as { name: string }).name) && element.type.length <= 1) {
        const name = (element.type as { name: string }).name;
        if (name !== "LinkComponent" && name !== "Link") {
          // Page-local components are plain functions; a throw here is a real rendering failure, so it propagates.
          return walk((element.type as (props: unknown) => unknown)(element.props), out);
        }
      }
      const props = element.props;
      if (typeof props.action === "function") out.actions.add(props.action);
      if (typeof props.href === "string") out.hrefs.push(props.href);
      walk(props.children, out);
    }
    return out;
  }

  function seedCenter() {
    const db = seed({ envelopeStatus: "sent" });
    Object.assign(db.rows("document_templates")[0], {
      scope: "studio",
      organizer_id: null,
      document_type: "waiver",
      description: null,
      body: "Waiver body",
      default_consent_text: null,
      applies_to: "manual",
      current_version: 1,
      current_version_id: "ver-1",
      updated_at: "2026-04-01T00:00:00.000Z",
      document_template_versions: [{ id: "ver-1", version_number: 1, title: "Waiver", created_at: "2026-04-01T00:00:00.000Z" }],
    });
    db.rows("document_sign_envelopes").push(
      envelopeRow("env-done", "asg-done", {
        status: "completed",
        signed_bucket: "document-files",
        signed_path: `studios/${STUDIO}/envelopes/env-done/signed.pdf`,
        completed_at: "2026-05-01T00:00:00.000Z",
        created_at: "2026-04-01T00:00:00.000Z",
      }),
      envelopeRow("env-draft", "asg-draft", { status: "draft", created_at: "2026-04-02T00:00:00.000Z" }),
    );
    db.rows("document_assignments").push(assignmentRow("asg-done", { status: "signed", sign_envelope_id: "env-done" }));
    return db;
  }

  async function center() {
    const { default: DocumentsPage } = await import("@/app/app/documents/page");
    return walk(await DocumentsPage({ searchParams: Promise.resolve({}) }));
  }

  it("A. with Documents: the full management Center renders (create, reminders, waive/void, resend, revise, revoke)", async () => {
    seedCenter();
    const page = await center();
    const docs = await docActions();
    const sign = await signActions();
    for (const action of [
      docs.createDocumentTemplateAction,
      docs.sendDocumentReminderAction,
      docs.updateDocumentAssignmentDueDateAction,
      docs.waiveDocumentAssignmentAction,
      docs.voidDocumentAssignmentAction,
      docs.updateDocumentTemplateAction,
      sign.createSignEnvelopeAction,
      sign.resendSignEnvelopeAction,
      sign.reviseSignEnvelopeAction,
      sign.revokeSignEnvelopeAction,
      sign.duplicateCompletedSignEnvelopeAction,
    ]) {
      expect(page.actions.has(action)).toBe(true);
    }
    expect(page.hrefs).toContain("/app/documents/sign/env-draft/edit");
    expect(page.text).not.toContain("Existing document records remain available read-only.");
  });

  it("B. without Documents: the Center renders read-only with records, history links, evidence and the notice", async () => {
    state.features = new Set();
    seedCenter();
    const page = await center();
    expect(page.text).toContain("Your Documents feature is not active. Existing document records remain available read-only.");
    // existing records and statuses are visible
    expect(page.text).toContain("Waiver");
    expect(page.text).toContain("completed");
    expect(page.text).toContain("sent");
    // historical detail + evidence links (a draft opens its read-only detail, never the gated editor)
    expect(page.hrefs).toEqual(
      expect.arrayContaining([
        "/app/documents/sign/env-1",
        "/app/documents/sign/env-done",
        "/app/documents/sign/env-done/signed",
        "/app/documents/sign/env-done/certificate",
        "/app/documents/sign/env-draft",
      ]),
    );
    expect(page.hrefs.some((href) => href.endsWith("/edit"))).toBe(false);
    expect(page.hrefs).not.toContain("#create-document");
    // no management control of any kind
    expect(page.actions.size).toBe(0);
  });

  it("B. without Documents: the linked history page and evidence routes open", async () => {
    state.features = new Set();
    seedCenter();
    Object.assign(envelope("env-done"), { signed_sha256: sha256Hex(new Uint8Array([9, 9, 9])) });
    state.db.files.set(`document-files/studios/${STUDIO}/envelopes/env-done/signed.pdf`, new Uint8Array([9, 9, 9]));
    state.db.files.set(`document-files/studios/${STUDIO}/envelopes/env-done/source.pdf`, SOURCE);
    for (const route of ["source", "signed", "certificate"]) {
      const mod = (await import(`@/app/app/documents/sign/[envelopeId]/${route}/route`)) as {
        GET: (request: Request, ctx: { params: Promise<{ envelopeId: string }> }) => Promise<Response>;
      };
      const response = await mod.GET(new Request("https://example.test"), { params: Promise.resolve({ envelopeId: "env-done" }) });
      expect(response.status).toBe(200);
    }
    const { default: Detail } = await import("@/app/app/documents/sign/[envelopeId]/page");
    const detail = walk(await Detail({ params: Promise.resolve({ envelopeId: "env-done" }), searchParams: Promise.resolve({}) }));
    expect(detail.actions.size).toBe(0);
    expect(detail.hrefs).toContain("/app/documents/sign/env-done/signed");
  });

  it("C. without Documents: direct management calls are still denied on the server and change nothing", async () => {
    state.features = new Set();
    const db = seedCenter();
    const before = JSON.stringify(db.tables);
    const docs = await docActions();
    const sign = await signActions();
    const upgrade = "redirect:/app/settings/billing?upgrade=documents";
    const calls: Array<[(data: FormData) => Promise<unknown>, Record<string, string>]> = [
      [docs.createDocumentTemplateAction as unknown as (data: FormData) => Promise<unknown>, { scope: "studio", title: "New", body: "Body" }],
      [docs.assignDocumentToClientAction, { scope: "studio", templateId: "tpl-1", clientId: CLIENT }],
      [docs.sendDocumentReminderAction, { scope: "studio", assignmentId: "asg-1" }],
      [docs.updateDocumentAssignmentDueDateAction, { scope: "studio", assignmentId: "asg-1", dueDate: "2099-01-01" }],
      [docs.waiveDocumentAssignmentAction, { scope: "studio", assignmentId: "asg-1" }],
      [docs.voidDocumentAssignmentAction, { scope: "studio", assignmentId: "asg-1" }],
      [sign.createSignEnvelopeAction, { title: "T", signerName: "A", signerEmail: "a@example.test" }],
      [sign.resendSignEnvelopeAction, { envelopeId: "env-1" }],
      [sign.reviseSignEnvelopeAction, { envelopeId: "env-1", reason: "Corrected terms needed" }],
      [sign.revokeSignEnvelopeAction, { envelopeId: "env-1" }],
      [sign.duplicateCompletedSignEnvelopeAction, { envelopeId: "env-done" }],
      [sign.sendSignEnvelopeAction, { envelopeId: "env-draft" }],
    ];
    for (const [action, values] of calls) {
      const result = await outcome(() => (action as (data: FormData) => Promise<unknown>)(form(values)));
      expect(result.startsWith(upgrade) || result.includes("upgrade=documents")).toBe(true);
    }
    expect(JSON.stringify(db.tables)).toBe(before);
  });

  it("D. without Documents: another studio's records never appear in the Center", async () => {
    state.features = new Set();
    seedCenter();
    state.db.rows("document_sign_envelopes").push(envelopeRow("env-foreign", "asg-foreign", { studio_id: OTHER_STUDIO, status: "completed" }));
    const page = await center();
    expect(page.hrefs.some((href) => href.includes("env-foreign"))).toBe(false);
  });

  it("E. without Documents: a role outside the document-management boundary gets the upgrade redirect, not history", async () => {
    state.features = new Set();
    seedCenter();
    state.role = "instructor";
    const { default: DocumentsPage } = await import("@/app/app/documents/page");
    const result = await outcome(() => DocumentsPage({ searchParams: Promise.resolve({}) }));
    expect(result.startsWith("redirect:")).toBe(true);
    expect(result).not.toBe("no-redirect");
  });

  it("F. signed-out: the Center is login-gated", async () => {
    state.features = new Set();
    seedCenter();
    state.unauthenticated = true;
    const { default: DocumentsPage } = await import("@/app/app/documents/page");
    expect(await outcome(() => DocumentsPage({ searchParams: Promise.resolve({}) }))).toBe("redirect:/login");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("historical record access after a plan downgrade (record retention)", () => {
  const SIGNED = new Uint8Array([9, 9, 9]);

  function seedCompleted(studioId = STUDIO) {
    seed({ envelopeStatus: "completed" });
    Object.assign(envelope(), {
      studio_id: studioId,
      signed_bucket: "document-files",
      signed_path: `studios/${STUDIO}/envelopes/env-1/signed.pdf`,
      signed_sha256: sha256Hex(SIGNED),
      completed_at: "2026-05-01T00:00:00.000Z",
    });
    state.db.files.set(`document-files/studios/${STUDIO}/envelopes/env-1/signed.pdf`, SIGNED);
  }

  async function read(route: string) {
    const mod = (await import(`@/app/app/documents/sign/[envelopeId]/${route}/route`)) as {
      GET: (request: Request, ctx: { params: Promise<{ envelopeId: string }> }) => Promise<Response>;
    };
    return mod.GET(new Request("https://example.test"), { params: Promise.resolve({ envelopeId: "env-1" }) });
  }

  /** Every form action rendered by the (single-component) detail page, found by walking the returned element tree. */
  function formActions(node: unknown, found = new Set<unknown>()): Set<unknown> {
    if (Array.isArray(node)) {
      for (const child of node) formActions(child, found);
      return found;
    }
    if (node && typeof node === "object" && "props" in node) {
      const props = (node as { props: Record<string, unknown> }).props;
      if (typeof props.action === "function") found.add(props.action);
      formActions(props.children, found);
    }
    return found;
  }

  async function detailPage() {
    const mod = (await import("@/app/app/documents/sign/[envelopeId]/page")) as { default: (props: unknown) => Promise<unknown> };
    return mod.default({ params: Promise.resolve({ envelopeId: "env-1" }), searchParams: Promise.resolve({}) });
  }

  it.each(["source", "signed", "certificate"])("A. with Documents: the %s evidence read is allowed", async (route) => {
    seedCompleted();
    const response = await read(route);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/pdf");
  });

  it.each(["source", "signed", "certificate"])("B. without Documents: the historical %s evidence read is still allowed", async (route) => {
    state.features = new Set();
    seedCompleted();
    const response = await read(route);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/pdf");
  });

  it("B. without Documents: the completed record's history page renders read-only (no management controls)", async () => {
    state.features = new Set();
    seedCompleted();
    const tree = await detailPage();
    expect(tree).toBeTruthy();
    expect(formActions(tree).size).toBe(0);
  });

  it("B. without Documents: an open request's page is read-only too, while its actions stay denied on the server", async () => {
    state.features = new Set();
    seed({ envelopeStatus: "sent" });
    expect(formActions(await detailPage()).size).toBe(0);
    const { resendSignEnvelopeAction, reviseSignEnvelopeAction, revokeSignEnvelopeAction } = await signActions();
    for (const action of [resendSignEnvelopeAction, reviseSignEnvelopeAction, revokeSignEnvelopeAction]) {
      expect(await outcome(() => action(form({ envelopeId: "env-1", reason: "Corrected terms needed" })))).toBe(
        "redirect:/app/settings/billing?upgrade=documents",
      );
    }
    expect(envelope().status).toBe("sent");
  });

  it("A. with Documents: the same page offers the management controls (positive control)", async () => {
    seed({ envelopeStatus: "sent" });
    const { resendSignEnvelopeAction, reviseSignEnvelopeAction, revokeSignEnvelopeAction } = await signActions();
    const actions = formActions(await detailPage());
    expect(actions.has(resendSignEnvelopeAction)).toBe(true);
    expect(actions.has(reviseSignEnvelopeAction)).toBe(true);
    expect(actions.has(revokeSignEnvelopeAction)).toBe(true);
  });

  it("B. without Documents: due-date edit, reminder, waive and void are denied", async () => {
    state.features = new Set();
    seed();
    expect(await setDueDate("2099-03-01")).toBe("redirect:/app/settings/billing?upgrade=documents");
    expect(await remind()).toBe("redirect:/app/settings/billing?upgrade=documents");
    const { waiveDocumentAssignmentAction, voidDocumentAssignmentAction } = await docActions();
    expect(await outcome(() => waiveDocumentAssignmentAction(form({ assignmentId: "asg-1", scope: "studio" })))).toBe(
      "redirect:/app/settings/billing?upgrade=documents",
    );
    expect(await outcome(() => voidDocumentAssignmentAction(form({ assignmentId: "asg-1", scope: "studio" })))).toBe(
      "redirect:/app/settings/billing?upgrade=documents",
    );
    expect(assignment()).toMatchObject({ status: "pending", due_at: null });
  });

  it.each(["source", "signed", "certificate"])("C. another studio's historical %s evidence is still denied", async (route) => {
    state.features = new Set();
    seedCompleted(OTHER_STUDIO);
    expect((await read(route)).status).toBe(404);
    state.features = new Set(["documents"]);
    expect((await read(route)).status).toBe(404);
  });

  it("C. another studio's record page is not found", async () => {
    state.features = new Set();
    seedCompleted(OTHER_STUDIO);
    const tree = (await detailPage()) as { props: { children: unknown } };
    expect(formActions(tree).size).toBe(0);
    expect(JSON.stringify(tree.props.children)).toContain("Signing request not found.");
  });

  it.each(["source", "signed", "certificate"])("role: a non-document role cannot read the %s evidence even with Documents", async (route) => {
    seedCompleted();
    state.role = "instructor";
    expect((await read(route)).status).toBe(404);
  });

  it.each(["source", "signed", "certificate"])("D. an unauthenticated request for the %s evidence is login-gated", async (route) => {
    seedCompleted();
    state.unauthenticated = true;
    await expect(read(route)).rejects.toThrow("redirect:/login");
  });

  it("E. a signer still completes an already-issued request after the downgrade", async () => {
    state.features = new Set();
    seed();
    state.authUserId = USER;
    const { completeSigningAction } = await import("@/app/sign/[token]/actions");
    const result = await outcome(() =>
      completeSigningAction(
        form({ token: TOKEN, signerName: "Robin Lee", consent: "on", "field_fld-sig": JSON.stringify({ method: "typed", value: "Robin Lee" }) }),
      ),
    );
    expect(result).toContain("success=completed");
    expect(envelope().status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("revise (protected revision)", () => {
  it.each(["sent", "expired", "declined"])("a %s request keeps client / template / version / context and portal access", async (status) => {
    seed({ envelopeStatus: status, reminderSentAt: PAST, overdueReminderSentAt: PAST });
    expect(await revise()).toMatch(/^redirect:\/app\/documents\/sign\/.+\/edit\?success=revision_created$/);
    const revision = revisionOf()!;
    expect(revision).toMatchObject({
      client_id: CLIENT,
      template_id: "tpl-1",
      template_version_id: "ver-1",
      source_kind: "template_version",
      context_type: "client_assignment",
      context_id: "asg-1",
      assignment_id: "asg-1",
      status: "draft",
    });
    expect(assignment()).toMatchObject({ status: "pending", sign_envelope_id: revision.id, reminder_sent_at: null, overdue_reminder_sent_at: null });
    expect(envelope()).toMatchObject({ status: "void", superseded_by_envelope_id: revision.id });

    // Send the revision, then the client's portal hand-off must reach the public signing surface again.
    const { sendSignEnvelopeAction } = await signActions();
    expect(await outcome(() => sendSignEnvelopeAction(form({ envelopeId: String(revision.id) })))).toContain("success=sent");
    state.authUserId = USER;
    const { GET } = await import("@/app/portal/[studioSlug]/documents/[assignmentId]/sign/route");
    const response = await GET(new NextRequest("https://example.test/portal/studio-a/documents/asg-1/sign"), {
      params: Promise.resolve({ studioSlug: "studio-a", assignmentId: "asg-1" }),
    });
    expect(response.headers.get("location")).toMatch(/\/sign\/[^/?]+$/);
  });

  it.each(["waived", "void", "signed"])("refuses to reopen a %s requirement and creates nothing", async (status) => {
    seed({ assignmentStatus: status, envelopeStatus: "expired" });
    expect(await revise()).toBe("redirect:/app/documents/sign/env-1?error=assignment_closed");
    expect(revisionOf()).toBeUndefined();
    expect(assignment()).toMatchObject({ status, sign_envelope_id: "env-1" });
    expect(envelope().status).toBe("expired");
    expect(state.db.files.size).toBe(1);
  });

  it("refuses an event-checkout waiver (by context) with a staff-facing reason", async () => {
    seed({ contextType: "event_checkout", envelopeStatus: "expired" });
    expect(await revise()).toBe("redirect:/app/documents/sign/env-1?error=event_checkout_not_revisable");
    expect(revisionOf()).toBeUndefined();
  });

  it("refuses an event-checkout waiver (by checkpoint link)", async () => {
    seed({ contextType: null, checkpointId: "cp-1", envelopeStatus: "declined" });
    expect(await revise()).toBe("redirect:/app/documents/sign/env-1?error=event_checkout_not_revisable");
    expect(revisionOf()).toBeUndefined();
  });

  it("if the requirement is waived while the revision is being created, the new draft is retired and nothing reopens", async () => {
    seed({ envelopeStatus: "expired" });
    hooks.onUpload = () => {
      assignment().status = "waived";
    };
    expect(await revise()).toBe("redirect:/app/documents/sign/env-1?error=assignment_closed");
    expect(assignment()).toMatchObject({ status: "waived", sign_envelope_id: "env-1" });
    expect(revisionOf()).toMatchObject({ status: "void", token_hash: null });
  });

  it("a revision of another studio's envelope is not found", async () => {
    seed();
    envelope().studio_id = OTHER_STUDIO;
    expect(await revise()).toContain("error=request_not_found");
    expect(revisionOf()).toBeUndefined();
  });

  it("a duplicate of a completed request keeps identity but not the assignment context", async () => {
    seed({ envelopeStatus: "completed" });
    const { duplicateCompletedSignEnvelopeAction } = await signActions();
    expect(await outcome(() => duplicateCompletedSignEnvelopeAction(form({ envelopeId: "env-1" })))).toContain("success=duplicate_created");
    expect(revisionOf()).toMatchObject({ client_id: CLIENT, template_version_id: "ver-1", assignment_id: null, context_type: null, context_id: null });
    expect(assignment().sign_envelope_id).toBe("env-1");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("due-date editing", () => {
  it("updates the due date, restarts reminders and extends the open link to due + grace", async () => {
    seed({ expiresAt: "2099-01-02T00:00:00.000Z", dueAt: "2099-01-01T00:00:00.000Z", reminderSentAt: PAST, overdueReminderSentAt: PAST });
    expect(await setDueDate("2099-03-01")).toBe("redirect:/app/documents?success=due_date_updated");
    const dueAt = new Date("2099-03-01T23:59:59").toISOString();
    expect(assignment()).toMatchObject({ due_at: dueAt, reminder_sent_at: null, overdue_reminder_sent_at: null });
    expect(envelope().expires_at).toBe(new Date(Date.parse(dueAt) + SIGN_LINK_GRACE_DAYS * DAY).toISOString());
  });

  it("never shortens a live link and clears the due date when blank", async () => {
    seed({ expiresAt: FUTURE, dueAt: "2098-01-01T00:00:00.000Z" });
    expect(await setDueDate("")).toBe("redirect:/app/documents?success=due_date_updated");
    expect(assignment().due_at).toBeNull();
    expect(envelope().expires_at).toBe(FUTURE);
  });

  it.each(["expired", "declined", "void"])("never revives a %s request", async (status) => {
    seed({ envelopeStatus: status, expiresAt: PAST });
    expect(await setDueDate("2099-03-01")).toBe("redirect:/app/documents?success=due_date_updated");
    expect(envelope()).toMatchObject({ status, expires_at: PAST });
  });

  it("does not revive an open envelope whose link already lapsed", async () => {
    seed({ envelopeStatus: "sent", expiresAt: PAST });
    await setDueDate("2099-03-01");
    expect(envelope()).toMatchObject({ status: "sent", expires_at: PAST });
  });

  it.each(["signed", "waived", "void"])("a %s assignment is terminal and unchanged", async (status) => {
    seed({ assignmentStatus: status, dueAt: PAST });
    expect(await setDueDate("2099-03-01")).toContain("error=");
    expect(assignment()).toMatchObject({ status, due_at: PAST });
  });

  it("refuses event-checkout waivers, invalid dates, other studios and non-managing roles", async () => {
    seed({ checkpointId: "cp-1" });
    expect(await setDueDate("2099-03-01")).toContain(encodeURIComponent("Event checkout waivers"));
    seed();
    expect(await setDueDate("03/01/2099")).toContain(encodeURIComponent("Choose a valid due date."));
    seed({ assignmentStudio: OTHER_STUDIO });
    expect(await setDueDate("2099-03-01")).toContain(encodeURIComponent("Assignment not found."));
    seed();
    state.role = "instructor";
    expect(await setDueDate("2099-03-01")).toContain("error=");
    expect(assignment().due_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("manual reminder", () => {
  it.each([
    ["expired", "expired", FUTURE],
    ["declined", "declined", FUTURE],
    ["lapsed open", "sent", PAST],
    ["void", "void", FUTURE],
  ])("is refused for a %s request", async (label, status, expiresAt) => {
    seed({ envelopeStatus: status, expiresAt });
    assignment().assigned_to_email = "robin@example.test";
    const expected =
      label === "void"
        ? "This signing request is no longer open, so no reminder was sent."
        : `This signing request is ${status === "sent" ? "expired" : status}. Open it and create a revision to send a new link.`;
    expect(await remind()).toBe(`redirect:/app/documents?error=${encodeURIComponent(expected)}`);
    expect(state.db.rows("outbound_deliveries")).toHaveLength(0);
  });

  it("is queued for an open request (positive control)", async () => {
    seed();
    assignment().assigned_to_email = "robin@example.test";
    expect(await remind()).toBe("redirect:/app/documents?success=reminder_queued");
    expect(state.db.rows("outbound_deliveries")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("document operations cron", () => {
  const NOW = new Date("2026-06-15T12:00:00.000Z");
  const ops = () => import("@/lib/documents/operations");

  function cronSeed() {
    const db = seed();
    db.tables.document_assignments = [];
    db.tables.document_sign_envelopes = [];
    return db;
  }

  function addRequest(id: string, overrides: { due?: string | null; status?: string; envelope?: Record<string, unknown> | null; studio?: string; email?: string | null; extra?: Record<string, unknown> } = {}) {
    const studio = overrides.studio ?? STUDIO;
    const envelopeId = overrides.envelope === null ? null : `env-${id}`;
    state.db.rows("document_assignments").push(
      assignmentRow(id, {
        studio_id: studio,
        status: overrides.status ?? "pending",
        due_at: overrides.due === undefined ? "2026-06-14T00:00:00.000Z" : overrides.due,
        sign_envelope_id: envelopeId,
        clients: { first_name: "Robin", last_name: "Lee", email: overrides.email === undefined ? "robin@example.test" : overrides.email },
        ...overrides.extra,
      }),
    );
    if (envelopeId) {
      state.db.rows("document_sign_envelopes").push(envelopeRow(envelopeId, id, { studio_id: studio, expires_at: "2026-07-01T00:00:00.000Z", ...overrides.envelope }));
    }
  }

  it("persists expiry for lapsed open envelopes only, keeps the assignment pending and records the event", async () => {
    cronSeed();
    addRequest("a1", { envelope: { status: "sent", expires_at: "2026-06-10T00:00:00.000Z" } });
    addRequest("a2", { envelope: { status: "viewed", expires_at: "2026-06-15T12:00:00.000Z" } });
    addRequest("a3", { envelope: { status: "completed", expires_at: "2026-06-10T00:00:00.000Z" } });
    addRequest("a4", { envelope: { status: "started", expires_at: "2026-06-20T00:00:00.000Z" } });
    const { runDocumentOperations } = await ops();
    const result = await runDocumentOperations(NOW);
    expect(result.expiredEnvelopes).toBe(2);
    expect(envelope("env-a1").status).toBe("expired");
    expect(envelope("env-a2").status).toBe("expired");
    expect(envelope("env-a3").status).toBe("completed");
    expect(envelope("env-a4").status).toBe("started");
    expect(assignment("a1").status).toBe("pending");
    expect(state.db.rows("document_sign_events").filter((row) => row.event_type === "expired").map((row) => row.envelope_id).sort()).toEqual(["env-a1", "env-a2"]);
    // a second run is a no-op
    expect((await runDocumentOperations(NOW)).expiredEnvelopes).toBe(0);
  });

  it("reminds only pending, eligible requests (never signed / waived / void / declined / expired / draft / superseded)", async () => {
    cronSeed();
    addRequest("open", {});
    addRequest("legacy", { envelope: null });
    addRequest("signed", { status: "signed" });
    addRequest("waived", { status: "waived" });
    addRequest("voided", { status: "void" });
    addRequest("declined", { envelope: { status: "declined" } });
    addRequest("expired", { envelope: { status: "expired" } });
    addRequest("lapsed", { envelope: { status: "sent", expires_at: "2026-06-01T00:00:00.000Z" } });
    addRequest("draft", { envelope: { status: "draft" } });
    addRequest("checkout", { extra: { event_signing_checkpoint_id: "cp-x" } });
    // superseded: the assignment points at a draft revision; the superseded original is void
    addRequest("superseded", { envelope: { status: "draft" } });
    state.db.rows("document_sign_envelopes").push(envelopeRow("env-superseded-old", "superseded", { status: "void", superseded_by_envelope_id: "env-superseded" }));
    addRequest("nodue", { due: null });
    addRequest("later", { due: "2026-07-30T00:00:00.000Z" });

    const { runDocumentOperations } = await ops();
    await runDocumentOperations(NOW);
    expect(state.deliveries.map((delivery) => delivery.relatedId).sort()).toEqual(["legacy", "open"]);
    expect(state.deliveries.every((delivery) => delivery.templateKey === "document_overdue_reminder")).toBe(true);
    expect(assignment("open").overdue_reminder_sent_at).toBe(NOW.toISOString());
    expect(assignment("declined").overdue_reminder_sent_at).toBeNull();

    // idempotent: no second email for the same cycle
    await runDocumentOperations(NOW);
    expect(state.deliveries).toHaveLength(2);
  });

  it("sends a due-soon reminder inside the 3-day window and an overdue one after the due date, on a live link", async () => {
    cronSeed();
    addRequest("soon", { due: "2026-06-17T00:00:00.000Z" });
    const { runDocumentOperations } = await ops();
    await runDocumentOperations(NOW);
    expect(state.deliveries.map((delivery) => delivery.templateKey)).toEqual(["document_due_soon_reminder"]);
    // after the due date, with the link alive until due + grace, the overdue reminder still goes out
    envelope("env-soon").expires_at = signLinkExpiryForDueDate("2026-06-17T00:00:00.000Z", NOW.getTime());
    await runDocumentOperations(new Date("2026-06-18T12:00:00.000Z"));
    expect(state.deliveries.map((delivery) => delivery.templateKey)).toEqual(["document_due_soon_reminder", "document_overdue_reminder"]);
  });

  it("does not starve: 600 earlier ineligible rows never hide later eligible ones", async () => {
    cronSeed();
    for (let index = 0; index < 600; index++) {
      addRequest(`dead-${String(index).padStart(4, "0")}`, { due: "2026-06-01T00:00:00.000Z", envelope: { status: "declined" } });
    }
    addRequest("eligible-1", { due: "2026-06-14T00:00:00.000Z" });
    addRequest("eligible-2", { due: "2026-06-14T06:00:00.000Z", envelope: null });
    const { runDocumentOperations } = await ops();
    await runDocumentOperations(NOW);
    expect(state.deliveries.map((delivery) => delivery.relatedId).sort()).toEqual(["eligible-1", "eligible-2"]);
  });

  it("skips studios without the feature without letting them starve the queue", async () => {
    cronSeed();
    state.studioFeatures = { [STUDIO]: ["documents"], [OTHER_STUDIO]: [] };
    for (let index = 0; index < 450; index++) {
      addRequest(`gated-${String(index).padStart(4, "0")}`, { due: "2026-06-01T00:00:00.000Z", studio: OTHER_STUDIO, envelope: null });
    }
    addRequest("eligible", { due: "2026-06-14T00:00:00.000Z", envelope: null });
    const { runDocumentOperations } = await ops();
    const result = await runDocumentOperations(NOW);
    expect(state.deliveries.map((delivery) => delivery.relatedId)).toEqual(["eligible"]);
    expect(result.featureSkipped).toBeGreaterThan(0);
    expect(state.db.rows("document_assignments").filter((row) => row.studio_id === OTHER_STUDIO && row.overdue_reminder_sent_at)).toHaveLength(0);
  });

  it("processes a large backlog deterministically in (due_at, id) order, bounded per run", async () => {
    cronSeed();
    // inserted latest-due first, so only a real (due_at, id) ordering selects the earliest rows
    for (let index = 649; index >= 0; index--) {
      const minutes = String(index % 60).padStart(2, "0");
      const hour = String(Math.floor(index / 60)).padStart(2, "0");
      addRequest(`bk-${String(649 - index).padStart(4, "0")}`, { due: `2026-06-10T${hour}:${minutes}:00.000Z`, envelope: null });
    }
    const { runDocumentOperations, DOCUMENT_REMINDER_BATCH, DOCUMENT_REMINDER_MAX_PAGES } = await ops();
    const cap = DOCUMENT_REMINDER_BATCH * DOCUMENT_REMINDER_MAX_PAGES;
    await runDocumentOperations(NOW);
    expect(state.deliveries).toHaveLength(cap);
    const sentDue = state.deliveries.map((delivery) => assignment(delivery.relatedId).due_at as string);
    expect([...sentDue].sort()).toEqual(sentDue);
    expect(sentDue[sentDue.length - 1] < (assignment("bk-0000").due_at as string)).toBe(true);
    await runDocumentOperations(NOW);
    expect(state.deliveries).toHaveLength(650);
  });

  it("flags a missing-email row once (one exception) so it cannot block the queue", async () => {
    cronSeed();
    addRequest("noemail", { email: null, envelope: null });
    const { runDocumentOperations } = await ops();
    await runDocumentOperations(NOW);
    await runDocumentOperations(NOW);
    expect(state.deliveries).toHaveLength(0);
    expect(assignment("noemail").overdue_reminder_sent_at).toBe(NOW.toISOString());
    expect(state.db.rows("document_operation_events").filter((row) => row.event_type === "delivery_exception")).toHaveLength(1);
  });

  it("a changed due date or a revision restarts the reminder cycle (new dedupe key)", async () => {
    cronSeed();
    addRequest("cycle", {});
    const { runDocumentOperations } = await ops();
    await runDocumentOperations(NOW);
    expect(state.deliveries).toHaveLength(1);
    const row = assignment("cycle");
    row.due_at = "2026-06-14T18:00:00.000Z";
    row.overdue_reminder_sent_at = null;
    await runDocumentOperations(NOW);
    expect(state.deliveries).toHaveLength(2);
    expect(new Set(state.deliveries.map((delivery) => delivery.dedupeKey)).size).toBe(2);
  });

  describe("abandoned event checkouts", () => {
    function checkoutSeed(checkpoint: Record<string, unknown>, envelope: Record<string, unknown> = {}) {
      cronSeed();
      state.db.rows("event_signing_checkpoints").push({ id: "cp-1", status: "signing", expires_at: "2026-06-15T12:30:00.000Z", ...checkpoint });
      addRequest("co", {
        due: null,
        envelope: { context_type: "event_checkout", event_signing_checkpoint_id: "cp-1", expires_at: "2026-06-15T12:30:00.000Z", ...envelope },
        extra: { client_id: null, event_signing_checkpoint_id: "cp-1" },
      });
    }

    it.each([
      ["expired", { status: "expired", expires_at: "2026-06-15T11:00:00.000Z" }],
      ["cancelled", { status: "cancelled" }],
      ["signing past its window", { status: "signing", expires_at: "2026-06-15T11:00:00.000Z" }],
    ])("voids a pending waiver whose checkout %s, closing its live envelope", async (_label, checkpoint) => {
      checkoutSeed(checkpoint);
      const { runDocumentOperations } = await ops();
      const result = await runDocumentOperations(NOW);
      expect(result.voidedCheckoutAssignments).toBe(1);
      expect(assignment("co")).toMatchObject({ status: "void", void_reason: "Event checkout ended before signing was completed." });
      expect(["void", "expired"]).toContain(envelope("env-co").status);
      expect(envelope("env-co").token_hash ?? null).toBeNull();
      expect(state.db.rows("event_signing_checkpoints")[0]).toMatchObject(checkpoint);
      expect(state.db.rows("document_operation_events").filter((row) => row.event_type === "voided")).toHaveLength(1);
    });

    it.each([
      ["still signing within its window", { status: "signing" }],
      ["completed", { status: "completed", expires_at: "2026-06-15T11:00:00.000Z" }],
      ["ready for payment", { status: "ready_for_payment", expires_at: "2026-06-15T11:00:00.000Z" }],
    ])("leaves a checkout that is %s untouched", async (_label, checkpoint) => {
      checkoutSeed(checkpoint);
      const { runDocumentOperations } = await ops();
      await runDocumentOperations(NOW);
      expect(assignment("co").status).toBe("pending");
      expect(envelope("env-co").status).toBe("sent");
    });

    it("a completed envelope keeps its evidence and its assignment is not voided", async () => {
      checkoutSeed({ status: "expired" }, { status: "completed" });
      const { runDocumentOperations } = await ops();
      const result = await runDocumentOperations(NOW);
      expect(result.voidedCheckoutAssignments).toBe(0);
      expect(envelope("env-co").status).toBe("completed");
      expect(assignment("co").status).toBe("pending");
    });

    it("never reminds a checkout waiver", async () => {
      checkoutSeed({ status: "signing" });
      assignment("co").due_at = "2026-06-14T00:00:00.000Z";
      const { runDocumentOperations } = await ops();
      await runDocumentOperations(NOW);
      expect(state.deliveries).toHaveLength(0);
    });
  });
});
