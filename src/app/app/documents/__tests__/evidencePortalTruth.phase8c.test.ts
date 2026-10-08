import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FakeSupabase } from "@/lib/aria/__tests__/fakeSupabase";
import { hashSigningToken } from "@/lib/documents/signing";
import { sha256Hex } from "@/lib/documents/pdf";
import {
  countSignedRecordsByTemplate,
  presentDocumentAssignment,
  presentPortalTemplate,
} from "@/lib/documents/presentation";
import { buildCertificateModel, formatCertificateDate, type CertificateEvent } from "@/lib/documents/certificate";
import { parsePortalReturn, portalDocumentsHref } from "@/lib/documents/portal-return";

/**
 * Phase 8C -- Documents evidence + portal truth.
 *   A. signing authorization (who MAY sign) vs B. signer evidence (who DID sign) vs C. evidence access (who may read):
 *      every channel records the entered signer name, the authenticated account (or honestly none), the relationship
 *      and on-behalf context; the requested recipient is never used as the actor;
 *   - guardian / dependent client context survives the portal -> signing -> return trip and cannot be forged;
 *   - one presentation contract (portal web, student API, counts): only actionable requests offer signing;
 *   - the certificate is built from immutable recorded evidence; staff counts never double count or borrow evidence.
 * The RLS side of C (instructors cannot read raw evidence) is proven by sql-tests/test_T_phase8c_*.sql.
 */

const STUDIO = "studio-a";
const OTHER_STUDIO = "studio-b";
const CHILD = "00000000-0000-4000-8000-0000000000c1";
const OTHER_CLIENT = "00000000-0000-4000-8000-0000000000c2";
const SELF_USER = "user-self";
const GUARDIAN = "user-guardian";
const BILLING = "user-billing";
const STRANGER = "user-stranger";
const TOKEN = "phase8c-token";
const SOURCE = new Uint8Array([1, 2, 3, 4]);
const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

class DocumentsFake extends FakeSupabase {
  files = new Map<string, Uint8Array>();
  auth = {
    getUser: async () =>
      state.authUserId ? { data: { user: { id: state.authUserId, email: `${state.authUserId}@example.test` } } } : { data: { user: null } },
  };
  storage = {
    from: (bucket: string) => ({
      download: async (p: string) => {
        const bytes = this.files.get(`${bucket}/${p}`);
        return bytes ? { data: { arrayBuffer: async () => bytes.slice().buffer }, error: null } : { data: null, error: { message: "missing" } };
      },
      upload: async (p: string, bytes: Uint8Array) => {
        this.files.set(`${bucket}/${p}`, bytes);
        return { error: null };
      },
      remove: async (paths: string[]) => {
        for (const p of paths) this.files.delete(`${bucket}/${p}`);
        return { error: null };
      },
      createSignedUrl: async () => ({ data: { signedUrl: "https://signed.example.test/doc" }, error: null }),
    }),
  };
}

const state: {
  db: DocumentsFake;
  authUserId: string | null;
  role: string;
  deliveries: Array<{ templateKey: string; recipientEmail: string; relatedId: string }>;
} = { db: new DocumentsFake(), authUserId: SELF_USER, role: "studio_owner", deliveries: [] };

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
  getCurrentStudioContext: async () => ({ studioId: STUDIO, studioRole: state.role, userId: "staff" }),
}));
vi.mock("@/lib/billing/access", () => ({
  requireStudioFeature: async () => undefined,
  studioHasFeature: async () => true,
  studioIdHasFeature: async () => true,
}));
vi.mock("@/lib/notifications/outbound", () => ({
  queueOutboundDelivery: async (params: { templateKey: string; recipientEmail: string; relatedId: string }) => {
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
vi.mock("@/lib/auth/studentApiAuth", () => ({
  requireStudentApiUser: async () =>
    state.authUserId
      ? { ok: true, user: { id: state.authUserId, email: `${state.authUserId}@example.test` } }
      : { ok: false, response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }) },
  getStudentApiUser: async () => (state.authUserId ? { id: state.authUserId, email: `${state.authUserId}@example.test` } : null),
  createStudentApiUserScopedClient: async () => state.db,
  normalizeStudentApiUuid: (value: string) => value,
  studentApiJsonError: (message: string, status: number) => new Response(JSON.stringify({ error: message }), { status }),
}));

type Link = { user: string; client?: string; studio?: string; relationship?: string; canSign?: boolean; primary?: boolean };

function seed(options: {
  links?: Link[];
  assignmentStatus?: string;
  envelopeStatus?: string;
  expiresAt?: string;
  dueAt?: string | null;
  envelopeClient?: string;
} = {}) {
  const links = options.links ?? [{ user: SELF_USER, relationship: "self" }];
  const db = new DocumentsFake({
    studios: [{ id: STUDIO, name: "Studio A", slug: "studio-a", public_name: null, email: "studio@example.test" }],
    clients: [
      { id: CHILD, studio_id: STUDIO, first_name: "Robin", last_name: "Lee", email: "robin@example.test" },
      { id: OTHER_CLIENT, studio_id: STUDIO, first_name: "Other", last_name: "Client", email: "other@example.test" },
    ],
    client_account_links: links.map((link, index) => ({
      id: `link-${index}`,
      user_id: link.user,
      client_id: link.client ?? CHILD,
      studio_id: link.studio ?? STUDIO,
      status: "linked",
      relationship_type: link.relationship ?? "self",
      is_primary: link.primary ?? index === 0,
      can_view_schedule: true,
      can_view_billing: true,
      can_manage_bookings: true,
      can_sign_documents: link.canSign ?? true,
      created_at: `2026-01-0${index + 1}T00:00:00.000Z`,
    })),
    document_templates: [{ id: "tpl-1", studio_id: STUDIO, title: "Waiver", body: "Body", is_required: true, requires_signature: true, document_type: "waiver", applies_to: "manual" }],
    document_template_versions: [{ id: "ver-1", template_id: "tpl-1", version_number: 3, title: "Waiver v3", body: "Body" }],
    document_assignments: [
      {
        id: "asg-1",
        template_id: "tpl-1",
        template_version_id: "ver-1",
        studio_id: STUDIO,
        client_id: CHILD,
        status: options.assignmentStatus ?? "pending",
        sign_envelope_id: "env-1",
        due_at: options.dueAt ?? null,
        signed_at: null,
        assigned_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    document_sign_envelopes: [
      {
        id: "env-1",
        studio_id: STUDIO,
        client_id: options.envelopeClient ?? CHILD,
        assignment_id: "asg-1",
        template_id: "tpl-1",
        template_version_id: "ver-1",
        source_kind: "template_version",
        title: "Waiver",
        signer_name: "Robin Lee",
        signer_email: "robin@example.test",
        status: options.envelopeStatus ?? "sent",
        token_hash: hashSigningToken(TOKEN),
        expires_at: options.expiresAt ?? FUTURE,
        source_bucket: "document-files",
        source_path: `studios/${STUDIO}/envelopes/env-1/source.pdf`,
        source_sha256: sha256Hex(SOURCE),
        page_count: 1,
        page_sizes: [{ pageNumber: 1, width: 612, height: 792 }],
        completed_at: null,
      },
    ],
    document_sign_fields: [
      { id: "fld-sig", envelope_id: "env-1", field_type: "signature", page_number: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.05, label: "Signature", required: true, sort_order: 10 },
    ],
    document_sign_values: [],
    document_sign_events: [],
    document_signatures: [],
    document_operation_events: [],
    outbound_deliveries: [],
  });
  db.files.set(`document-files/studios/${STUDIO}/envelopes/env-1/source.pdf`, SOURCE);
  state.db = db;
  return db;
}

const envelope = () => state.db.rows("document_sign_envelopes").find((row) => row.id === "env-1")!;
const completedEvent = () => state.db.rows("document_sign_events").find((row) => row.event_type === "completed");

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

async function tokenComplete(signerName: string, extra: Record<string, string> = {}) {
  const { completeSigningAction } = await import("@/app/sign/[token]/actions");
  return outcome(() =>
    completeSigningAction(
      form({
        token: TOKEN,
        signerName,
        consent: "on",
        "field_fld-sig": JSON.stringify({ method: "typed", value: signerName }),
        ...extra,
      }),
    ),
  );
}

async function studentComplete(signerName: string) {
  const { POST } = await import("@/app/api/student/documents/[assignmentId]/complete/route");
  const response = await POST(
    new Request("https://example.test/api/student/documents/asg-1/complete", {
      method: "POST",
      body: JSON.stringify({ signerName, consent: true, values: { "fld-sig": { method: "typed", value: signerName } } }),
    }),
    { params: Promise.resolve({ assignmentId: "asg-1" }) },
  );
  return response.status;
}

async function portalHandOff(clientId = CHILD) {
  const { GET } = await import("@/app/portal/[studioSlug]/documents/[assignmentId]/sign/route");
  const response = await GET(new NextRequest(`https://example.test/portal/studio-a/documents/asg-1/sign?client=${clientId}`), {
    params: Promise.resolve({ studioSlug: "studio-a", assignmentId: "asg-1" }),
  });
  return response.headers.get("location") ?? "";
}

beforeEach(() => {
  state.authUserId = SELF_USER;
  state.role = "studio_owner";
  state.deliveries = [];
});

// ---------------------------------------------------------------------------------------------------------------
describe("signing authorization (stored can_sign_documents, relationship to the requested client)", () => {
  it("a self-linked account can hand off to signing for its own client", async () => {
    seed();
    expect(await portalHandOff()).toMatch(/\/sign\/[^?]+\?portal=studio-a&client=/);
  });

  it("an authorized guardian can hand off to signing for the linked child", async () => {
    seed({ links: [{ user: GUARDIAN, relationship: "guardian" }] });
    state.authUserId = GUARDIAN;
    expect(await portalHandOff()).toContain(`/sign/`);
  });

  it.each([
    ["guardian with can_sign_documents=false", { user: GUARDIAN, relationship: "guardian", canSign: false }],
    ["billing contact with stored can_sign_documents=false", { user: BILLING, relationship: "billing_contact", canSign: false }],
  ])("%s is refused (no signing session)", async (_label, link) => {
    seed({ links: [link] });
    state.authUserId = link.user;
    const location = await portalHandOff();
    expect(location).not.toContain("/sign/");
    expect(envelope().token_hash).toBe(hashSigningToken(TOKEN));
  });

  it("a billing contact follows its STORED flag: allowed when can_sign_documents=true", async () => {
    seed({ links: [{ user: BILLING, relationship: "billing_contact", canSign: true }] });
    state.authUserId = BILLING;
    expect(await portalHandOff()).toContain("/sign/");
  });

  it("a guardian linked to a different client cannot sign this client's document", async () => {
    seed({ links: [{ user: GUARDIAN, relationship: "guardian", client: OTHER_CLIENT }] });
    state.authUserId = GUARDIAN;
    expect(await portalHandOff(CHILD)).not.toContain("/sign/");
    expect(await portalHandOff(OTHER_CLIENT)).not.toContain("/sign/");
  });

  it("a link in another studio grants nothing here", async () => {
    seed({ links: [{ user: GUARDIAN, relationship: "guardian", studio: OTHER_STUDIO }] });
    state.authUserId = GUARDIAN;
    expect(await portalHandOff()).not.toContain("/sign/");
  });

  it("the student app refuses a linked account without can_sign_documents", async () => {
    seed({ links: [{ user: GUARDIAN, relationship: "guardian", canSign: false }] });
    state.authUserId = GUARDIAN;
    expect(await studentComplete("Pat Guardian")).toBe(403);
    expect(envelope().status).toBe("sent");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("signer evidence (who actually signed, recorded at completion)", () => {
  it("self signer through the portal session: entered name, account, self relationship, not on behalf", async () => {
    seed();
    expect(await tokenComplete("Robin Lee")).toContain("success=completed");
    const event = completedEvent()!;
    expect(event).toMatchObject({ actor_user_id: SELF_USER, actor_email: `${SELF_USER}@example.test` });
    expect(event.metadata).toMatchObject({
      signer_name_entered: "Robin Lee",
      signing_channel: "portal_session",
      authenticated_user_id: SELF_USER,
      subject_client_id: CHILD,
      relationship_type: "self",
      on_behalf: false,
      requested_signer_email: "robin@example.test",
      requested_signer_name: "Robin Lee",
    });
  });

  it("guardian signer: the guardian is the actor, the child is the subject, on-behalf is recorded", async () => {
    seed({ links: [{ user: GUARDIAN, relationship: "guardian" }] });
    state.authUserId = GUARDIAN;
    expect(await tokenComplete("Pat Guardian")).toContain("success=completed");
    const event = completedEvent()!;
    expect(event.actor_user_id).toBe(GUARDIAN);
    expect(event.actor_email).not.toBe("robin@example.test");
    expect(event.metadata).toMatchObject({
      signer_name_entered: "Pat Guardian",
      relationship_type: "guardian",
      on_behalf: true,
      subject_client_id: CHILD,
      requested_signer_name: "Robin Lee",
    });
    expect(String(event.summary)).toContain("on behalf of the client");
  });

  it("public token signer without a session: no invented identity, typed name kept, method honest", async () => {
    seed();
    state.authUserId = null;
    expect(await tokenComplete("Robin L.")).toContain("success=completed");
    const event = completedEvent()!;
    expect(event.actor_user_id).toBeNull();
    expect(event.actor_email).toBeNull();
    expect(event.metadata).toMatchObject({
      signer_name_entered: "Robin L.",
      signing_channel: "public_link",
      authenticated_user_id: null,
      relationship_type: null,
      on_behalf: null,
      requested_signer_email: "robin@example.test",
    });
  });

  it("a signed-in account with no link to this client is recorded as itself, never as the client", async () => {
    seed();
    state.authUserId = STRANGER;
    expect(await tokenComplete("Someone Else")).toContain("success=completed");
    expect(completedEvent()).toMatchObject({ actor_user_id: STRANGER });
    expect(completedEvent()!.metadata).toMatchObject({ signing_channel: "public_link", relationship_type: null, on_behalf: null });
  });

  it("student app self signer: authenticated actor, self relationship, same completion emails as the link", async () => {
    seed();
    expect(await studentComplete("Robin Lee")).toBe(200);
    const event = completedEvent()!;
    expect(event).toMatchObject({ actor_user_id: SELF_USER, actor_email: `${SELF_USER}@example.test` });
    expect(event.metadata).toMatchObject({ signing_channel: "student_app", signer_name_entered: "Robin Lee", on_behalf: false });
    expect(state.deliveries.map((delivery) => delivery.templateKey).sort()).toEqual([
      "document_signing_completed_signer",
      "document_signing_completed_studio",
    ]);
  });

  it("student app guardian signer: on-behalf evidence with the guardian's entered name", async () => {
    seed({ links: [{ user: GUARDIAN, relationship: "guardian" }] });
    state.authUserId = GUARDIAN;
    expect(await studentComplete("Pat Guardian")).toBe(200);
    expect(completedEvent()!.metadata).toMatchObject({ relationship_type: "guardian", on_behalf: true, signer_name_entered: "Pat Guardian" });
  });

  it("a decline is not attributed to the requested recipient", async () => {
    seed();
    state.authUserId = null;
    const { declineSigningAction } = await import("@/app/sign/[token]/actions");
    expect(await outcome(() => declineSigningAction(form({ token: TOKEN, reason: "No" })))).toContain("success=declined");
    const declined = state.db.rows("document_sign_events").find((row) => row.event_type === "declined")!;
    expect(declined.actor_email).toBeNull();
    expect(declined.metadata).toMatchObject({ requested_signer_email: "robin@example.test" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("guardian client context through Documents", () => {
  it("the portal hand-off carries the verified client to the signing page", async () => {
    seed({ links: [{ user: GUARDIAN, relationship: "guardian" }] });
    state.authUserId = GUARDIAN;
    expect(await portalHandOff()).toMatch(new RegExp(`\\?portal=studio-a&client=${CHILD}$`));
  });

  it("completion and decline keep the client for the return trip", async () => {
    seed({ links: [{ user: GUARDIAN, relationship: "guardian" }] });
    state.authUserId = GUARDIAN;
    expect(await tokenComplete("Pat Guardian", { portalSlug: "studio-a", portalClient: CHILD })).toBe(
      `redirect:/sign/${TOKEN}?success=completed&portal=studio-a&client=${CHILD}`,
    );
  });

  it("errors keep the client too (the signer stays in the child's context)", async () => {
    seed();
    const { completeSigningAction } = await import("@/app/sign/[token]/actions");
    expect(
      await outcome(() => completeSigningAction(form({ token: TOKEN, signerName: "", portalSlug: "studio-a", portalClient: CHILD }))),
    ).toBe(`redirect:/sign/${TOKEN}?error=missing_required_fields&portal=studio-a&client=${CHILD}`);
  });

  it("a tampered return value is dropped, never echoed", async () => {
    seed();
    expect(await tokenComplete("Robin Lee", { portalSlug: "studio-a", portalClient: "not-a-uuid\"><script>" })).toBe(
      `redirect:/sign/${TOKEN}?success=completed`,
    );
    expect(parsePortalReturn("../evil", CHILD)).toBeNull();
    expect(parsePortalReturn("studio-a", CHILD)).toEqual({ studioSlug: "studio-a", clientId: CHILD });
    expect(portalDocumentsHref({ studioSlug: "studio-a", clientId: CHILD })).toBe(`/portal/studio-a/documents?client=${CHILD}`);
  });

  it("an unlinked user's requested client is not honoured by the relationship resolver", async () => {
    seed({ links: [{ user: GUARDIAN, relationship: "guardian", client: OTHER_CLIENT }] });
    const { resolvePortalRelationship } = await import("@/lib/student-identity/portal-context");
    expect(await resolvePortalRelationship({ userId: GUARDIAN, studioId: STUDIO, requestedClientId: CHILD })).toBeNull();
    expect(await resolvePortalRelationship({ userId: STRANGER, studioId: STUDIO, requestedClientId: CHILD })).toBeNull();
    expect((await resolvePortalRelationship({ userId: GUARDIAN, studioId: STUDIO, requestedClientId: OTHER_CLIENT }))?.clientId).toBe(OTHER_CLIENT);
  });

  it("legacy typed-signature redirects keep the selected client", async () => {
    seed();
    const { signPortalDocumentAction } = await import("@/app/portal/[studioSlug]/documents/actions");
    expect(
      await outcome(() => signPortalDocumentAction(form({ studioSlug: "studio-a", templateId: "", assignmentId: "", clientId: CHILD }))),
    ).toBe(`redirect:/portal/studio-a/documents?client=${CHILD}&error=missing_document`);
  });

  it("every portal-home Documents link carries the selected client", () => {
    const source = readFileSync(path.join(process.cwd(), "src/app/portal/[studioSlug]/page.tsx"), "utf8");
    expect(source).not.toMatch(/`\/portal\/\$\{encodeURIComponent\(typedStudio\.slug\)\}\/documents`/);
    expect(source.match(/portalClientPath\(typedStudio\.slug, typedClient\.id, "\/documents"\)/g)?.length).toBeGreaterThanOrEqual(7);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("one presentation contract (portal web, student API, counts)", () => {
  const NOW = Date.parse("2026-06-01T00:00:00.000Z");
  const open = { status: "sent", expires_at: FUTURE };

  it.each([
    ["actionable pending", { assignmentStatus: "pending", dueAt: null, hasEnvelope: true, envelope: open }, "needs_signature", true],
    ["overdue but still actionable", { assignmentStatus: "pending", dueAt: "2026-05-01T00:00:00.000Z", hasEnvelope: true, envelope: open }, "overdue", true],
    ["waived", { assignmentStatus: "waived", dueAt: null, hasEnvelope: true, envelope: { status: "void", expires_at: FUTURE } }, "waived", false],
    ["waived with a still-open envelope", { assignmentStatus: "waived", dueAt: null, hasEnvelope: true, envelope: open }, "waived", false],
    ["signed", { assignmentStatus: "signed", dueAt: null, hasEnvelope: true, envelope: { status: "completed", expires_at: FUTURE } }, "signed", false],
    ["void", { assignmentStatus: "void", dueAt: null, hasEnvelope: true, envelope: open }, "void", false],
    ["expired (persisted)", { assignmentStatus: "pending", dueAt: null, hasEnvelope: true, envelope: { status: "expired", expires_at: PAST } }, "expired", false],
    ["expired (open past its link expiry)", { assignmentStatus: "pending", dueAt: null, hasEnvelope: true, envelope: { status: "viewed", expires_at: PAST } }, "expired", false],
    ["declined", { assignmentStatus: "pending", dueAt: null, hasEnvelope: true, envelope: { status: "declined", expires_at: FUTURE } }, "declined", false],
    ["being prepared", { assignmentStatus: "pending", dueAt: null, hasEnvelope: true, envelope: { status: "draft", expires_at: FUTURE } }, "preparing", false],
    ["legacy pending", { assignmentStatus: "pending", dueAt: null, hasEnvelope: false, envelope: null }, "needs_signature", true],
  ])("%s", (_label, input, state, needsAction) => {
    const presentation = presentDocumentAssignment(input, NOW);
    expect(presentation.state).toBe(state);
    expect(presentation.needsAction).toBe(needsAction);
  });

  it("an older legacy signature never marks an envelope-backed request signed", () => {
    expect(presentDocumentAssignment({ assignmentStatus: "pending", dueAt: null, hasEnvelope: true, envelope: open, legacySignature: true }, NOW).state).toBe("needs_signature");
    expect(presentDocumentAssignment({ assignmentStatus: "pending", dueAt: null, hasEnvelope: false, envelope: null, legacySignature: true }, NOW).state).toBe("signed");
  });

  it("reference templates are not counted as needing a signature", () => {
    expect(presentPortalTemplate({ signed: false, requiresSignature: false, isRequired: false })).toMatchObject({ state: "reference", needsAction: false });
    expect(presentPortalTemplate({ signed: false, requiresSignature: true, isRequired: false })).toMatchObject({ needsAction: true });
  });

  it.each([
    ["waived", "waived", "void", FUTURE, false],
    ["expired", "pending", "expired", PAST, false],
    ["declined", "pending", "declined", FUTURE, false],
    ["actionable", "pending", "sent", FUTURE, true],
  ])("student API detail: %s request -> nativeSigningAvailable %s", async (_label, assignmentStatus, envelopeStatus, expiresAt, available) => {
    seed({ assignmentStatus, envelopeStatus, expiresAt });
    const { GET } = await import("@/app/api/student/documents/[assignmentId]/route");
    const response = await GET(new Request("https://example.test/api/student/documents/asg-1"), {
      params: Promise.resolve({ assignmentId: "asg-1" }),
    });
    const body = (await response.json()) as { document: { nativeSigningAvailable: boolean; needsAction: boolean; presentationState: string } };
    expect(body.document.nativeSigningAvailable).toBe(available);
    expect(body.document.needsAction).toBe(available);
  });

  it("student API list reports the shared state (waived is not actionable)", async () => {
    seed({ assignmentStatus: "waived", envelopeStatus: "void" });
    const { GET } = await import("@/app/api/student/documents/route");
    const response = await GET(new Request("https://example.test/api/student/documents"));
    const body = (await response.json()) as { documents: Array<{ presentationState: string; needsAction: boolean; nativeSigningAvailable: boolean }> };
    expect(body.documents[0]).toMatchObject({ presentationState: "waived", needsAction: false, nativeSigningAvailable: false });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("portal Documents page truth (rendered)", () => {
  type Rendered = { hrefs: string[]; actions: number; text: string };
  function walk(node: unknown, out: Rendered = { hrefs: [], actions: 0, text: "" }): Rendered {
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
      const props = (node as { props: Record<string, unknown> }).props;
      if (typeof props.action === "function") out.actions += 1;
      if (typeof props.href === "string") out.hrefs.push(props.href);
      walk(props.children, out);
    }
    return out;
  }

  async function render(clientId = CHILD) {
    const { default: Page } = await import("@/app/portal/[studioSlug]/documents/page");
    return walk(await Page({ params: Promise.resolve({ studioSlug: "studio-a" }), searchParams: Promise.resolve({ client: clientId }) } as never));
  }

  const signHref = `/portal/studio-a/documents/asg-1/sign?client=${CHILD}`;

  it("an actionable request offers the sign CTA (positive control)", async () => {
    seed();
    const page = await render();
    expect(page.hrefs).toContain(signHref);
    expect(page.text).toContain("Needs signature");
  });

  it.each([
    ["waived", "waived", "void", FUTURE, "No signature needed"],
    ["expired", "pending", "expired", PAST, "Signing request expired"],
    ["declined", "pending", "declined", FUTURE, "Signing request declined"],
  ])("a %s request shows no sign CTA and a truthful status", async (_label, assignmentStatus, envelopeStatus, expiresAt, message) => {
    seed({ assignmentStatus, envelopeStatus, expiresAt });
    const page = await render();
    expect(page.hrefs).not.toContain(signHref);
    expect(page.actions).toBe(0);
    expect(page.text).toContain(message);
    expect(page.text).not.toContain("Needs signature");
  });

  it("a guardian without can_sign_documents sees the document but no sign CTA", async () => {
    seed({ links: [{ user: GUARDIAN, relationship: "guardian", canSign: false }] });
    state.authUserId = GUARDIAN;
    const page = await render();
    expect(page.hrefs).not.toContain(signHref);
    expect(page.text).toContain("Signing not available for your account");
  });

  it("a signed envelope never names the client as signer and links the authenticated download", async () => {
    seed({ assignmentStatus: "signed", envelopeStatus: "completed" });
    state.db.rows("document_assignments")[0].signed_at = "2026-05-01T00:00:00.000Z";
    const page = await render();
    expect(page.text).not.toContain("Signed by Robin Lee");
    expect(page.hrefs).toContain(`/portal/studio-a/documents/asg-1/signed?client=${CHILD}`);
  });

  it("an unrelated legacy signature does not mark a pending envelope request signed", async () => {
    seed();
    state.db.rows("document_signatures").push({ id: "sig-old", assignment_id: null, template_id: "tpl-1", template_version_id: "ver-1", studio_id: STUDIO, client_id: CHILD, signer_name: "Robin Lee", signed_at: "2025-01-01T00:00:00.000Z" });
    const page = await render();
    expect(page.hrefs).toContain(signHref);
    expect(page.text).not.toContain("Signature recorded");
  });

  it("a legacy (non-envelope) assignment is not marked signed by an older signature of the same template version", async () => {
    seed();
    Object.assign(state.db.rows("document_assignments")[0], { sign_envelope_id: null });
    state.db.rows("document_signatures").push({ id: "sig-old", assignment_id: null, template_id: "tpl-1", template_version_id: "ver-1", studio_id: STUDIO, client_id: CHILD, signer_name: "Robin Lee", signed_at: "2025-01-01T00:00:00.000Z" });
    const page = await render();
    expect(page.text).toContain("Needs signature");
    expect(page.text).not.toContain("Signature recorded");
    expect(page.actions).toBeGreaterThan(0); // the legacy typed-signature form is still offered
  });

  it("a guardian's tampered client id falls back safely to a client they are linked to", async () => {
    seed({ links: [{ user: GUARDIAN, relationship: "guardian" }] });
    state.authUserId = GUARDIAN;
    expect(await outcome(() => render(OTHER_CLIENT))).toBe("redirect:/portal/studio-a");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("certificate evidence (immutable, truthful, deterministic)", () => {
  const baseEnvelope = {
    id: "env-1",
    title: "Waiver",
    signer_name: "Robin Lee",
    signer_email: "robin@example.test",
    source_kind: "template_version",
    source_sha256: "src-sha",
    signed_sha256: "signed-sha",
    completed_at: "2026-05-01T10:30:00.000Z",
    signature_method: "typed",
    signed_timezone: "America/New_York",
    consent_text: "I agree to sign electronically.",
  };
  const events = (completed: Partial<CertificateEvent>): CertificateEvent[] => [
    { event_type: "created", actor_user_id: "staff-1", actor_email: "owner@studio.test", ip_address: null, user_agent: null, metadata: {}, created_at: "2026-04-30T09:00:00.000Z" },
    { event_type: "viewed", actor_user_id: null, actor_email: "robin@example.test", ip_address: null, user_agent: null, metadata: {}, created_at: "2026-05-01T10:00:00.000Z" },
    { event_type: "completed", actor_user_id: null, actor_email: null, ip_address: "203.0.113.5", user_agent: "vitest", metadata: {}, created_at: "2026-05-01T10:30:00.000Z", ...completed },
  ];
  const value = (model: ReturnType<typeof buildCertificateModel>, label: string) => model.rows.find((row) => row.label === label)?.value;

  it("guardian signer: actual signer, on-behalf context, client, template version, hashes, timeline", () => {
    const model = buildCertificateModel({
      envelope: baseEnvelope,
      events: events({
        actor_user_id: GUARDIAN,
        actor_email: "guardian@example.test",
        metadata: { signer_name_entered: "Pat Guardian", signing_channel: "portal_session", authenticated_user_id: GUARDIAN, relationship_type: "guardian", on_behalf: true },
      }),
      clientName: "Robin Lee",
      template: { title: "Waiver v3", versionNumber: 3 },
    });
    expect(value(model, "Signed by")).toBe("Pat Guardian");
    expect(value(model, "Signed on behalf of")).toBe("Robin Lee (signer is the guardian)");
    expect(value(model, "Signer account")).toBe("guardian@example.test");
    expect(value(model, "Signing channel")).toBe("DanceFlow client portal (signed in)");
    expect(value(model, "Client")).toBe("Robin Lee");
    expect(value(model, "Template")).toBe("Waiver v3 (version 3)");
    expect(value(model, "Requested signer")).toBe("Robin Lee <robin@example.test>");
    expect(value(model, "Source SHA-256")).toBe("src-sha");
    expect(value(model, "Signed SHA-256")).toBe("signed-sha");
    expect(value(model, "Completion IP")).toBe("203.0.113.5");
    expect(model.timeline.map((entry) => entry.label)).toEqual(["Request created", "Opened", "Signed and completed"]);
    expect(model.timeline[0].detail).toBe("owner@studio.test");
    expect(model.timeline[1].detail).toBeNull(); // the requested recipient is never shown as the actor
    expect(model.timeline[2].detail).toBe("guardian@example.test");
  });

  it("self signer: 'signed by the client'", () => {
    const model = buildCertificateModel({
      envelope: baseEnvelope,
      events: events({ actor_user_id: SELF_USER, actor_email: "robin@example.test", metadata: { signer_name_entered: "Robin Lee", signing_channel: "student_app", on_behalf: false, relationship_type: "self" } }),
      clientName: "Robin Lee",
      template: { title: "Waiver v3", versionNumber: 3 },
    });
    expect(value(model, "Signed on behalf of")).toBe("No - signed by the client");
    expect(value(model, "Signing channel")).toBe("DanceFlow student app (signed in)");
  });

  it("public token signer: no invented account, method stated truthfully", () => {
    const model = buildCertificateModel({
      envelope: baseEnvelope,
      events: events({ metadata: { signer_name_entered: "Robin L.", signing_channel: "public_link", on_behalf: null } }),
      clientName: "Robin Lee",
      template: null,
    });
    expect(value(model, "Signed by")).toBe("Robin L.");
    expect(value(model, "Signer account")).toBe("Not signed in (access by secure signing link)");
    expect(value(model, "Signed on behalf of")).toBeUndefined();
  });

  it("historical completion without signer evidence: omitted honestly, never inferred", () => {
    const model = buildCertificateModel({
      envelope: { ...baseEnvelope, signature_method: null, signed_timezone: null },
      events: [{ event_type: "completed", actor_user_id: null, actor_email: "robin@example.test", ip_address: null, user_agent: null, metadata: { signature_method: "typed" }, created_at: "2026-05-01T10:30:00.000Z" }],
      clientName: null,
      template: null,
    });
    expect(value(model, "Signed by")).toBe("Not recorded");
    expect(value(model, "Signer account")).toBe("Not recorded");
    expect(value(model, "Signed on behalf of")).toBeUndefined();
    expect(value(model, "Completion IP")).toBeUndefined();
    expect(value(model, "Signature method")).toBe("Not recorded");
    expect(model.timeline[0].detail).toBeNull();
  });

  it("is deterministic and independent of the current template (version identity only)", () => {
    const input = {
      envelope: baseEnvelope,
      events: events({ metadata: { signer_name_entered: "Robin Lee", signing_channel: "public_link" } }),
      clientName: "Robin Lee",
      template: { title: "Waiver v3", versionNumber: 3 },
    };
    expect(buildCertificateModel(input)).toEqual(buildCertificateModel(structuredClone(input)));
    expect(formatCertificateDate("2026-05-01T10:30:00.000Z")).toBe("2026-05-01 10:30 UTC");
  });

  it("the certificate route renders from recorded evidence for a document-management role", async () => {
    seed({ envelopeStatus: "completed", assignmentStatus: "signed" });
    const signed = new Uint8Array([9, 9, 9]);
    Object.assign(envelope(), { signed_bucket: "document-files", signed_path: `studios/${STUDIO}/envelopes/env-1/signed.pdf`, signed_sha256: sha256Hex(signed), completed_at: "2026-05-01T10:30:00.000Z" });
    state.db.files.set(`document-files/studios/${STUDIO}/envelopes/env-1/signed.pdf`, signed);
    state.db.rows("document_sign_events").push({ envelope_id: "env-1", event_type: "completed", actor_user_id: GUARDIAN, actor_email: "guardian@example.test", ip_address: null, user_agent: null, metadata: { signer_name_entered: "Pat Guardian", on_behalf: true, relationship_type: "guardian" }, created_at: "2026-05-01T10:30:00.000Z" });
    const { GET } = await import("@/app/app/documents/sign/[envelopeId]/certificate/route");
    const response = await GET(new Request("https://example.test"), { params: Promise.resolve({ envelopeId: "env-1" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("evidence access boundary (routes) and legacy consistency", () => {
  it.each(["source", "signed", "certificate"])("an instructor cannot download the %s evidence", async (route) => {
    seed({ envelopeStatus: "completed" });
    state.role = "instructor";
    const mod = (await import(`@/app/app/documents/sign/[envelopeId]/${route}/route`)) as {
      GET: (request: Request, ctx: { params: Promise<{ envelopeId: string }> }) => Promise<Response>;
    };
    expect((await mod.GET(new Request("https://example.test"), { params: Promise.resolve({ envelopeId: "env-1" }) })).status).toBe(404);
  });

  it("another studio's evidence is not found even for an owner", async () => {
    seed({ envelopeStatus: "completed" });
    envelope().studio_id = OTHER_STUDIO;
    const { GET } = await import("@/app/app/documents/sign/[envelopeId]/source/route");
    expect((await GET(new Request("https://example.test"), { params: Promise.resolve({ envelopeId: "env-1" }) })).status).toBe(404);
  });

  it("signed records: envelope completions count, legacy evidence counts once, nothing is double counted", () => {
    const counts = countSignedRecordsByTemplate(
      [
        { id: "a-envelope", template_id: "tpl-1", status: "signed" },
        { id: "a-legacy", template_id: "tpl-1", status: "signed" },
        { id: "a-pending", template_id: "tpl-1", status: "pending" },
        { id: "a-waived", template_id: "tpl-1", status: "waived" },
      ],
      [
        { template_id: "tpl-1", assignment_id: "a-legacy" }, // same record as its signed assignment
        { template_id: "tpl-1", assignment_id: null }, // standalone legacy signature
        { template_id: "tpl-2", assignment_id: null },
      ],
    );
    expect(counts.get("tpl-1")).toBe(3);
    expect(counts.get("tpl-2")).toBe(1);
  });

  it("the client profile never borrows an unrelated legacy signature for an assigned document", () => {
    const source = readFileSync(path.join(process.cwd(), "src/app/app/clients/[id]/page.tsx"), "utf8");
    const assigned = source.slice(source.indexOf("const assignedDocumentStatusRows"), source.indexOf("const documentStatusRows"));
    expect(assigned).not.toContain("latestSignatureByTemplateId");
    expect(assigned).toContain("presentDocumentAssignment(");
    expect(source).toContain("/app/documents/sign/${document.envelopeId}/signed");
    expect(source).toContain("Legacy typed signature");
  });

  it("check-in waiver status uses signed assignments (visible to every staff role) as well as legacy signatures", () => {
    const source = readFileSync(path.join(process.cwd(), "src/app/app/events/[id]/check-in/page.tsx"), "utf8");
    expect(source).toMatch(/from\("document_assignments"\)\s*\.select\("id, event_registration_id, template_id, signed_at"\)\s*\.in\("event_registration_id", registrationIds\)\s*\.eq\("status", "signed"\)/);
    expect(source).toContain("signedAssignmentTemplatesByRegistrationId.get(registrationId)");
  });
});
