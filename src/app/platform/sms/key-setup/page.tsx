import { requirePlatformStepUp } from "@/lib/auth/platform-assurance";
import KeySetup from "./KeySetup";
import { signingToolEnabled } from "@/lib/sms/keySetup";

/**
 * One-time hardware-key setup for the SMS price authorization. Platform administrators with a fresh second-factor session only. The page writes nothing: it shows the
 * PUBLIC values of a key you create (and, only while engineering has switched it on for an enrolment proof, signs one challenge you paste), for engineering to use in the owner-level bootstrap. Not linked from the navigation.
 */
export const dynamic = "force-dynamic";

export default async function KeySetupPage() {
  await requirePlatformStepUp("fresh", "/platform/sms/key-setup");
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-4">
      <h1 className="text-lg font-semibold text-slate-900">Hardware key setup (price authorization)</h1>
      <KeySetup signingEnabled={signingToolEnabled(process.env)} />
    </main>
  );
}
