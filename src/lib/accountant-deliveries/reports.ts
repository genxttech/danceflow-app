import { createAdminClient } from "@/lib/supabase/admin";
import { getStudioAccountingEntries } from "@/lib/accounting/entries";
import { toCsv } from "@/lib/utils/csv";

const supported = ["profit_loss", "accounting_ledger", "payments_refunds", "expenses", "event_profitability"] as const;
export type AccountantReportType = (typeof supported)[number];
export function isSupportedAccountantReport(value: string): value is AccountantReportType { return supported.includes(value as AccountantReportType); }

function rangeStart(range: string) {
  const now = new Date();
  if (range === "quarter") return new Date(now.getFullYear(), Math.floor(now.getMonth()/3)*3, 1);
  if (range === "year") return new Date(now.getFullYear(), 0, 1);
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export async function buildAccountantReport(params: { studioId: string; reportType: AccountantReportType; range: string }) {
  const supabase = createAdminClient();
  const start = rangeStart(params.range);
  const startIso = start.toISOString();
  const endIso = new Date().toISOString();
  const startDate = startIso.slice(0,10);
  const endDate = endIso.slice(0,10);

  if (params.reportType === "accounting_ledger" || params.reportType === "profit_loss") {
    const entries = await getStudioAccountingEntries({ supabase, studioId: params.studioId, startDate: startIso, endDate: endIso });
    if (params.reportType === "accounting_ledger") {
      return { filename: `danceflow-accounting-ledger-${params.range}.csv`, csv: toCsv([
        "Entry Date","Entry Type","Category","Direction","Gross Amount","Fee Amount","Refund Amount","Net Amount","Currency","Payment Method","Source Table","Source ID","Status","Description","Created At"
      ], entries.map((e) => [e.entryDate,e.entryType,e.category,e.direction,e.grossAmount,e.feeAmount,e.refundAmount,e.netAmount,e.currency,e.paymentMethod,e.sourceTable,e.sourceId,e.status,e.description,e.createdAt])) };
    }
    const totals = entries.reduce((a,e) => { if(e.entryType === "revenue") a.revenue += e.grossAmount; if(e.entryType === "refund") a.refunds += Math.abs(e.refundAmount || e.netAmount); if(e.entryType === "processing_fee" || e.entryType === "platform_fee") a.fees += Math.abs(e.netAmount || e.feeAmount); if(e.entryType === "expense") a.expenses += Math.abs(e.netAmount); return a; }, { revenue:0, refunds:0, fees:0, expenses:0 });
    const net = totals.revenue - totals.refunds - totals.fees - totals.expenses;
    return { filename: `danceflow-profit-loss-${params.range}.csv`, csv: toCsv(["Metric","Amount"], [["Gross Revenue",totals.revenue],["Refunds",totals.refunds],["Fees",totals.fees],["Expenses",totals.expenses],["Estimated Net",net]]) };
  }

  if (params.reportType === "payments_refunds") {
    const { data, error } = await supabase.from("payments").select("id,amount,payment_method,status,created_at,notes,refunded_amount,refund_amount").eq("studio_id", params.studioId).gte("created_at", startIso).lte("created_at", endIso).order("created_at", { ascending:false }).limit(5000);
    if (error) throw new Error(error.message);
    return { filename:`danceflow-payments-refunds-${params.range}.csv`, csv:toCsv(["Payment ID","Amount","Refunded Amount","Payment Method","Status","Created At","Notes"], (data??[]).map((r) => [r.id,r.amount,Math.max(Number(r.refunded_amount??0),Number(r.refund_amount??0)),r.payment_method,r.status,r.created_at,r.notes])) };
  }

  if (params.reportType === "expenses") {
    const { data, error } = await supabase.from("expenses").select("id,expense_date,vendor_name,category,amount,currency,payment_method,notes,created_at").eq("studio_id", params.studioId).gte("expense_date", startDate).lte("expense_date", endDate).order("expense_date", { ascending:false }).limit(5000);
    if (error) throw new Error(error.message);
    return { filename:`danceflow-expenses-${params.range}.csv`, csv:toCsv(["Expense ID","Expense Date","Vendor","Category","Amount","Currency","Payment Method","Notes","Created At"], (data??[]).map((r) => [r.id,r.expense_date,r.vendor_name,r.category,r.amount,r.currency,r.payment_method,r.notes,r.created_at])) };
  }

  const { data, error } = await supabase.from("accounting_entries").select("event_id,source_table,category,gross_amount,fee_amount,refund_amount,net_amount").eq("studio_id", params.studioId).not("event_id","is",null).gte("entry_date",startDate).lte("entry_date",endDate).in("source_table",["event_payments","expenses","event_labor_costs"]).limit(10000);
  if (error) throw new Error(error.message);
  const map = new Map<string,{gross:number;refunds:number;fees:number;expenses:number;labor:number;net:number}>();
  for (const r of data??[]) { const id=r.event_id as string; const v=map.get(id)??{gross:0,refunds:0,fees:0,expenses:0,labor:0,net:0}; if(r.source_table==="event_payments"){v.gross+=Number(r.gross_amount??0);v.refunds+=Math.abs(Number(r.refund_amount??0));v.fees+=Math.abs(Number(r.fee_amount??0));v.net+=Number(r.net_amount??0);} else if(r.source_table==="event_labor_costs") v.labor+=Math.abs(Number(r.net_amount??0)); else v.expenses+=Math.abs(Number(r.net_amount??0)); map.set(id,v); }
  return { filename:`danceflow-event-profitability-${params.range}.csv`, csv:toCsv(["Event ID","Gross Revenue","Refunds","Fees","Net Ticket Revenue","Event Expenses","Labor Costs","Profit Loss"], Array.from(map.entries()).map(([id,v])=>[id,v.gross,v.refunds,v.fees,v.net,v.expenses,v.labor,v.net-v.expenses-v.labor])) };
}
