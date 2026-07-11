export type UploadValidationKind = "image" | "video" | "csv" | "generic";

type UploadValidationOptions = {
  fieldLabel: string;
  maxBytes: number;
  allowedMimeTypes: readonly string[];
  allowedExtensions?: readonly string[];
  kind?: UploadValidationKind;
};

type UploadValidationResult =
  | { ok: true; mimeType: string; extension: string }
  | { ok: false; error: string };

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;

const MIME_EXTENSION_MAP: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "text/csv": "csv",
  "text/plain": "csv",
  "application/csv": "csv",
  "application/vnd.ms-excel": "csv",
};

export const IMAGE_UPLOAD_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const CSV_UPLOAD_MIME_TYPES = ["text/csv", "application/csv", "application/vnd.ms-excel", "text/plain"] as const;
export const VIDEO_UPLOAD_MIME_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;

function normalizeMimeType(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function normalizeExtension(value: string | null | undefined) {
  const clean = (value ?? "").trim().toLowerCase().replace(/^\./, "").replace(/[^a-z0-9]+/g, "");
  if (clean === "jpeg") return "jpg";
  return clean;
}

function extensionFromFileName(name: string | null | undefined) {
  const clean = (name ?? "").trim().toLowerCase();
  const match = clean.match(/\.([a-z0-9]{1,12})$/i);
  return normalizeExtension(match?.[1] ?? "");
}

export function extensionForMimeType(mimeType: string | null | undefined, fallback = "bin") {
  return MIME_EXTENSION_MAP[normalizeMimeType(mimeType)] ?? fallback;
}

export function getOptionalUploadFile(formData: FormData, key: string) {
  const value = formData.get(key);
  return value instanceof File && value.size > 0 ? value : null;
}

export function safeStorageSegment(value: string, fallback: string) {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(CONTROL_CHARACTERS, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return cleaned || fallback;
}

export function safeOriginalFileName(value: string | null | undefined, fallback: string) {
  const cleaned = (value ?? "")
    .trim()
    .replace(CONTROL_CHARACTERS, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 180);

  return cleaned || fallback;
}

async function readHeader(file: File, byteCount = 4096) {
  const slice = file.slice(0, Math.min(file.size, byteCount));
  return new Uint8Array(await slice.arrayBuffer());
}

function isJpeg(header: Uint8Array) {
  return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
}

function isPng(header: Uint8Array) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return signature.every((byte, index) => header[index] === byte);
}

function isWebp(header: Uint8Array) {
  if (header.length < 12) return false;
  const riff = String.fromCharCode(...header.slice(0, 4));
  const webp = String.fromCharCode(...header.slice(8, 12));
  return riff === "RIFF" && webp === "WEBP";
}

function isMp4Like(header: Uint8Array) {
  if (header.length < 12) return false;
  const marker = String.fromCharCode(...header.slice(4, 8));
  return marker === "ftyp";
}

function isWebm(header: Uint8Array) {
  return header.length >= 4 && header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3;
}

function hasNullByte(header: Uint8Array) {
  return header.some((byte) => byte === 0x00);
}

function matchesExpectedSignature(kind: UploadValidationKind, mimeType: string, header: Uint8Array) {
  if (kind === "generic") return true;

  if (kind === "image") {
    if (mimeType === "image/jpeg" || mimeType === "image/jpg") return isJpeg(header);
    if (mimeType === "image/png") return isPng(header);
    if (mimeType === "image/webp") return isWebp(header);
    return false;
  }

  if (kind === "video") {
    if (mimeType === "video/mp4" || mimeType === "video/quicktime") return isMp4Like(header);
    if (mimeType === "video/webm") return isWebm(header);
    return false;
  }

  if (kind === "csv") {
    return !hasNullByte(header);
  }

  return true;
}

function humanBytes(bytes: number) {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${Number.isInteger(mb) ? mb.toFixed(0) : mb.toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

export async function validateUploadFile(file: File | null, options: UploadValidationOptions): Promise<UploadValidationResult> {
  if (!file || file.size <= 0) {
    return { ok: false, error: `${options.fieldLabel} is required.` };
  }

  const mimeType = normalizeMimeType(file.type);
  const allowedMimeTypes = options.allowedMimeTypes.map(normalizeMimeType);

  if (!mimeType || !allowedMimeTypes.includes(mimeType)) {
    return { ok: false, error: `${options.fieldLabel} must be an allowed file type.` };
  }

  if (file.size > options.maxBytes) {
    return { ok: false, error: `${options.fieldLabel} must be ${humanBytes(options.maxBytes)} or smaller.` };
  }

  const fileExtension = extensionFromFileName(file.name);
  const canonicalExtension = extensionForMimeType(mimeType, fileExtension || "bin");
  const allowedExtensions = (options.allowedExtensions ?? [canonicalExtension]).map(normalizeExtension);

  if (!canonicalExtension || !allowedExtensions.includes(canonicalExtension)) {
    return { ok: false, error: `${options.fieldLabel} has an unsupported file extension.` };
  }

  if (fileExtension && !allowedExtensions.includes(fileExtension)) {
    return { ok: false, error: `${options.fieldLabel} file extension does not match an allowed type.` };
  }

  const header = await readHeader(file);
  const kind = options.kind ?? "generic";

  if (!matchesExpectedSignature(kind, mimeType, header)) {
    return { ok: false, error: `${options.fieldLabel} contents do not match the selected file type.` };
  }

  return { ok: true, mimeType, extension: canonicalExtension };
}
