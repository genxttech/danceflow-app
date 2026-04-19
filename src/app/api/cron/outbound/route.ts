import { dispatchQueuedOutboundDeliveries } from "@/lib/notifications/dispatch";

function isAuthorized(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true;

  const authHeader = request.headers.get("authorization");
  return authHeader === `Bearer ${expected}`;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

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