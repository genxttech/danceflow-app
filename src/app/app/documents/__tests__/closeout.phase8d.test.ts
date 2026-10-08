import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { FakeSupabase } from "@/lib/aria/__tests__/fakeSupabase";
import { chooseDocumentRecipient, type DocumentSignerOption } from "@/lib/documents/recipients";
import { signingPermissionWrite } from "@/lib/student-identity/lifecycle";

/**
 * Phase 8D -- Documents closeout.
 *   - signing permission: self signs; every NEW non-self link defaults to no signing until staff grant it; existing
 *     stored decisions are never rewritten; staff grant / revoke through an authorized, studio-scoped server action;
 *   - delivery recipient: the client stays owner + subject; the request goes to the client or ONE explicitly eligible
 *     linked signer (never guessed, never cross-client, never without can_sign_documents);
 *   - truthful statuses + only valid actions on the Documents Center; Decision #9 vocabulary;
 *   - one assignment flow (searchable picker, preselected client from the profile), field-layout reuse, save != send.
 * The database default (column FALSE + self trigger) is proven by sql-tests/test_T_phase8d_*.sql.
 */

const STUDIO = "studio-a";
const OTHER_STUDIO = "studio-b";
const CLIENT = "00000000-0000-4000-8000-0000000000d1";
const NO_EMAIL_CLIENT = "00000000-0000-4000-8000-0000000000d2";
const OTHER_CLIENT = "00000000-0000-4000-8000-0000000000d3";

class DocumentsFake extends FakeSupabase {
  files = new Map<string, Uint8Array>();
  auth = { getUser: async () => ({ data: { user: { id: "staff", email: "staff@example.test" } } }) };
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
      remove: async () => ({ error: null }),
      createSignedUrl: async () => ({ data: { signedUrl: "https://signed.example.test" }, error: null }),
    }),
  };
}

const state: { db: DocumentsFake; role: string; features: Set<string> } = {
  db: new DocumentsFake(),
  role: "studio_owner",
  features: new Set(["documents"]),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  unstable_rethrow: () => undefined,
}));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: STUDIO, studioRole: state.role, userId: "staff" }),
}));
vi.mock("@/lib/billing/access", () => ({
  requireStudioFeature: async (feature: string) => {
    if (!state.features.has(feature)) throw new Error(`redirect:/app/settings/billing?upgrade=${feature}`);
  },
  studioHasFeature: async (feature: string) => state.features.has(feature),
  studioIdHasFeature: async () => true,
}));
vi.mock("@/lib/notifications/expoPush", () => ({ sendMobilePushToUser: async () => undefined }));
vi.mock("@/lib/documents/template-pdf", () => ({
  renderTemplateVersionPdf: async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    return new Uint8Array(await pdf.save());
  },
}));

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

type LinkSeed = { id: string; user: string | null; client?: string; studio?: string; relationship: string; canSign: boolean; status?: string; email?: string | null };

function seed(links: LinkSeed[] = []) {
  const db = new DocumentsFake({
    studios: [
      { id: STUDIO, name: "Studio A", slug: "studio-a", public_name: null, public_logo_url: null },
      { id: OTHER_STUDIO, name: "Studio B", slug: "studio-b" },
    ],
    clients: [
      { id: CLIENT, studio_id: STUDIO, first_name: "Robin", last_name: "Lee", email: "robin@example.test", status: "active", is_independent_instructor: false },
      { id: NO_EMAIL_CLIENT, studio_id: STUDIO, first_name: "Kid", last_name: "Lee", email: null, status: "active", is_independent_instructor: false },
      { id: OTHER_CLIENT, studio_id: STUDIO, first_name: "Other", last_name: "Client", email: "other@example.test", status: "active", is_independent_instructor: false },
    ],
    profiles: links
      .filter((link) => link.user)
      .map((link) => ({ id: link.user, email: link.email === undefined ? `${link.user}@example.test` : link.email, full_name: `${link.user} name` })),
    client_account_links: links.map((link) => ({
      id: link.id,
      user_id: link.user,
      client_id: link.client ?? NO_EMAIL_CLIENT,
      studio_id: link.studio ?? STUDIO,
      status: link.status ?? "linked",
      relationship_type: link.relationship,
      can_sign_documents: link.canSign,
      invited_email: link.email ?? null,
      created_at: "2026-01-01T00:00:00.000Z",
    })),
    document_templates: [
      { id: "tpl-1", studio_id: STUDIO, scope: "studio", is_active: true, current_version: 1, current_version_id: "ver-1", title: "Waiver", description: null, body: "Body", default_consent_text: null },
    ],
    document_template_versions: [{ id: "ver-1", template_id: "tpl-1", version_number: 1, title: "Waiver", description: null, body: "Body", consent_text: null }],
    document_assignments: [],
    document_sign_envelopes: [],
    document_sign_fields: [],
    document_sign_events: [],
  });
  state.db = db;
  return db;
}

beforeEach(() => {
  state.role = "studio_owner";
  state.features = new Set(["documents"]);
});

// ---------------------------------------------------------------------------------------------------------------
describe("signing-permission default (new links fail safe; existing decisions untouched)", () => {
  it.each(["guardian", "parent", "billing_contact", "dependent_manager", "dependent"] as const)(
    "a new %s link gets no signing permission unless staff grant it",
    (relationshipType) => {
      expect(signingPermissionWrite({ relationshipType, isNewRow: true })).toEqual({ can_sign_documents: false });
      expect(signingPermissionWrite({ relationshipType, isNewRow: true, explicitGrant: true })).toEqual({ can_sign_documents: true });
      // an existing row (an invitation being accepted, a reused link) keeps its stored decision
      expect(signingPermissionWrite({ relationshipType, isNewRow: false })).toEqual({});
    },
  );

  it("a self link always signs for itself", () => {
    expect(signingPermissionWrite({ relationshipType: "self", isNewRow: true })).toEqual({ can_sign_documents: true });
    expect(signingPermissionWrite({ relationshipType: "self", isNewRow: false })).toEqual({ can_sign_documents: true });
  });

  it("staff invitations: a new guardian invite is not a signer; an explicit grant is; self is", async () => {
    seed();
    const { createOrRefreshClientInvitation } = await import("@/lib/student-identity/lifecycle");
    await createOrRefreshClientInvitation({ studioId: STUDIO, clientId: NO_EMAIL_CLIENT, email: "g1@example.test", relationshipType: "guardian" });
    await createOrRefreshClientInvitation({ studioId: STUDIO, clientId: OTHER_CLIENT, email: "p1@example.test", relationshipType: "parent", grantDocumentSigning: true });
    await createOrRefreshClientInvitation({ studioId: STUDIO, clientId: CLIENT, email: "robin@example.test", relationshipType: "self" });
    const rows = state.db.rows("client_account_links");
    expect(rows.find((row) => row.invited_email === "g1@example.test")?.can_sign_documents).toBe(false);
    expect(rows.find((row) => row.invited_email === "p1@example.test")?.can_sign_documents).toBe(true);
    expect(rows.find((row) => row.invited_email === "robin@example.test")?.can_sign_documents).toBe(true);
  });

  it("re-targeting a client's open invitation to a different person never carries the previous grant", async () => {
    seed([{ id: "inv-1", user: null, relationship: "guardian", canSign: true, status: "invited", email: "granted@example.test" }]);
    const { createOrRefreshClientInvitation } = await import("@/lib/student-identity/lifecycle");
    // the single open invitation is reused for a different person (pre-existing reuse behaviour)
    await createOrRefreshClientInvitation({ studioId: STUDIO, clientId: NO_EMAIL_CLIENT, email: "billing@example.test", relationshipType: "billing_contact" });
    expect(state.db.rows("client_account_links")[0]).toMatchObject({ invited_email: "billing@example.test", relationship_type: "billing_contact", can_sign_documents: false });
    // re-sending to the SAME person keeps the stored decision
    seed([{ id: "inv-1", user: null, relationship: "guardian", canSign: true, status: "invited", email: "granted@example.test" }]);
    await createOrRefreshClientInvitation({ studioId: STUDIO, clientId: NO_EMAIL_CLIENT, email: "granted@example.test", relationshipType: "guardian" });
    expect(state.db.rows("client_account_links")[0]).toMatchObject({ invited_email: "granted@example.test", can_sign_documents: true });
  });

  it("accepting / re-sending an existing non-self invitation never rewrites the stored decision", async () => {
    seed([
      { id: "inv-granted", user: null, relationship: "guardian", canSign: true, status: "invited", email: "granted@example.test" },
      { id: "inv-denied", user: null, relationship: "billing_contact", canSign: false, status: "invited", email: "denied@example.test" },
    ]);
    const { createOrRefreshClientInvitation, linkExistingClientAccount } = await import("@/lib/student-identity/lifecycle");
    await createOrRefreshClientInvitation({ studioId: STUDIO, clientId: NO_EMAIL_CLIENT, email: "granted@example.test", relationshipType: "guardian" });
    await linkExistingClientAccount({ studioId: STUDIO, clientId: NO_EMAIL_CLIENT, userId: "acct-denied", invitedEmail: "denied@example.test", relationshipType: "billing_contact" });
    const row = (id: string) => state.db.rows("client_account_links").find((candidate) => candidate.id === id)!;
    expect(row("inv-granted").can_sign_documents).toBe(true);
    expect(row("inv-denied")).toMatchObject({ status: "linked", can_sign_documents: false });
  });

  it("a brand-new linked non-self account is not a signer", async () => {
    seed();
    const { linkExistingClientAccount } = await import("@/lib/student-identity/lifecycle");
    await linkExistingClientAccount({ studioId: STUDIO, clientId: NO_EMAIL_CLIENT, userId: "acct-g", invitedEmail: "g@example.test", relationshipType: "guardian" });
    expect(state.db.rows("client_account_links")[0]).toMatchObject({ relationship_type: "guardian", can_sign_documents: false });
  });

  it("no link-creation path still writes signing TRUE for a non-self relationship", () => {
    const sources = [
      "src/lib/student-identity/lifecycle.ts",
      "src/app/api/student/marketplace/[catalogItemId]/checkout/route.ts",
    ].map((file) => readFileSync(path.join(process.cwd(), file), "utf8"));
    expect(sources[0]).not.toMatch(/can_sign_documents: true,/);
    // the marketplace path creates the buyer's own (self) link only
    expect(sources[1]).toMatch(/relationship_type: "self",[\s\S]{0,400}can_sign_documents: true,/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("staff signing-permission control (authorized, studio + client scoped)", () => {
  async function setPermission(values: Record<string, string>) {
    const { updateDocumentSigningPermissionAction } = await import("@/app/app/clients/[id]/actions");
    return outcome(() => updateDocumentSigningPermissionAction(form(values)));
  }
  const link = () => state.db.rows("client_account_links").find((row) => row.id === "lnk-g")!;

  it.each(["studio_owner", "studio_admin", "front_desk"])("%s can grant and revoke a guardian's signing permission", async (role) => {
    seed([{ id: "lnk-g", user: "g", relationship: "guardian", canSign: false }]);
    state.role = role;
    expect(await setPermission({ clientId: NO_EMAIL_CLIENT, linkId: "lnk-g", allow: "true" })).toContain("success=signing_permission_granted");
    expect(link().can_sign_documents).toBe(true);
    expect(await setPermission({ clientId: NO_EMAIL_CLIENT, linkId: "lnk-g", allow: "false" })).toContain("success=signing_permission_removed");
    expect(link().can_sign_documents).toBe(false);
  });

  it("an instructor cannot change signing permission", async () => {
    seed([{ id: "lnk-g", user: "g", relationship: "guardian", canSign: false }]);
    state.role = "instructor";
    expect(await setPermission({ clientId: NO_EMAIL_CLIENT, linkId: "lnk-g", allow: "true" })).toContain("error=unauthorized");
    expect(link().can_sign_documents).toBe(false);
  });

  it("refuses another studio's link, another client's link, a self link and a disconnected link", async () => {
    seed([
      { id: "lnk-g", user: "g", relationship: "guardian", canSign: false, studio: OTHER_STUDIO },
      { id: "lnk-other", user: "o", relationship: "guardian", canSign: false, client: OTHER_CLIENT },
      { id: "lnk-self", user: "s", relationship: "self", canSign: true },
      { id: "lnk-gone", user: "d", relationship: "parent", canSign: false, status: "disconnected" },
    ]);
    for (const linkId of ["lnk-g", "lnk-other", "lnk-self", "lnk-gone"]) {
      expect(await setPermission({ clientId: NO_EMAIL_CLIENT, linkId, allow: linkId === "lnk-self" ? "false" : "true" })).toContain(
        "error=signing_permission_update_failed",
      );
    }
    const rows = state.db.rows("client_account_links");
    expect(rows.map((row) => row.can_sign_documents)).toEqual([false, false, true, false]);
  });

  it("refuses a client of another studio", async () => {
    seed([{ id: "lnk-g", user: "g", relationship: "guardian", canSign: false }]);
    state.db.rows("clients").find((row) => row.id === NO_EMAIL_CLIENT)!.studio_id = OTHER_STUDIO;
    expect(await setPermission({ clientId: NO_EMAIL_CLIENT, linkId: "lnk-g", allow: "true" })).not.toContain("success=");
    expect(link().can_sign_documents).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("delivery recipient (client stays the owner; one explicit eligible signer)", () => {
  const signer = (linkId: string, relationshipType = "guardian"): DocumentSignerOption => ({
    linkId,
    relationshipType,
    email: `${linkId}@example.test`,
    name: `${linkId} name`,
  });

  it("A. client with email -> the client by default", () => {
    expect(chooseDocumentRecipient({ clientName: "Robin", clientEmail: "robin@example.test", eligible: [signer("g")] })).toEqual({
      ok: true,
      recipient: { kind: "client", email: "robin@example.test", name: "Robin" },
    });
  });
  it("B. no client email + one eligible signer -> that signer automatically", () => {
    const choice = chooseDocumentRecipient({ clientName: "Kid", clientEmail: null, eligible: [signer("g")] });
    expect(choice).toMatchObject({ ok: true, recipient: { kind: "linked", linkId: "g", email: "g@example.test" } });
  });
  it("C. no client email + several eligible -> staff must choose (never guessed)", () => {
    expect(chooseDocumentRecipient({ clientName: "Kid", clientEmail: null, eligible: [signer("g"), signer("p", "parent")] })).toEqual({ ok: false, reason: "choose_recipient" });
    expect(chooseDocumentRecipient({ clientName: "Kid", clientEmail: null, eligible: [signer("g"), signer("p")], requested: "p" })).toMatchObject({ ok: true, recipient: { linkId: "p" } });
  });
  it("D. no client email + none eligible -> blocked", () => {
    expect(chooseDocumentRecipient({ clientName: "Kid", clientEmail: "", eligible: [] })).toEqual({ ok: false, reason: "no_signer" });
  });
  it("E. client with email but staff deliberately choose an eligible signer", () => {
    expect(chooseDocumentRecipient({ clientName: "Robin", clientEmail: "robin@example.test", eligible: [signer("g")], requested: "g" })).toMatchObject({ ok: true, recipient: { kind: "linked", linkId: "g" } });
  });
  it("a requested link that is not eligible is refused", () => {
    expect(chooseDocumentRecipient({ clientName: "Robin", clientEmail: "robin@example.test", eligible: [signer("g")], requested: "someone-else" })).toEqual({ ok: false, reason: "not_eligible" });
  });

  it("eligibility excludes can_sign=false, other clients, other studios, inactive links and accounts without email", async () => {
    seed([
      { id: "ok", user: "u-ok", relationship: "guardian", canSign: true },
      { id: "no-perm", user: "u-np", relationship: "parent", canSign: false },
      { id: "other-client", user: "u-oc", relationship: "guardian", canSign: true, client: OTHER_CLIENT },
      { id: "other-studio", user: "u-os", relationship: "guardian", canSign: true, studio: OTHER_STUDIO },
      { id: "invited", user: null, relationship: "guardian", canSign: true, status: "invited", email: "inv@example.test" },
      { id: "no-email", user: "u-ne", relationship: "guardian", canSign: true, email: null },
    ]);
    const { loadEligibleDocumentSigners } = await import("@/lib/documents/recipients");
    expect((await loadEligibleDocumentSigners({ studioId: STUDIO, clientId: NO_EMAIL_CLIENT })).map((option) => option.linkId)).toEqual(["ok"]);
  });

  async function assign(clientId: string, extra: Record<string, string> = {}) {
    const { assignDocumentToClientAction } = await import("@/app/app/documents/actions");
    return outcome(() => assignDocumentToClientAction(form({ scope: "studio", templateId: "tpl-1", clientId, ...extra })));
  }

  it("no-email client with one authorized guardian: the guardian receives it, the client stays owner + subject", async () => {
    seed([{ id: "lnk-g", user: "guardian-1", relationship: "guardian", canSign: true }]);
    expect(await assign(NO_EMAIL_CLIENT)).toMatch(/^redirect:\/app\/documents\/sign\/.+\/edit\?source=template$/);
    const assignment = state.db.rows("document_assignments")[0];
    const envelope = state.db.rows("document_sign_envelopes")[0];
    expect(assignment).toMatchObject({ client_id: NO_EMAIL_CLIENT, assigned_to_email: "guardian-1@example.test", status: "pending" });
    expect(envelope).toMatchObject({ client_id: NO_EMAIL_CLIENT, signer_email: "guardian-1@example.test", signer_name: "guardian-1 name", status: "draft" });
    expect(state.db.rows("document_sign_events")[0].metadata).toMatchObject({ recipient_kind: "linked", recipient_link_id: "lnk-g", recipient_relationship_type: "guardian" });
  });

  it("client with email: the client receives it", async () => {
    seed();
    await assign(CLIENT);
    expect(state.db.rows("document_sign_envelopes")[0]).toMatchObject({ client_id: CLIENT, signer_email: "robin@example.test" });
  });

  it("several authorized guardians: blocked until staff choose; a chosen one is used", async () => {
    seed([
      { id: "lnk-g", user: "guardian-1", relationship: "guardian", canSign: true },
      { id: "lnk-p", user: "parent-1", relationship: "parent", canSign: true },
    ]);
    expect(await assign(NO_EMAIL_CLIENT)).toContain(encodeURIComponent("Choose who should receive this document"));
    expect(state.db.rows("document_sign_envelopes")).toHaveLength(0);
    await assign(NO_EMAIL_CLIENT, { recipient: "lnk-p" });
    expect(state.db.rows("document_sign_envelopes")[0]).toMatchObject({ signer_email: "parent-1@example.test", client_id: NO_EMAIL_CLIENT });
  });

  it("no authorized signer: blocked with a clear message (and the profile context is kept)", async () => {
    seed([{ id: "lnk-g", user: "guardian-1", relationship: "guardian", canSign: false }]);
    const result = await assign(NO_EMAIL_CLIENT, { assignContext: "client" });
    expect(result).toContain(encodeURIComponent("no one linked to them is allowed to sign documents"));
    expect(result).toContain(`assignClient=${NO_EMAIL_CLIENT}#assign-document`);
    expect(state.db.rows("document_assignments")).toHaveLength(0);
  });

  it("a guardian without can_sign_documents, or one linked to another client, cannot be chosen", async () => {
    seed([
      { id: "lnk-np", user: "guardian-np", relationship: "guardian", canSign: false, client: CLIENT },
      { id: "lnk-oc", user: "guardian-oc", relationship: "guardian", canSign: true, client: OTHER_CLIENT },
    ]);
    for (const recipient of ["lnk-np", "lnk-oc"]) {
      expect(await assign(CLIENT, { recipient })).toContain(encodeURIComponent("not allowed to sign documents for this client"));
    }
    expect(state.db.rows("document_sign_envelopes")).toHaveLength(0);
  });

  it("reuses the field layout already sent for this template version (staff still review before sending)", async () => {
    const db = seed();
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    db.rows("document_sign_envelopes").push({
      id: "env-prior",
      studio_id: STUDIO,
      template_version_id: "ver-1",
      source_kind: "template_version",
      status: "completed",
      page_count: 1,
      page_sizes: [{ pageNumber: 1, width: 612, height: 792 }],
      created_at: "2026-01-01T00:00:00.000Z",
    });
    db.rows("document_sign_fields").push(
      { envelope_id: "env-prior", field_type: "signature", page_number: 1, x: 0.1, y: 0.8, width: 0.5, height: 0.08, label: "Signature", required: true, sort_order: 10, placeholder_text: null, default_value: null },
      { envelope_id: "env-prior", field_type: "date", page_number: 1, x: 0.6, y: 0.8, width: 0.2, height: 0.05, label: "Date", required: true, sort_order: 20, placeholder_text: null, default_value: null },
    );
    const result = await assign(CLIENT);
    expect(result).toMatch(/edit\?source=template&layout=reused$/);
    const draft = db.rows("document_sign_envelopes").find((row) => row.id !== "env-prior")!;
    expect(draft.status).toBe("draft");
    expect(db.rows("document_sign_fields").filter((row) => row.envelope_id === draft.id).map((row) => row.field_type).sort()).toEqual(["date", "signature"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("assignment UX (searchable picker, one flow)", () => {
  it("client search is role + plan gated, studio scoped, bounded, and strips filter syntax", async () => {
    seed();
    const { searchAssignableClientsAction } = await import("@/app/app/documents/assign-actions");
    const results = await searchAssignableClientsAction("Rob");
    expect(results.length).toBeLessThanOrEqual(8);
    expect(results.every((client) => client.id !== undefined)).toBe(true);
    expect(await searchAssignableClientsAction("a")).toEqual([]); // too short: no roster dump
    state.role = "instructor";
    expect(await searchAssignableClientsAction("Robin")).toEqual([]);
    state.role = "studio_owner";
    state.features = new Set();
    expect(await searchAssignableClientsAction("Robin")).toEqual([]);
    const source = readFileSync(path.join(process.cwd(), "src/app/app/documents/assign-actions.ts"), "utf8");
    expect(source).toContain('.replace(/[^\\p{L}\\p{N}@.\\-\' ]/gu, "")');
    expect(source).toContain(".limit(8)");
  });

  it("recipient options: the client's email plus eligible signers only; another studio's client returns nothing", async () => {
    seed([{ id: "lnk-g", user: "guardian-1", relationship: "guardian", canSign: true }]);
    const { loadRecipientOptionsAction } = await import("@/app/app/documents/assign-actions");
    expect(await loadRecipientOptionsAction(NO_EMAIL_CLIENT)).toMatchObject({ clientEmail: null, signers: [{ linkId: "lnk-g", email: "guardian-1@example.test" }] });
    state.db.rows("clients").find((row) => row.id === NO_EMAIL_CLIENT)!.studio_id = OTHER_STUDIO;
    expect(await loadRecipientOptionsAction(NO_EMAIL_CLIENT)).toBeNull();
  });

  it("one assignment flow: template cards and the client-profile entry use the same form + server action", () => {
    const center = readFileSync(path.join(process.cwd(), "src/app/app/documents/page.tsx"), "utf8");
    const profile = readFileSync(path.join(process.cwd(), "src/app/app/clients/[id]/page.tsx"), "utf8");
    const form = readFileSync(path.join(process.cwd(), "src/app/app/documents/AssignDocumentForm.tsx"), "utf8");
    expect(center).toContain("<AssignDocumentForm templateId={template.id} />");
    expect(center).toContain("initialClient={assignClient}");
    expect(center).not.toMatch(/\.from\("clients"\)\s*\.select\("id, first_name, last_name, email, status"\)/); // no roster dump
    expect(profile).toContain("href={`/app/documents?assignClient=${typedClient.id}#assign-document`}");
    expect(form).toContain("action={assignDocumentToClientAction}");
    expect(form).toContain('role="combobox"');
    expect(form).toContain("Prepare document"); // creates a draft; sending is a separate, later step
    expect((center.match(/assignDocumentToClientAction/g) ?? []).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Decision #9 (waivers are Documents; the signing certificate is the evidence receipt)", () => {
  it("no separate waiver engine or Documents receipt object was introduced", () => {
    const migrations = readdirSync(path.join(process.cwd(), "src/lib/supabase/migrations"));
    const phase8d = migrations.filter((name) => name.startsWith("2026110"));
    expect(phase8d).toEqual(["20261101090000_client_account_links_signing_default.sql"]);
    const sql = readFileSync(path.join(process.cwd(), "src/lib/supabase/migrations", phase8d[0]), "utf8").toLowerCase();
    expect(sql).not.toMatch(/create table/);
    expect(sql).not.toMatch(/receipt|waiver/);
  });

  it("event waivers sign through the canonical envelope lifecycle", () => {
    const eventSigning = readFileSync(path.join(process.cwd(), "src/lib/documents/event-signing.ts"), "utf8");
    expect(eventSigning).toContain('.from("document_sign_envelopes").insert(');
    expect(eventSigning).toContain('context_type: "event_checkout"');
  });

  it("Documents surfaces say 'signing certificate' / 'signature record'; 'receipt' stays a payments word", () => {
    const files = [
      "src/app/app/documents/page.tsx",
      "src/app/app/documents/sign/[envelopeId]/page.tsx",
      "src/app/app/clients/[id]/documents/[signatureId]/page.tsx",
      "src/app/app/events/[id]/registrations/[registrationId]/signed-documents/[signatureId]/page.tsx",
    ].map((file) => readFileSync(path.join(process.cwd(), file), "utf8"));
    for (const source of files) expect(source).not.toMatch(/Signed Document Receipt|Signed receipts|signed receipts/);
    expect(files[0]).toContain(">Signing certificate</a>");
    expect(files[1]).toContain("Signing certificate");
    expect(files[2]).toContain("Legacy signature record");
    expect(files[3]).toContain("Legacy signature record");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("truthful statuses and only valid actions (Documents Center + request detail)", () => {
  type Form = { action: unknown; fields: Record<string, string> };
  type Rendered = { forms: Form[]; hrefs: string[]; text: string };

  function fieldsOf(node: unknown, fields: Record<string, string> = {}): Record<string, string> {
    if (Array.isArray(node)) {
      for (const child of node) fieldsOf(child, fields);
      return fields;
    }
    if (node && typeof node === "object" && "props" in node) {
      const props = (node as { props: Record<string, unknown> }).props;
      if (typeof props.name === "string" && typeof props.value === "string") fields[props.name] = props.value;
      fieldsOf(props.children, fields);
    }
    return fields;
  }

  function walk(node: unknown, out: Rendered = { forms: [], hrefs: [], text: "" }): Rendered {
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
        if (name === "AssignDocumentForm") return out;
        if (name !== "LinkComponent" && name !== "Link") return walk((element.type as (props: unknown) => unknown)(element.props), out);
      }
      const props = element.props;
      if (typeof props.action === "function") out.forms.push({ action: props.action, fields: fieldsOf(props.children) });
      if (typeof props.href === "string") out.hrefs.push(props.href);
      walk(props.children, out);
    }
    return out;
  }

  const FUTURE = "2099-01-01T00:00:00.000Z";
  function seedStates() {
    const db = seed();
    Object.assign(db.rows("document_templates")[0], {
      organizer_id: null,
      document_type: "waiver",
      applies_to: "manual",
      requires_signature: true,
      is_required: true,
      updated_at: "2026-01-01T00:00:00.000Z",
      document_template_versions: [{ id: "ver-1", version_number: 1, title: "Waiver", created_at: "2026-01-01T00:00:00.000Z" }],
    });
    const envelope = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
      id, studio_id: STUDIO, title: "Waiver", signer_name: "Robin", signer_email: "robin@example.test", status,
      expires_at: FUTURE, created_at: "2026-01-01T00:00:00.000Z", document_sign_fields: [{ id: "f" }], superseded_by_envelope_id: null, ...extra,
    });
    const assignment = (id: string, envelopeId: string, extra: Record<string, unknown> = {}) => ({
      id, template_id: "tpl-1", client_id: CLIENT, status: "pending", assigned_at: "2026-01-01T00:00:00.000Z", due_at: null,
      assigned_to_email: "robin@example.test", sign_envelope_id: envelopeId, event_signing_checkpoint_id: null,
      document_templates: { title: "Waiver", is_required: true }, clients: { first_name: "Robin", last_name: "Lee", email: "robin@example.test" }, ...extra,
    });
    db.tables.document_sign_envelopes = [
      envelope("env-open", "sent"),
      envelope("env-over", "viewed"),
      envelope("env-exp", "expired"),
      envelope("env-dec", "declined"),
      envelope("env-prep", "draft"),
      envelope("env-done", "completed"),
      envelope("env-old", "void", { superseded_by_envelope_id: "env-open" }),
      // still "sent" in the database but past its link expiry: effectively expired
      envelope("env-lapsed", "sent", { expires_at: "2001-01-01T00:00:00.000Z" }),
    ];
    db.tables.document_assignments = [
      assignment("a-open", "env-open"),
      assignment("a-over", "env-over", { due_at: "2026-01-02T00:00:00.000Z" }),
      assignment("a-exp", "env-exp"),
      assignment("a-dec", "env-dec"),
      assignment("a-prep", "env-prep"),
      assignment("a-done", "env-done", { status: "signed" }),
    ];
    return db;
  }

  async function center() {
    const { default: DocumentsPage } = await import("@/app/app/documents/page");
    return walk(await DocumentsPage({ searchParams: Promise.resolve({}) }));
  }

  it("each pending row shows its shared-contract label and only its valid actions", async () => {
    seedStates();
    const page = await center();
    const docs = await import("@/app/app/documents/actions");
    const formsFor = (assignmentId: string) => page.forms.filter((entry) => entry.fields.assignmentId === assignmentId).map((entry) => entry.action);

    for (const label of ["Needs signature", "Past due", "Expired", "Declined", "Being prepared"]) expect(page.text).toContain(label);

    // actionable: reminder + due date + waive / void
    for (const id of ["a-open", "a-over"]) {
      expect(formsFor(id)).toEqual(expect.arrayContaining([docs.sendDocumentReminderAction, docs.updateDocumentAssignmentDueDateAction, docs.waiveDocumentAssignmentAction, docs.voidDocumentAssignmentAction]));
    }
    // expired / declined: revise (replacement) -- no reminder, no due-date change, never a sign action
    for (const [id, envelopeId] of [["a-exp", "env-exp"], ["a-dec", "env-dec"]]) {
      expect(formsFor(id)).not.toContain(docs.sendDocumentReminderAction);
      expect(formsFor(id)).not.toContain(docs.updateDocumentAssignmentDueDateAction);
      expect(page.hrefs).toContain(`/app/documents/sign/${envelopeId}`);
    }
    // being prepared: finish the fields first
    expect(formsFor("a-prep")).not.toContain(docs.sendDocumentReminderAction);
    expect(page.hrefs).toContain("/app/documents/sign/env-prep/edit");
  });

  it("the requests table uses user-facing labels, never raw statuses, and no resend on a dead link", async () => {
    seedStates();
    const page = await center();
    const sign = await import("@/app/app/documents/sign/actions");
    for (const label of ["Signed", "Being prepared", "Replaced by revision"]) expect(page.text).toContain(label);
    // raw envelope statuses never appear as status text ("completed" also appears in the page's own description copy)
    for (const raw of [" sent ", " viewed ", " started ", " draft ", " void "]) expect(page.text).not.toContain(raw);
    const resendTargets = page.forms.filter((entry) => entry.action === sign.resendSignEnvelopeAction).map((entry) => entry.fields.envelopeId).sort();
    expect(resendTargets).toEqual(["env-open", "env-over"]);
  });

  it("the request detail page shows the same vocabulary", async () => {
    seedStates();
    state.db.rows("document_sign_envelopes").find((row) => row.id === "env-exp")!.signer_name = "Robin";
    const { default: Detail } = await import("@/app/app/documents/sign/[envelopeId]/page");
    const page = walk(await Detail({ params: Promise.resolve({ envelopeId: "env-exp" }), searchParams: Promise.resolve({}) }));
    expect(page.text).toContain("Expired");
    const done = walk(await Detail({ params: Promise.resolve({ envelopeId: "env-done" }), searchParams: Promise.resolve({}) }));
    expect(done.text).toContain("Signed");
    expect(done.text).toContain("Signing certificate");
  });
});
