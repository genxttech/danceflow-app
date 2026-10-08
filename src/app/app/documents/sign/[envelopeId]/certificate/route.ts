import { NextResponse } from "next/server";
import { PDFDocument, PDFFont, StandardFonts, rgb } from "pdf-lib";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canManageDocumentsRole } from "@/lib/documents/studio-access";
import { sha256Hex } from "@/lib/documents/pdf";
import { buildCertificateModel, certificateSafeText, type CertificateEvent } from "@/lib/documents/certificate";

/** Phase 8C: wraps text to the column width so long values (hashes, user agents, consent) never overflow. */
function wrap(font: PDFFont, text: string, size: number, maxWidth: number) {
  const out: string[] = [];
  for (const paragraph of certificateSafeText(text).split(/\n/)) {
    let current = "";
    for (const word of paragraph.split(/\s+/)) {
      const pieces = font.widthOfTextAtSize(word, size) > maxWidth ? word.match(/.{1,40}/g) ?? [word] : [word];
      for (const piece of pieces) {
        const candidate = current ? `${current} ${piece}` : piece;
        if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
          out.push(current);
          current = piece;
        } else {
          current = candidate;
        }
      }
    }
    out.push(current);
  }
  return out;
}
function unavailable() { return new NextResponse("Certificate unavailable", { status: 404 }); }
export async function GET(_request: Request, { params }: { params: Promise<{ envelopeId: string }> }) {
  const { envelopeId } = await params; const context = await getCurrentStudioContext(); if (!canManageDocumentsRole(context.studioRole)) return new NextResponse("Not found", { status: 404 }); const admin = createAdminClient();
  const { data: envelope } = await admin.from("document_sign_envelopes").select("id,title,status,client_id,template_id,template_version_id,source_kind,signer_name,signer_email,source_sha256,signed_sha256,signed_bucket,signed_path,sent_at,viewed_at,started_at,completed_at,signature_method,signed_timezone,consent_text").eq("id", envelopeId).eq("studio_id", context.studioId).maybeSingle();
  if (!envelope || envelope.status !== "completed") return unavailable();
  if (!envelope.signed_bucket || !envelope.signed_path || !envelope.signed_sha256) return unavailable();
  try {
    const { data: signedBlob, error: downloadError } = await admin.storage.from(envelope.signed_bucket).download(envelope.signed_path);
    if (downloadError || !signedBlob) return unavailable();
    const signedBytes = new Uint8Array(await signedBlob.arrayBuffer());
    if (sha256Hex(signedBytes) !== envelope.signed_sha256) return unavailable();
  } catch {
    return unavailable();
  }
  const { data: studio } = await admin.from("studios").select("name,public_name,public_logo_url").eq("id", context.studioId).maybeSingle();
  const studioName = studio?.public_name || studio?.name || "Your studio";
  const pdf = await PDFDocument.create(); const page = pdf.addPage([612,792]); const regular = await pdf.embedFont(StandardFonts.Helvetica); const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let brandTextX = 54;
  if (studio?.public_logo_url) {
    try {
      const response = await fetch(studio.public_logo_url, { cache: "no-store", signal: AbortSignal.timeout(5000) });
      const contentType = response.headers.get("content-type")?.split(";")[0]?.toLowerCase();
      const logoBytes = new Uint8Array(await response.arrayBuffer());
      if (response.ok && logoBytes.length <= 2 * 1024 * 1024 && (contentType === "image/png" || contentType === "image/jpeg")) {
        const logo = contentType === "image/png" ? await pdf.embedPng(logoBytes) : await pdf.embedJpg(logoBytes);
        const natural = logo.scale(1);
        const scale = Math.min(74 / natural.width, 42 / natural.height, 1);
        const width = natural.width * scale;
        const height = natural.height * scale;
        page.drawImage(logo, { x:54, y:718, width, height });
        brandTextX = 54 + width + 12;
      }
    } catch {
      // Certificate generation must continue even when a remote logo cannot be loaded.
    }
  }
  page.drawText(certificateSafeText(studioName), { x:brandTextX, y:735, size:13, font:bold, color:rgb(.35,.12,.45), maxWidth:612-brandTextX-54 }); page.drawText("Completion Certificate", { x:54, y:695, size:24, font:bold, color:rgb(.08,.08,.12) });
  page.drawText("This certificate summarizes the recorded signing evidence and file integrity values.", { x:54, y:668, size:10, font:regular, color:rgb(.35,.35,.42) });

  // Phase 8C: immutable evidence only -- the envelope, its recorded audit events and the issued template VERSION.
  const [{ data: events }, { data: client }, { data: version }] = await Promise.all([
    admin.from("document_sign_events").select("event_type,actor_user_id,actor_email,ip_address,user_agent,metadata,created_at").eq("envelope_id", envelope.id).order("created_at", { ascending: true }),
    envelope.client_id
      ? admin.from("clients").select("first_name,last_name").eq("id", envelope.client_id).eq("studio_id", context.studioId).maybeSingle()
      : Promise.resolve({ data: null }),
    envelope.template_version_id
      ? admin.from("document_template_versions").select("title,version_number").eq("id", envelope.template_version_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const clientName = client ? [client.first_name, client.last_name].filter(Boolean).join(" ").trim() || null : null;
  const model = buildCertificateModel({
    envelope,
    events: (events ?? []) as CertificateEvent[],
    clientName,
    template: version ? { title: version.title ?? null, versionNumber: Number(version.version_number ?? 0) || null } : null,
  });

  let current = page;
  let y = 630;
  const ensure = (needed: number) => {
    if (y - needed < 72) {
      current = pdf.addPage([612, 792]);
      y = 740;
    }
  };
  const heading = (text: string) => {
    ensure(34);
    y -= 10;
    current.drawText(text, { x:54, y, size:11, font:bold, color:rgb(.08,.08,.12) });
    y -= 18;
  };
  for (const row of model.rows) {
    const lines = wrap(regular, row.value || "Not recorded", 9.5, 360);
    ensure(lines.length * 13 + 6);
    current.drawText(certificateSafeText(row.label), { x:54, y, size:9.5, font:regular, color:rgb(.35,.35,.42) });
    for (const text of lines) {
      current.drawText(text, { x:180, y, size:9.5, font:regular, color:rgb(.08,.08,.12) });
      y -= 13;
    }
    y -= 5;
  }
  heading("Evidence timeline");
  if (!model.timeline.length) {
    current.drawText("No signing events were recorded.", { x:54, y, size:9, font:regular, color:rgb(.35,.35,.42) });
    y -= 14;
  }
  for (const entry of model.timeline) {
    const lines = wrap(regular, `${entry.label}${entry.detail ? ` - ${entry.detail}` : ""}`, 9, 360);
    ensure(lines.length * 12 + 4);
    current.drawText(entry.at, { x:54, y, size:9, font:regular, color:rgb(.35,.35,.42) });
    for (const text of lines) {
      current.drawText(text, { x:180, y, size:9, font:regular, color:rgb(.08,.08,.12) });
      y -= 12;
    }
    y -= 3;
  }
  heading("Electronic signature consent");
  for (const text of wrap(regular, model.consentText, 9, 500)) {
    ensure(13);
    current.drawText(text, { x:54, y, size:9, font:regular, color:rgb(.25,.25,.3) });
    y -= 13;
  }
  current.drawText(certificateSafeText(`Generated by DanceFlow Sign on behalf of ${studioName}`), { x:54, y:54, size:9, font:regular, color:rgb(.45,.45,.5), maxWidth:500 });
  const bytes = await pdf.save(); const filename = `${String(envelope.title).replace(/[^a-z0-9]+/gi,"-").replace(/^-|-$/g,"").toLowerCase() || "document"}-certificate.pdf`;
  return new NextResponse(Buffer.from(bytes), { headers: { "Content-Type":"application/pdf", "Content-Disposition":`attachment; filename="${filename}"`, "Cache-Control":"private, no-store" } });
}
