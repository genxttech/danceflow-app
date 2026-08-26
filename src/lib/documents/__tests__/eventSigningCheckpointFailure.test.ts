import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FakeTable,
  createFakeAdminClient,
  type Row,
} from "@/lib/supabase/__tests__/simpleFakeAdminClient";

/**
 * Public Event Document-Checkpoint Remediation -- regression coverage for
 * src/lib/documents/event-signing.ts. Covers the confirmed production root
 * cause (document_assignments.status written as "sent", which always
 * violates document_assignments_status_check -- see
 * test_P_event_document_assignment_status_check.sql for the constraint-level
 * proof) and the checkpoint-terminal-state fix: a position-creation failure
 * must mark the checkpoint "cancelled" (an existing, valid
 * event_signing_checkpoints.status value) and rethrow the original error
 * unmasked, without touching an already-signed earlier position.
 */

const STUDIO_ID = "studio-1";
const EVENT_ID = "event-1";
const ORDER_ID = "order-1";

let tables: Record<string, FakeTable>;
let storageUploadShouldFail = false;

function table(rows: Row[] = []) {
  const t = new FakeTable();
  t.rows = rows;
  return t;
}

function buildTables() {
  return {
    event_signing_checkpoints: table(),
    event_document_requirements: table(),
    document_sign_envelopes: table(),
    document_assignments: table(),
    document_sign_fields: table(),
    document_sign_events: table(),
    studios: table([{ id: STUDIO_ID, name: "Test Studio" }]),
    event_orders: table([{ id: ORDER_ID }]),
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () =>
    createFakeAdminClient(tables, {
      uploadShouldFail: () => storageUploadShouldFail,
    }),
}));

vi.mock("@/lib/documents/template-pdf", () => ({
  renderTemplateVersionPdf: async () => new Uint8Array([1, 2, 3]),
}));

vi.mock("@/lib/documents/pdf", () => ({
  getPdfPageSizes: async () => [{ width: 612, height: 792 }],
  sha256Hex: () => "fake-sha256",
}));

vi.mock("@/lib/documents/signing", () => ({
  DOCUMENT_FILES_BUCKET: "document-files",
  createSigningToken: () => "fake-signing-token",
  hashSigningToken: (token: string) => `hashed-${token}`,
  sourceStoragePath: (studioId: string, envelopeId: string) => `${studioId}/${envelopeId}.pdf`,
}));

const { beginEventSigningCheckpoint, advanceEventSigningCheckpoint } = await import(
  "@/lib/documents/event-signing"
);

function seedRequirement(id: string) {
  return {
    id,
    event_id: EVENT_ID,
    template_id: `template-${id}`,
    template_version_id: null,
    studio_id: STUDIO_ID,
    organizer_id: null,
    active: true,
    is_required: true,
    document_templates: {
      id: `template-${id}`,
      title: `Template ${id}`,
      description: null,
      body: "Body",
      current_version: 1,
    },
  };
}

beforeEach(() => {
  tables = buildTables();
  storageUploadShouldFail = false;
});

describe("beginEventSigningCheckpoint -- anonymous attendee, single required waiver", () => {
  it("creates document_assignments with status='pending' (not 'sent') on success", async () => {
    tables.event_document_requirements.rows.push(seedRequirement("req-0"));

    const result = await beginEventSigningCheckpoint({
      orderId: ORDER_ID,
      eventId: EVENT_ID,
      studioId: STUDIO_ID,
      buyerEmail: "buyer@example.com",
      requirementIds: ["req-0"],
      registrationIds: ["reg-1"],
      surface: "web",
      paymentMode: "checkout",
    });

    expect(result?.signingUrl).toContain("fake-signing-token");
    expect(tables.document_assignments.rows).toHaveLength(1);
    expect(tables.document_assignments.rows[0].status).toBe("pending");
    // Anonymous attendee -- no client_id is referenced by the insert at all.
    expect(tables.document_assignments.rows[0]).not.toHaveProperty("client_id");
    expect(tables.event_signing_checkpoints.rows[0].status).toBe("signing");
  });
});

describe("beginEventSigningCheckpoint -- position-0 creation failure", () => {
  it("marks the checkpoint status='cancelled' and rethrows the original error unmasked", async () => {
    // No event_document_requirements row seeded for "req-0" -- createEnvelopeForPosition
    // throws "Required event document is no longer available." before any storage/PDF work.
    await expect(
      beginEventSigningCheckpoint({
        orderId: ORDER_ID,
        eventId: EVENT_ID,
        studioId: STUDIO_ID,
        buyerEmail: "buyer@example.com",
        requirementIds: ["req-0"],
        registrationIds: ["reg-1"],
        surface: "web",
        paymentMode: "checkout",
      }),
    ).rejects.toThrow("Required event document is no longer available.");

    expect(tables.event_signing_checkpoints.rows).toHaveLength(1);
    expect(tables.event_signing_checkpoints.rows[0].status).toBe("cancelled");
    // No orphaned assignment/envelope was left behind by the failed attempt.
    expect(tables.document_assignments.rows).toHaveLength(0);
    expect(tables.document_sign_envelopes.rows).toHaveLength(0);
  });

  it("still marks the checkpoint cancelled (not masked) when the storage upload itself fails", async () => {
    tables.event_document_requirements.rows.push(seedRequirement("req-0"));
    storageUploadShouldFail = true;

    await expect(
      beginEventSigningCheckpoint({
        orderId: ORDER_ID,
        eventId: EVENT_ID,
        studioId: STUDIO_ID,
        buyerEmail: "buyer@example.com",
        requirementIds: ["req-0"],
        registrationIds: ["reg-1"],
        surface: "web",
        paymentMode: "checkout",
      }),
    ).rejects.toThrow("Required event document could not be prepared.");

    expect(tables.event_signing_checkpoints.rows[0].status).toBe("cancelled");
    expect(tables.document_assignments.rows).toHaveLength(0);
  });
});

describe("advanceEventSigningCheckpoint -- two-required-waiver sequence, position-1 failure", () => {
  it("leaves the position-0 signed assignment untouched and cancels the checkpoint when position 1 fails", async () => {
    // Only req-0 is seeded -- req-1 will fail to resolve when position 1 is attempted.
    tables.event_document_requirements.rows.push(seedRequirement("req-0"));

    const begun = await beginEventSigningCheckpoint({
      orderId: ORDER_ID,
      eventId: EVENT_ID,
      studioId: STUDIO_ID,
      buyerEmail: "buyer@example.com",
      requirementIds: ["req-0", "req-1"],
      registrationIds: ["reg-1"],
      surface: "web",
      paymentMode: "checkout",
    });
    expect(begun?.signingUrl).toBeTruthy();
    expect(tables.document_assignments.rows).toHaveLength(1);
    expect(tables.document_assignments.rows[0].status).toBe("pending");

    const position0EnvelopeId = tables.document_sign_envelopes.rows[0].id as string;

    await expect(advanceEventSigningCheckpoint(position0EnvelopeId)).rejects.toThrow(
      "Required event document is no longer available.",
    );

    // The prior, legitimately-signed position-0 assignment is untouched --
    // advanceEventSigningCheckpoint's own unconditional "signed" update ran
    // first (it always marks the completing position signed), and nothing
    // in the position-1 failure path deletes or reverts it.
    expect(tables.document_assignments.rows).toHaveLength(1);
    expect(tables.document_assignments.rows[0].status).toBe("signed");

    // No second (partial/orphaned) assignment was created for position 1.
    expect(tables.document_sign_envelopes.rows).toHaveLength(1);

    expect(tables.event_signing_checkpoints.rows[0].status).toBe("cancelled");
  });
});

describe("advanceEventSigningCheckpoint -- checkpoint cleanup update itself also fails", () => {
  it("still propagates the original document-creation error, not the cleanup error, and leaves the position-0 signed assignment untouched", async () => {
    // Only req-0 is seeded -- position 1 fails the same way as the test
    // above. This time the cleanup update that would mark the checkpoint
    // "cancelled" is itself forced to fail (simulating a network/client
    // error during that cleanup call), proving markCheckpointCancelledAfterCreationFailure's
    // own try/catch swallows the cleanup failure rather than letting it
    // replace the original "Required event document is no longer
    // available." error the caller must actually see.
    tables.event_document_requirements.rows.push(seedRequirement("req-0"));

    const begun = await beginEventSigningCheckpoint({
      orderId: ORDER_ID,
      eventId: EVENT_ID,
      studioId: STUDIO_ID,
      buyerEmail: "buyer@example.com",
      requirementIds: ["req-0", "req-1"],
      registrationIds: ["reg-1"],
      surface: "web",
      paymentMode: "checkout",
    });
    expect(begun?.signingUrl).toBeTruthy();

    const position0EnvelopeId = tables.document_sign_envelopes.rows[0].id as string;

    // Scoped to the *cleanup* update specifically (payload has
    // status:"cancelled") -- not the earlier position-advance update
    // (payload has current_position/last_progress_at, no `status` key at
    // all), which must still succeed or this test would fail before ever
    // reaching the document-creation error it's actually exercising.
    tables.event_signing_checkpoints.forceErrorRule = {
      op: "update",
      error: { message: "simulated network failure during checkpoint cleanup update" },
      matchesPayload: (payload) =>
        !Array.isArray(payload) && payload?.status === "cancelled",
    };

    await expect(advanceEventSigningCheckpoint(position0EnvelopeId)).rejects.toThrow(
      "Required event document is no longer available.",
    );
    // Explicitly not the cleanup error -- toThrow() above already asserts
    // the exact original message, which is the point: if the cleanup
    // failure had replaced it, this assertion would instead see
    // "simulated network failure during checkpoint cleanup update".

    // The cleanup update never actually succeeded (it was the one forced
    // to fail), so the checkpoint's status legitimately remains whatever
    // the last *successful* write left it as -- the position-advance
    // update, which never touches `status` -- i.e. still "signing", not
    // "cancelled". This is the honest, expected consequence of a cleanup
    // failure: best-effort cleanup, not a guarantee, and never worth
    // risking the original error to force it through.
    expect(tables.event_signing_checkpoints.rows[0].status).toBe("signing");

    // The prior, legitimately-signed position-0 assignment is untouched.
    expect(tables.document_assignments.rows).toHaveLength(1);
    expect(tables.document_assignments.rows[0].status).toBe("signed");
    expect(tables.document_sign_envelopes.rows).toHaveLength(1);
  });
});
