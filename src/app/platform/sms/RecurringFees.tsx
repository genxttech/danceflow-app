import type { RflOps } from "@/lib/sms/providerFeeOps";
import RecurringFeesCancel from "./RecurringFeesCancel";
import RecurringFeesDual from "./RecurringFeesDual";
import RecurringFeesExposure from "./RecurringFeesExposure";
import RecurringFeesHealth from "./RecurringFeesHealth";
import RecurringFeesPilot from "./RecurringFeesPilot";
import RecurringFeesVariances from "./RecurringFeesVariances";

/**
 * Platform-administrator operations for recurring PROVIDER fees (the monthly rent Twilio bills for numbers, campaigns and Messaging Services). Dark: it reads
 * and writes only through server-side-authorized actions, and every block says "not available" when its database function is not installed here.
 * Nothing on this panel renews, charges a studio, enables a schedule, or cancels anything at Twilio. Cents appear as dollars in this administrator panel only.
 */
export default function RecurringFees({ ops, adminId, now, notice = null, error = null }: { ops: RflOps; adminId: string; now: number; notice?: string | null; error?: string | null }) {
  const none = !ops.health && !ops.overview && !ops.exposures && !ops.variances && !ops.dual;
  return (
    <section id="recurring-fees" aria-labelledby="recurring-fees-title" className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
      <h2 id="recurring-fees-title" className="text-base font-semibold text-slate-900">Recurring provider fees</h2>
      <p className="text-sm text-slate-700">
        Operations for the monthly fees Twilio bills for provider resources. DanceFlow bears unauthorized provider cost; it is never billed to a studio retroactively.
        Nothing here renews or charges anything, and nothing here cancels anything at Twilio.
      </p>
      {notice ? <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{notice}</p> : null}
      {error ? <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p> : null}
      {none ? <p className="text-sm text-slate-600">Not available: recurring provider fee operations are not installed in this environment.</p> : null}
      <RecurringFeesHealth health={ops.health} />
      <RecurringFeesExposure exposures={ops.exposures} dual={ops.dual} />
      <RecurringFeesVariances variances={ops.variances} />
      <RecurringFeesDual dual={ops.dual} overview={ops.overview} adminId={adminId} />
      <RecurringFeesCancel overview={ops.overview} dual={ops.dual} />
      <RecurringFeesPilot overview={ops.overview} now={now} />
    </section>
  );
}
