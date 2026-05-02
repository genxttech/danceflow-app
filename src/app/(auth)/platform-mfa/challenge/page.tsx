import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { createClient } from "@/lib/supabase/server";
import { signOutAction } from "@/app/(auth)/actions";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

type MfaFactor = {
  id: string;
  status?: string | null;
  factor_type?: string | null;
  friendly_name?: string | null;
  created_at?: string | null;
};

function getSingleSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeCode(value: FormDataEntryValue | null) {
  return String(value ?? "").replace(/\s/g, "").trim();
}

function getVerifiedTotpFactors(factorsData: unknown): MfaFactor[] {
  const factors = factorsData as
    | {
        totp?: MfaFactor[];
        all?: MfaFactor[];
      }
    | null
    | undefined;

  const totpFactors = Array.isArray(factors?.totp)
    ? factors.totp
    : Array.isArray(factors?.all)
      ? factors.all.filter((factor) => factor.factor_type === "totp")
      : [];

  return totpFactors.filter((factor) => factor.status === "verified");
}

export default async function PlatformMfaChallengePage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  await requirePlatformAdmin();

  const resolvedSearchParams = (await searchParams) ?? {};
  const error = getSingleSearchParam(resolvedSearchParams.error);

  const supabase = await createClient();

  const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();

  if (aalData?.currentLevel === "aal2") {
    redirect("/platform");
  }

  const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();

  if (factorsError) {
    throw new Error(`Could not load MFA factors: ${factorsError.message}`);
  }

  const verifiedFactors = getVerifiedTotpFactors(factorsData);
  const defaultFactor = verifiedFactors[0] ?? null;

  if (!defaultFactor) {
    redirect("/platform-mfa/setup");
  }

  async function verifyMfaChallengeAction(formData: FormData) {
    "use server";

    await requirePlatformAdmin();

    const factorId = String(formData.get("factorId") ?? "").trim();
    const code = normalizeCode(formData.get("code"));

    if (!factorId || !code) {
      redirect("/platform-mfa/challenge?error=missing_code");
    }

    const supabase = await createClient();

    const { error } = await supabase.auth.mfa.challengeAndVerify({
      factorId,
      code,
    });

    if (error) {
      redirect("/platform-mfa/challenge?error=invalid_code");
    }

    redirect("/platform");
  }

  return (
    <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_20%,#f8fafc_100%)] px-6 py-12">
      <section className="mx-auto max-w-xl rounded-[2rem] border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-700">
          Platform Admin Security
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
          Verify your MFA code
        </h1>
        <p className="mt-4 text-sm leading-6 text-slate-600">
          Enter the current 6-digit code from your authenticator app to continue to the platform admin portal.
        </p>

        {error ? (
          <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">
            {error === "missing_code"
              ? "Enter the 6-digit code from your authenticator app."
              : "That code did not verify. Try the current code from your authenticator app."}
          </div>
        ) : null}

        <form action={verifyMfaChallengeAction} className="mt-8 space-y-4">
          <input type="hidden" name="factorId" value={defaultFactor.id} />
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
            {defaultFactor.friendly_name ? (
              <p className="mt-2 text-xs text-slate-500">
                Using factor: {defaultFactor.friendly_name}
              </p>
            ) : null}
          </div>
          <button
            type="submit"
            className="w-full rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
          >
            Verify and open platform admin
          </button>
        </form>

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
