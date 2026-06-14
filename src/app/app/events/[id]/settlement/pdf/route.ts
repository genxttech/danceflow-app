import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type EventRow = {
  id: string;
  studio_id: string;
  organizer_id: string | null;
  name: string | null;
  slug: string | null;
  status: string | null;
  event_type: string | null;
  start_date: string | null;
};

type EventProfitLossRow = {
  gross_ticket_revenue: number | string | null;
  refunds: number | string | null;
  processing_and_platform_fees: number | string | null;
  net_ticket_revenue: number | string | null;
  event_expenses: number | string | null;
  event_labor_costs: number | string | null;
  total_event_costs: number | string | null;
  event_profit_loss: number | string | null;
};

type RegistrationRow = {
  id: string;
  payment_status: string | null;
  status: string | null;
  quantity: number | string | null;
  checked_in_at: string | null;
};

type AttendeeRow = {
  id: string;
  checked_in_at: string | null;
};

type SettlementRow = {
  status: string | null;
  notes: string | null;
  gross_ticket_revenue: number | string | null;
  refunds: number | string | null;
  processing_and_platform_fees: number | string | null;
  net_ticket_revenue: number | string | null;
  event_expenses: number | string | null;
  event_labor_costs: number | string | null;
  total_event_costs: number | string | null;
  event_profit_loss: number | string | null;
  margin: number | string | null;
  paid_registrations: number | string | null;
  tickets_issued: number | string | null;
  tickets_checked_in: number | string | null;
  unpaid_registrations: number | string | null;
  pending_registrations: number | string | null;
  refunded_registrations: number | string | null;
  settled_at: string | null;
  settled_by: string | null;
  updated_at: string | null;
};

type PdfSection = {
  title: string;
  rows: Array<[string, string]>;
};

function safeNumber(value: number | string | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number.isFinite(value) ? value : 0);
}

function formatPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function slugifyFilename(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "event";
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

function escapePdfText(value: string) {
  return normalizePdfText(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapPdfText(value: string, maxChars: number) {
  const normalized = normalizePdfText(value);
  const words = normalized.split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function pdfTextLine(text: string, x: number, y: number, size = 10, font = "F1") {
  return `BT /${font} ${size} Tf ${x} ${y} Td (${escapePdfText(text)}) Tj ET`;
}

function pdfLine(x1: number, y1: number, x2: number, y2: number) {
  return `${x1} ${y1} m ${x2} ${y2} l S`;
}

function buildSettlementPdf(params: {
  title: string;
  subtitle: string;
  generatedAt: string;
  sections: PdfSection[];
}) {
  const pageWidth = 612;
  const pageHeight = 792;
  const marginX = 54;
  const topY = 744;
  const bottomY = 60;
  const maxTextChars = 92;
  const pages: string[] = [];
  let commands: string[] = [];
  let y = topY;
  let pageNumber = 1;

  function footer() {
    commands.push(pdfLine(marginX, 46, pageWidth - marginX, 46));
    commands.push(pdfTextLine(`DanceFlow Event Settlement Report - Page ${pageNumber}`, marginX, 32, 8));
  }

  function newPage() {
    if (commands.length > 0) {
      footer();
      pages.push(commands.join("\n"));
      pageNumber += 1;
    }
    commands = [];
    y = topY;
  }

  function ensureSpace(required: number) {
    if (y - required < bottomY) {
      newPage();
    }
  }

  function addText(text: string, size = 10, indent = 0, gap = 14, maxChars = maxTextChars) {
    const lines = wrapPdfText(text, maxChars - Math.floor(indent / 5));
    for (const line of lines) {
      ensureSpace(gap + 2);
      commands.push(pdfTextLine(line, marginX + indent, y, size));
      y -= gap;
    }
  }

  function addSection(section: PdfSection) {
    ensureSpace(48);
    y -= 8;
    commands.push(pdfTextLine(section.title, marginX, y, 13, "F2"));
    y -= 8;
    commands.push(pdfLine(marginX, y, pageWidth - marginX, y));
    y -= 18;

    for (const [label, value] of section.rows) {
      const labelText = normalizePdfText(label);
      const valueText = normalizePdfText(value || "-");
      const wrappedValue = wrapPdfText(valueText, 62);
      ensureSpace(Math.max(18, wrappedValue.length * 12 + 4));
      commands.push(pdfTextLine(labelText, marginX, y, 10, "F2"));
      commands.push(pdfTextLine(wrappedValue[0] || "-", marginX + 190, y, 10));
      y -= 12;
      for (const continuation of wrappedValue.slice(1)) {
        commands.push(pdfTextLine(continuation, marginX + 190, y, 10));
        y -= 12;
      }
      y -= 3;
    }
  }

  newPage();
  commands.push(pdfTextLine(params.title, marginX, y, 20, "F2"));
  y -= 24;
  addText(params.subtitle, 11, 0, 14);
  addText(`Generated ${params.generatedAt}`, 9, 0, 12);
  y -= 8;
  commands.push(pdfLine(marginX, y, pageWidth - marginX, y));
  y -= 12;

  for (const section of params.sections) {
    addSection(section);
  }

  footer();
  pages.push(commands.join("\n"));

  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const fontObjectId = 3 + pages.length * 2;
  const boldFontObjectId = fontObjectId + 1;
  const pageObjectIds: number[] = [];

  pages.forEach((content, index) => {
    const pageObjectId = 3 + index * 2;
    const contentObjectId = pageObjectId + 1;
    pageObjectIds.push(pageObjectId);
    objects[pageObjectId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontObjectId} 0 R /F2 ${boldFontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`;
    objects[contentObjectId] = `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
  });

  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[fontObjectId] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objects[boldFontObjectId] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(pdf, "latin1");
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length}\n`;
  pdf += "0000000000 65535 f \n";
  for (let id = 1; id < objects.length; id += 1) {
    pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, "latin1");
}

function canExportEventSettlement(params: {
  isPlatformAdmin: boolean;
  organizerUserRole: string | null;
  studioRole: string | null;
  isStudioHosted: boolean;
}) {
  const { isPlatformAdmin, organizerUserRole, studioRole, isStudioHosted } = params;

  if (isPlatformAdmin) return true;

  if (["organizer_owner", "organizer_admin", "organizer_staff"].includes(organizerUserRole ?? "")) {
    return true;
  }

  if (isStudioHosted && ["studio_owner", "studio_admin"].includes(studioRole ?? "")) {
    return true;
  }

  return false;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const context = await getCurrentStudioContext();

  if (!context?.studioId) {
    return new NextResponse("No active workspace was found.", { status: 401 });
  }

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("id, studio_id, organizer_id, name, slug, status, event_type, start_date")
    .eq("id", id)
    .eq("studio_id", context.studioId)
    .maybeSingle();

  if (eventError) {
    return new NextResponse(`Failed to load event: ${eventError.message}`, { status: 500 });
  }

  if (!event) {
    return new NextResponse("Event not found", { status: 404 });
  }

  const typedEvent = event as EventRow;
  const isStudioHosted = !typedEvent.organizer_id;
  let organizerUserRole: string | null = null;

  if (typedEvent.organizer_id) {
    const { data: organizerUser, error: organizerUserError } = await supabase
      .from("organizer_users")
      .select("role")
      .eq("organizer_id", typedEvent.organizer_id)
      .eq("user_id", user.id)
      .eq("active", true)
      .maybeSingle();

    if (organizerUserError) {
      return new NextResponse(`Could not verify organizer role: ${organizerUserError.message}`, {
        status: 500,
      });
    }

    organizerUserRole = organizerUser?.role ?? null;
  }

  const canExport = canExportEventSettlement({
    isPlatformAdmin: Boolean(context.isPlatformAdmin),
    organizerUserRole,
    studioRole: context.studioRole ?? null,
    isStudioHosted,
  });

  if (!canExport) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const [profitabilityResult, registrationsResult, attendeesResult, settlementResult] = await Promise.all([
    (supabase as any)
      .from("v_event_profit_loss")
      .select("gross_ticket_revenue, refunds, processing_and_platform_fees, net_ticket_revenue, event_expenses, event_labor_costs, total_event_costs, event_profit_loss")
      .eq("event_id", typedEvent.id)
      .maybeSingle(),
    supabase
      .from("event_registrations")
      .select("id, payment_status, status, quantity, checked_in_at")
      .eq("event_id", typedEvent.id)
      .limit(10000),
    supabase
      .from("event_registration_attendees")
      .select("id, checked_in_at")
      .eq("event_id", typedEvent.id)
      .limit(10000),
    (supabase as any)
      .from("event_settlements")
      .select("status, notes, gross_ticket_revenue, refunds, processing_and_platform_fees, net_ticket_revenue, event_expenses, event_labor_costs, total_event_costs, event_profit_loss, margin, paid_registrations, tickets_issued, tickets_checked_in, unpaid_registrations, pending_registrations, refunded_registrations, settled_at, settled_by, updated_at")
      .eq("event_id", typedEvent.id)
      .maybeSingle(),
  ]);

  if (profitabilityResult.error) {
    return new NextResponse(`Failed to load profitability: ${profitabilityResult.error.message}`, {
      status: 500,
    });
  }

  if (registrationsResult.error) {
    return new NextResponse(`Failed to load registrations: ${registrationsResult.error.message}`, {
      status: 500,
    });
  }

  if (settlementResult.error) {
    return new NextResponse(`Failed to load settlement: ${settlementResult.error.message}`, {
      status: 500,
    });
  }

  const profitability = profitabilityResult.data as EventProfitLossRow | null;
  const settlement = settlementResult.data as SettlementRow | null;
  const registrations = (registrationsResult.data ?? []) as RegistrationRow[];
  const attendees = attendeesResult.error ? [] : ((attendeesResult.data ?? []) as AttendeeRow[]);

  const grossTicketRevenue = safeNumber(profitability?.gross_ticket_revenue);
  const refunds = safeNumber(profitability?.refunds);
  const processingAndPlatformFees = safeNumber(profitability?.processing_and_platform_fees);
  const netTicketRevenue = safeNumber(profitability?.net_ticket_revenue);
  const eventExpenses = safeNumber(profitability?.event_expenses);
  const eventLaborCosts = safeNumber(profitability?.event_labor_costs);
  const totalEventCosts = safeNumber(profitability?.total_event_costs) || eventExpenses + eventLaborCosts;
  const eventProfitLoss = safeNumber(profitability?.event_profit_loss);
  const margin = netTicketRevenue > 0 ? eventProfitLoss / netTicketRevenue : null;

  const paidRegistrations = registrations.filter((registration) =>
    ["paid", "partial", "comped", "free"].includes((registration.payment_status ?? "").toLowerCase()),
  ).length;
  const unpaidRegistrations = registrations.filter((registration) =>
    ["unpaid", "failed", "requires_payment"].includes((registration.payment_status ?? "").toLowerCase()),
  ).length;
  const pendingRegistrations = registrations.filter((registration) =>
    ["pending", "processing", "requires_action"].includes((registration.payment_status ?? "").toLowerCase()),
  ).length;
  const refundedRegistrations = registrations.filter((registration) => {
    const paymentStatus = (registration.payment_status ?? "").toLowerCase();
    const registrationStatus = (registration.status ?? "").toLowerCase();
    return paymentStatus.includes("refund") || registrationStatus.includes("refund");
  }).length;

  const ticketsIssued = attendees.length;
  const ticketsCheckedIn = attendees.filter((attendee) => attendee.checked_in_at).length;
  const checkInRate = ticketsIssued > 0 ? ticketsCheckedIn / ticketsIssued : null;
  const settlementStatus = settlement?.status ?? "open";
  const eventName = typedEvent.name ?? "Untitled event";

  const sections: PdfSection[] = [
    {
      title: "Event Summary",
      rows: [
        ["Event Name", eventName],
        ["Event ID", typedEvent.id],
        ["Event Type", typedEvent.event_type ?? "event"],
        ["Event Date", formatDateTime(typedEvent.start_date)],
        ["Event Status", typedEvent.status ?? ""],
      ],
    },
    {
      title: "Settlement Status",
      rows: [
        ["Closeout Status", settlementStatus.replaceAll("_", " ")],
        ["Closeout Notes", settlement?.notes ?? ""],
        ["Settled At", formatDateTime(settlement?.settled_at)],
        ["Settled By", settlement?.settled_by ?? ""],
        ["Last Updated", formatDateTime(settlement?.updated_at)],
      ],
    },
    {
      title: "Revenue",
      rows: [
        ["Gross Ticket Revenue", formatMoney(grossTicketRevenue)],
        ["Refunds", `-${formatMoney(refunds)}`],
        ["Processing and Platform Fees", `-${formatMoney(processingAndPlatformFees)}`],
        ["Net Ticket Revenue", formatMoney(netTicketRevenue)],
      ],
    },
    {
      title: "Costs and Profitability",
      rows: [
        ["Event Expenses", `-${formatMoney(eventExpenses)}`],
        ["Labor / Staff Costs", `-${formatMoney(eventLaborCosts)}`],
        ["Total Event Costs", `-${formatMoney(totalEventCosts)}`],
        ["Final Profit / Loss", formatMoney(eventProfitLoss)],
        ["Margin", formatPercent(margin)],
      ],
    },
    {
      title: "Registrations and Attendance",
      rows: [
        ["Paid Registrations", String(settlement?.paid_registrations ?? paidRegistrations)],
        ["Unpaid Registrations", String(settlement?.unpaid_registrations ?? unpaidRegistrations)],
        ["Pending Registrations", String(settlement?.pending_registrations ?? pendingRegistrations)],
        ["Refunded Registrations", String(settlement?.refunded_registrations ?? refundedRegistrations)],
        ["Tickets Issued", String(settlement?.tickets_issued ?? ticketsIssued)],
        ["Tickets Checked In", String(settlement?.tickets_checked_in ?? ticketsCheckedIn)],
        ["Check-In Rate", formatPercent(checkInRate)],
      ],
    },
  ];

  if (settlement) {
    sections.push({
      title: "Saved Settlement Snapshot",
      rows: [
        ["Gross Ticket Revenue", formatMoney(safeNumber(settlement.gross_ticket_revenue))],
        ["Refunds", `-${formatMoney(safeNumber(settlement.refunds))}`],
        ["Processing and Platform Fees", `-${formatMoney(safeNumber(settlement.processing_and_platform_fees))}`],
        ["Net Ticket Revenue", formatMoney(safeNumber(settlement.net_ticket_revenue))],
        ["Event Expenses", `-${formatMoney(safeNumber(settlement.event_expenses))}`],
        ["Labor / Staff Costs", `-${formatMoney(safeNumber(settlement.event_labor_costs))}`],
        ["Total Event Costs", `-${formatMoney(safeNumber(settlement.total_event_costs))}`],
        ["Final Profit / Loss", formatMoney(safeNumber(settlement.event_profit_loss))],
        ["Margin", formatPercent(safeNumber(settlement.margin))],
      ],
    });
  }

  const pdf = buildSettlementPdf({
    title: "Event Settlement Report",
    subtitle: eventName,
    generatedAt: formatDateTime(new Date().toISOString()),
    sections,
  });

  const filename = `danceflow-event-settlement-${slugifyFilename(eventName)}.pdf`;

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
