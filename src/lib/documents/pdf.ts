import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createHash } from "crypto";

export type SigningField = {
  id: string;
  field_type: "signature" | "initials" | "printed_name" | "date" | "text" | "checkbox";
  page_number: number;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  required: boolean;
  placeholder_text?: string | null;
  default_value?: string | null;
};

export type PdfPageSize = { pageNumber: number; width: number; height: number };
export type AppliedSignature = { method: "typed" | "drawn"; value: string };
export type SigningValue = string | boolean | AppliedSignature;

export function sha256Hex(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function getPdfPageCount(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false });
  return pdf.getPageCount();
}

export async function getPdfPageSizes(bytes: Uint8Array): Promise<PdfPageSize[]> {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false });
  return pdf.getPages().map((page, index) => {
    const { width, height } = page.getSize();
    return { pageNumber: index + 1, width, height };
  });
}

function fitTextSize(value: string, width: number, height: number) {
  const byHeight = Math.max(8, Math.min(18, height * 0.55));
  return Math.max(8, Math.min(byHeight, width / Math.max(1, value.length * 0.55)));
}

function isAppliedSignature(value: SigningValue | undefined): value is AppliedSignature {
  return Boolean(value && typeof value === "object" && "method" in value && "value" in value);
}

export async function applySigningFields(params: {
  sourceBytes: Uint8Array;
  fields: SigningField[];
  values: Record<string, SigningValue>;
  signerName: string;
  signerEmail?: string | null;
  signedAt: string;
  timezone?: string | null;
}) {
  const pdf = await PDFDocument.load(params.sourceBytes, { ignoreEncryption: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const pages = pdf.getPages();
  const timestamp = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: params.timezone || "UTC",
  }).format(new Date(params.signedAt));

  for (const field of params.fields) {
    const page = pages[field.page_number - 1];
    if (!page) throw new Error(`Signing field ${field.id} references an invalid page.`);
    const { width: pageWidth, height: pageHeight } = page.getSize();
    const x = field.x * pageWidth;
    const y = pageHeight - field.y * pageHeight - field.height * pageHeight;
    const width = field.width * pageWidth;
    const height = field.height * pageHeight;
    const raw = params.values[field.id];

    if (field.field_type === "checkbox") {
      if (raw === true || raw === "true" || raw === "on") {
        page.drawRectangle({ x, y, width, height, borderWidth: 0.8, borderColor: rgb(0.15, 0.15, 0.15) });
        page.drawText("X", { x: x + 3, y: y + 2, size: Math.max(10, height * 0.75), font });
      }
      continue;
    }

    if ((field.field_type === "signature" || field.field_type === "initials") && isAppliedSignature(raw)) {
      const footerHeight = Math.min(11, Math.max(7, height * 0.22));
      const contentHeight = Math.max(8, height - footerHeight - 2);
      if (raw.method === "drawn" && raw.value.startsWith("data:image/png;base64,")) {
        const png = await pdf.embedPng(raw.value);
        const scale = Math.min((width - 6) / png.width, contentHeight / png.height);
        const drawWidth = Math.max(1, png.width * scale);
        const drawHeight = Math.max(1, png.height * scale);
        page.drawImage(png, {
          x: x + Math.max(3, (width - drawWidth) / 2),
          y: y + footerHeight + Math.max(1, (contentHeight - drawHeight) / 2),
          width: drawWidth,
          height: drawHeight,
        });
      } else {
        const value = raw.value.trim();
        const size = fitTextSize(value, width, contentHeight);
        page.drawText(value, {
          x: x + 3,
          y: y + footerHeight + Math.max(2, (contentHeight - size) / 2),
          size,
          font: italic,
          color: rgb(0.08, 0.08, 0.08),
          maxWidth: Math.max(10, width - 6),
        });
      }
      page.drawText(`Signed ${timestamp}`, {
        x: x + 3,
        y: y + 1.5,
        size: Math.min(7.5, footerHeight - 1),
        font,
        color: rgb(0.12, 0.45, 0.25),
        maxWidth: Math.max(10, width - 6),
      });
      continue;
    }

    let value = typeof raw === "string" ? raw.trim() : "";
    if (!value) value = field.default_value?.trim() ?? "";
    if (field.field_type === "date" && !value) value = new Date(params.signedAt).toLocaleDateString("en-US");
    if (field.field_type === "printed_name" && !value) value = params.signerName;
    if (!value) continue;

    const size = fitTextSize(value, width, height);
    page.drawText(value, {
      x: x + 3,
      y: y + Math.max(2, (height - size) / 2),
      size,
      font,
      color: rgb(0.08, 0.08, 0.08),
      maxWidth: Math.max(10, width - 6),
    });
  }

  const bytes = await pdf.save({ useObjectStreams: false });
  return { bytes, sha256: sha256Hex(bytes) };
}
