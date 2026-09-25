import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeTable,
  createFakeAdminClient,
  type Row,
} from "@/lib/supabase/__tests__/simpleFakeAdminClient";
import { SIGNING_CONSENT_TEXT } from "@/lib/documents/consent";

/**
 * BR-3D2c1: proves the student/mobile completion path (Path B) enforces the
 * same source-hash invariant as the public web path (Path A) -- the exact
 * bytes downloaded from the source bucket must hash to the envelope's
 * persisted `source_sha256` before `applySigningFields` ever runs. No test
 * file existed for this route before this slice (confirmed via glob).
 *
 * `sha256Hex` is kept as the REAL implementation (only `applySigningFields`
 * is stubbed) so the hash check exercises genuine SHA-256 computation over
 * the fake blob's real bytes, matching the technique already established in
 * completeSigningActionContinuation.test.ts for Path A.
 */

const ASSIGNMENT_ID = "11111111-1111-4111-8111-111111111111";
const ENVELOPE_ID = "envelope-1";
const STUDIO_ID = "studio-1";
const CLIENT_ID = "client-1";
const USER_ID = "user-1";
const FIELD_ID = "field-1";

const SOURCE_BYTES = new Uint8Array([9, 8, 7, 6]);

let CORRECT_SOURCE_SHA256: string;

function fakeBlob() {
  return { arrayBuffer: async () => SOURCE_BYTES.buffer };
}

let assignmentsTable: FakeTable;
let linksTable: FakeTable;
let envelopesTable: FakeTable;
let fieldsTable: FakeTable;
let valuesTable: FakeTable;
let eventsTable: FakeTable;

const uploadMock = vi.fn();
uploadMock.mockResolvedValue({ error: null });
let uploadShouldThrowIfCalled = false;

vi.mock("@/lib/auth/studentApiAuth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/studentApiAuth")>(
    "@/lib/auth/studentApiAuth",
  );
  return {
    ...actual,
    requireStudentApiUser: async () => ({ ok: true as const, user: { id: USER_ID, email: "student@example.test" } }),
  };
});

const applySigningFieldsMock = vi.fn();

vi.mock("@/lib/documents/pdf", async () => {
  const actual = await vi.importActual<typeof import("@/lib/documents/pdf")>(
    "@/lib/documents/pdf",
  );
  return {
    ...actual,
    applySigningFields: (...args: unknown[]) => applySigningFieldsMock(...args),
  };
});

vi.mock("@/lib/documents/public-signing-security", () => ({
  requestIp: () => "127.0.0.1",
  consumePublicSigningRateLimit: async () => ({ allowed: true, retryAfterSeconds: 60 }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    ...createFakeAdminClient({
      document_assignments: assignmentsTable,
      client_account_links: linksTable,
      document_sign_envelopes: envelopesTable,
      document_sign_fields: fieldsTable,
      document_sign_values: valuesTable,
      document_sign_events: eventsTable,
    }),
    storage: {
      from: () => ({
        download: async () => ({ data: fakeBlob(), error: null }),
        upload: (...args: unknown[]) => {
          if (uploadShouldThrowIfCalled) {
            throw new Error("UNEXPECTED_UPLOAD: signed storage upload must not run after a source-hash mismatch");
          }
          return uploadMock(...args);
        },
        createSignedUrl: async () => ({ data: { signedUrl: "https://example.test/signed.pdf" } }),
      }),
    },
  }),
}));

const { POST } = await import("../route");
const { sha256Hex } = await import("@/lib/documents/pdf");

function seedRows(overrides: { envelope?: Row } = {}) {
  assignmentsTable.rows.push({
    id: ASSIGNMENT_ID,
    studio_id: STUDIO_ID,
    client_id: CLIENT_ID,
    sign_envelope_id: ENVELOPE_ID,
    status: "sent",
    signed_at: null,
  });
  linksTable.rows.push({
    id: "link-1",
    user_id: USER_ID,
    studio_id: STUDIO_ID,
    client_id: CLIENT_ID,
    status: "linked",
    can_sign_documents: true,
  });
  envelopesTable.rows.push({
    id: ENVELOPE_ID,
    studio_id: STUDIO_ID,
    client_id: CLIENT_ID,
    assignment_id: ASSIGNMENT_ID,
    signer_email: "student@example.test",
    status: "sent",
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    source_bucket: "document-files",
    source_path: `studios/${STUDIO_ID}/envelopes/${ENVELOPE_ID}/source.pdf`,
    source_sha256: CORRECT_SOURCE_SHA256,
    signed_bucket: null,
    signed_path: null,
    completed_at: null,
    ...overrides.envelope,
  });
  fieldsTable.rows.push({
    id: FIELD_ID,
    envelope_id: ENVELOPE_ID,
    field_type: "printed_name",
    page_number: 1,
    x: 0.1,
    y: 0.1,
    width: 0.3,
    height: 0.05,
    label: "Printed name",
    required: true,
    placeholder_text: null,
    default_value: null,
    sort_order: 1,
  });
}

function buildRequest(body: Record<string, unknown>) {
  return new Request(`https://example.test/api/student/documents/${ASSIGNMENT_ID}/complete`, {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function callRoute(body: Record<string, unknown>) {
  return POST(buildRequest(body), { params: Promise.resolve({ assignmentId: ASSIGNMENT_ID }) });
}

const validBody = {
  signerName: "Jane Doe",
  timezone: "America/New_York",
  consent: true,
  values: { [FIELD_ID]: "Jane Doe" },
};

beforeEach(() => {
  CORRECT_SOURCE_SHA256 = sha256Hex(SOURCE_BYTES);
  applySigningFieldsMock.mockClear();
  applySigningFieldsMock.mockResolvedValue({ bytes: SOURCE_BYTES, sha256: CORRECT_SOURCE_SHA256 });

  assignmentsTable = new FakeTable();
  linksTable = new FakeTable();
  envelopesTable = new FakeTable();
  fieldsTable = new FakeTable();
  valuesTable = new FakeTable();
  eventsTable = new FakeTable();

  seedRows();

  uploadMock.mockClear();
  uploadShouldThrowIfCalled = false;
});

describe("POST /api/student/documents/[assignmentId]/complete -- BR-3D2c1 source-hash verification", () => {
  it("source bytes matching the persisted hash complete successfully", async () => {
    const response = await callRoute(validBody);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.completed).toBe(true);
    expect(applySigningFieldsMock).toHaveBeenCalledTimes(1);
    expect(envelopesTable.rows.find((r) => r.id === ENVELOPE_ID)?.status).toBe("completed");
  });

  it("a source-hash mismatch returns the existing generic generation-failure response, before any downstream write", async () => {
    envelopesTable.rows = [];
    envelopesTable.rows.push({
      id: ENVELOPE_ID,
      studio_id: STUDIO_ID,
      client_id: CLIENT_ID,
      assignment_id: ASSIGNMENT_ID,
      signer_email: "student@example.test",
      status: "sent",
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      source_bucket: "document-files",
      source_path: `studios/${STUDIO_ID}/envelopes/${ENVELOPE_ID}/source.pdf`,
      source_sha256: "0".repeat(64),
      signed_bucket: null,
      signed_path: null,
      completed_at: null,
    });
    uploadShouldThrowIfCalled = true;

    const response = await callRoute(validBody);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("The signed document could not be generated.");
    expect(applySigningFieldsMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(valuesTable.rows).toHaveLength(0);
    expect(eventsTable.rows).toHaveLength(0);
    expect(assignmentsTable.rows.find((r) => r.id === ASSIGNMENT_ID)?.status).toBe("sent");
    expect(envelopesTable.rows.find((r) => r.id === ENVELOPE_ID)?.status).toBe("sent");
  });

  it("on success, the persisted signed_sha256 equals sha256Hex of the exact bytes uploaded to signed storage", async () => {
    await callRoute(validBody);

    const uploadedBytes = uploadMock.mock.calls[0][1] as Uint8Array;
    const persisted = envelopesTable.rows.find((r) => r.id === ENVELOPE_ID);
    expect(persisted?.signed_sha256).toBe(sha256Hex(uploadedBytes));
  });
});

describe("POST /api/student/documents/[assignmentId]/complete -- BR-3D2c2 consent evidence correctness", () => {
  it("persists exactly the same full canonical consent text as the public web completion path", async () => {
    await callRoute(validBody);

    const persisted = envelopesTable.rows.find((r) => r.id === ENVELOPE_ID);
    expect(persisted?.consent_text).toBe(SIGNING_CONSENT_TEXT);
    expect(persisted?.consent_text).toBe(
      "I have reviewed this document, agree to use electronic records and signatures, and confirm that the signature I apply is my own. Review the Electronic Records and Signature Consent.",
    );

    const completedEvent = eventsTable.rows.find((r) => r.event_type === "completed");
    expect((completedEvent?.metadata as { consent_text?: string } | undefined)?.consent_text).toBe(
      SIGNING_CONSENT_TEXT,
    );
  });
});
