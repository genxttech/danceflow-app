import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeTable,
  createFakeAdminClient,
  type Row,
} from "@/lib/supabase/__tests__/simpleFakeAdminClient";
import { hashSigningToken } from "@/lib/documents/signing";
// Resolves to the REAL implementation: the `@/lib/documents/pdf` mock below
// preserves it unchanged via `importActual`, only stubbing `applySigningFields`.
import { sha256Hex } from "@/lib/documents/pdf";
import { SIGNING_CONSENT_TEXT } from "@/lib/documents/consent";

/**
 * Regression coverage for the confirmed Public Event Registration
 * signing-continuation defect: `completeSigningAction`'s catch block around
 * `advanceEventSigningCheckpoint()` / `redirect(next.url)` was catching
 * Next.js's own internal NEXT_REDIRECT control-flow signal (thrown by a
 * *successful* `redirect()` call) and converting it into
 * `?error=event_checkout_continuation_failed`, silently blocking every
 * public-event required-document continuation (advance to the next waiver,
 * or resume to payment). Root-caused and fixed via `unstable_rethrow`.
 *
 * `redirect` is mocked to throw a genuinely NEXT_REDIRECT-digest-shaped
 * error (same format Next's own `redirect()` produces -- see
 * node_modules/next/dist/client/components/redirect-error.js's
 * `isRedirectError`), and `unstable_rethrow` is the REAL, unmocked
 * implementation (pulled via `importActual`) -- so these tests exercise
 * Next's actual redirect-detection logic, not an assumption that it works.
 *
 * Everything upstream of the continuation branch (envelope/fields lookup,
 * PDF signing, storage, document_sign_values/document_sign_events writes,
 * envelope completion) is faked/mocked to the minimum needed to reach that
 * branch deterministically -- this file's job is the continuation branch
 * specifically, not re-proving the rest of completeSigningAction.
 */

let envelopesTable: FakeTable;
let fieldsTable: FakeTable;
let valuesTable: FakeTable;
let eventsTable: FakeTable;
let studiosTable: FakeTable;

const STUDIO_ID = "studio-1";
const ENVELOPE_ID = "envelope-1";
const TOKEN = "test-signing-token";
const FIELD_ID = "field-1";

const SOURCE_BYTES = new Uint8Array([1, 2, 3]);
/** The real, correct source hash for SOURCE_BYTES -- what a genuine envelope would have persisted at creation time. */
const CORRECT_SOURCE_SHA256 = sha256Hex(SOURCE_BYTES);

function fakeBlob() {
  return {
    arrayBuffer: async () => SOURCE_BYTES.buffer,
  };
}

const uploadMock = vi.fn();
uploadMock.mockResolvedValue({ error: null });
/** Set true only by the source-mismatch tests below, so an unexpected upload fails loudly rather than silently succeeding. */
let uploadShouldThrowIfCalled = false;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    ...createFakeAdminClient({
      document_sign_envelopes: envelopesTable,
      document_sign_fields: fieldsTable,
      document_sign_values: valuesTable,
      document_sign_events: eventsTable,
      studios: studiosTable,
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
        remove: async () => ({ error: null }),
      }),
    },
  }),
}));

vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => "test-agent" }),
}));

const SIGNED_BYTES = new Uint8Array([1, 2, 3]);

const applySigningFieldsMock = vi.fn();
// Internally consistent with production's real sha256Hex(bytes) invariant --
// SIGNED_BYTES happens to share SOURCE_BYTES' content, so CORRECT_SOURCE_SHA256
// is also the correct hash of these signed bytes.
applySigningFieldsMock.mockResolvedValue({ bytes: SIGNED_BYTES, sha256: CORRECT_SOURCE_SHA256 });

vi.mock("@/lib/documents/pdf", async () => {
  // sha256Hex is kept as the REAL implementation (not stubbed) so the new
  // BR-3D2c1 source-hash check exercises genuine SHA-256 computation over
  // the fake blob's real bytes, not a hard-coded string.
  const actual = await vi.importActual<typeof import("@/lib/documents/pdf")>(
    "@/lib/documents/pdf",
  );
  return {
    ...actual,
    applySigningFields: (...args: unknown[]) => applySigningFieldsMock(...args),
  };
});

vi.mock("@/lib/documents/public-signing-security", () => ({
  serverActionIp: async () => "127.0.0.1",
  consumePublicSigningRateLimit: async () => ({ allowed: true, retryAfterSeconds: 60 }),
}));

vi.mock("@/lib/notifications/outbound", () => ({
  queueOutboundDelivery: vi.fn(async () => {}),
}));

vi.mock("@/lib/notifications/email-branding", () => ({
  renderStudioBrandedEmail: () => "",
}));

const advanceEventSigningCheckpointMock = vi.fn();

vi.mock("@/lib/documents/event-signing", () => ({
  advanceEventSigningCheckpoint: (...args: unknown[]) => advanceEventSigningCheckpointMock(...args),
  normalizeSigningReturnUrl: () => null,
}));

const redirectMock = vi.fn((url: string) => {
  // Genuinely NEXT_REDIRECT-shaped, matching the exact format Next's real
  // redirect() produces: "NEXT_REDIRECT;<type>;<destination>;<statusCode>;"
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;push;${url};307;`;
  throw error;
});

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    redirect: (url: string) => redirectMock(url),
    // unstable_rethrow is intentionally the REAL implementation (not
    // overridden) -- these tests exist specifically to prove it correctly
    // detects the mocked redirect signal above.
  };
});

const { completeSigningAction } = await import("@/app/sign/[token]/actions");

function seedEnvelope(overrides: Row = {}) {
  const row: Row = {
    id: ENVELOPE_ID,
    token_hash: hashSigningToken(TOKEN),
    studio_id: STUDIO_ID,
    title: "Test Waiver",
    signer_name: "Jane Doe",
    signer_email: null,
    status: "sent",
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    source_bucket: "document-files",
    source_path: `studios/${STUDIO_ID}/envelopes/${ENVELOPE_ID}/source.pdf`,
    source_sha256: CORRECT_SOURCE_SHA256,
    return_url: null,
    context_type: "event_checkout",
    context_id: "checkpoint-1",
    sequence_group_id: "checkpoint-1",
    sequence_position: 1,
    sequence_total: 2,
    event_signing_checkpoint_id: "checkpoint-1",
    ...overrides,
  };
  envelopesTable.rows.push(row);
  return row;
}

function buildFormData() {
  const fd = new FormData();
  fd.set("token", TOKEN);
  fd.set("signerName", "Jane Doe");
  fd.set("timezone", "America/New_York");
  fd.set("consent", "on");
  fd.set(`field_${FIELD_ID}`, "Jane Doe");
  return fd;
}

beforeEach(() => {
  envelopesTable = new FakeTable();
  fieldsTable = new FakeTable();
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
  valuesTable = new FakeTable();
  eventsTable = new FakeTable();
  studiosTable = new FakeTable();

  seedEnvelope();

  redirectMock.mockClear();
  advanceEventSigningCheckpointMock.mockReset();
  applySigningFieldsMock.mockClear();
  uploadMock.mockClear();
  uploadShouldThrowIfCalled = false;
});

async function expectRedirectTo(promise: Promise<unknown>, urlSubstring: string) {
  await expect(promise).rejects.toMatchObject({
    digest: expect.stringContaining(urlSubstring),
  });
}

describe("completeSigningAction -- BR-3D2c1 source-hash verification", () => {
  it("source bytes matching the persisted hash proceed to normal completion", async () => {
    advanceEventSigningCheckpointMock.mockResolvedValue({ kind: "next", url: "https://app.example.com/sign/next" });

    await expectRedirectTo(completeSigningAction(buildFormData()), "https://app.example.com/sign/next");

    expect(applySigningFieldsMock).toHaveBeenCalledTimes(1);
    // The exact bytes handed to applySigningFields are the exact bytes that were hashed and compared --
    // proven by byte-for-byte equality, not object identity, matching the FakeBlob's real downloaded content.
    const passedBytes = applySigningFieldsMock.mock.calls[0][0].sourceBytes as Uint8Array;
    expect(Array.from(passedBytes)).toEqual(Array.from(SOURCE_BYTES));
    expect(envelopesTable.rows.find((r) => r.id === ENVELOPE_ID)?.status).toBe("completed");
  });

  it("a source-hash mismatch fails closed using the existing generic completion_failed redirect, before any downstream write", async () => {
    envelopesTable.rows = [];
    seedEnvelope({ source_sha256: "0000000000000000000000000000000000000000000000000000000000000000" });
    uploadShouldThrowIfCalled = true;

    await expectRedirectTo(
      completeSigningAction(buildFormData()),
      `/sign/${encodeURIComponent(TOKEN)}?error=completion_failed`,
    );

    expect(applySigningFieldsMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(valuesTable.rows).toHaveLength(0);
    expect(envelopesTable.rows.find((r) => r.id === ENVELOPE_ID)?.status).toBe("sent");
  });

  it("on success, the persisted signed_sha256 equals sha256Hex of the exact bytes uploaded to signed storage", async () => {
    advanceEventSigningCheckpointMock.mockResolvedValue({ kind: "next", url: "https://app.example.com/sign/next" });

    await expectRedirectTo(completeSigningAction(buildFormData()), "https://app.example.com/sign/next");

    const uploadedBytes = uploadMock.mock.calls[0][1] as Uint8Array;
    const persisted = envelopesTable.rows.find((r) => r.id === ENVELOPE_ID);
    expect(persisted?.signed_sha256).toBe(sha256Hex(uploadedBytes));
  });
});

describe("completeSigningAction -- BR-3D2c2 consent evidence correctness", () => {
  it("persists the complete canonical consent text byte-for-byte, including the previously-omitted policy sentence", async () => {
    advanceEventSigningCheckpointMock.mockResolvedValue({ kind: "next", url: "https://app.example.com/sign/next" });

    await expectRedirectTo(completeSigningAction(buildFormData()), "https://app.example.com/sign/next");

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

describe("completeSigningAction -- event_checkout continuation (redirect-swallowing regression)", () => {
  it("first-of-two waiver completion advances to the next waiver -- the redirect signal propagates, not swallowed", async () => {
    const nextUrl = "https://app.example.com/sign/next-token-abc";
    advanceEventSigningCheckpointMock.mockResolvedValue({ kind: "next", url: nextUrl });

    await expectRedirectTo(completeSigningAction(buildFormData()), nextUrl);

    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith(nextUrl);
  });

  it("final waiver completion advances to the payment continuation path", async () => {
    const resumeUrl =
      "https://app.example.com/api/events/cart/resume-after-signing?checkpointId=cp-1&orderId=order-1&proof=abc";
    advanceEventSigningCheckpointMock.mockResolvedValue({ kind: "complete", url: resumeUrl });

    await expectRedirectTo(completeSigningAction(buildFormData()), resumeUrl);

    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith(resumeUrl);
  });

  it("a genuine application failure still logs and redirects to error=event_checkout_continuation_failed", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    advanceEventSigningCheckpointMock.mockRejectedValue(
      new Error("Event signing checkpoint was not found."),
    );

    await expectRedirectTo(
      completeSigningAction(buildFormData()),
      `/sign/${encodeURIComponent(TOKEN)}?error=event_checkout_continuation_failed`,
    );

    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Event signing continuation failed",
      "Event signing checkpoint was not found.",
    );

    consoleErrorSpy.mockRestore();
  });

  it("successful continuation never falls through to the error redirect", async () => {
    const nextUrl = "https://app.example.com/sign/next-token-xyz";
    advanceEventSigningCheckpointMock.mockResolvedValue({ kind: "next", url: nextUrl });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expectRedirectTo(completeSigningAction(buildFormData()), nextUrl);

    // The specific regression: redirect must never be called with the
    // error destination when the continuation actually succeeded, and the
    // "continuation failed" log must never fire for a success.
    for (const call of redirectMock.mock.calls) {
      expect(call[0]).not.toContain("error=event_checkout_continuation_failed");
    }
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      "Event signing continuation failed",
      expect.anything(),
    );

    consoleErrorSpy.mockRestore();
  });
});
