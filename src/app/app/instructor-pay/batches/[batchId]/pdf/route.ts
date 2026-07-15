import { NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { createClient } from "@/lib/supabase/server";
import { canPreparePayroll } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type BatchRow = {
  id: string;
  pay_period_id: string;
  batch_number: number | string;
  provider: string;
  provider_batch_reference: string | null;
  status: string;
  compensation_total: number | string | null;
  reimbursement_total: number | string | null;
  deduction_total: number | string | null;
  net_payment_total: number | string | null;
  earning_count: number;
  approved_at: string | null;
  approved_by: string | null;
  paid_at: string | null;
  paid_by: string | null;
  payment_method: string | null;
  created_at: string;
};

type PeriodRow = {
  id: string;
  period_start: string;
  period_end: string;
  pay_date: string | null;
  status: string;
};

type EarningRow = {
  id: string;
  earning_date: string;
  source_type: string | null;
  appointment_type: string | null;
  status: string;
  worker_classification_snapshot: string | null;
  accounting_category_snapshot: string | null;
  taxable_compensation_amount: number | string | null;
  reimbursement_amount: number | string | null;
  deduction_amount: number | string | null;
  notes: string | null;
  instructors:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
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

function relationName(value: EarningRow["instructors"]) {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row) return "Instructor";
  return `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || "Instructor";
}

function normalizePdfText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
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

  const [batchResult, studioResult] = await Promise.all([
    supabase
      .from("payroll_batches")
      .select("id, pay_period_id, batch_number, provider, provider_batch_reference, status, compensation_total, reimbursement_total, deduction_total, net_payment_total, earning_count, approved_at, approved_by, paid_at, paid_by, payment_method, created_at")
      .eq("id", batchId)
      .eq("studio_id", studioId)
      .maybeSingle(),
    supabase
      .from("studios")
      .select("name, public_name, public_logo_url")
      .eq("id", studioId)
      .maybeSingle(),
  ]);

  if (batchResult.error) {
    console.error("Payroll packet batch load failed", {
      batchId,
      studioId,
      code: batchResult.error.code,
      message: batchResult.error.message,
    });
    return new NextResponse("The payroll packet could not be generated.", { status: 500 });
  }

  if (!batchResult.data) {
    return new NextResponse("Payroll batch not found", { status: 404 });
  }

  const batch = batchResult.data as BatchRow;

  const [periodResult, earningsResult] = await Promise.all([
    supabase
      .from("payroll_pay_periods")
      .select("id, period_start, period_end, pay_date, status")
      .eq("id", batch.pay_period_id)
      .eq("studio_id", studioId)
      .maybeSingle(),
    supabase
      .from("instructor_earnings")
      .select("id, earning_date, source_type, appointment_type, status, worker_classification_snapshot, accounting_category_snapshot, taxable_compensation_amount, reimbursement_amount, deduction_amount, notes, instructors(first_name, last_name)")
      .eq("studio_id", studioId)
      .eq("payroll_batch_id", batch.id)
      .neq("status", "void")
      .order("earning_date", { ascending: true })
      .limit(5000),
  ]);

  if (periodResult.error || !periodResult.data) {
    console.error("Payroll packet period load failed", {
      batchId,
      studioId,
      error: periodResult.error?.message,
    });
    return new NextResponse("The payroll pay period could not be loaded.", { status: 500 });
  }

  if (earningsResult.error) {
    console.error("Payroll packet earnings load failed", {
      batchId,
      studioId,
      code: earningsResult.error.code,
      message: earningsResult.error.message,
    });
    return new NextResponse("The payroll earnings could not be loaded.", { status: 500 });
  }

  const period = periodResult.data as PeriodRow;
  const earnings = (earningsResult.data ?? []) as EarningRow[];
  const studioName = studioResult.data?.public_name || studioResult.data?.name || "Dance studio";

  const instructorSummaries = new Map<string, InstructorSummary>();
  const classificationTotals = new Map<string, number>();

  for (const earning of earnings) {
    const instructor = relationName(earning.instructors);
    const classification = earning.worker_classification_snapshot || "not_set";
    const compensation = safeNumber(earning.taxable_compensation_amount);
    const reimbursement = safeNumber(earning.reimbursement_amount);
    const deduction = safeNumber(earning.deduction_amount);
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
  if (studioResult.data?.public_logo_url) {
    try {
      const response = await fetch(studioResult.data.public_logo_url, {
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
    `Batch #${batch.batch_number} for ${dateLabel(period.period_start)} through ${dateLabel(period.period_end)}`,
    MARGIN,
    regular,
    11,
    CONTENT_WIDTH,
    15,
    rgb(0.34, 0.34, 0.4),
  );
  y -= 8;

  sectionTitle("Batch Summary");
  detailRow("Studio", studioName);
  detailRow("Pay period", `${dateLabel(period.period_start)} - ${dateLabel(period.period_end)}`);
  detailRow("Pay date", dateLabel(period.pay_date));
  detailRow("Batch", `#${batch.batch_number}`);
  detailRow("Status", label(batch.status));
  detailRow("Provider workflow", label(batch.provider));
  detailRow("Provider reference", batch.provider_batch_reference || "Not recorded");
  detailRow("Created", dateTimeLabel(batch.created_at));
  detailRow("Approved", dateTimeLabel(batch.approved_at));
  detailRow("Paid", dateTimeLabel(batch.paid_at));
  detailRow("Payment method", label(batch.payment_method));
  detailRow("Earnings", String(batch.earning_count ?? earnings.length));

  sectionTitle("Batch Totals");
  detailRow("Taxable compensation", money(batch.compensation_total));
  detailRow("Reimbursements", money(batch.reimbursement_total));
  detailRow("Deductions", money(batch.deduction_total));
  detailRow("Net payment", money(batch.net_payment_total));

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
  for (const earning of earnings) {
    const compensation = safeNumber(earning.taxable_compensation_amount);
    const reimbursement = safeNumber(earning.reimbursement_amount);
    const deduction = safeNumber(earning.deduction_amount);
    const net = compensation + reimbursement - deduction;
    ensureSpace(72);
    page.drawText(normalizePdfText(relationName(earning.instructors)), {
      x: MARGIN,
      y,
      size: 10,
      font: bold,
      color: rgb(0.08, 0.08, 0.12),
    });
    page.drawText(`${dateLabel(earning.earning_date)} | ${label(earning.appointment_type || earning.source_type)} | ${label(earning.worker_classification_snapshot)}`, {
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
    if (earning.notes) {
      const noteLines = wrapText(earning.notes, regular, 8, CONTENT_WIDTH);
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
  if (!earnings.length) detailRow("Details", "No earnings are included in this batch.");

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
    `Generated by DanceFlow on ${dateTimeLabel(new Date().toISOString())}. Batch ID: ${batch.id}`,
    MARGIN,
    regular,
    8,
    CONTENT_WIDTH,
    11,
    rgb(0.45, 0.45, 0.5),
  );

  drawFooter(page);
  const bytes = await pdf.save();
  const filename = `danceflow-payroll-${safeFilename(studioName)}-batch-${batch.batch_number}.pdf`;

  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
