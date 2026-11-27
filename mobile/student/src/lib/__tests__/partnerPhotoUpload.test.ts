const mockUpload = jest.fn();
const mockBytes = jest.fn();
const mockFile = jest.fn();

jest.mock("expo-file-system", () => ({
  File: function File(uri: string) {
    mockFile(uri);
    return { bytes: mockBytes };
  },
}));
jest.mock("@/lib/danceflowApi", () => ({ danceflowApiFetch: jest.fn() }));
jest.mock("@/lib/supabase", () => ({
  supabase: {
    storage: {
      from: () => ({
        upload: mockUpload,
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://files.example.test/${path}` } }),
      }),
    },
  },
}));

import { uploadPartnerProfilePhoto } from "@/lib/partnerSearch";

beforeEach(() => {
  mockUpload.mockReset().mockResolvedValue({ error: null });
  mockBytes.mockReset().mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
  mockFile.mockReset();
});

describe("uploadPartnerProfilePhoto", () => {
  it("uploads the picked file's bytes (never a Blob, which React Native cannot send) with its content type", async () => {
    const url = await uploadPartnerProfilePhoto({ contentType: "image/png", uri: "file:///cache/p.png", userId: "u1" });

    expect(mockFile).toHaveBeenCalledWith("file:///cache/p.png");
    const [path, body, options] = mockUpload.mock.calls[0];
    expect(path).toMatch(/^u1\/profile-\d+\.png$/);
    expect(body).toBeInstanceOf(Uint8Array);
    expect(Array.from(body as Uint8Array)).toEqual([137, 80, 78, 71]);
    expect(options).toMatchObject({ contentType: "image/png", upsert: true });
    expect(url).toBe(`https://files.example.test/${path}`);
  });

  it("passes a storage error to the screen", async () => {
    const error = new Error("new row violates row-level security policy");
    mockUpload.mockResolvedValue({ error });
    await expect(uploadPartnerProfilePhoto({ uri: "file:///cache/p.jpg", userId: "u1" })).rejects.toBe(error);
  });

  it("does not upload when the file cannot be read", async () => {
    mockBytes.mockRejectedValue(new Error("cannot read"));
    await expect(uploadPartnerProfilePhoto({ uri: "file:///gone.jpg", userId: "u1" })).rejects.toThrow("cannot read");
    expect(mockUpload).not.toHaveBeenCalled();
  });
});
