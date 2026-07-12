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
};

export function sha256Hex(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function getPdfPageCount(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false });
  return pdf.getPageCount();
}

function fitTextSize(value: string, width: number, height: number) {
  const byHeight = Math.max(8, Math.min(18, height * 0.55));
  const byWidth = Math.max(8, Math.min(byHeight, width / Math.max(1, value.length * 0.55)));
  return byWidth;
}

export async function applySigningFields(params: {
  sourceBytes: Uint8Array;
  fields: SigningField[];
  values: Record<string, string | boolean>;
  signerName: string;
  signedAt: string;
}) {
  const pdf = await PDFDocument.load(params.sourceBytes, { ignoreEncryption: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const pages = pdf.getPages();

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
        page.drawText("X", { x: x + 3, y: y + 2, size: Math.max(10, height * 0.75), font });
      }
      continue;
    }

    let value = typeof raw === "string" ? raw.trim() : "";
    if (field.field_type === "date" && !value) value = new Date(params.signedAt).toLocaleDateString("en-US");
    if (field.field_type === "signature" && !value) value = params.signerName;
    if (field.field_type === "printed_name" && !value) value = params.signerName;
    if (!value) continue;

    const size = fitTextSize(value, width, height);
    page.drawText(value, {
      x: x + 3,
      y: y + Math.max(2, (height - size) / 2),
      size,
      font: field.field_type === "signature" ? italic : font,
      color: rgb(0.08, 0.08, 0.08),
      maxWidth: Math.max(10, width - 6),
    });
  }

  const bytes = await pdf.save({ useObjectStreams: false });
  return { bytes, sha256: sha256Hex(bytes) };
}
