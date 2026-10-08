import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/aria/__tests__/fakeSupabase";
import { hashSigningToken } from "@/lib/documents/signing";
import { sha256Hex } from "@/lib/documents/pdf";

/**
 * Phase 8A -- document signing integrity, behavioural coverage of the server write paths (the RLS side is proven by
 * the live-Postgres suite sql-tests/test_T_phase8a_documents_signing_integrity.sql):
 *   - public token completion, student-app completion and the legacy portal typed-signature action never sign a
 *     waived / void assignment, never complete an expired / declined / void envelope, and never bypass an envelope;
 *   - staff waive / void close every live envelope first; revoke / revise never overwrite a completed envelope;
 *   - every race ordering resolves to exactly one authoritative outcome with no duplicate evidence.
 */

const STUDIO = "studio-a";
const CLIENT = "client-a";
const USER = "user-portal";
const STAFF = "user-staff";
const TOKEN = "phase8a-token";
const SOURCE = new Uint8Array([1, 2, 3, 4]);
const SOURCE_SHA = sha256Hex(SOURCE);

type Hook = (db: FakeSupabase) => void;
const hooks: { onSignedUpload?: Hook; onSignatureInsert?: Hook } = {};

class DocumentsFake extends FakeSupabase {
  files = new Map<string, Uint8Array>();
  uploads = 0;
  auth = { getUser: async () => ({ data: { user: { id: state.authUserId, email: "portal@example.test" } } }) };
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
        this.uploads += 1;
        if (path.endsWith("signed.pdf")) hooks.onSignedUpload?.(this);
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

const state: { db: DocumentsFake; authUserId: string } = { db: new DocumentsFake(), authUserId: USER };

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.5" }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
  unstable_rethrow: (error: unknown) => {
    if (error instanceof Error && error.message.startsWith("redirect:")) throw error;
  },
}));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: STUDIO, studioRole: "studio_owner", userId: STAFF }),
}));
vi.mock("@/lib/billing/access", () => ({ requireStudioFeature: async () => undefined }));
vi.mock("@/lib/notifications/expoPush", () => ({ sendMobilePushToUser: async () => undefined }));
vi.mock("@/lib/notifications/outbound", () => ({ queueOutboundDelivery: async () => ({ error: null }) }));
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
vi.mock("@/lib/auth/studentApiAuth", () => ({
  requireStudentApiUser: async () => ({ ok: true, user: { id: USER, email: "portal@example.test" } }),
  normalizeStudentApiUuid: (value: string) => value,
  studentApiJsonError: (message: string, status: number) => new Response(JSON.stringify({ error: message }), { status }),
}));

const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

function seed(options: { assignmentStatus?: string; envelopeStatus?: string; expiresAt?: string; withEnvelope?: boolean } = {}) {
  const withEnvelope = options.withEnvelope ?? true;
  const db = new DocumentsFake({
    studios: [{ id: STUDIO, name: "Studio A", slug: "studio-a", public_name: null }],
    clients: [{ id: CLIENT, studio_id: STUDIO, first_name: "Robin", last_name: "Lee", email: "robin@example.test" }],
    document_templates: [
      { id: "tpl-1", studio_id: STUDIO, organizer_id: null, title: "Waiver", body: "Waiver body", current_version: 1, requires_signature: true, is_required: true, is_active: true, applies_to: "manual" },
    ],
    document_template_versions: [{ id: "ver-1", template_id: "tpl-1", version_number: 1, title: "Waiver", body: "Waiver body" }],
    document_assignments: [
      {
        id: "asg-1",
        template_id: "tpl-1",
        template_version_id: "ver-1",
        studio_id: STUDIO,
        client_id: CLIENT,
        status: options.assignmentStatus ?? "pending",
        sign_envelope_id: withEnvelope ? "env-1" : null,
        signed_at: null,
        event_id: null,
        event_registration_id: null,
        organizer_id: null,
        organizer_contact_id: null,
      },
    ],
    document_sign_envelopes: withEnvelope
      ? [
          {
            id: "env-1",
            studio_id: STUDIO,
            client_id: CLIENT,
            assignment_id: "asg-1",
            title: "Waiver",
            signer_name: "Robin Lee",
            signer_email: "robin@example.test",
            status: options.envelopeStatus ?? "sent",
            token_hash: hashSigningToken(TOKEN),
            expires_at: options.expiresAt ?? FUTURE,
            source_bucket: "document-files",
            source_path: `studios/${STUDIO}/envelopes/env-1/source.pdf`,
            source_sha256: SOURCE_SHA,
            superseded_by_envelope_id: null,
            revision_number: 1,
            reminder_count: 0,
            completed_at: null,
          },
        ]
      : [],
    document_sign_fields: [
      { id: "fld-sig", envelope_id: "env-1", field_type: "signature", page_number: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.05, label: "Signature", required: true, sort_order: 1 },
    ],
    document_sign_values: [],
    document_sign_events: [],
    document_signatures: [],
    document_signature_audit_events: [],
    document_operation_events: [],
    client_account_links: [{ id: "link-1", user_id: USER, studio_id: STUDIO, client_id: CLIENT, status: "linked", can_sign_documents: true }],
  });
  db.files.set(`document-files/studios/${STUDIO}/envelopes/env-1/source.pdf`, SOURCE);
  state.db = db;
  return db;
}

const envelope = () => state.db.rows("document_sign_envelopes").find((row) => row.id === "env-1")!;
const assignment = () => state.db.rows("document_assignments").find((row) => row.id === "asg-1")!;
const completedEvents = () => state.db.rows("document_sign_events").filter((row) => row.event_type === "completed");

async function publicComplete() {
  const { completeSigningAction } = await import("@/app/sign/[token]/actions");
  const form = new FormData();
  form.set("token", TOKEN);
  form.set("signerName", "Robin Lee");
  form.set("consent", "on");
  form.set("field_fld-sig", JSON.stringify({ method: "typed", value: "Robin Lee" }));
  try {
    await completeSigningAction(form);
    return "no-redirect";
  } catch (error) {
    return (error as Error).message;
  }
}

async function studentComplete() {
  const { POST } = await import("@/app/api/student/documents/[assignmentId]/complete/route");
  const response = await POST(
    new Request("https://example.test/api/student/documents/asg-1/complete", {
      method: "POST",
      body: JSON.stringify({ signerName: "Robin Lee", consent: true, values: { "fld-sig": { method: "typed", value: "Robin Lee" } } }),
    }),
    { params: Promise.resolve({ assignmentId: "asg-1" }) },
  );
  return response.status;
}

async function staff(action: "waive" | "void" | "revoke" | "revise") {
  const form = new FormData();
  try {
    if (action === "waive" || action === "void") {
      form.set("assignmentId", "asg-1");
      const mod = await import("@/app/app/documents/actions");
      await (action === "waive" ? mod.waiveDocumentAssignmentAction(form) : mod.voidDocumentAssignmentAction(form));
    } else {
      form.set("envelopeId", "env-1");
      form.set("reason", "Corrected terms needed");
      const mod = await import("@/app/app/documents/sign/actions");
      await (action === "revoke" ? mod.revokeSignEnvelopeAction(form) : mod.reviseSignEnvelopeAction(form));
    }
    return "no-redirect";
  } catch (error) {
    return (error as Error).message;
  }
}

beforeEach(() => {
  state.authUserId = USER;
  hooks.onSignedUpload = undefined;
  hooks.onSignatureInsert = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("envelope completion (public token)", () => {
  it("pending -> completed through a valid envelope, with one completion event", async () => {
    seed();
    expect(await publicComplete()).toContain("success=completed");
    expect(envelope()).toMatchObject({ status: "completed", signed_sha256: "signed-sha" });
    expect(completedEvents()).toHaveLength(1);
  });

  it.each(["waived", "void", "signed"])("a %s assignment cannot be signed even if its envelope is still open", async (status) => {
    seed({ assignmentStatus: status });
    expect(await publicComplete()).toContain("error=link_unavailable");
    expect(envelope().status).toBe("sent");
    expect(state.db.uploads).toBe(0);
    expect(assignment().status).toBe(status);
  });

  it("an expired envelope cannot complete (and is marked expired)", async () => {
    seed({ expiresAt: PAST });
    expect(await publicComplete()).toContain("error=link_expired");
    expect(envelope().status).toBe("expired");
    expect(completedEvents()).toHaveLength(0);
  });

  it.each(["declined", "void"])("a %s envelope cannot complete", async (status) => {
    seed({ envelopeStatus: status });
    expect(await publicComplete()).toContain("error=link_unavailable");
    expect(envelope().status).toBe(status);
  });

  it("Case C: staff revoke lands while the signer is submitting -> revoke wins, signing rejected, no evidence kept", async () => {
    seed();
    hooks.onSignedUpload = (db) => {
      Object.assign(db.rows("document_sign_envelopes")[0], { status: "void", token_hash: null });
    };
    expect(await publicComplete()).toContain("error=link_unavailable");
    expect(envelope().status).toBe("void");
    expect(completedEvents()).toHaveLength(0);
    expect(state.db.files.has(`document-files/studios/${STUDIO}/envelopes/env-1/signed.pdf`)).toBe(false);
  });

  it("Case D: two completion requests -> one authoritative completion, replay is idempotent", async () => {
    seed();
    const [first, second] = await Promise.all([publicComplete(), publicComplete()]);
    expect([first, second].filter((result) => result.includes("success=completed"))).toHaveLength(1);
    expect(completedEvents()).toHaveLength(1);
    // the losing request fails at the no-overwrite signed-PDF upload, so exactly one signed artifact exists
    expect(state.db.uploads).toBe(1);
    expect(envelope().status).toBe("completed");
    // replay after completion
    expect(await publicComplete()).toContain("success=completed");
    expect(completedEvents()).toHaveLength(1);
  });
});

describe("student-app completion", () => {
  it.each(["waived", "void"])("a %s assignment returns 409 and stays %s", async (status) => {
    seed({ assignmentStatus: status });
    expect(await studentComplete()).toBe(409);
    expect(assignment().status).toBe(status);
    expect(envelope().status).toBe("sent");
  });

  it("Case B: staff waives while the student is signing -> waive preserved, signing rejected", async () => {
    seed();
    hooks.onSignedUpload = (db) => {
      Object.assign(db.rows("document_assignments")[0], { status: "waived" });
      Object.assign(db.rows("document_sign_envelopes")[0], { status: "void", token_hash: null });
    };
    expect(await studentComplete()).toBe(409);
    expect(assignment().status).toBe("waived");
    expect(envelope().status).toBe("void");
  });

  it("never converts waived -> signed even if the envelope itself completes", async () => {
    seed();
    hooks.onSignedUpload = (db) => {
      Object.assign(db.rows("document_assignments")[0], { status: "waived" });
    };
    await studentComplete();
    expect(assignment().status).toBe("waived");
  });

  it("valid completion signs the pending assignment", async () => {
    seed();
    expect(await studentComplete()).toBe(200);
    expect(envelope().status).toBe("completed");
    expect(assignment().status).toBe("signed");
  });
});

describe("staff waive / void / revoke / revise", () => {
  it.each(["sent", "viewed", "started", "draft"])("waive closes a %s envelope first, so the signer can no longer complete", async (status) => {
    seed({ envelopeStatus: status });
    expect(await staff("waive")).toContain("success=waived");
    expect(assignment().status).toBe("waived");
    expect(envelope()).toMatchObject({ status: "void", token_hash: null });
    // the link was cleared with the envelope, so the submission fails closed before any write
    expect(await publicComplete()).toMatch(/error=(invalid_link|link_unavailable)/);
    expect(assignment().status).toBe("waived");
  });

  it("void closes a started envelope too", async () => {
    seed({ envelopeStatus: "started" });
    expect(await staff("void")).toContain("success=voided");
    expect(assignment().status).toBe("void");
    expect(envelope().status).toBe("void");
  });

  it("waive of an already-completed document is a conflict: evidence untouched, no operation event", async () => {
    seed({ envelopeStatus: "completed", assignmentStatus: "signed" });
    expect(await staff("waive")).toContain("error=");
    expect(envelope().status).toBe("completed");
    expect(assignment().status).toBe("signed");
    expect(state.db.rows("document_operation_events")).toHaveLength(0);
  });

  it("Case A: staff read the request as open, the client completed, then staff revoke -> completion preserved", async () => {
    seed();
    expect(await publicComplete()).toContain("success=completed");
    // the staff page still shows the stale 'sent' state; the revoke action re-reads and the guarded write is a no-op
    const { revokeSignEnvelopeAction } = await import("@/app/app/documents/sign/actions");
    const form = new FormData();
    form.set("envelopeId", "env-1");
    state.db.rows("document_sign_envelopes")[0].status = "completed";
    await expect(revokeSignEnvelopeAction(form)).rejects.toThrow(/request_not_revocable|request_changed/);
    expect(envelope().status).toBe("completed");
    expect(state.db.rows("document_sign_events").filter((row) => row.event_type === "revoked")).toHaveLength(0);
  });

  it("stale revoke whose write races a completion is reported as a conflict, not forced", async () => {
    seed();
    const original = state.db.from.bind(state.db);
    let raced = false;
    state.db.from = (table: string) => {
      const query = original(table);
      if (table === "document_sign_envelopes" && !raced) {
        const update = query.update.bind(query);
        query.update = (payload: unknown) => {
          raced = true;
          state.db.rows("document_sign_envelopes")[0].status = "completed"; // client completed between read and write
          return update(payload);
        };
      }
      return query;
    };
    expect(await staff("revoke")).toContain("error=request_changed");
    expect(envelope().status).toBe("completed");
    expect(assignment().status).toBe("pending");
  });

  it("revoke before the client submits wins and the submission is rejected", async () => {
    seed();
    expect(await staff("revoke")).toContain("success=revoked");
    expect(assignment().status).toBe("void");
    expect(await publicComplete()).toMatch(/error=(invalid_link|link_unavailable)/);
  });

  it("revise cannot supersede a request that completed after it was read", async () => {
    seed();
    const original = state.db.from.bind(state.db);
    let raced = false;
    state.db.from = (table: string) => {
      const query = original(table);
      if (table === "document_sign_envelopes" && !raced) {
        const update = query.update.bind(query);
        query.update = (payload: unknown) => {
          if ((payload as { superseded_by_envelope_id?: string }).superseded_by_envelope_id) {
            raced = true;
            state.db.rows("document_sign_envelopes").find((row) => row.id === "env-1")!.status = "completed";
          }
          return update(payload);
        };
      }
      return query;
    };
    expect(await staff("revise")).toContain("error=revision_supersede_failed");
    expect(envelope().status).toBe("completed");
    // the half-created revision was removed
    expect(state.db.rows("document_sign_envelopes")).toHaveLength(1);
  });
});

describe("legacy portal typed-signature action", () => {
  async function legacySign() {
    const { signPortalDocumentAction } = await import("@/app/portal/[studioSlug]/documents/actions");
    const form = new FormData();
    form.set("studioSlug", "studio-a");
    form.set("assignmentId", "00000000-0000-4000-8000-000000000001");
    form.set("signerName", "Robin Lee");
    form.set("consentAccepted", "on");
    form.set("clientId", "");
    try {
      await signPortalDocumentAction(form);
      return "no-redirect";
    } catch (error) {
      return (error as Error).message;
    }
  }

  function legacySeed(options: { assignmentStatus?: string; withEnvelope?: boolean } = {}) {
    const db = seed({ assignmentStatus: options.assignmentStatus, withEnvelope: options.withEnvelope });
    db.rows("document_assignments")[0].id = "00000000-0000-4000-8000-000000000001";
    return db;
  }

  const legacyAssignment = () => state.db.rows("document_assignments")[0];

  it("an envelope-backed assignment cannot be signed through the typed legacy path", async () => {
    legacySeed({ withEnvelope: true });
    expect(await legacySign()).toContain("error=signing_request_unavailable");
    expect(state.db.rows("document_signatures")).toHaveLength(0);
    expect(legacyAssignment().status).toBe("pending");
  });

  it.each(["waived", "void"])("a %s legacy assignment cannot be signed", async (status) => {
    legacySeed({ withEnvelope: false, assignmentStatus: status });
    const result = await legacySign();
    expect(result).toMatch(/error=(signing_request_unavailable|document_not_found)/);
    expect(state.db.rows("document_signatures")).toHaveLength(0);
    expect(legacyAssignment().status).toBe(status);
  });

  it("a genuinely legacy pending assignment is still signed through the validated server path", async () => {
    legacySeed({ withEnvelope: false });
    expect(await legacySign()).toContain("success=signed");
    expect(state.db.rows("document_signatures")).toHaveLength(1);
    expect(state.db.rows("document_signatures")[0]).toMatchObject({ studio_id: STUDIO, client_id: CLIENT, signer_user_id: USER });
    expect(legacyAssignment().status).toBe("signed");
    expect(state.db.rows("document_signature_audit_events")).toHaveLength(1);
  });

  it("a staff waive that lands mid-signing wins: the typed signature is withdrawn", async () => {
    legacySeed({ withEnvelope: false });
    const original = state.db.from.bind(state.db);
    state.db.from = (table: string) => {
      const query = original(table);
      if (table === "document_signatures") {
        const insert = query.insert.bind(query);
        query.insert = (payload: unknown) => {
          state.db.rows("document_assignments")[0].status = "waived";
          return insert(payload);
        };
      }
      return query;
    };
    expect(await legacySign()).toContain("error=signing_failed");
    expect(legacyAssignment().status).toBe("waived");
    expect(state.db.rows("document_signatures")).toHaveLength(0);
  });
});

describe("event checkout advance", () => {
  it("does not sign an assignment whose envelope is not completed", async () => {
    seed();
    state.db.rows("document_sign_envelopes")[0].event_signing_checkpoint_id = "cp-1";
    state.db.rows("event_signing_checkpoints").push({ id: "cp-1", expires_at: FUTURE, current_position: 0, total_required: 1, status: "signing" });
    const { advanceEventSigningCheckpoint } = await import("@/lib/documents/event-signing");
    await expect(advanceEventSigningCheckpoint("env-1")).rejects.toThrow(/before the document is completed/);
    expect(assignment().status).toBe("pending");
  });
});
