import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashAccountantDeliveryToken } from "@/lib/accountant-deliveries/tokens";
import {
  buildAccountantReport,
  isSupportedAccountantReport,
} from "@/lib/accountant-deliveries/reports";

function isValidDeliveryToken(token: string) {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

function unavailableResponse() {
  return new NextResponse("Link unavailable", {
    status: 404,
    headers: {
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(
  _request: Request,
  {
    params,
  }: {
    params: Promise<{ token: string; reportType: string }>;
  },
) {
  const { token, reportType } = await params;

  if (!isValidDeliveryToken(token) || !isSupportedAccountantReport(reportType)) {
    return unavailableResponse();
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("studio_accountant_deliveries")
    .select("id,studio_id,report_types,report_range,status,expires_at")
    .eq("token_hash", hashAccountantDeliveryToken(token))
    .maybeSingle();

  const expired =
    !data?.expires_at || new Date(data.expires_at).getTime() <= Date.now();
  const accessibleStatus = data?.status === "queued" || data?.status === "sent";
  const reportAllowed = (data?.report_types ?? []).includes(reportType);

  if (error || !data || expired || !accessibleStatus || !reportAllowed) {
    return unavailableResponse();
  }

  try {
    const result = await buildAccountantReport({
      studioId: data.studio_id,
      reportType,
      range: data.report_range,
    });

    const { error: auditError } = await supabase.rpc(
      "record_accountant_delivery_download",
      {
        p_delivery_id: data.id,
      },
    );

    if (auditError) {
      console.error("Failed to record accountant report download", {
        deliveryId: data.id,
        reportType,
        error: auditError,
      });
    }

    return new NextResponse(result.csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (caught) {
    console.error("Accountant report download failed", {
      deliveryId: data.id,
      reportType,
      error: caught,
    });

    return new NextResponse("Report could not be generated.", {
      status: 500,
      headers: {
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
}
