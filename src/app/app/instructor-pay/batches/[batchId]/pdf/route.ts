import { NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { createClient } from "@/lib/supabase/server";
import { canPreparePayroll } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  LEGACY_EXPORT_NOTICE,
  exportedTotals,
  loadBatchExportSource,
  recordPayrollExport,
  type BatchExportRow,
  type LiveEarningRow,
} from "@/lib/payroll/approved-batch-export";

// One packet model, filled either from the immutable approval snapshot
// (approved / paid batches) or from current records (legacy or draft batches).
type PacketLine = {
  instructorName: string;
  classification: string | null;
  earningDate: string;
  typeLabel: string | null;
  compensation: number;
  reimbursement: number;
  deduction: number;
  notes: string | null;
};

type PacketModel = {
  batchId: string;
  batchNumber: number | string;
  provider: string;
  providerReference: string | null;
  statusLabel: string;
  createdAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
  paidAt: string | null;
  paidBy: string | null;
  paymentMethod: string | null;
  earningCount: number;
  totals: {
    compensation: number | string | null;
    reimbursement: number | string | null;
    deduction: number | string | null;
    net: number | string | null;
  };
  period: { start: string; end: string; payDate: string | null };
  lines: PacketLine[];
  sourceNotice: string | null;
  evidence: "snapshot" | "legacy" | null;
};

type InstructorSummary = {
  name: string;
  classification: string;
  compensation: number;
  reimbursement: number;
  deduction: number;
  net: number;
  count: number;
};

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

function safeNumber(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: number | string | null | undefined) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(safeNumber(value));
}

function dateLabel(value: string | null | undefined) {
  if (!value) return "Not set";
  const date = new Date(value.includes("T") ? value : `${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function dateTimeLabel(value: string | null | undefined) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function label(value: string | null | undefined) {
  return (value || "Not set")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function relationName(value: LiveEarningRow["instructors"]) {
  const row = value;
  if (!row) return "Instructor";
  return `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || "Instructor";
}

function normalizePdfText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wrapText(text: string, font: PDFFont, fontSize: number, maxWidth: number) {
  const words = normalizePdfText(text).split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, fontSize) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }

  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function safeFilename(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "payroll-batch";
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ batchId: string }> },
) {
  const { batchId } = await params;
  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const studioId = context.studioId;
  const role = context.studioRole ?? "";

  if (!studioId || !canPreparePayroll(role)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const source = await loadBatchExportSource(supabase, studioId, batchId);

  if (source.kind === "not_found") {
    return new NextResponse("Payroll batch not found", { status: 404 });
  }
  if (source.kind === "forbidden") {
    return new NextResponse("Forbidden", { status: 403 });
  }
  if (source.kind === "error") {
    console.error("Payroll packet load failed", { batchId, studioId, stage: source.stage, message: source.message });
    return new NextResponse("The payroll packet could not be generated.", { status: 500 });
  }

  let packet: PacketModel;
  if (source.kind === "snapshot") {
    const { snapshot, payment } = source;
    packet = {
      batchId: source.batch.id,
      batchNumber: snapshot.batch_number,
      provider: snapshot.provider,
      providerReference: payment?.provider_batch_reference ?? snapshot.provider_batch_reference,
      statusLabel: payment ? "paid" : "approved",
      createdAt: source.batch.created_at,
      approvedAt: snapshot.approved_at,
      approvedBy: snapshot.approved_by_name || "Recorded user",
      paidAt: payment?.paid_at ?? null,
      paidBy: payment ? payment.paid_by_name || "Recorded user" : null,
      paymentMethod: payment?.payment_method ?? null,
      earningCount: Number(snapshot.earning_count),
      totals: {
        compensation: snapshot.compensation_total,
        reimbursement: snapshot.reimbursement_total,
        deduction: snapshot.deduction_total,
        net: snapshot.net_payment_total,
      },
      period: { start: snapshot.period_start, end: snapshot.period_end, payDate: snapshot.pay_date },
      lines: source.lines.map((line) => ({
        instructorName: line.instructor_name || "Instructor",
        classification: line.worker_classification_snapshot,
        earningDate: line.earning_date,
        typeLabel: line.appointment_type || line.source_type,
        compensation: safeNumber(line.taxable_compensation_amount),
        reimbursement: safeNumber(line.reimbursement_amount),
        deduction: safeNumber(line.deduction_amount),
        notes: line.notes,
      })),
      sourceNotice: null,
      evidence: "snapshot",
    };
  } else {
    const batch: BatchExportRow = source.batch;
    const payment = source.kind === "legacy" ? source.payment : null;
    const period = source.period;
    if (!period) {
      console.error("Payroll packet period load failed", { batchId, studioId });
      return new NextResponse("The payroll pay period could not be loaded.", { status: 500 });
    }
    const earnings = source.earnings.filter((earning) => earning.status !== "void");
    packet = {
      batchId: batch.id,
      batchNumber: batch.batch_number,
      provider: batch.provider,
      providerReference: batch.provider_batch_reference,
      statusLabel: batch.status,
      createdAt: batch.created_at,
      approvedAt: batch.approved_at,
      approvedBy: null,
      paidAt: payment?.paid_at ?? batch.paid_at,
      paidBy: payment ? payment.paid_by_name || "Recorded user" : null,
      paymentMethod: payment?.payment_method ?? batch.payment_method,
      earningCount: batch.earning_count ?? earnings.length,
      totals: {
        compensation: batch.compensation_total,
        reimbursement: batch.reimbursement_total,
        deduction: batch.deduction_total,
        net: batch.net_payment_total,
      },
      period: { start: period.period_start, end: period.period_end, payDate: period.pay_date },
      lines: earnings.map((earning) => ({
        instructorName: relationName(earning.instructors),
        classification: earning.worker_classification_snapshot,
        earningDate: earning.earning_date,
        typeLabel: earning.appointment_type || earning.source_type,
        compensation: safeNumber(earning.taxable_compensation_amount),
        reimbursement: safeNumber(earning.reimbursement_amount),
        deduction: safeNumber(earning.deduction_amount),
        notes: earning.notes,
      })),
      sourceNotice:
        source.kind === "legacy"
          ? LEGACY_EXPORT_NOTICE
          : "This batch is not approved yet. Its figures are a working copy of the current payroll records.",
      evidence: source.kind === "legacy" ? "legacy" : null,
    };
  }

  // Studio identity comes from the trusted, studio-scoped export payload.
  const studioName = source.studio.public_name || source.studio.name;
  const studioLogoUrl = source.studio.public_logo_url;

  const instructorSummaries = new Map<string, InstructorSummary>();
  const classificationTotals = new Map<string, number>();

  for (const line of packet.lines) {
    const instructor = line.instructorName;
    const classification = line.classification || "not_set";
    const compensation = line.compensation;
    const reimbursement = line.reimbursement;
    const deduction = line.deduction;
    const net = compensation + reimbursement - deduction;
    const key = `${instructor}:${classification}`;
    const current = instructorSummaries.get(key) ?? {
      name: instructor,
      classification,
      compensation: 0,
      reimbursement: 0,
      deduction: 0,
      net: 0,
      count: 0,
    };
    current.compensation += compensation;
    current.reimbursement += reimbursement;
    current.deduction += deduction;
    current.net += net;
    current.count += 1;
    instructorSummaries.set(key, current);
    classificationTotals.set(classification, (classificationTotals.get(classification) ?? 0) + net);
  }

  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;
  let pageNumber = 1;

  const drawFooter = (targetPage: PDFPage) => {
    targetPage.drawLine({
      start: { x: MARGIN, y: 38 },
      end: { x: PAGE_WIDTH - MARGIN, y: 38 },
      thickness: 0.5,
      color: rgb(0.82, 0.82, 0.86),
    });
    targetPage.drawText(`DanceFlow Payroll Preparation Packet - Page ${pageNumber}`, {
      x: MARGIN,
      y: 24,
      size: 8,
      font: regular,
      color: rgb(0.42, 0.42, 0.48),
    });
  };

  const newPage = () => {
    drawFooter(page);
    pageNumber += 1;
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  };

  const ensureSpace = (height: number) => {
    if (y - height < 54) newPage();
  };

  const drawWrapped = (
    text: string,
    x: number,
    font: PDFFont,
    size: number,
    width: number,
    lineHeight = size + 3,
    color = rgb(0.16, 0.16, 0.2),
  ) => {
    const lines = wrapText(text, font, size, width);
    for (const line of lines) {
      ensureSpace(lineHeight + 2);
      page.drawText(line, { x, y, size, font, color });
      y -= lineHeight;
    }
  };

  const sectionTitle = (title: string) => {
    ensureSpace(38);
    y -= 8;
    page.drawText(title, {
      x: MARGIN,
      y,
      size: 14,
      font: bold,
      color: rgb(0.12, 0.12, 0.16),
    });
    y -= 10;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_WIDTH - MARGIN, y },
      thickness: 0.7,
      color: rgb(0.78, 0.72, 0.84),
    });
    y -= 18;
  };

  const detailRow = (rowLabel: string, value: string) => {
    const valueLines = wrapText(value || "-", regular, 10, 330);
    ensureSpace(Math.max(18, valueLines.length * 13 + 4));
    page.drawText(rowLabel, {
      x: MARGIN,
      y,
      size: 10,
      font: bold,
      color: rgb(0.33, 0.33, 0.4),
    });
    valueLines.forEach((line, index) => {
      page.drawText(line, {
        x: MARGIN + 180,
        y: y - index * 13,
        size: 10,
        font: regular,
        color: rgb(0.08, 0.08, 0.12),
      });
    });
    y -= Math.max(18, valueLines.length * 13 + 4);
  };

  let brandTextX = MARGIN;
  if (studioLogoUrl) {
    try {
      const response = await fetch(studioLogoUrl, {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      const contentType = response.headers.get("content-type")?.split(";")[0]?.toLowerCase();
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (
        response.ok &&
        bytes.length <= 2 * 1024 * 1024 &&
        (contentType === "image/png" || contentType === "image/jpeg")
      ) {
        const image = contentType === "image/png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
        const natural = image.scale(1);
        const scale = Math.min(74 / natural.width, 42 / natural.height, 1);
        const width = natural.width * scale;
        const height = natural.height * scale;
        page.drawImage(image, { x: MARGIN, y: y - height + 4, width, height });
        brandTextX = MARGIN + width + 12;
      }
    } catch {
      // Packet generation continues without a remote logo.
    }
  }

  page.drawText(normalizePdfText(studioName), {
    x: brandTextX,
    y,
    size: 13,
    font: bold,
    color: rgb(0.35, 0.12, 0.45),
    maxWidth: PAGE_WIDTH - brandTextX - MARGIN,
  });
  y -= 42;
  page.drawText("Payroll Preparation Packet", {
    x: MARGIN,
    y,
    size: 23,
    font: bold,
    color: rgb(0.08, 0.08, 0.12),
  });
  y -= 24;
  drawWrapped(
    `Batch #${packet.batchNumber} for ${dateLabel(packet.period.start)} through ${dateLabel(packet.period.end)}`,
    MARGIN,
    regular,
    11,
    CONTENT_WIDTH,
    15,
    rgb(0.34, 0.34, 0.4),
  );
  y -= 8;

  if (packet.sourceNotice) {
    drawWrapped(packet.sourceNotice, MARGIN, regular, 9, CONTENT_WIDTH, 13, rgb(0.55, 0.25, 0.1));
    y -= 6;
  }

  sectionTitle("Batch Summary");
  detailRow("Studio", studioName);
  detailRow("Pay period", `${dateLabel(packet.period.start)} - ${dateLabel(packet.period.end)}`);
  detailRow("Pay date", dateLabel(packet.period.payDate));
  detailRow("Batch", `#${packet.batchNumber}`);
  detailRow("Status", label(packet.statusLabel));
  detailRow("Provider workflow", label(packet.provider));
  detailRow("Provider reference", packet.providerReference || "Not recorded");
  detailRow("Created", dateTimeLabel(packet.createdAt));
  detailRow("Approved", dateTimeLabel(packet.approvedAt));
  if (packet.approvedBy) detailRow("Approved by", packet.approvedBy);
  detailRow("Paid", dateTimeLabel(packet.paidAt));
  if (packet.paidBy) detailRow("Paid by", packet.paidBy);
  detailRow("Payment method", label(packet.paymentMethod));
  detailRow("Earnings", String(packet.earningCount));

  sectionTitle("Batch Totals");
  detailRow("Taxable compensation", money(packet.totals.compensation));
  detailRow("Reimbursements", money(packet.totals.reimbursement));
  detailRow("Deductions", money(packet.totals.deduction));
  detailRow("Net payment", money(packet.totals.net));

  sectionTitle("Worker Classification Totals");
  for (const classification of ["employee", "contractor", "owner", "not_set"]) {
    if (classificationTotals.has(classification)) {
      detailRow(label(classification), money(classificationTotals.get(classification)));
    }
  }
  if (!classificationTotals.size) detailRow("Summary", "No earnings are included in this batch.");

  sectionTitle("Instructor Summary");
  for (const summary of [...instructorSummaries.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    ensureSpace(58);
    page.drawText(normalizePdfText(summary.name), {
      x: MARGIN,
      y,
      size: 11,
      font: bold,
      color: rgb(0.08, 0.08, 0.12),
    });
    page.drawText(`${label(summary.classification)} | ${summary.count} earning${summary.count === 1 ? "" : "s"}`, {
      x: MARGIN,
      y: y - 14,
      size: 9,
      font: regular,
      color: rgb(0.4, 0.4, 0.46),
    });
    page.drawText(`Compensation ${money(summary.compensation)}   Reimbursements ${money(summary.reimbursement)}   Deductions ${money(summary.deduction)}   Net ${money(summary.net)}`, {
      x: MARGIN,
      y: y - 29,
      size: 9,
      font: regular,
      color: rgb(0.12, 0.12, 0.16),
      maxWidth: CONTENT_WIDTH,
    });
    y -= 48;
  }
  if (!instructorSummaries.size) detailRow("Summary", "No instructor earnings are included in this batch.");

  sectionTitle("Detailed Earnings Appendix");
  for (const line of packet.lines) {
    const compensation = line.compensation;
    const reimbursement = line.reimbursement;
    const deduction = line.deduction;
    const net = compensation + reimbursement - deduction;
    ensureSpace(72);
    page.drawText(normalizePdfText(line.instructorName), {
      x: MARGIN,
      y,
      size: 10,
      font: bold,
      color: rgb(0.08, 0.08, 0.12),
    });
    page.drawText(`${dateLabel(line.earningDate)} | ${label(line.typeLabel)} | ${label(line.classification)}`, {
      x: MARGIN,
      y: y - 14,
      size: 8.5,
      font: regular,
      color: rgb(0.4, 0.4, 0.46),
    });
    page.drawText(`Comp ${money(compensation)}   Reimb ${money(reimbursement)}   Deduct ${money(deduction)}   Net ${money(net)}`, {
      x: MARGIN,
      y: y - 28,
      size: 9,
      font: regular,
      color: rgb(0.12, 0.12, 0.16),
    });
    if (line.notes) {
      const noteLines = wrapText(line.notes, regular, 8, CONTENT_WIDTH);
      page.drawText(noteLines[0] || "", {
        x: MARGIN,
        y: y - 42,
        size: 8,
        font: regular,
        color: rgb(0.42, 0.42, 0.48),
      });
    }
    y -= 58;
  }
  if (!packet.lines.length) detailRow("Details", "No earnings are included in this batch.");

  sectionTitle("Important Notice");
  drawWrapped(
    "DanceFlow prepares compensation records and payroll-ready reports. It does not calculate payroll taxes, determine worker classification, file tax forms, or transmit payroll to Gusto, QuickBooks Payroll, ADP, or another provider. The studio and its payroll or tax professionals remain responsible for review, compliance, withholding, filing, and payment.",
    MARGIN,
    regular,
    9,
    CONTENT_WIDTH,
    13,
    rgb(0.3, 0.3, 0.36),
  );
  y -= 8;
  drawWrapped(
    `Generated by DanceFlow on ${dateTimeLabel(new Date().toISOString())}. Batch ID: ${packet.batchId}`,
    MARGIN,
    regular,
    8,
    CONTENT_WIDTH,
    11,
    rgb(0.45, 0.45, 0.5),
  );

  drawFooter(page);
  const bytes = await pdf.save();
  const filename = `danceflow-payroll-${safeFilename(studioName)}-batch-${packet.batchNumber}.pdf`;

  // Approved batches: append the export evidence only once the packet exists;
  // if it cannot be recorded, the packet is not returned.
  if (packet.evidence) {
    const recorded = await recordPayrollExport(supabase, {
      studioId,
      batchId: packet.batchId,
      exportType: "pdf",
      ...exportedTotals(packet.lines.map((line) => ({ net: line.compensation + line.reimbursement - line.deduction }))),
    });
    if (!recorded.ok) {
      console.error("Payroll packet export evidence failed", { batchId, studioId, message: recorded.message });
      return new NextResponse("The payroll packet could not be generated.", { status: 500 });
    }
  }

  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
