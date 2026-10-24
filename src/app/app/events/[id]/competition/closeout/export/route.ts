import { NextResponse } from "next/server";
import { loadCompetitionWorkspace } from "@/lib/competition/workspaceServer";
import { loadCompetitionCloseout } from "@/lib/competition/closeout/load";
import { closeoutCsv, isCloseoutCsvKind } from "@/lib/competition/closeout/pnlCsv";

/**
 * C1 closeout CSV (read only). Managers of this competition only; the event is looked up inside the caller's
 * studio, so another tenant's event id answers 404. There is no anonymous or public path.
 *   GET .../competition/closeout/export?kind=pnl|lines|refunds
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const kind = new URL(request.url).searchParams.get("kind") ?? "pnl";
  if (!isCloseoutCsvKind(kind)) {
    return NextResponse.json({ error: "Unknown export." }, { status: 400 });
  }

  // Redirects anonymous callers to login, 404s unknown events and non-managers.
  const { supabase, event, canManage } = await loadCompetitionWorkspace(id);
  if (!canManage) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const { pnl } = await loadCompetitionCloseout(supabase, event);
  return new NextResponse(closeoutCsv(kind, pnl), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="competition-closeout-${kind}.csv"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
