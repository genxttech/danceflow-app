import { NextRequest } from "next/server";
import QRCode from "qrcode";

export const runtime = "nodejs";

function normalizeTicketCode(value: string | null) {
  return (value ?? "").trim().toUpperCase();
}

export async function GET(request: NextRequest) {
  const code = normalizeTicketCode(request.nextUrl.searchParams.get("code"));

  if (!code) {
    return new Response("Missing ticket code.", { status: 400 });
  }

  // Keep this intentionally narrow so the route only renders ticket-code-like values.
  if (!/^DF-[A-Z0-9-]{6,80}$/.test(code)) {
    return new Response("Invalid ticket code.", { status: 400 });
  }

  const png = await QRCode.toBuffer(code, {
    type: "png",
    margin: 2,
    scale: 8,
    errorCorrectionLevel: "M",
  });

  return new Response(new Uint8Array(png), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}