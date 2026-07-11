import { dispatchQueuedOutboundDeliveries } from "@/lib/notifications/dispatch";
import { getCronAuthFailure } from "@/lib/security/cron";

export async function POST(request: Request) {
  const authFailure = getCronAuthFailure(request);
  if (authFailure) return authFailure;

  try {
    const result = await dispatchQueuedOutboundDeliveries(50);

    return Response.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown dispatch error",
      },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  return POST(request);
}