import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * LAUNCH-SEC-1B Stage 1: client photo uploads go through the service-role
 * storage client only after requireClientEditAccess(), keep the existing file
 * validation, naming convention and upsert:false, and store the canonical bare
 * object path (never a public URL) so the bucket can be made private.
 */

vi.mock("server-only", () => ({}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

const events: string[] = [];
const requireClientEditAccessMock = vi.fn();

vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireClientEditAccess: async (...args: unknown[]) => {
    events.push("guard");
    return requireClientEditAccessMock(...args);
  },
}));

type UploadCall = { bucket: string; path: string; file: File; options: Record<string, unknown> };
const uploadCalls: UploadCall[] = [];
let uploadError: { message: string } | null = null;
const createAdminClientMock = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: (...args: unknown[]) => createAdminClientMock(...args),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co";

const { createClientAction, updateClientAction } = await import("../actions");
const { parseClientPhotoObjectPath } = await import("@/lib/clients/clientPhotoAccess");

const STUDIO = "11111111-2222-4333-8444-555555555555";
const EXISTING_CLIENT = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const DENIAL_MESSAGE = "You do not have permission to manage clients.";

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngFile(name = "headshot.png") {
  return new File([new Uint8Array([...PNG_HEADER, 0, 0, 0, 0])], name, { type: "image/png" });
}

function digestUrl(error: unknown) {
  const digest = (error as { digest?: string })?.digest ?? "";
  return digest.match(/^NEXT_REDIRECT;replace;([^;]*);/)?.[1] ?? "";
}

function createFormData(file?: File) {
  const formData = new FormData();
  formData.set("firstName", "Jane");
  formData.set("lastName", "Doe");
  if (file) formData.set("clientPhoto", file);
  return formData;
}

function updateFormData(file?: File) {
  const formData = createFormData(file);
  formData.set("clientId", EXISTING_CLIENT);
  return formData;
}

function makeCreateSupabase() {
  const inserts: Record<string, unknown>[] = [];
  return {
    inserts,
    storage: {
      from() {
        throw new Error("tenant storage client must not be used for client photos");
      },
    },
    from(table: string) {
      if (table !== "clients") throw new Error(`UNEXPECTED_TABLE_ACCESS:${table}`);
      return {
        insert: async (row: Record<string, unknown>) => {
          events.push("insert");
          inserts.push(row);
          return { error: null };
        },
      };
    },
  };
}

function makeUpdateSupabase() {
  const updates: Record<string, unknown>[] = [];
  return {
    updates,
    storage: {
      from() {
        throw new Error("tenant storage client must not be used for client photos");
      },
    },
    from(table: string) {
      if (table !== "clients") throw new Error(`UNEXPECTED_TABLE_ACCESS:${table}`);
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({ data: { id: EXISTING_CLIENT }, error: null }),
            }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          events.push("update");
          updates.push(payload);
          return { eq: () => ({ eq: async () => ({ error: null }) }) };
        },
      };
    },
  };
}

function authorize(supabase: unknown, role = "studio_owner") {
  requireClientEditAccessMock.mockResolvedValue({
    supabase,
    studioId: STUDIO,
    user: { id: "user-1" },
    studioRole: role,
    isPlatformAdmin: false,
  });
}

beforeEach(() => {
  events.length = 0;
  uploadCalls.length = 0;
  uploadError = null;
  requireClientEditAccessMock.mockReset();
  createAdminClientMock.mockReset();
  createAdminClientMock.mockImplementation(() => {
    events.push("admin");
    return {
      storage: {
        from(bucket: string) {
          return {
            async upload(path: string, file: File, options: Record<string, unknown>) {
              events.push("upload");
              uploadCalls.push({ bucket, path, file, options });
              return { data: uploadError ? null : { path }, error: uploadError };
            },
            getPublicUrl() {
              throw new Error("getPublicUrl must never be used for client photos");
            },
          };
        },
      },
    };
  });
});

describe("createClientAction photo upload", () => {
  it.each(["studio_owner", "studio_admin", "front_desk"])(
    "%s uploads via the admin client after the gate and stores the bare object path",
    async (role) => {
      const supabase = makeCreateSupabase();
      authorize(supabase, role);
      const file = pngFile();

      const result = await createClientAction({ error: "" }, createFormData(file)).catch((e) => e);

      expect(digestUrl(result)).toMatch(/^\/app\/clients\//);
      expect(events).toEqual(["guard", "admin", "upload", "insert"]);
      expect(uploadCalls).toHaveLength(1);

      const [call] = uploadCalls;
      const insertedId = supabase.inserts[0].id as string;
      expect(call.bucket).toBe("client-photos");
      expect(call.path).toMatch(new RegExp(`^${STUDIO}/${insertedId}/[0-9]{13}-${UUID}\\.png$`));
      expect(call.file).toBe(file);
      expect(call.options).toEqual({ cacheControl: "3600", contentType: "image/png", upsert: false });

      const stored = supabase.inserts[0].photo_url as string;
      expect(stored).toBe(call.path);
      expect(stored).not.toMatch(/^https?:/);
      expect(parseClientPhotoObjectPath(stored)).toEqual({
        path: stored,
        studioId: STUDIO,
        clientId: insertedId,
      });
    },
  );

  it("no photo: no admin client, no upload, photo_url stored as null", async () => {
    const supabase = makeCreateSupabase();
    authorize(supabase);

    await createClientAction({ error: "" }, createFormData()).catch((e) => e);

    expect(createAdminClientMock).not.toHaveBeenCalled();
    expect(uploadCalls).toEqual([]);
    expect(supabase.inserts[0].photo_url).toBeNull();
  });

  it.each(["instructor", "independent_instructor", "organizer_owner", "organizer_admin", "organizer_staff"])(
    "%s is rejected before any storage access",
    async () => {
      requireClientEditAccessMock.mockImplementation(() => {
        throw new Error(DENIAL_MESSAGE);
      });

      const result = await createClientAction({ error: "" }, createFormData(pngFile()));

      expect(result).toEqual({ error: DENIAL_MESSAGE });
      expect(createAdminClientMock).not.toHaveBeenCalled();
      expect(uploadCalls).toEqual([]);
    },
  );

  it.each([
    ["disallowed type", new File([new Uint8Array([0x47, 0x49, 0x46, 0x38])], "a.gif", { type: "image/gif" }), "must be an allowed file type"],
    ["contents not matching type", new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])], "a.png", { type: "image/png" }), "contents do not match"],
    ["mismatched extension", new File([new Uint8Array([...PNG_HEADER, 0])], "a.exe", { type: "image/png" }), "extension"],
    ["oversized file", new File([new Uint8Array([...PNG_HEADER, ...new Uint8Array(5 * 1024 * 1024)])], "a.png", { type: "image/png" }), "or smaller"],
  ])("existing validation still rejects a %s before any storage access", async (_label, file, message) => {
    const supabase = makeCreateSupabase();
    authorize(supabase);

    const result = await createClientAction({ error: "" }, createFormData(file));

    expect((result as { error: string }).error).toContain(message);
    expect(createAdminClientMock).not.toHaveBeenCalled();
    expect(supabase.inserts).toEqual([]);
  });

  it("a non-UUID studio context never uploads (path would not be signable)", async () => {
    const supabase = makeCreateSupabase();
    requireClientEditAccessMock.mockResolvedValue({
      supabase,
      studioId: "studio-1",
      user: { id: "user-1" },
      studioRole: "studio_owner",
      isPlatformAdmin: false,
    });

    const result = await createClientAction({ error: "" }, createFormData(pngFile()));

    expect(result).toEqual({ error: "Client photo upload failed." });
    expect(createAdminClientMock).not.toHaveBeenCalled();
    expect(supabase.inserts).toEqual([]);
  });

  it("a storage upload error stops before the client insert", async () => {
    const supabase = makeCreateSupabase();
    authorize(supabase);
    uploadError = { message: "The resource already exists" };

    const result = await createClientAction({ error: "" }, createFormData(pngFile()));

    expect((result as { error: string }).error).toMatch(/^Client photo upload failed/);
    expect(supabase.inserts).toEqual([]);
  });
});

describe("updateClientAction photo upload", () => {
  it("uploads after the gate and stores the bare object path for the existing client", async () => {
    const supabase = makeUpdateSupabase();
    authorize(supabase, "front_desk");

    const result = await updateClientAction({ error: "" }, updateFormData(pngFile())).catch((e) => e);

    expect(digestUrl(result)).toMatch(/^\/app\/clients\//);
    expect(events).toEqual(["guard", "admin", "upload", "update"]);
    const [call] = uploadCalls;
    expect(call.bucket).toBe("client-photos");
    expect(call.path).toMatch(new RegExp(`^${STUDIO}/${EXISTING_CLIENT}/[0-9]{13}-${UUID}\\.png$`));
    expect(call.options.upsert).toBe(false);
    expect(supabase.updates[0].photo_url).toBe(call.path);
  });

  it("without a new photo leaves photo_url untouched and never creates the admin client", async () => {
    const supabase = makeUpdateSupabase();
    authorize(supabase);

    await updateClientAction({ error: "" }, updateFormData()).catch((e) => e);

    expect(createAdminClientMock).not.toHaveBeenCalled();
    expect(supabase.updates[0]).not.toHaveProperty("photo_url");
  });

  it("denied roles are rejected before any storage access", async () => {
    requireClientEditAccessMock.mockImplementation(() => {
      throw new Error(DENIAL_MESSAGE);
    });

    const result = await updateClientAction({ error: "" }, updateFormData(pngFile()));

    expect(result).toEqual({ error: DENIAL_MESSAGE });
    expect(createAdminClientMock).not.toHaveBeenCalled();
    expect(uploadCalls).toEqual([]);
  });
});
