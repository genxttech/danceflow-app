import { NextResponse } from "next/server";
import { requireEventWorkspaceFeature } from "@/lib/billing/access";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";

type RouteContext = {
  params: Promise<{
    id: string;
    registrationId: string;
    signatureId: string;
  }>;
};

type EventRow = {
  id: string;
  name: string | null;
  start_date: string | null;
};

type RegistrationRow = {
  id: string;
  attendee_first_name: string;
  attendee_last_name: string;
  attendee_email: string;
  attendee_phone: string | null;
  created_at: string;
};

type SignatureRow = {
  id: string;
  assignment_id: string | null;
  signer_name: string;
  signer_email: string | null;
  signer_user_id: string | null;
  signature_method: string | null;
  signature_text: string | null;
  consent_text: string | null;
  signed_body: string | null;
  ip_address: string | null;
  user_agent: string | null;
  device_metadata: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  signed_at: string;
  document_templates:
    | { title: string | null; description: string | null }
    | { title: string | null; description: string | null }[]
    | null;
  document_template_versions:
    | { version_number: number | null; title: string | null; body: string | null }
    | { version_number: number | null; title: string | null; body: string | null }[]
    | null;
};

type AuditEventRow = {
  id: string;
  event_type: string;
  event_summary: string | null;
  actor_email: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
};

type PdfSection = {
  rows?: Array<[string, string]>;
  text?: string;
  title: string;
};

function one<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function formatDateTime(value: string | null | undefined) {
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

function friendlyValue(value: string | null | undefined) {
  const normalized = (value ?? "").trim();
  if (!normalized) return "Not recorded";
  return normalized.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function compactJson(value: Record<string, unknown> | null) {
  if (!value || Object.keys(value).length === 0) return "";
  return JSON.stringify(value);
}

function slugifyFilename(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);

  return slug || "signed-document";
}

function documentTitle(signature: SignatureRow) {
  return one(signature.document_template_versions)?.title ??
    one(signature.document_templates)?.title ??
    "Signed document";
}

function documentBody(signature: SignatureRow) {
  return signature.signed_body ??
    one(signature.document_template_versions)?.body ??
    "Signed document body was not recorded.";
}

function versionLabel(signature: SignatureRow) {
  const version = one(signature.document_template_versions);
  return typeof version?.version_number === "number"
    ? `Version ${version.version_number}`
    : "Version not recorded";
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
  return normalizePdfText(value)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
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
  return lines.length ? lines : [""];
}

function pdfTextLine(text: string, x: number, y: number, size = 10, font = "F1") {
  return `BT /${font} ${size} Tf ${x} ${y} Td (${escapePdfText(text)}) Tj ET`;
}

function pdfLine(x1: number, y1: number, x2: number, y2: number) {
  return `${x1} ${y1} m ${x2} ${y2} l S`;
}

function buildSignedDocumentPdf(params: {
  generatedAt: string;
  sections: PdfSection[];
  subtitle: string;
  title: string;
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
    commands.push(pdfTextLine(`DanceFlow Signed Document Receipt - Page ${pageNumber}`, marginX, 32, 8));
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
    if (y - required < bottomY) newPage();
  }

  function addText(text: string, size = 10, indent = 0, gap = 14, maxChars = maxTextChars) {
    for (const line of wrapPdfText(text, maxChars - Math.floor(indent / 5))) {
      ensureSpace(gap + 2);
      commands.push(pdfTextLine(line, marginX + indent, y, size));
      y -= gap;
    }
  }

  function addRows(rows: Array<[string, string]>) {
    for (const [label, value] of rows) {
      const wrapped = wrapPdfText(value || "-", 62);
      ensureSpace(Math.max(18, wrapped.length * 12 + 4));
      commands.push(pdfTextLine(label, marginX, y, 10, "F2"));
      commands.push(pdfTextLine(wrapped[0] || "-", marginX + 190, y, 10));
      y -= 12;
      for (const continuation of wrapped.slice(1)) {
        commands.push(pdfTextLine(continuation, marginX + 190, y, 10));
        y -= 12;
      }
      y -= 3;
    }
  }

  function addSection(section: PdfSection) {
    ensureSpace(50);
    y -= 8;
    commands.push(pdfTextLine(section.title, marginX, y, 13, "F2"));
    y -= 8;
    commands.push(pdfLine(marginX, y, pageWidth - marginX, y));
    y -= 18;

    if (section.rows) addRows(section.rows);
    if (section.text) addText(section.text, 10, 0, 13, 94);
  }

  newPage();
  commands.push(pdfTextLine(params.title, marginX, y, 20, "F2"));
  y -= 24;
  addText(params.subtitle, 11, 0, 14);
  addText(`Generated ${params.generatedAt}`, 9, 0, 12);
  y -= 8;
  commands.push(pdfLine(marginX, y, pageWidth - marginX, y));
  y -= 12;

  params.sections.forEach(addSection);

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

export async function GET(_request: Request, context: RouteContext) {
  const { id, registrationId, signatureId } = await context.params;

  await requireEventWorkspaceFeature({
    eventId: id,
    feature: "organizer_tools",
    allowedOrganizerRoles: ["organizer_owner", "organizer_admin", "organizer_staff"],
  });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const contextWorkspace = await getCurrentStudioContext();
  const studioId = contextWorkspace.studioId;

  const [
    { data: event, error: eventError },
    { data: registration, error: registrationError },
    { data: signature, error: signatureError },
    { data: auditEvents, error: auditError },
  ] = await Promise.all([
    supabase
      .from("events")
      .select("id, name, start_date")
      .eq("id", id)
      .eq("studio_id", studioId)
      .maybeSingle<EventRow>(),
    supabase
      .from("event_registrations")
      .select("id, attendee_first_name, attendee_last_name, attendee_email, attendee_phone, created_at")
      .eq("id", registrationId)
      .eq("event_id", id)
      .maybeSingle<RegistrationRow>(),
    supabase
      .from("document_signatures")
      .select(
        `
        id,
        assignment_id,
        signer_name,
        signer_email,
        signer_user_id,
        signature_method,
        signature_text,
        consent_text,
        signed_body,
        ip_address,
        user_agent,
        device_metadata,
        metadata,
        signed_at,
        document_templates ( title, description ),
        document_template_versions ( version_number, title, body )
      `,
      )
      .eq("id", signatureId)
      .eq("event_registration_id", registrationId)
      .eq("event_id", id)
      .maybeSingle<SignatureRow>(),
    supabase
      .from("document_signature_audit_events")
      .select("id, event_type, event_summary, actor_email, ip_address, user_agent, created_at")
      .eq("signature_id", signatureId)
      .order("created_at", { ascending: true }),
  ]);

  if (eventError) return new NextResponse(`Failed to load event: ${eventError.message}`, { status: 500 });
  if (registrationError) return new NextResponse(`Failed to load registration: ${registrationError.message}`, { status: 500 });
  if (signatureError) return new NextResponse(`Failed to load signature: ${signatureError.message}`, { status: 500 });
  if (auditError) return new NextResponse(`Failed to load audit trail: ${auditError.message}`, { status: 500 });
  if (!event || !registration || !signature) return new NextResponse("Signed document not found", { status: 404 });

  const typedEvent = event as EventRow;
  const typedRegistration = registration as RegistrationRow;
  const typedSignature = signature as SignatureRow;
  const typedAuditEvents = (auditEvents ?? []) as AuditEventRow[];
  const eventName = typedEvent.name ?? "Event";
  const attendeeName =
    `${typedRegistration.attendee_first_name} ${typedRegistration.attendee_last_name}`.trim() ||
    typedRegistration.attendee_email;
  const title = documentTitle(typedSignature);

  const auditText = typedAuditEvents.length
    ? typedAuditEvents
        .map((event) =>
          [
            `${friendlyValue(event.event_type)} - ${formatDateTime(event.created_at)}`,
            event.event_summary,
            event.actor_email ? `Actor: ${event.actor_email}` : null,
            event.ip_address ? `IP: ${event.ip_address}` : null,
            event.user_agent ? `User agent: ${event.user_agent}` : null,
          ]
            .filter(Boolean)
            .join(" | "),
        )
        .join("\n")
    : "No audit events were recorded for this signature.";

  const pdf = buildSignedDocumentPdf({
    title: "Signed Document Receipt",
    subtitle: `${title} - ${eventName}`,
    generatedAt: formatDateTime(new Date().toISOString()),
    sections: [
      {
        title: "Event and Registration",
        rows: [
          ["Event", eventName],
          ["Event Date", formatDateTime(typedEvent.start_date)],
          ["Registration ID", typedRegistration.id],
          ["Registered", formatDateTime(typedRegistration.created_at)],
          ["Attendee", attendeeName],
          ["Attendee Email", typedRegistration.attendee_email],
          ["Attendee Phone", typedRegistration.attendee_phone ?? ""],
        ],
      },
      {
        title: "Signature Evidence",
        rows: [
          ["Signer Name", typedSignature.signer_name],
          ["Signer Email", typedSignature.signer_email ?? typedRegistration.attendee_email],
          ["Signed At", formatDateTime(typedSignature.signed_at)],
          ["Document Version", versionLabel(typedSignature)],
          ["Signature Method", friendlyValue(typedSignature.signature_method ?? "typed")],
          ["Signature Text", typedSignature.signature_text ?? ""],
          ["IP Address", typedSignature.ip_address ?? ""],
          ["Signer User ID", typedSignature.signer_user_id ?? ""],
          ["Signature ID", typedSignature.id],
          ["Assignment ID", typedSignature.assignment_id ?? ""],
        ],
      },
      {
        title: "Consent Accepted",
        text: typedSignature.consent_text ?? "Consent text was not recorded.",
      },
      {
        title: "Signed Document Text",
        text: documentBody(typedSignature),
      },
      {
        title: "Technical Metadata",
        rows: [
          ["User Agent", typedSignature.user_agent ?? ""],
          ["Device Metadata", compactJson(typedSignature.device_metadata)],
          ["Signature Metadata", compactJson(typedSignature.metadata)],
        ],
      },
      {
        title: "Audit Trail",
        text: auditText,
      },
    ],
  });

  const filename = `danceflow-signed-document-${slugifyFilename(title)}-${slugifyFilename(attendeeName)}.pdf`;

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": "application/pdf",
    },
  });
}
