import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { createClient } from "@/lib/supabase/server";
import { signOutAction } from "@/app/(auth)/actions";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function getSingleSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeCode(value: FormDataEntryValue | null) {
  return String(value ?? "").replace(/\s/g, "").trim();
}

function getVerifiedTotpFactorCount(factorsData: unknown) {
  const factors = factorsData as
    | {
        totp?: { id: string; status?: string | null }[];
        all?: { id: string; status?: string | null; factor_type?: string | null }[];
      }
    | null
    | undefined;

  const totpFactors = Array.isArray(factors?.totp)
    ? factors.totp
    : Array.isArray(factors?.all)
      ? factors.all.filter((factor) => factor.factor_type === "totp")
      : [];

  return totpFactors.filter((factor) => factor.status === "verified").length;
}

export default async function PlatformMfaSetupPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  await requirePlatformAdmin();

  const resolvedSearchParams = (await searchParams) ?? {};
  const error = getSingleSearchParam(resolvedSearchParams.error);

  const supabase = await createClient();

  const { data: factorsData } = await supabase.auth.mfa.listFactors();
  const verifiedFactorCount = getVerifiedTotpFactorCount(factorsData);

  if (verifiedFactorCount > 0) {
    redirect("/platform-mfa/challenge");
  }

  const { data: enrollment, error: enrollmentError } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: "DanceFlow Platform Admin",
  });

  async function verifyMfaSetupAction(formData: FormData) {
    "use server";

    await requirePlatformAdmin();

    const factorId = String(formData.get("factorId") ?? "").trim();
    const code = normalizeCode(formData.get("code"));

    if (!factorId || !code) {
      redirect("/platform-mfa/setup?error=missing_code");
    }

    const supabase = await createClient();

    const { error } = await supabase.auth.mfa.challengeAndVerify({
      factorId,
      code,
    });

    if (error) {
      redirect("/platform-mfa/setup?error=invalid_code");
    }

    redirect("/platform");
  }

  return (
    <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_20%,#f8fafc_100%)] px-6 py-12">
      <section className="mx-auto max-w-3xl rounded-[2rem] border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-700">
          Platform Admin Security
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
          Set up MFA for platform access
        </h1>
        <p className="mt-4 text-sm leading-6 text-slate-600">
          Platform admin access requires an authenticator app code in addition to your normal DanceFlow sign-in.
        </p>

        {error ? (
          <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">
            {error === "missing_code"
              ? "Enter the 6-digit code from your authenticator app."
              : "That code did not verify. Try the current code from your authenticator app."}
          </div>
        ) : null}

        {enrollmentError || !enrollment ? (
          <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
            MFA setup could not be started. Check that MFA is enabled in Supabase Auth settings, then refresh this page.
          </div>
        ) : (
          <div className="mt-8 grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
            <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4 text-center">
              {enrollment.totp?.qr_code ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={enrollment.totp.qr_code}
                  alt="MFA QR code"
                  className="mx-auto h-52 w-52 rounded-2xl bg-white p-3 shadow-sm"
                />
              ) : null}
              {enrollment.totp?.secret ? (
                <p className="mt-4 break-all rounded-2xl bg-white p-3 text-xs font-mono text-slate-700">
                  {enrollment.totp.secret}
                </p>
              ) : null}
            </div>

            <div>
              <ol className="space-y-3 text-sm leading-6 text-slate-700">
                <li>1. Open your authenticator app.</li>
                <li>2. Scan the QR code or manually enter the secret.</li>
                <li>3. Enter the 6-digit code shown in the app.</li>
              </ol>

              <form action={verifyMfaSetupAction} className="mt-6 space-y-4">
                <input type="hidden" name="factorId" value={enrollment.id} />
                <div>
                  <label htmlFor="code" className="block text-sm font-semibold text-slate-800">
                    Authenticator Code
                  </label>
                  <input
                    id="code"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9 ]{6,10}"
                    placeholder="123456"
                    className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-lg tracking-[0.2em] shadow-sm focus:border-violet-400 focus:outline-none focus:ring-4 focus:ring-violet-100"
                    required
                  />
                </div>
                <button
                  type="submit"
                  className="w-full rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
                >
                  Verify and continue
                </button>
              </form>
            </div>
          </div>
        )}

        <div className="mt-8 flex flex-wrap gap-3 border-t border-slate-200 pt-6">
          <Link
            href="/login?intent=studio&next=/platform"
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Back to login
          </Link>
          <form action={signOutAction}>
            <button
              type="submit"
              className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100"
            >
              Log out
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
