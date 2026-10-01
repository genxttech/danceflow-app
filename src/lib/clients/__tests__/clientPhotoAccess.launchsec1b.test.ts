import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * LAUNCH-SEC-1B Stage 1: client photos are rendered through short-lived
 * signed URLs created on the server, so the client-photos bucket can be made
 * private. These tests prove the stored-value parser only accepts this
 * project's legacy public URL or the canonical bare object path, and that the
 * signer only signs after an exact studio/client match, never falls back to a
 * public URL, and treats legacy URLs and bare paths identically.
 */

vi.mock("server-only", () => ({}));

type SignResult = { data: { signedUrl: string } | null; error: { message: string } | null };

const storageCalls: { bucket: string; path: string; ttl: number }[] = [];
let signResult: SignResult = { data: { signedUrl: "https://signed.test/object" }, error: null };
let signThrows = false;
const createAdminClientMock = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: (...args: unknown[]) => createAdminClientMock(...args),
}));

const PROJECT_URL = "https://abcdefghijklmnopqrst.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_URL = PROJECT_URL;

const {
  CLIENT_PHOTO_BUCKET,
  CLIENT_PHOTO_SIGNED_URL_TTL_SECONDS,
  createClientPhotoSignedUrl,
  parseClientPhotoObjectPath,
} = await import("../clientPhotoAccess");

const STUDIO = "11111111-2222-4333-8444-555555555555";
const CLIENT = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const OTHER_STUDIO = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const OTHER_CLIENT = "12345678-90ab-4cde-8f01-234567890abc";
const OBJECT_UUID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const FILE = `1759276800000-${OBJECT_UUID}.jpg`;
const PATH = `${STUDIO}/${CLIENT}/${FILE}`;
const LEGACY_PREFIX = `${PROJECT_URL}/storage/v1/object/public/client-photos/`;
const LEGACY_URL = `${LEGACY_PREFIX}${PATH}`;

beforeEach(() => {
  storageCalls.length = 0;
  signResult = { data: { signedUrl: "https://signed.test/object" }, error: null };
  signThrows = false;
  process.env.NEXT_PUBLIC_SUPABASE_URL = PROJECT_URL;
  createAdminClientMock.mockReset();
  createAdminClientMock.mockImplementation(() => ({
    storage: {
      from(bucket: string) {
        return {
          async createSignedUrl(path: string, ttl: number) {
            storageCalls.push({ bucket, path, ttl });
            if (signThrows) throw new Error("network down");
            return signResult;
          },
          getPublicUrl() {
            throw new Error("getPublicUrl must never be used for client photos");
          },
        };
      },
    },
  }));
});

describe("parseClientPhotoObjectPath — accepted forms", () => {
  it.each(["jpg", "jpeg", "png", "webp"])("accepts a canonical bare path with .%s", (ext) => {
    const path = `${STUDIO}/${CLIENT}/1759276800000-${OBJECT_UUID}.${ext}`;
    expect(parseClientPhotoObjectPath(path)).toEqual({ path, studioId: STUDIO, clientId: CLIENT });
  });

  it("accepts the exact legacy public URL for this project and bucket", () => {
    expect(parseClientPhotoObjectPath(LEGACY_URL)).toEqual({
      path: PATH,
      studioId: STUDIO,
      clientId: CLIENT,
    });
  });

  it("legacy URL and bare path resolve to the identical object path", () => {
    expect(parseClientPhotoObjectPath(LEGACY_URL)?.path).toBe(parseClientPhotoObjectPath(PATH)?.path);
  });
});

describe("parseClientPhotoObjectPath — rejected values", () => {
  const rejected: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["non-string", 42],
    ["wrong host", `https://zyxwvutsrqponmlkjihg.supabase.co/storage/v1/object/public/client-photos/${PATH}`],
    ["host suffix trick", `${PROJECT_URL}.evil.test/storage/v1/object/public/client-photos/${PATH}`],
    ["userinfo trick", `https://abcdefghijklmnopqrst.supabase.co@evil.test/storage/v1/object/public/client-photos/${PATH}`],
    ["wrong scheme", `${LEGACY_URL.replace("https://", "http://")}`],
    ["wrong bucket", `${PROJECT_URL}/storage/v1/object/public/other-bucket/${PATH}`],
    ["bucket prefix trick", `${PROJECT_URL}/storage/v1/object/public/client-photos-x/${PATH}`],
    ["signed-object URL", `${PROJECT_URL}/storage/v1/object/sign/client-photos/${PATH}`],
    ["authenticated-object URL", `${PROJECT_URL}/storage/v1/object/authenticated/client-photos/${PATH}`],
    ["foreign absolute URL", `https://example.test/${PATH}`],
    ["protocol-relative URL", `//abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/client-photos/${PATH}`],
    ["javascript: scheme", `javascript:${PATH}`],
    ["data: scheme", `data:image/png;base64,${PATH}`],
    ["dot-dot traversal", `${STUDIO}/../${CLIENT}/${FILE}`],
    ["dot-dot inside legacy URL", `${LEGACY_PREFIX}${STUDIO}/../${STUDIO}/${CLIENT}/${FILE}`],
    ["encoded traversal", `${STUDIO}/%2e%2e/${CLIENT}/${FILE}`],
    ["encoded slash", `${STUDIO}%2F${CLIENT}/${FILE}`],
    ["encoded path in legacy URL", `${LEGACY_PREFIX}${STUDIO}%2F${CLIENT}%2F${FILE}`],
    ["malformed percent encoding", `${STUDIO}/${CLIENT}/%zz${FILE}`],
    ["extra segment", `${STUDIO}/${CLIENT}/extra/${FILE}`],
    ["missing client segment", `${STUDIO}/${FILE}`],
    ["missing file segment", `${STUDIO}/${CLIENT}`],
    ["leading slash", `/${PATH}`],
    ["double slash", `${STUDIO}//${CLIENT}/${FILE}`],
    ["backslash separator", `${STUDIO}\\${CLIENT}\\${FILE}`],
    ["non-UUID studio", `studio-1/${CLIENT}/${FILE}`],
    ["non-UUID client", `${STUDIO}/client-1/${FILE}`],
    ["uppercase UUID (not normalized)", `${STUDIO}/${CLIENT.toUpperCase()}/${FILE}`],
    ["short timestamp", `${STUDIO}/${CLIENT}/175927680000-${OBJECT_UUID}.jpg`],
    ["non-numeric timestamp", `${STUDIO}/${CLIENT}/17592768000ab-${OBJECT_UUID}.jpg`],
    ["missing timestamp", `${STUDIO}/${CLIENT}/${OBJECT_UUID}.jpg`],
    ["malformed object UUID", `${STUDIO}/${CLIENT}/1759276800000-not-a-uuid.jpg`],
    ["unsupported extension", `${STUDIO}/${CLIENT}/1759276800000-${OBJECT_UUID}.gif`],
    ["uppercase extension", `${STUDIO}/${CLIENT}/1759276800000-${OBJECT_UUID}.JPG`],
    ["double extension", `${STUDIO}/${CLIENT}/1759276800000-${OBJECT_UUID}.jpg.exe`],
    ["extension suffix", `${STUDIO}/${CLIENT}/1759276800000-${OBJECT_UUID}.jpgx`],
    ["query on bare path", `${PATH}?download=1`],
    ["fragment on bare path", `${PATH}#x`],
    ["query on legacy URL", `${LEGACY_URL}?token=x`],
    ["fragment on legacy URL", `${LEGACY_URL}#x`],
    ["leading whitespace", ` ${PATH}`],
    ["trailing whitespace", `${PATH} `],
    ["trailing newline", `${PATH}\n`],
    ["overlong value", `${PATH}${"a".repeat(600)}`],
  ];

  it.each(rejected)("rejects %s", (_label, value) => {
    expect(parseClientPhotoObjectPath(value)).toBeNull();
  });

  it("rejects the legacy URL form when the project URL is not configured", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(parseClientPhotoObjectPath(LEGACY_URL)).toBeNull();
    expect(parseClientPhotoObjectPath(PATH)).not.toBeNull();
  });
});

describe("createClientPhotoSignedUrl", () => {
  it("signs the parsed path on the client-photos bucket with a 600 second TTL", async () => {
    expect(CLIENT_PHOTO_BUCKET).toBe("client-photos");
    expect(CLIENT_PHOTO_SIGNED_URL_TTL_SECONDS).toBe(600);

    const url = await createClientPhotoSignedUrl(PATH, { studioId: STUDIO, clientId: CLIENT });

    expect(url).toBe("https://signed.test/object");
    expect(storageCalls).toEqual([{ bucket: "client-photos", path: PATH, ttl: 600 }]);
  });

  it("legacy URL and bare path sign through the same mechanism and object", async () => {
    await createClientPhotoSignedUrl(LEGACY_URL, { studioId: STUDIO, clientId: CLIENT });
    await createClientPhotoSignedUrl(PATH, { studioId: STUDIO, clientId: CLIENT });

    expect(storageCalls).toEqual([
      { bucket: "client-photos", path: PATH, ttl: 600 },
      { bucket: "client-photos", path: PATH, ttl: 600 },
    ]);
  });

  it.each([
    ["another studio", { studioId: OTHER_STUDIO, clientId: CLIENT }],
    ["another client", { studioId: STUDIO, clientId: OTHER_CLIENT }],
    ["empty scope", { studioId: "", clientId: "" }],
  ])("does not sign when the path belongs to %s (no admin client created)", async (_label, scope) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const url = await createClientPhotoSignedUrl(PATH, scope);
    warn.mockRestore();

    expect(url).toBeNull();
    expect(createAdminClientMock).not.toHaveBeenCalled();
    expect(storageCalls).toEqual([]);
  });

  it.each([null, "", "https://example.test/photo.jpg", `${PATH}?x=1`])(
    "does not sign an invalid stored value (%s)",
    async (value) => {
      const url = await createClientPhotoSignedUrl(value, { studioId: STUDIO, clientId: CLIENT });
      expect(url).toBeNull();
      expect(createAdminClientMock).not.toHaveBeenCalled();
    },
  );

  it("returns null with no public fallback when signing returns an error", async () => {
    signResult = { data: null, error: { message: "Object not found" } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const url = await createClientPhotoSignedUrl(LEGACY_URL, { studioId: STUDIO, clientId: CLIENT });
    const logged = warn.mock.calls.flat().join(" ");
    warn.mockRestore();

    expect(url).toBeNull();
    expect(logged).toBe("client_photo_sign_failed");
    expect(logged).not.toContain(PATH);
  });

  it("returns null when signing throws or returns no URL", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    signThrows = true;
    expect(await createClientPhotoSignedUrl(PATH, { studioId: STUDIO, clientId: CLIENT })).toBeNull();
    signThrows = false;
    signResult = { data: null, error: null };
    expect(await createClientPhotoSignedUrl(PATH, { studioId: STUDIO, clientId: CLIENT })).toBeNull();
    warn.mockRestore();
  });

  it("returns null when the admin client cannot be created", async () => {
    createAdminClientMock.mockImplementation(() => {
      throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY.");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const url = await createClientPhotoSignedUrl(PATH, { studioId: STUDIO, clientId: CLIENT });
    const logged = warn.mock.calls.flat().join(" ");
    warn.mockRestore();

    expect(url).toBeNull();
    expect(logged).not.toContain("SERVICE_ROLE");
  });
});

describe("source invariants (active code)", () => {
  const root = process.cwd();
  const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");

  it("the signer module is server-only and never builds a public URL", () => {
    const source = read("src/lib/clients/clientPhotoAccess.ts");
    expect(source.startsWith('import "server-only";')).toBe(true);
    expect(source).not.toContain("getPublicUrl");
    expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("the signer is used only by the three server-rendered pages (no endpoint or action signs a browser path)", () => {
    const users = [
      "src/app/app/clients/[id]/page.tsx",
      "src/app/app/clients/[id]/edit/page.tsx",
      "src/app/app/client-identity/[token]/page.tsx",
    ];
    for (const path of users) {
      const source = read(path);
      expect(source).toContain('import { createClientPhotoSignedUrl } from "@/lib/clients/clientPhotoAccess";');
      expect(source).not.toMatch(/^"use (server|client)";/);
    }

    const actions = read("src/app/app/clients/actions.ts");
    expect(actions).not.toContain("createClientPhotoSignedUrl");
    expect(read("src/app/app/client-identity/[token]/actions.ts")).not.toContain("createClientPhotoSignedUrl");
  });

  it("active render paths only render the signed URL, never the stored photo value", () => {
    const detail = read("src/app/app/clients/[id]/page.tsx");
    expect(detail).toContain("src={clientPhotoSignedUrl}");
    expect(detail).not.toContain("src={typedClient.photo_url}");

    const qr = read("src/app/app/client-identity/[token]/page.tsx");
    expect(qr).toContain("src={clientPhotoSignedUrl}");
    expect(qr).not.toContain("src={typedClient.photo_url}");
    expect(qr.indexOf("createClientPhotoSignedUrl(typedClient.photo_url")).toBeGreaterThan(
      qr.indexOf('"get_client_by_qr_token_for_checkin"'),
    );

    const editPage = read("src/app/app/clients/[id]/edit/page.tsx");
    expect(editPage).toContain("<EditClientForm client={clientForForm} photoSignedUrl={photoSignedUrl} />");
    expect(editPage).toContain("const { photo_url: storedPhotoValue, ...clientForForm } = client as ClientRow;");

    const editForm = read("src/app/app/clients/[id]/edit/EditClientForm.tsx");
    expect(editForm).toContain("src={photoSignedUrl}");
    expect(editForm).not.toContain("photo_url");
  });

  it("upload stores the bare object path through the admin client, with no public URL", () => {
    const actions = read("src/app/app/clients/actions.ts");
    expect(actions).not.toContain("getPublicUrl");
    expect(actions).not.toMatch(/supabase\.storage/);
    expect(actions).toContain("const admin = createAdminClient();\n  const { error: uploadError } = await admin.storage");
    expect(actions).toContain("upsert: false,");
    expect(actions).toContain("return { path: photoPath, error: null as string | null };");
    expect(actions).toContain("photo_url: photoResult.path,");
    expect(actions).toContain("...(photoResult.path ? { photo_url: photoResult.path } : {})");
  });

  it("ClientEditForm.tsx is dead code: untouched and not imported by any active page", () => {
    const dead = read("src/app/app/clients/[id]/edit/ClientEditForm.tsx");
    expect(dead).toContain("src={client.photo_url}");
    for (const path of [
      "src/app/app/clients/[id]/edit/page.tsx",
      "src/app/app/clients/[id]/page.tsx",
      "src/app/app/clients/[id]/edit/EditClientForm.tsx",
    ]) {
      expect(read(path)).not.toMatch(/from "\.\/ClientEditForm"|ClientEditForm"/);
    }
  });
});
