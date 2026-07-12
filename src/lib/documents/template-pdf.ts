import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const BODY_SIZE = 11;
const LINE_HEIGHT = 16;

function wrapText(text: string, maxChars: number) {
  const paragraphs = text.replace(/\r\n/g, "\n").split("\n");
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
      if (next.length <= maxChars) current = next;
      else {
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
}) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  const addPage = () => {
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  };

  const ensureSpace = (height: number) => {
    if (y - height < MARGIN) addPage();
  };

  page.drawText(params.title, {
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
