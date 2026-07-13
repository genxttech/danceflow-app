import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const BODY_SIZE = 11;
const LINE_HEIGHT = 16;

function normalizePdfText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u2610/g, "[ ]")
    .replace(/[\u2611\u2612\u2705\u2713\u2714]/g, "[x]")
    .replace(/[\u2022\u25CF\u25E6]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
}

function wrapText(text: string, maxChars: number) {
  const paragraphs = normalizePdfText(text)
    .replace(/\r\n/g, "\n")
    .split("\n");
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }

    const words = paragraph.trim().split(/\s+/);
    let current = "";

    for (const word of words) {
      const next = current ? `${current} ${word}` : word;

      if (next.length <= maxChars) {
        current = next;
      } else {
        if (current) lines.push(current);
        current = word;
      }
    }

    if (current) lines.push(current);
  }

  return lines;
}

export async function renderTemplateVersionPdf(params: {
  title: string;
  description?: string | null;
  body: string;
  versionNumber: number;
  consentText?: string | null;
  studioName?: string | null;
  studioLogoBytes?: Uint8Array | null;
  studioLogoMimeType?: "image/png" | "image/jpeg" | null;
}) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  let logo:
    | Awaited<ReturnType<typeof pdf.embedPng>>
    | Awaited<ReturnType<typeof pdf.embedJpg>>
    | null = null;

  if (params.studioLogoBytes?.length && params.studioLogoMimeType) {
    try {
      logo =
        params.studioLogoMimeType === "image/png"
          ? await pdf.embedPng(params.studioLogoBytes)
          : await pdf.embedJpg(params.studioLogoBytes);
    } catch {
      logo = null;
    }
  }

  const drawBrandHeader = () => {
    const studioName = normalizePdfText(params.studioName?.trim() ?? "");
    let textX = MARGIN;

    if (logo) {
      const natural = logo.scale(1);
      const maxWidth = 96;
      const maxHeight = 44;
      const scale = Math.min(
        maxWidth / natural.width,
        maxHeight / natural.height,
        1,
      );
      const width = natural.width * scale;
      const height = natural.height * scale;

      page.drawImage(logo, {
        x: MARGIN,
        y: PAGE_HEIGHT - MARGIN - height,
        width,
        height,
      });
      textX = MARGIN + width + 14;
    }

    if (studioName) {
      page.drawText(studioName, {
        x: textX,
        y: PAGE_HEIGHT - MARGIN - 18,
        size: 12,
        font: bold,
        color: rgb(0.25, 0.08, 0.3),
        maxWidth: PAGE_WIDTH - textX - MARGIN,
      });
    }

    page.drawLine({
      start: { x: MARGIN, y: PAGE_HEIGHT - MARGIN - 54 },
      end: { x: PAGE_WIDTH - MARGIN, y: PAGE_HEIGHT - MARGIN - 54 },
      thickness: 0.8,
      color: rgb(0.82, 0.78, 0.84),
    });

    y = PAGE_HEIGHT - MARGIN - 82;
  };

  const addPage = () => {
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    drawBrandHeader();
  };

  drawBrandHeader();

  const ensureSpace = (height: number) => {
    if (y - height < MARGIN) addPage();
  };

  page.drawText(normalizePdfText(params.title), {
    x: MARGIN,
    y,
    size: 18,
    font: bold,
    color: rgb(0.08, 0.08, 0.1),
    maxWidth: PAGE_WIDTH - MARGIN * 2,
  });
  y -= 28;

  page.drawText(`Version ${params.versionNumber}`, {
    x: MARGIN,
    y,
    size: 9,
    font: regular,
    color: rgb(0.4, 0.4, 0.45),
  });
  y -= 24;

  if (params.description?.trim()) {
    for (const line of wrapText(params.description, 86)) {
      ensureSpace(LINE_HEIGHT);
      page.drawText(line, {
        x: MARGIN,
        y,
        size: BODY_SIZE,
        font: regular,
        color: rgb(0.2, 0.2, 0.24),
      });
      y -= LINE_HEIGHT;
    }
    y -= 10;
  }

  for (const line of wrapText(params.body, 92)) {
    ensureSpace(LINE_HEIGHT);

    if (line) {
      page.drawText(line, {
        x: MARGIN,
        y,
        size: BODY_SIZE,
        font: regular,
        color: rgb(0.08, 0.08, 0.1),
      });
    }

    y -= LINE_HEIGHT;
  }

  if (params.consentText?.trim()) {
    y -= 12;
    ensureSpace(54);
    page.drawText("Electronic signature consent", {
      x: MARGIN,
      y,
      size: 10,
      font: bold,
      color: rgb(0.15, 0.15, 0.18),
    });
    y -= 16;

    for (const line of wrapText(params.consentText, 96)) {
      ensureSpace(14);
      page.drawText(line, {
        x: MARGIN,
        y,
        size: 9,
        font: regular,
        color: rgb(0.3, 0.3, 0.34),
      });
      y -= 14;
    }
  }

  return new Uint8Array(await pdf.save({ useObjectStreams: false }));
}
